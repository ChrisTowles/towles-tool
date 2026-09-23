//! The branch a task's worktree is on *now*, for resyncing the board row's recorded
//! one after a `git switch` inside the task. Only the record follows: the directory
//! name is the task's identity (ports, sessions, env claims), and
//! [`crate::layout::task_name_from_branch`] is one-way by design.

use std::path::Path;

use thiserror::Error;

use super::{base_branch, repo_at};
use crate::layout;

/// Why the live branch can't be recorded. Each is a state the user resolves in git,
/// so none of them has a force.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum BranchRefused {
    #[error("{name} no longer exists on disk")]
    DirMissing { name: String },
    #[error("{name} is not a readable git checkout: {detail}")]
    Unreadable { name: String, detail: String },
    #[error("{name} has a detached HEAD — no branch to record")]
    Detached { name: String },
    /// A `git switch main` to look around is not the task moving to `main`.
    #[error("{name} is on {base}, the task's base branch — not recording it")]
    OnBase { name: String, base: String },
}

impl BranchRefused {
    pub fn remedy(&self) -> &'static str {
        match self {
            BranchRefused::DirMissing { .. } => {
                "remove the task (`tt task rm`) or recreate it from the rail"
            }
            BranchRefused::Unreadable { .. } => "check the worktree with `git status`",
            BranchRefused::Detached { .. } | BranchRefused::OnBase { .. } => {
                "switch back to the task's branch, or create one: git switch -c <branch>"
            }
        }
    }
}

/// The branch checked out in task `dir`, refusing the states that aren't a task's
/// branch. `checkout` supplies the base when `dir` has no `.tt-task` marker.
pub fn live_task_branch(dir: &Path, checkout: &Path) -> Result<String, BranchRefused> {
    let name = layout::task_name_from_dir(dir);
    if !dir.is_dir() {
        return Err(BranchRefused::DirMissing { name });
    }
    let repo = repo_at(dir)
        .map_err(|e| BranchRefused::Unreadable { name: name.clone(), detail: e.to_string() })?;
    let Some(branch) = repo.head_branch().filter(|b| !b.is_empty()) else {
        return Err(BranchRefused::Detached { name });
    };
    let base = layout::read_task_base(dir).unwrap_or_else(|| base_branch(checkout));
    if branch == base {
        return Err(BranchRefused::OnBase { name, base });
    }
    Ok(branch)
}

#[derive(Debug, Error)]
pub enum SyncError {
    #[error("task {0} has no worktree to read a branch from")]
    NoWorktree(i64),
    #[error(transparent)]
    Refused(#[from] BranchRefused),
    #[error(transparent)]
    Store(#[from] tt_store::Error),
}

impl SyncError {
    pub fn remedy(&self) -> Option<&'static str> {
        match self {
            SyncError::Refused(refused) => Some(refused.remedy()),
            SyncError::Store(tt_store::Error::BranchTaken { .. }) => {
                Some("sync or close that task first")
            }
            _ => None,
        }
    }
}

/// Re-read task `id`'s worktree branch and record it — the one sequence behind
/// `tt task sync`, MCP `task_sync` and the rail's drift badge. `surface` tags the event.
pub fn sync_task_branch(
    store: &tt_store::Store,
    id: i64,
    surface: &str,
) -> Result<tt_store::BranchResync, SyncError> {
    let result = resync(store, id);
    let (from, to, outcome) = match &result {
        Ok(r) => (
            r.previous.as_deref().unwrap_or(""),
            r.current.as_str(),
            if r.changed { "synced" } else { "unchanged" },
        ),
        Err(_) => ("", "", "refused"),
    };
    tracing::info!(task_id = id, from, to, outcome, surface, "task.branch_synced");
    result
}

fn resync(store: &tt_store::Store, id: i64) -> Result<tt_store::BranchResync, SyncError> {
    let task = store.task_by_id(id)?;
    let Some(tt_store::TaskWorktree { repo_root, dir: Some(dir), .. }) = task.worktree else {
        return Err(SyncError::NoWorktree(id));
    };
    let branch = live_task_branch(Path::new(&dir), Path::new(&repo_root))?;
    Ok(store.resync_task_branch(id, &branch)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::tests::git_ok as git;

    /// `<tmp>/repo` on `main`, plus a marked task worktree on `feat/one`.
    fn task_fixture() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let checkout = tmp.path().join("repo");
        std::fs::create_dir_all(&checkout).unwrap();
        git(&checkout, &["init", "-q", "-b", "main"]);
        git(&checkout, &["commit", "-q", "--allow-empty", "-m", "x"]);
        let dir = layout::worktrees_dir(&checkout).join("feat-one");
        git(
            &checkout,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feat/one",
                dir.to_str().unwrap(),
            ],
        );
        let marker = layout::marker_contents("feat-one", "main", "main");
        std::fs::write(dir.join(layout::MARKER_FILE), marker).unwrap();
        (tmp, checkout, dir)
    }

