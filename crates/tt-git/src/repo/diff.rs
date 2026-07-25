//! Diffs: what changed against a base, with per-file line counts.
//!
//! This replaces `git diff --numstat`, `git diff --name-status -M`, `git show
//! <rev>:<path>`, `git log --numstat` and `git ls-files`.
//!
//! ## What "changed against a base" means here
//!
//! The same thing `git diff <base>` means: the **working tree** against a
//! commit — committed work and uncommitted edits alike, which is why the
//! Folder Rail's numbers move the moment a file is saved. gitoxide's
//! tree-to-tree diff only covers the committed half, so the two halves are
//! assembled here: tree-to-tree for what HEAD holds, and the working tree's
//! own bytes for everything the status walk reports as changed.
//!
//! Line counts come from the worktree bytes as they are on disk, without a
//! smudge/clean round-trip. For a repository that configures content filters
//! on a text file, a count could differ from `git diff` by whatever the filter
//! changes; nothing in this workspace configures any.

use std::collections::BTreeMap;

use super::{GitError, Repo, Result};

/// One changed file, with the line counts `--numstat` reports.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileChange {
    /// Repo-relative path, post-rename.
    pub path: String,
    /// Where a renamed file came from.
    pub old_path: Option<String>,
    /// git's name-status letter: `A`, `D`, `M`, `R`, or `?` for untracked.
    pub status: char,
    pub lines_added: i64,
    pub lines_removed: i64,
    /// Binary content, which has no line counts (`--numstat` prints `-`). The
    /// file still counts as changed.
    pub binary: bool,
}

/// One commit's own line-count diff against its first parent.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommitStat {
    pub sha: String,
    pub subject: String,
    pub lines_added: i64,
    pub lines_removed: i64,
}

/// A file's two sides. `None` means absent on that side (added or deleted).
type Sides = (Option<Vec<u8>>, Option<Vec<u8>>);

impl Repo {
    /// Every file that differs between `base` and the working tree, with line
    /// counts — the in-process `git diff --numstat -M <base>` plus untracked
    /// files, which `git diff` never shows but which the rail counts as
    /// changed.
    pub fn changes_vs(&self, base: &str) -> Result<Vec<FileChange>> {
        let base_id = self.resolve(base).ok_or_else(|| GitError::NoSuchRev(base.to_string()))?;
        let base_tree = self.tree_of(base_id)?;

        // Committed half: base..HEAD, rename-tracked so a move is one `R`
        // entry rather than an add/delete pair.
        let mut renames: BTreeMap<String, String> = BTreeMap::new();
        let mut paths: BTreeMap<String, char> = BTreeMap::new();
        if let Some(head) = self.head_id() {
            let head_tree = self.tree_of(head)?;
            let changes = self
                .inner()
                .diff_tree_to_tree(Some(&base_tree), Some(&head_tree), None)
                .map_err(|e| GitError::Read(e.to_string()))?;
            for change in changes {
                use gix::object::tree::diff::ChangeDetached as C;
                match change {
                    C::Addition { location, .. } => {
                        paths.insert(location.to_string(), 'A');
                    }
                    C::Deletion { location, .. } => {
                        paths.insert(location.to_string(), 'D');
                    }
                    C::Modification { location, .. } => {
                        paths.insert(location.to_string(), 'M');
                    }
                    C::Rewrite { location, source_location, copy, .. } => {
                        let path = location.to_string();
                        renames.insert(path.clone(), source_location.to_string());
                        paths.insert(path, if copy { 'C' } else { 'R' });
                    }
                }
            }
        }

        // Uncommitted half: anything the status walk sees, which is also the
        // only way untracked files enter the list.
        let status = self.status()?;
        for entry in &status.entries {
            if entry.untracked {
                // An untracked *directory* collapses to one status entry; the
                // rail counts files, so expand it.
                for file in self.untracked_files_under(entry) {
                    paths.entry(file).or_insert('?');
                }
            } else {
                paths.entry(entry.path.clone()).or_insert('M');
            }
        }

        let mut out = Vec::with_capacity(paths.len());
        for (path, status) in paths {
            let old_path = renames.get(&path).cloned();
            let source = old_path.as_deref().unwrap_or(&path);
            let (before, after) = self.sides(&base_tree, source, &path);
            // An untracked file has no diff — `git diff` never shows one, and
            // the diff pane lists it with empty ± columns. It counts as a
            // changed *file* and nothing more; giving it line counts here
            // would make the rail's totals disagree with the pane beside it.
            let (added, removed, binary) = if status == '?' {
                (0, 0, false)
            } else {
                count_lines(before.as_deref(), after.as_deref())
            };
            // A path the diff reported but whose two sides are identical is not
            // a change: an edit saved and then reverted leaves the status walk
            // reporting it (the index stat is stale) while the content matches.
            if added == 0 && removed == 0 && !binary && before.is_some() == after.is_some() {
                let unchanged = before == after;
                if unchanged && status != 'R' && status != 'C' {
                    continue;
                }
            }
            let status = match (before.is_some(), after.is_some(), status) {
                (_, _, existing @ ('R' | 'C' | '?')) => existing,
                (false, true, _) => 'A',
                (true, false, _) => 'D',
                _ => 'M',
            };
            out.push(FileChange {
                path,
                old_path,
                status,
                lines_added: added,
                lines_removed: removed,
                binary,
            });
        }
        Ok(out)
    }

