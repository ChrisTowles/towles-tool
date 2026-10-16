//! Fixture helpers for other crates' tests, behind the `test-support` feature, so
//! no test outside tt-git spawns `git` itself.

use std::path::Path;
use std::time::Duration;

const IDENTITY: [&str; 6] = [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@test",
    "-c",
    "init.defaultBranch=main",
];

/// `git -C <dir> <args>` with a fixed identity, whatever its exit status. A CI
/// runner has no ambient identity, so a bare `commit` would otherwise fail.
pub fn git_output(dir: &Path, args: &[&str]) -> tt_exec::Output {
    let dir_s = dir.to_string_lossy();
    let mut full: Vec<&str> = vec!["-C", dir_s.as_ref()];
    full.extend_from_slice(&IDENTITY);
    full.extend_from_slice(args);
    tt_exec::run_with_timeout_env(
        "git",
        &full,
        tt_exec::GIT_NON_INTERACTIVE_ENV,
        Duration::from_secs(60),
    )
    .expect("git runs")
}

/// [`git_output`] that panics unless git succeeded; returns trimmed stdout.
pub fn git(dir: &Path, args: &[&str]) -> String {
    let out = git_output(dir, args);
    assert!(out.ok(), "git {args:?} failed: {}", out.stderr);
    out.stdout.trim().to_string()
}
