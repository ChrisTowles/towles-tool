//! Diffs: what changed against a base, with per-file line counts.
//!
//! Replaces `git diff --numstat`, `git diff --name-status -M`, `git show
//! <rev>:<path>`, `git log --numstat` and `git ls-files`.
//!
//! "Changed against a base" means what `git diff <base>` means: the **working tree**
//! against a commit — committed work and uncommitted edits alike, which is why the
//! Folder Rail's numbers move the moment a file is saved. gitoxide's tree-to-tree
//! diff covers only the committed half, so both are assembled here.
//!
//! Line counts come from the worktree bytes on disk, with no smudge/clean round-trip.
//! A repository configuring content filters on a text file could see a count differ
//! from `git diff`; nothing in this workspace configures any.

use std::collections::BTreeMap;

use super::{GitError, Repo, Result};

/// How many files one untracked directory is expanded into before the walk
/// gives up and reports the directory itself. A build-output tree a
/// `.gitignore` forgot — `node_modules`, `target`, `.venv` — is hundreds of
/// thousands of files, and the rail asks for this diff on every poll.
const UNTRACKED_PER_DIR_CAP: usize = 1_000;

/// The same bound across one whole diff, so a hundred capped directories
/// can't add up to the walk the per-directory cap just prevented.
const UNTRACKED_TOTAL_CAP: usize = 5_000;

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
    /// Nonzero only on a `?` row that is a whole untracked *directory* left
    /// collapsed because expanding it hit a cap: how many files were found
    /// beneath it before the walk stopped, i.e. a floor, never a total.
    pub untracked_files: i64,
}

/// A diff, plus whether listing it was cut short.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Changes {
    pub files: Vec<FileChange>,
    /// Set when untracked expansion hit [`UNTRACKED_PER_DIR_CAP`] or
    /// [`UNTRACKED_TOTAL_CAP`]. Every count on this diff is then a floor, and
    /// callers must say so rather than print a truncated number as a total.
    pub untracked_cap: Option<UntrackedCap>,
}

impl Changes {
    /// Files covered, counting a collapsed untracked directory as the files
    /// found beneath it rather than as the single row it occupies. A floor
    /// whenever [`Self::untracked_cap`] is set.
    pub fn file_count(&self) -> i64 {
        self.files.iter().map(|change| change.untracked_files.max(1)).sum()
    }
}

/// Where an untracked walk stopped — enough to name the directory that is
/// almost certainly a `.gitignore` gap.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UntrackedCap {
    /// Repo-relative directory whose expansion was cut short.
    pub dir: String,
    /// Files listed beneath it before stopping.
    pub files: i64,
    /// The whole-diff budget ran out, not just this directory's share — so
    /// other untracked directories went unlisted too.
    pub total: bool,
}

/// Cumulative totals of one diff: how many files it touches and its ±.
///
/// Deliberately a distinct type from a `Vec<FileChange>` sum, because the two
/// diffs the Folder Rail reports are computed by different means — the
/// committed half is a tree-to-tree walk that never touches the working tree
/// (see [`Repo::committed_totals_vs`]), the uncommitted half is
/// [`Repo::changes_vs`] against `HEAD`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DiffTotals {
    pub files_changed: i64,
    pub lines_added: i64,
    pub lines_removed: i64,
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

/// What one untracked status entry expanded to.
enum Untracked {
    Files(Vec<String>),
    /// The walk stopped at its cap; the directory stays one row carrying how
    /// many files were seen before stopping.
    Capped {
        count: i64,
    },
}

