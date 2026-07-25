//! Tauri commands backing the Cockpit issue-queue actions (assign an issue to a
//! sibling task checkout, or create a local branch for it). Thin wrappers over
//! the Tauri-free guard + slugging in `tt_git::task_assign` /
//! `tt_git::branch_name`: this layer only gathers the target task's git state
//! (`remote`, `status`, `stash`) and shells out; every *decision* lives in the
//! pure crate so it stays unit-tested. Mirrors the CLI's `tt gh assign`
//! (`crates-cli/tt-cli/src/commands/gh.rs`), but matches the task against the
//! issue's `owner/name` slug rather than a current-directory checkout — the app
//! has no single cwd repo, the issue names its own.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tt_git::branch_name::create_branch_name_from_issue;
use tt_git::task_assign::validate_task_for_repo;

/// Timeout for `gh issue develop` (talks to the network, then fetches).
const GH_DEVELOP_TIMEOUT: Duration = Duration::from_secs(120);

/// Gather the task's remote/status/stash and run the clean-tree + matching-repo
/// guard. Returns `Ok(())` only when `task_dir` is a clean checkout of the same
/// GitHub repo (`owner/name`) the issue belongs to. Hard-fails with no `--force`
/// escape hatch — the whole point is that a dispatch can never trample a task
/// holding in-progress work.
///
/// A repository that cannot be read fails the guard rather than passing it:
/// "we could not tell" and "it is clean" must never be the same answer here.
fn guard_task(repo: &str, task_dir: &Path) -> Result<(), String> {
    let git = tt_git::repo::open(task_dir)
        .map_err(|e| format!("{} is not a usable git checkout: {e}", task_dir.display()))?;
    let task_remote = git.origin_url().unwrap_or_default();
    let status = git
        .status()
        .map_err(|e| format!("cannot read {}'s working tree: {e}", task_dir.display()))?;
    validate_task_for_repo(repo, &task_remote, status.len(), git.stash_count())
        .map_err(|blocked| format!("Refusing to use {}: {blocked}", task_dir.display()))
}

/// `cockpit_assign_issue`: dispatch issue `#number` of `repo` (`owner/name`)
/// into the task checkout at `task_dir` via `gh issue develop --checkout`, but
/// only after the clean-tree guard passes. Async so the network round-trip runs
/// off the main thread (matches the store's `gh` commands).
#[tauri::command]
pub async fn cockpit_assign_issue(
    repo: String,
    number: u64,
    task_dir: String,
) -> Result<String, String> {
    let dir = PathBuf::from(&task_dir);
    tauri::async_runtime::spawn_blocking(move || {
        guard_task(&repo, &dir)?;
        let issue_arg = number.to_string();
        match tt_exec::run_in_dir_with_timeout(
            "gh",
            &["issue", "develop", &issue_arg, "--checkout"],
            &dir,
            GH_DEVELOP_TIMEOUT,
        ) {
            Ok(out) if out.ok() => {
                tracing::info!(%repo, number, dir = %dir.display(), "cockpit.issue_assigned");
                Ok(format!("Issue #{number} checked out in {}", dir.display()))
            }
            Ok(out) => Err(format!("gh issue develop failed: {}", out.stderr.trim())),
            Err(e) => Err(format!("failed to run gh in {}: {e}", dir.display())),
        }
    })
    .await
    .map_err(|e| format!("assign task failed: {e}"))?
}

/// `cockpit_create_issue_branch`: create a local `feature/<number>-<slug>`
/// branch (from the issue title) in the task checkout at `task_dir`, after the
/// same clean-tree guard. Purely local — no `gh` or network — for starting work
/// without the issue-develop linkage.
///
/// The guard running first is what makes the branch switch two ref writes
/// rather than a working-tree checkout; see
/// [`tt_git::repo::Repo::create_branch_at_head`].
#[tauri::command]
pub async fn cockpit_create_issue_branch(
    repo: String,
    number: u64,
    title: String,
    task_dir: String,
) -> Result<String, String> {
    let dir = PathBuf::from(&task_dir);
    tauri::async_runtime::spawn_blocking(move || {
        guard_task(&repo, &dir)?;
        let branch = create_branch_name_from_issue(number, &title);
        let git =
            tt_git::repo::open(&dir).map_err(|e| format!("cannot open {}: {e}", dir.display()))?;
        match git.create_branch_at_head(&branch) {
            Ok(()) => {
                tracing::info!(%repo, number, %branch, "cockpit.issue_branch_created");
                Ok(format!("Created branch {branch} in {}", dir.display()))
            }
            Err(e) => Err(format!("could not create branch {branch}: {e}")),
        }
    })
    .await
    .map_err(|e| format!("create-branch task failed: {e}"))?
}