    /// A file's content at `rev`, or `None` when it does not exist there —
    /// `git show <rev>:<path>` for the original side of the diff editor.
    pub fn file_at(&self, rev: &str, path: &str) -> Option<Vec<u8>> {
        let id = self.resolve(rev)?;
        let tree = self.tree_of(id).ok()?;
        blob_at(&tree, path)
    }

    /// Every tracked file plus every untracked-but-not-ignored one, sorted and
    /// capped — `git ls-files` merged with `ls-files --others
    /// --exclude-standard`.
    pub fn list_files(&self, cap: usize) -> Result<Vec<String>> {
        let index = self.inner().index_or_empty().map_err(|e| GitError::Read(e.to_string()))?;
        let mut files: Vec<String> =
            index.entries().iter().map(|e| e.path(&index).to_string()).collect();
        for entry in self.status()?.entries.iter().filter(|e| e.untracked) {
            files.extend(self.untracked_files_under(entry));
        }
        files.sort();
        files.dedup();
        files.truncate(cap);
        Ok(files)
    }

    /// Per-commit line counts for `base..HEAD`, oldest first — the
    /// `DiffButton` hover's breakdown, `git log --reverse --numstat`.
    pub fn commit_stats(&self, base: &str) -> Result<Vec<CommitStat>> {
        let Some(head) = self.head_id() else {
            return Ok(Vec::new());
        };
        let Some(boundary) = self.merge_base(base, "HEAD") else {
            return Ok(Vec::new());
        };
        let mut commits = self.rev_list(boundary, head)?;
        commits.reverse();

        let mut out = Vec::with_capacity(commits.len());
        for id in commits {
            let Some(commit) =
                self.inner().find_object(id).ok().and_then(|o| o.try_into_commit().ok())
            else {
                continue;
            };
            let subject = commit.message().map(|m| m.summary().to_string()).unwrap_or_default();
            let tree = commit.tree().map_err(|e| GitError::Read(e.to_string()))?;
            let parent_tree =
                commit.parent_ids().next().and_then(|parent| self.tree_of(parent.detach()).ok());
            let (added, removed) = self.tree_line_counts(parent_tree.as_ref(), &tree)?;
            out.push(CommitStat {
                sha: id.to_string(),
                subject,
                lines_added: added,
                lines_removed: removed,
            });
        }
        Ok(out)
    }