impl Repo {
    /// Every file that differs between `base` and the working tree, with line
    /// counts — the in-process `git diff --numstat -M <base>` plus untracked
    /// files, which `git diff` never shows but which the rail counts as
    /// changed.
    ///
    /// Untracked *directories* are expanded to their files only up to a cap
    /// ([`Changes::untracked_cap`]); past it the directory stays one row with
    /// a count, because a repository with an unignored `node_modules` would
    /// otherwise stat and list half a million paths on every rail poll.
    pub fn changes_vs(&self, base: &str) -> Result<Changes> {
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
        let mut budget = UNTRACKED_TOTAL_CAP;
        let mut cap: Option<UntrackedCap> = None;
        let mut collapsed: BTreeMap<String, i64> = BTreeMap::new();
        for entry in &status.entries {
            if entry.untracked {
                // An untracked *directory* collapses to one status entry; the
                // rail counts files, so expand it — but only so far.
                match self.untracked_files_under(entry, budget) {
                    Untracked::Files(files) => {
                        budget -= files.len().min(budget);
                        for file in files {
                            paths.entry(file).or_insert('?');
                        }
                    }
                    Untracked::Capped { count } => {
                        let dir = entry.path.trim_end_matches('/').to_string();
                        let hit = UntrackedCap {
                            dir: dir.clone(),
                            files: count,
                            total: budget <= UNTRACKED_PER_DIR_CAP,
                        };
                        budget = budget.saturating_sub(count as usize);
                        collapsed.insert(dir.clone(), count);
                        paths.entry(dir).or_insert('?');
                        // The first cap is the one worth naming, unless a later
                        // one exhausted the whole diff's budget — that is the
                        // bigger fact, and it hides directories entirely.
                        if cap.as_ref().is_none_or(|prev| hit.total && !prev.total) {
                            cap = Some(hit);
                        }
                    }
                }
            } else {
                paths.entry(entry.path.clone()).or_insert('M');
            }
        }

        let mut out = Vec::with_capacity(paths.len());
        for (path, status) in paths {
            // An untracked path has no diff to compute, so nothing here may
            // read its bytes: reading every file of an unignored `node_modules`
            // only to discard the contents is what froze the rail. Existence is
            // the whole question — a collapsed directory doesn't even need that.
            if status == '?' {
                // Membership, not a nonzero count: a directory the budget ran
                // out before entering counts 0 files and must still be listed.
                let collapsed_dir = collapsed.get(&path).copied();
                if collapsed_dir.is_none() && !self.is_workdir_file(&path) {
                    continue;
                }
                let untracked_files = collapsed_dir.unwrap_or_default();
                out.push(FileChange { path, status, untracked_files, ..Default::default() });
                continue;
            }
            let old_path = renames.get(&path).cloned();
            let source = old_path.as_deref().unwrap_or(&path);
            let (before, after) = self.sides(&base_tree, source, &path);
            let (added, removed, binary) = count_lines(before.as_deref(), after.as_deref());
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
                (_, _, existing @ ('R' | 'C')) => existing,
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
                untracked_files: 0,
            });
        }
        Ok(Changes { files: out, untracked_cap: cap })
    }

    /// What `base..HEAD` **committed** — the tree-to-tree half of
    /// [`Repo::changes_vs`] with the working tree left out entirely, i.e.
    /// `git diff --numstat <base> HEAD`.
    ///
    /// This exists so the rail can report committed and uncommitted work as
    /// two separate quantities. Blending them (which `changes_vs` does, by
    /// design, for the diff pane) produces a ± that belongs to neither the
    /// commit count beside it nor the dirty working tree — and only the
    /// uncommitted half is destroyed by deleting the checkout, so the two
    /// carry different consequences and must not share a number.
    ///
    /// Zero totals when `HEAD` is unborn or `base` is `HEAD` itself.
    pub fn committed_totals_vs(&self, base: &str) -> Result<DiffTotals> {
        let base_id = self.resolve(base).ok_or_else(|| GitError::NoSuchRev(base.to_string()))?;
        let Some(head) = self.head_id() else {
            return Ok(DiffTotals::default());
        };
        if head == base_id {
            return Ok(DiffTotals::default());
        }
        let base_tree = self.tree_of(base_id)?;
        let head_tree = self.tree_of(head)?;
        self.tree_totals(Some(&base_tree), &head_tree)
    }

    /// A file's content at `rev`, or `None` when it does not exist there —
    /// `git show <rev>:<path>` for the original side of the diff editor.
    pub fn file_at(&self, rev: &str, path: &str) -> Option<Vec<u8>> {
        let id = self.resolve(rev)?;
        let tree = self.tree_of(id).ok()?;
        blob_at(&tree, path)
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
            let totals = self.tree_totals(parent_tree.as_ref(), &tree)?;
            out.push(CommitStat {
                sha: id.to_string(),
                subject,
                lines_added: totals.lines_added,
                lines_removed: totals.lines_removed,
            });
        }
        Ok(out)
    }

    /// Files touched and total ± between two trees. `None` for `old` means the
    /// empty tree — a root commit, whose whole content is an addition.
    fn tree_totals(&self, old: Option<&gix::Tree<'_>>, new: &gix::Tree<'_>) -> Result<DiffTotals> {
        let changes = self
            .inner()
            .diff_tree_to_tree(old, Some(new), None)
            .map_err(|e| GitError::Read(e.to_string()))?;
        let empty = self.inner().empty_tree();
        let old = old.unwrap_or(&empty);
        let mut totals = DiffTotals::default();
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
            totals.files_changed += 1;
            totals.lines_added += a;
            totals.lines_removed += r;
        }
        Ok(totals)
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
    ///
    /// `budget` is what remains of the diff's whole untracked allowance; the
    /// walk stops at the smaller of it and [`UNTRACKED_PER_DIR_CAP`] and the
    /// caller keeps the directory as one row. Stopping also ends the one walk
    /// here that a symlink cycle could otherwise run forever.
    fn untracked_files_under(&self, entry: &super::StatusEntry, budget: usize) -> Untracked {
        if !entry.is_dir {
            return Untracked::Files(vec![entry.path.clone()]);
        }
        let Some(workdir) = self.inner().workdir() else {
            return Untracked::Files(Vec::new());
        };
        let cap = UNTRACKED_PER_DIR_CAP.min(budget);
        if cap == 0 {
            return Untracked::Capped { count: 0 };
        }
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
                    if out.len() >= cap {
                        return Untracked::Capped { count: out.len() as i64 };
                    }
                }
            }
        }
        Untracked::Files(out)
    }

    /// Whether a repo-relative path is a regular file in the working tree.
    fn is_workdir_file(&self, path: &str) -> bool {
        self.inner().workdir().is_some_and(|dir| dir.join(path).is_file())
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
            .files
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
        let changes =
            Repo::open(repo.path()).expect("open").changes_vs("HEAD").expect("changes").files;
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

        let changes =
            Repo::open(repo.path()).expect("open").changes_vs("origin/main").unwrap().files;
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
        let changes =
            Repo::open(repo.path()).expect("open").changes_vs("HEAD").expect("changes").files;
        let untracked: Vec<&FileChange> = changes.iter().filter(|c| c.status == '?').collect();
        let mut paths: Vec<&str> = untracked.iter().map(|c| c.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, vec!["fresh.txt", "nested/deep.txt"]);
        assert!(
            untracked.iter().all(|c| c.lines_added == 0 && c.lines_removed == 0),
            "untracked files have no diff to count: {untracked:?}"
        );
    }

    /// `count` untracked files under `dir`, the shape of a `node_modules` that
    /// no `.gitignore` covers.
    fn untracked_tree(repo: &TestRepo, dir: &str, count: usize) {
        for i in 0..count {
            // Nested, so the walk has directories to descend as well as files.
            repo.write(&format!("{dir}/pkg{}/file{i}.js", i % 20), "x\n");
        }
    }

    #[test]
    fn a_huge_untracked_directory_stays_one_collapsed_row() {
        let repo = TestRepo::new();
        untracked_tree(&repo, "node_modules", UNTRACKED_PER_DIR_CAP + 500);
        let changes = Repo::open(repo.path()).expect("open").changes_vs("HEAD").expect("changes");

        let paths: Vec<&str> = changes.files.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(paths, vec!["node_modules"], "the directory must not be expanded: {paths:?}");
        let row = &changes.files[0];
        assert_eq!((row.status, row.untracked_files), ('?', UNTRACKED_PER_DIR_CAP as i64));
        // The count is the files behind the row, not the one row itself.
        assert_eq!(changes.file_count(), UNTRACKED_PER_DIR_CAP as i64);

        let cap = changes.untracked_cap.expect("the cap that was hit is reported");
        assert_eq!(cap.dir, "node_modules");
        assert_eq!(cap.files, UNTRACKED_PER_DIR_CAP as i64);
        assert!(!cap.total, "one directory's cap is not the whole diff's: {cap:?}");
    }

    #[test]
    fn a_small_untracked_directory_is_still_expanded_file_by_file() {
        let repo = TestRepo::new();
        untracked_tree(&repo, "smalldir", 3);
        let changes = Repo::open(repo.path()).expect("open").changes_vs("HEAD").expect("changes");
        assert_eq!(changes.files.len(), 3, "{:?}", changes.files);
        assert!(changes.files.iter().all(|c| c.status == '?' && c.untracked_files == 0));
        assert_eq!(changes.untracked_cap, None);
        assert_eq!(changes.file_count(), 3);
    }

    #[test]
    fn many_capped_directories_stop_at_the_whole_diff_budget() {
        let repo = TestRepo::new();
        // Six directories over the per-dir cap: five exhaust the total budget,
        // and the sixth must not be walked at all.
        for i in 0..6 {
            untracked_tree(&repo, &format!("dir{i}"), UNTRACKED_PER_DIR_CAP + 1);
        }
        let changes = Repo::open(repo.path()).expect("open").changes_vs("HEAD").expect("changes");
        // One row per directory, none of them walked past the budget. The row
        // a drained budget leaves counts 0 files but still says "something is
        // over here", so the total lands a little above the cap.
        assert_eq!(changes.files.len(), 6);
        let counted = changes.file_count();
        assert!(
            (UNTRACKED_TOTAL_CAP as i64..=UNTRACKED_TOTAL_CAP as i64 + 6).contains(&counted),
            "the budget bounds the walk: {counted}"
        );
        // Which directory drains the budget depends on the order the status
        // walk emits them, so the invariant is the flag, not the name: some
        // directory ran the whole diff out, and `total` is what tells the UI
        // that others went unlisted entirely.
        let cap = changes.untracked_cap.expect("capped");
        assert!(cap.total, "the whole-diff budget ran out, which hides directories: {cap:?}");
        assert!(cap.dir.starts_with("dir"), "the cap names a real directory: {cap:?}");
    }

    #[test]
    fn an_untracked_file_is_listed_without_its_content_being_read() {
        use std::os::unix::fs::PermissionsExt;

        // An unreadable file is the observable form of "nothing here reads the
        // bytes": the old code's `fs::read` failed and dropped the row, which
        // is the same discarded read that made an unignored `node_modules`
        // freeze the rail.
        let repo = TestRepo::new();
        repo.write("secret.txt", "new\n");
        let path = repo.path().join("secret.txt");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).expect("chmod");
        if std::fs::read(&path).is_ok() {
            return; // running as root, where no file is unreadable
        }

        let changes = Repo::open(repo.path()).expect("open").changes_vs("HEAD").expect("changes");
        let paths: Vec<&str> = changes.files.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(paths, vec!["secret.txt"]);
    }

    #[test]
    fn binary_files_count_as_changed_without_line_counts() {
        let repo = TestRepo::new();
        std::fs::write(repo.path().join("blob.bin"), [0u8, 1, 2, 0, 3]).expect("write");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "--quiet", "-m", "binary"]);
        let changes =
            Repo::open(repo.path()).expect("open").changes_vs("origin/main").unwrap().files;
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
