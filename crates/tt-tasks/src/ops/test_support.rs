//! Fixtures shared by the `ops` sibling test files: real git repos. Port-ledger dirs are
//! injected per test (`ports_dir`), never resolved from the environment.

use std::fs;
use std::path::{Path, PathBuf};

use super::TaskRoot;

pub(super) fn git(dir: &Path, args: &[&str]) -> String {
    let dir = dir.to_str().unwrap();
    let mut full = vec!["-C", dir, "-c", "user.name=T", "-c", "user.email=t@t"];
    full.extend_from_slice(args);
    let out = tt_exec::run("git", &full).unwrap();
    assert!(out.ok(), "git {full:?} failed: {}", out.stderr);
    out.stdout.trim().to_string()
}

/// A clone of a bare `origin` with one commit on `main`; `.env` is git-ignored so a
/// rendered task `.env` doesn't count as a dirty tree.
pub(super) fn repo_with_origin() -> (tempfile::TempDir, TaskRoot) {
    let tmp = tempfile::tempdir().unwrap();
    let seed = tmp.path().join("seed");
    fs::create_dir_all(&seed).unwrap();
    git(&seed, &["init", "-q", "-b", "main"]);
    git(&seed, &["commit", "-q", "--allow-empty", "-m", "base"]);
    git(tmp.path(), &["clone", "-q", "--bare", "seed", "origin.git"]);
    git(tmp.path(), &["clone", "-q", "origin.git", "repo"]);
    let checkout = tmp.path().join("repo");
    fs::write(checkout.join(".git/info/exclude"), ".env\n").unwrap();
    let sr = TaskRoot { checkout, repo: "repo".to_string() };
    (tmp, sr)
}

/// Add a worktree task on a new branch cut from `main`, returning its directory.
pub(super) fn add_task(sr: &TaskRoot, name: &str, branch: &str) -> PathBuf {
    let dir = sr.task_dir(name);
    git(
        &sr.checkout,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            branch,
            dir.to_str().unwrap(),
            "main",
        ],
    );
    dir
}
