//! Fixtures for other crates' tests: real repositories built by the `git` binary itself,
//! so what they read back was never produced by the code under test.

use std::path::Path;

/// Run `git <args>` in `dir` with a fixed identity, asserting success; returns trimmed stdout.
pub fn git(dir: &Path, args: &[&str]) -> String {
    let dir = dir.to_str().unwrap();
    let mut full = vec!["-C", dir, "-c", "user.name=T", "-c", "user.email=t@t"];
    full.extend_from_slice(args);
    let out = tt_exec::run("git", &full).unwrap();
    assert!(out.ok(), "git {full:?} failed: {}", out.stderr);
    out.stdout.trim().to_string()
}
