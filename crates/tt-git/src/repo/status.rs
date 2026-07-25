//! Working-tree status — the in-process `git status --porcelain`.
//!
//! Callers of the old shell-out parsed porcelain text for two facts: is
//! anything changed at all, and which paths are untracked. Those are what this
//! returns, as data. Nothing reconstructs a porcelain line, because nothing
//! ever wanted one.

use super::{Repo, Result};

/// One changed path in the working tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusEntry {
    /// Repo-relative path. A collapsed untracked directory is reported without
    /// a trailing slash (gitoxide's spelling, unlike porcelain's `newdir/`) —
    /// [`Self::is_dir`] is what tells the two apart, not the string.
    pub path: String,
    /// Untracked (porcelain `??`) rather than a modification of tracked
    /// content. Untracked entries count toward "files changed" even though no
    /// diff covers them.
    pub untracked: bool,
    /// The entry is a whole untracked *directory*, collapsed to one entry the
    /// way porcelain collapses it. Callers that count files have to walk it;
    /// callers that count changes do not.
    pub is_dir: bool,
}

/// The working tree's changes, staged and unstaged alike.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StatusSummary {
    pub entries: Vec<StatusEntry>,
}

impl StatusSummary {
    /// Whether anything at all is changed — the `dirty` flag.
    pub fn is_dirty(&self) -> bool {
        !self.entries.is_empty()
    }

    /// Number of changed paths, the porcelain line count the removal guard
    /// counts as "uncommitted".
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Untracked paths only, in the order reported.
    pub fn untracked(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().filter(|e| e.untracked).map(|e| e.path.as_str())
    }
}

impl Repo {
    /// The working tree's status: tree-vs-index (staged) and index-vs-worktree
    /// (unstaged and untracked) changes, deduplicated by path so a file that is
    /// both staged and modified counts once — as `git status --porcelain`'s one
    /// line per path did.
    ///
    /// Ignored files are excluded, and untracked directories collapse to the
    /// directory (`newdir/`), matching porcelain: both are gitoxide defaults,
    /// verified against real `git` output in this module's tests.
    pub fn status(&self) -> Result<StatusSummary> {
        let platform = self
            .inner()
            .status(gix::progress::Discard)
            .map_err(|e| super::GitError::Read(e.to_string()))?;
        let iter = platform.into_iter(None).map_err(|e| super::GitError::Read(e.to_string()))?;

        let mut entries: Vec<StatusEntry> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for item in iter {
            let Ok(item) = item else { continue };
            let path = item.location().to_string();
            let (untracked, is_dir) = match &item {
                gix::status::Item::IndexWorktree(
                    gix::status::index_worktree::Item::DirectoryContents { entry, .. },
                ) => (
                    true,
                    matches!(
                        entry.disk_kind,
                        Some(gix::dir::entry::Kind::Directory | gix::dir::entry::Kind::Repository)
                    ),
                ),
                _ => (false, false),
            };
            if seen.insert(path.clone()) {
                entries.push(StatusEntry { path, untracked, is_dir });
            }
        }
        Ok(StatusSummary { entries })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::testrepo::TestRepo;

    /// Every porcelain shape at once: staged modification, staged deletion,
    /// unstaged modification, untracked file, untracked directory, and an
    /// ignored path that must not appear.
    fn messy() -> TestRepo {
        let repo = TestRepo::new();
        repo.write(".gitignore", "ignored.txt\nnode_modules/\n");
        repo.write("tracked.txt", "a\n");
        repo.write("staged.txt", "b\n");
        repo.write("doomed.txt", "c\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "--quiet", "-m", "fixture"]);

        repo.write("tracked.txt", "a\nunstaged\n");
        repo.write("staged.txt", "b\nstaged\n");
        repo.git(&["add", "staged.txt"]);
        repo.git(&["rm", "--quiet", "doomed.txt"]);
        repo.write("untracked.txt", "new\n");
        repo.write("newdir/deep.txt", "deep\n");
        repo.write("ignored.txt", "ignore me\n");
        repo.write("node_modules/pkg.js", "x\n");
        repo
    }

    /// What `git status --porcelain` reports, as (path, untracked) pairs.
    fn porcelain(repo: &TestRepo) -> Vec<(String, bool)> {
        let mut seen: Vec<(String, bool)> = repo
            .git(&["status", "--porcelain"])
            .lines()
            .map(|line| {
                let untracked = line.starts_with("??");
                (line[3..].trim().trim_end_matches('/').to_string(), untracked)
            })
            .collect();
        seen.sort();
        seen.dedup();
        seen
    }

    fn observed(repo: &TestRepo) -> Vec<(String, bool)> {
        let git = Repo::open(repo.path()).expect("open");
        let mut seen: Vec<(String, bool)> = git
            .status()
            .expect("status")
            .entries
            .into_iter()
            .map(|e| (e.path.trim_end_matches('/').to_string(), e.untracked))
            .collect();
        seen.sort();
        seen.dedup();
        seen
    }

    #[test]
    fn status_matches_git_porcelain() {
        let repo = messy();
        assert_eq!(observed(&repo), porcelain(&repo));
    }

    #[test]
    fn status_excludes_ignored_paths() {
        let repo = messy();
        let seen = observed(&repo);
        assert!(
            !seen.iter().any(|(path, _)| path.contains("node_modules") || path == "ignored.txt"),
            "ignored paths leaked into status: {seen:?}"
        );
    }

    #[test]
    fn status_marks_untracked_paths() {
        let repo = messy();
        let git = Repo::open(repo.path()).expect("open");
        let summary = git.status().expect("status");
        let mut untracked: Vec<&str> = summary.untracked().collect();
        untracked.sort();
        assert_eq!(untracked, vec!["newdir", "untracked.txt"]);
        assert!(
            summary.entries.iter().any(|e| e.path == "newdir" && e.is_dir),
            "a collapsed untracked directory must be flagged as one: {:?}",
            summary.entries
        );
        assert!(summary.is_dirty());
    }

    #[test]
    fn a_clean_tree_is_not_dirty() {
        let repo = TestRepo::new();
        let git = Repo::open(repo.path()).expect("open");
        let summary = git.status().expect("status");
        assert!(!summary.is_dirty());
        assert_eq!(summary.len(), 0);
    }

    #[test]
    fn a_path_both_staged_and_modified_counts_once() {
        let repo = TestRepo::new();
        repo.write("both.txt", "one\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "--quiet", "-m", "both"]);
        repo.write("both.txt", "two\n");
        repo.git(&["add", "both.txt"]);
        repo.write("both.txt", "three\n");

        let git = Repo::open(repo.path()).expect("open");
        let summary = git.status().expect("status");
        assert_eq!(summary.len(), 1, "one path, one entry: {:?}", summary.entries);
    }
}