    /// Total ± between two trees. `None` for `old` means the empty tree — a
    /// root commit, whose whole content is an addition.
    fn tree_line_counts(
        &self,
        old: Option<&gix::Tree<'_>>,
        new: &gix::Tree<'_>,
    ) -> Result<(i64, i64)> {
        let changes = self
            .inner()
            .diff_tree_to_tree(old, Some(new), None)
            .map_err(|e| GitError::Read(e.to_string()))?;
        let empty = self.inner().empty_tree();
        let old = old.unwrap_or(&empty);
        let (mut added, mut removed) = (0, 0);
        for change in changes {
            use gix::object::tree::diff::ChangeDetached as C;
            let path = match &change {
                C::Addition { location, .. }
                | C::Deletion { location, .. }
                | C::Modification { location, .. }
                | C::Rewrite { location, .. } => location.to_string(),
            };
            let source = match &change {
                C::Rewrite { source_location, .. } => source_location.to_string(),
                _ => path.clone(),
            };
            let before = blob_at(old, &source);
            let after = blob_at(new, &path);
            let (a, r, _) = count_lines(before.as_deref(), after.as_deref());
            added += a;
            removed += r;
        }
        Ok((added, removed))
    }

    /// The two sides of one path: its content in `base_tree` (at `source`, the
    /// pre-rename path) and in the working tree (at `path`).
    fn sides(&self, base_tree: &gix::Tree<'_>, source: &str, path: &str) -> Sides {
        let before = blob_at(base_tree, source);
        let after = self
            .inner()
            .workdir()
            .map(|dir| dir.join(path))
            .filter(|full| full.is_file())
            .and_then(|full| std::fs::read(full).ok());
        (before, after)
    }

    /// Expand an untracked status entry into the files it covers: itself for a
    /// file, or every file beneath it for a collapsed directory. A collapsed
    /// directory is only ever reported when *nothing* in it is tracked or
    /// ignored, so everything under it is untracked by construction — no
    /// second ignore check is needed here.
    fn untracked_files_under(&self, entry: &super::StatusEntry) -> Vec<String> {
        if !entry.is_dir {
            return vec![entry.path.clone()];
        }
        let Some(workdir) = self.inner().workdir() else {
            return Vec::new();
        };
        let root = workdir.join(entry.path.trim_end_matches('/'));
        let mut out = Vec::new();
        let mut stack = vec![root];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for item in entries.flatten() {
                let path = item.path();
                if path.is_dir() {
                    stack.push(path);
                } else if let Ok(rel) = path.strip_prefix(workdir) {
                    out.push(rel.to_string_lossy().into_owned());
                }
            }
        }
        out
    }

    /// The tree of whatever `id` names — a commit's tree, or the tree itself.
    fn tree_of(&self, id: gix::ObjectId) -> Result<gix::Tree<'_>> {
        self.inner()
            .find_object(id)
            .map_err(|e| GitError::Read(e.to_string()))?
            .peel_to_tree()
            .map_err(|e| GitError::Read(e.to_string()))
    }
}

/// A path's blob content within `tree`, or `None` when absent (or when it
/// names a directory rather than a file).
pub(super) fn blob_at(tree: &gix::Tree<'_>, path: &str) -> Option<Vec<u8>> {
    let entry = tree.lookup_entry_by_path(path).ok().flatten()?;
    let object = entry.object().ok()?;
    object.try_into_blob().ok().map(|blob| blob.data.clone())
}

/// Added/removed line counts between two sides, and whether either is binary.
///
/// Binary is decided the way git decides it — a NUL byte in the content — and
/// yields no counts, matching `--numstat`'s `-` columns.
fn count_lines(before: Option<&[u8]>, after: Option<&[u8]>) -> (i64, i64, bool) {
    let before = before.unwrap_or(&[]);
    let after = after.unwrap_or(&[]);
    if is_binary(before) || is_binary(after) {
        return (0, 0, true);
    }
    if before == after {
        return (0, 0, false);
    }
    let input = gix::diff::blob::InternedInput::new(before, after);
    let diff = gix::diff::blob::diff_with_slider_heuristics(super::DIFF_ALGORITHM, &input);
    (i64::from(diff.count_additions()), i64::from(diff.count_removals()), false)
}