    /// The fixture's worktree bound to a fresh board row recording `feat/one`.
    fn bound_store(checkout: &Path, dir: &Path) -> (tt_store::Store, i64) {
        let store = tt_store::Store::open_in_memory().unwrap();
        let id = store.add_task("t", "doing", None, None, 1).unwrap().id;
        let (root, dir) = (checkout.to_str().unwrap(), dir.to_str().unwrap());
        store.set_task_worktree(id, root, None, Some("feat/one"), Some(dir)).unwrap();
        (store, id)
    }

    #[test]
    fn follows_a_branch_switch_inside_the_worktree() {
        let (_tmp, checkout, dir) = task_fixture();
        let (store, id) = bound_store(&checkout, &dir);
        assert!(!sync_task_branch(&store, id, "test").unwrap().changed);

        git(&dir, &["switch", "-q", "-c", "feat/two"]);
        let resync = sync_task_branch(&store, id, "test").unwrap();
        assert_eq!(resync.previous.as_deref(), Some("feat/one"));
        assert_eq!(resync.current, "feat/two");
        let wt = store.task_by_id(id).unwrap().worktree.unwrap();
        assert_eq!(wt.branch.as_deref(), Some("feat/two"));
    }

    #[test]
    fn refuses_a_detached_head_and_the_base_branch_without_writing() {
        let (_tmp, checkout, dir) = task_fixture();
        let (store, id) = bound_store(&checkout, &dir);
        git(&dir, &["switch", "-q", "--detach"]);
        let error = sync_task_branch(&store, id, "test").unwrap_err();
        assert!(matches!(error, SyncError::Refused(BranchRefused::Detached { .. })));
        assert!(error.remedy().is_some_and(|r| r.contains("git switch -c")));

        // `main` is already checked out in the primary, so move the base instead.
        git(&dir, &["switch", "-q", "feat/one"]);
        let marker = layout::marker_contents("feat-one", "feat/one", "main");
        std::fs::write(dir.join(layout::MARKER_FILE), marker).unwrap();
        assert!(matches!(
            live_task_branch(&dir, &checkout),
            Err(BranchRefused::OnBase { base, .. }) if base == "feat/one"
        ));
        let wt = store.task_by_id(id).unwrap().worktree.unwrap();
        assert_eq!(wt.branch.as_deref(), Some("feat/one"), "a refusal writes nothing");
    }

    #[test]
    fn falls_back_to_the_checkouts_branch_without_a_marker() {
        let (_tmp, checkout, dir) = task_fixture();
        std::fs::remove_file(dir.join(layout::MARKER_FILE)).unwrap();
        assert_eq!(live_task_branch(&dir, &checkout), Ok("feat/one".to_string()));
        assert!(matches!(
            live_task_branch(&checkout, &checkout),
            Err(BranchRefused::OnBase { base, .. }) if base == "main"
        ));
    }

    #[test]
    fn refuses_a_missing_directory_and_a_row_without_one() {
        let (_tmp, checkout, dir) = task_fixture();
        let gone = dir.with_file_name("gone");
        assert_eq!(
            live_task_branch(&gone, &checkout),
            Err(BranchRefused::DirMissing { name: "gone".to_string() })
        );
        let store = tt_store::Store::open_in_memory().unwrap();
        let id = store.add_task("no worktree", "backlog", None, None, 1).unwrap().id;
        assert!(matches!(sync_task_branch(&store, id, "test"), Err(SyncError::NoWorktree(_))));
    }
}
