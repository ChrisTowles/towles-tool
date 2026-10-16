//! What each task's checkout has changed against its base, and where two tasks touch the
//! same files — the read behind `task_diff`, so an agent can see a sibling's edits before
//! they collide in a rebase.

use std::collections::BTreeSet;
use std::path::Path;

use serde::Serialize;

/// One path a checkout changed since it forked from its base.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    /// git's name-status letter, `?` for untracked.
    pub status: String,
    pub lines_added: i64,
    pub lines_removed: i64,
    /// Differs from `HEAD`, so not yet visible on the branch.
    pub uncommitted: bool,
}

/// A checkout's diff against the merge-base with its base — committed and uncommitted alike.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutChanges {
    pub base: String,
    pub files: Vec<ChangedFile>,
    /// The untracked walk stopped early, so `files` is a floor.
    pub capped: bool,
}

/// `git diff $(git merge-base <base> HEAD)` plus untracked files for `dir`. `base` is a branch
/// name; its `origin/` ref is preferred when present, so a stale local base doesn't inflate it.
pub fn changes_since_base(dir: &Path, base: &str) -> Option<CheckoutChanges> {
    let repo = tt_git::repo::open(dir).ok()?;
    let base = base.trim_start_matches("origin/");
    let remote = format!("refs/remotes/origin/{base}");
    let compared = if repo.has_rev(&remote) { remote } else { format!("refs/heads/{base}") };
    let boundary = repo.merge_base(&compared, "HEAD")?.to_string();
    let changes = repo.changes_vs(&boundary).ok()?;
    let uncommitted: BTreeSet<String> = repo
        .changes_vs("HEAD")
        .map(|c| c.files.into_iter().map(|f| f.path).collect())
        .unwrap_or_default();
    let files = changes
        .files
        .into_iter()
        .map(|f| ChangedFile {
            uncommitted: uncommitted.contains(&f.path),
            status: f.status.to_string(),
            path: f.path,
            lines_added: f.lines_added,
            lines_removed: f.lines_removed,
        })
        .collect();
    Some(CheckoutChanges { base: base.to_string(), files, capped: changes.untracked_cap.is_some() })
}

/// Paths both sides changed, sorted.
pub fn overlap(mine: &[ChangedFile], theirs: &[ChangedFile]) -> Vec<String> {
    let mine: BTreeSet<&str> = mine.iter().map(|f| f.path.as_str()).collect();
    let theirs: BTreeSet<&str> = theirs.iter().map(|f| f.path.as_str()).collect();
    mine.intersection(&theirs).map(|p| p.to_string()).collect()
}

/// The base a task checkout compares against: its `.tt-task` marker, else the main checkout's
/// branch.
pub fn task_base(task_dir: &Path, main_checkout: &Path) -> String {
    crate::read_task_base(task_dir).unwrap_or_else(|| crate::ops::base_branch(main_checkout))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tt_git::testing::git;

    fn file(path: &str) -> ChangedFile {
        ChangedFile {
            path: path.to_string(),
            status: "M".to_string(),
            lines_added: 1,
            lines_removed: 0,
            uncommitted: false,
        }
    }

    #[test]
    fn overlap_is_the_sorted_intersection() {
        let mine = [file("b.rs"), file("a.rs"), file("only-mine.rs")];
        let theirs = [file("a.rs"), file("b.rs"), file("only-theirs.rs")];
        assert_eq!(overlap(&mine, &theirs), vec!["a.rs", "b.rs"]);
        assert!(overlap(&mine, &[]).is_empty());
    }

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "--quiet"]);
        std::fs::write(dir.path().join("README.md"), "hello\n").unwrap();
        git(dir.path(), &["add", "."]);
        git(dir.path(), &["commit", "--quiet", "-m", "init"]);
        dir
    }

    #[test]
    fn changes_count_from_the_fork_point_not_the_base_tip() {
        let main = repo();
        let wt = main.path().join("wt");
        git(
            main.path(),
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "feat",
                wt.to_str().unwrap(),
            ],
        );

        std::fs::write(wt.join("feature.rs"), "fn f() {}\n").unwrap();
        git(&wt, &["add", "."]);
        git(&wt, &["commit", "--quiet", "-m", "feature"]);
        std::fs::write(wt.join("draft.rs"), "wip\n").unwrap();

        // Base moves on after the fork; its file must not show up as the task's change.
        std::fs::write(main.path().join("upstream.rs"), "later\n").unwrap();
        git(main.path(), &["add", "upstream.rs"]);
        git(main.path(), &["commit", "--quiet", "-m", "upstream"]);

        let changes = changes_since_base(&wt, "main").expect("diff");
        assert_eq!(changes.base, "main");
        let paths: Vec<(&str, bool)> =
            changes.files.iter().map(|f| (f.path.as_str(), f.uncommitted)).collect();
        assert_eq!(paths, vec![("draft.rs", true), ("feature.rs", false)]);
    }

    #[test]
    fn an_unknown_base_has_no_diff() {
        let main = repo();
        assert_eq!(changes_since_base(main.path(), "no-such-branch"), None);
    }
}
