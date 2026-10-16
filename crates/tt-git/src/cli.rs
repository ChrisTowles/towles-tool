//! The `git` subprocess seam: the operations gitoxide can't do (network, worktree
//! writes), each a typed function so no other crate names the `git` program.

use std::path::Path;
use std::time::Duration;

use tt_exec::Result;

/// Bounded, so a stalled network op fails after the timeout instead of hanging.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

fn run(dir: &Path, args: &[&str], timeout: Duration) -> Result<tt_exec::Output> {
    let dir_s = dir.to_string_lossy();
    let mut full: Vec<&str> = vec!["-C", dir_s.as_ref()];
    full.extend_from_slice(args);
    tt_exec::run_with_timeout_env("git", &full, tt_exec::GIT_NON_INTERACTIVE_ENV, timeout)
}

/// `git fetch --quiet origin`, with `--prune` when `prune`.
pub fn fetch_origin(dir: &Path, prune: bool, timeout: Duration) -> Result<tt_exec::Output> {
    let args: &[&str] = if prune {
        &["fetch", "--prune", "--quiet", "origin"]
    } else {
        &["fetch", "--quiet", "origin"]
    };
    run(dir, args, timeout)
}

/// `git fetch --quiet origin <refspecs…>`.
pub fn fetch_refspecs(dir: &Path, refspecs: &[&str]) -> Result<tt_exec::Output> {
    let mut args = vec!["fetch", "--quiet", "origin"];
    args.extend_from_slice(refspecs);
    run(dir, &args, DEFAULT_TIMEOUT)
}

/// `git worktree add <path> <branch>` — an existing branch.
pub fn worktree_add(dir: &Path, path: &str, branch: &str) -> Result<tt_exec::Output> {
    run(dir, &["worktree", "add", path, branch], DEFAULT_TIMEOUT)
}

/// `git worktree add -b <branch> <path> <base>` — a new branch off `base`.
pub fn worktree_add_new_branch(
    dir: &Path,
    path: &str,
    branch: &str,
    base: &str,
) -> Result<tt_exec::Output> {
    run(dir, &["worktree", "add", "-b", branch, path, base], DEFAULT_TIMEOUT)
}

pub fn worktree_remove(
    dir: &Path,
    path: &str,
    force: bool,
    timeout: Duration,
) -> Result<tt_exec::Output> {
    let args: &[&str] = if force {
        &["worktree", "remove", "--force", path]
    } else {
        &["worktree", "remove", path]
    };
    run(dir, args, timeout)
}

pub fn worktree_prune(dir: &Path, timeout: Duration) -> Result<tt_exec::Output> {
    run(dir, &["worktree", "prune"], timeout)
}

/// `git branch --set-upstream-to <upstream> <branch>`.
pub fn set_upstream(dir: &Path, branch: &str, upstream: &str) -> Result<tt_exec::Output> {
    run(dir, &["branch", "--set-upstream-to", upstream, branch], DEFAULT_TIMEOUT)
}

/// `git merge --ff-only <upstream>` in `dir`'s checked-out branch.
pub fn merge_ff_only(dir: &Path, upstream: &str) -> Result<tt_exec::Output> {
    run(dir, &["merge", "--ff-only", upstream], DEFAULT_TIMEOUT)
}