/// git's own binary heuristic: a NUL byte within the first 8000 bytes.
fn is_binary(content: &[u8]) -> bool {
    content.iter().take(8000).any(|b| *b == 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::testrepo::TestRepo;

    /// `git diff --numstat -M <base>` as (added, removed, path) triples.
    fn numstat(repo: &TestRepo, base: &str) -> Vec<(i64, i64, String)> {
        let mut seen: Vec<(i64, i64, String)> = repo
            .git(&["diff", "--numstat", "-M", base])
            .lines()
            .filter(|l| !l.is_empty())
            .map(|line| {
                let mut parts = line.splitn(3, '\t');
                let added = parts.next().unwrap_or("0");
                let removed = parts.next().unwrap_or("0");
                let path = parts.next().unwrap_or("").to_string();
                (added.parse().unwrap_or(0), removed.parse().unwrap_or(0), path)
            })
            .collect();
        seen.sort();
        seen
    }

    fn observed(repo: &TestRepo, base: &str) -> Vec<(i64, i64, String)> {
        let git = Repo::open(repo.path()).expect("open");
        let mut seen: Vec<(i64, i64, String)> = git
            .changes_vs(base)
            .expect("changes")
            .into_iter()
            .filter(|c| c.status != '?')
            .map(|c| (c.lines_added, c.lines_removed, c.path))
            .collect();
        seen.sort();
        seen
    }

    #[test]
    fn committed_changes_match_git_numstat() {
        let repo = TestRepo::new();
        repo.git(&["checkout", "--quiet", "-b", "feature"]);
        repo.commit_file("added.txt", "one\ntwo\nthree\n");
        repo.write("README.md", "hello\nmore\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "--quiet", "-m", "edit readme"]);
        assert_eq!(observed(&repo, "origin/main"), numstat(&repo, "origin/main"));
    }

    #[test]
    fn uncommitted_edits_are_included_like_git_diff() {
        let repo = TestRepo::new();
        repo.write("README.md", "hello\nuncommitted\n");
        assert_eq!(observed(&repo, "origin/main"), numstat(&repo, "origin/main"));
        assert_eq!(observed(&repo, "origin/main"), vec![(1, 0, "README.md".to_string())]);
    }

    #[test]
    fn committed_and_uncommitted_changes_combine() {
        let repo = TestRepo::new();
        repo.git(&["checkout", "--quiet", "-b", "feature"]);
        repo.commit_file("a.txt", "one\n");
        repo.write("a.txt", "one\ntwo\n");
        repo.write("README.md", "hello\nedited\n");
        assert_eq!(observed(&repo, "origin/main"), numstat(&repo, "origin/main"));
    }

    #[test]
    fn deletions_are_counted() {
        let repo = TestRepo::new();
        repo.commit_file("gone.txt", "a\nb\n");
        repo.git(&["update-ref", "refs/remotes/origin/main", "main"]);
        repo.git(&["rm", "--quiet", "gone.txt"]);
        let changes = Repo::open(repo.path()).expect("open").changes_vs("HEAD").expect("changes");
        let gone = changes.iter().find(|c| c.path == "gone.txt").expect("deletion reported");
        assert_eq!((gone.status, gone.lines_added, gone.lines_removed), ('D', 0, 2));
    }

    #[test]
    fn renames_carry_their_source_path() {
        let repo = TestRepo::new();
        let body = (0..40).map(|i| format!("line {i}\n")).collect::<String>();
        repo.commit_file("old.txt", &body);
        repo.git(&["update-ref", "refs/remotes/origin/main", "main"]);
        repo.git(&["checkout", "--quiet", "-b", "feature"]);
        repo.git(&["mv", "old.txt", "new.txt"]);
        repo.git(&["commit", "--quiet", "-m", "rename"]);

        let changes = Repo::open(repo.path()).expect("open").changes_vs("origin/main").unwrap();
        let renamed = changes.iter().find(|c| c.path == "new.txt").expect("rename reported");
        assert_eq!(renamed.status, 'R');
        assert_eq!(renamed.old_path.as_deref(), Some("old.txt"));
        assert!(
            !changes.iter().any(|c| c.path == "old.txt"),
            "a rename must not also appear as a deletion: {changes:?}"
        );
    }

    #[test]
    fn untracked_files_are_listed_but_not_diffed() {
        let repo = TestRepo::new();
        repo.write("fresh.txt", "new\n");
        repo.write("nested/deep.txt", "deep\n");
        let changes = Repo::open(repo.path()).expect("open").changes_vs("HEAD").expect("changes");
        let untracked: Vec<&FileChange> = changes.iter().filter(|c| c.status == '?').collect();
        let mut paths: Vec<&str> = untracked.iter().map(|c| c.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, vec!["fresh.txt", "nested/deep.txt"]);
        assert!(
            untracked.iter().all(|c| c.lines_added == 0 && c.lines_removed == 0),
            "untracked files have no diff to count: {untracked:?}"
        );
    }

    #[test]
    fn binary_files_count_as_changed_without_line_counts() {
        let repo = TestRepo::new();
        std::fs::write(repo.path().join("blob.bin"), [0u8, 1, 2, 0, 3]).expect("write");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "--quiet", "-m", "binary"]);
        let changes = Repo::open(repo.path()).expect("open").changes_vs("origin/main").unwrap();
        let bin = changes.iter().find(|c| c.path == "blob.bin").expect("binary reported");
        assert!(bin.binary);
        assert_eq!((bin.lines_added, bin.lines_removed), (0, 0));
    }

    #[test]
    fn file_at_reads_content_from_a_revision() {
        let repo = TestRepo::new();
        let git = Repo::open(repo.path()).expect("open");
        assert_eq!(git.file_at("HEAD", "README.md").as_deref(), Some(&b"hello\n"[..]));
        assert!(git.file_at("HEAD", "nope.txt").is_none());
    }

    #[test]
    fn list_files_covers_tracked_and_untracked() {
        let repo = TestRepo::new();
        repo.write(".gitignore", "ignored.txt\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "--quiet", "-m", "ignore"]);
        repo.write("untracked.txt", "x\n");
        repo.write("ignored.txt", "x\n");

        let files = Repo::open(repo.path()).expect("open").list_files(100).expect("list");
        assert!(files.contains(&"README.md".to_string()));
        assert!(files.contains(&"untracked.txt".to_string()));
        assert!(!files.contains(&"ignored.txt".to_string()), "ignored file listed: {files:?}");
    }

    #[test]
    fn list_files_respects_the_cap() {
        let repo = TestRepo::new();
        for i in 0..10 {
            repo.write(&format!("f{i}.txt"), "x\n");
        }
        let files = Repo::open(repo.path()).expect("open").list_files(4).expect("list");
        assert_eq!(files.len(), 4);
    }

    #[test]
    fn commit_stats_are_oldest_first_with_per_commit_counts() {
        let repo = TestRepo::new();
        repo.git(&["checkout", "--quiet", "-b", "feature"]);
        repo.commit_file("first.txt", "a\nb\n");
        repo.commit_file("second.txt", "c\n");

        let stats = Repo::open(repo.path()).expect("open").commit_stats("origin/main").unwrap();
        assert_eq!(stats.len(), 2);
        assert_eq!(stats[0].subject, "add first.txt");
        assert_eq!((stats[0].lines_added, stats[0].lines_removed), (2, 0));
        assert_eq!(stats[1].subject, "add second.txt");
        assert_eq!((stats[1].lines_added, stats[1].lines_removed), (1, 0));
    }

    #[test]
    fn commit_stats_are_empty_on_the_base_branch() {
        let repo = TestRepo::new();
        let stats = Repo::open(repo.path()).expect("open").commit_stats("origin/main").unwrap();
        assert!(stats.is_empty());
    }
}
