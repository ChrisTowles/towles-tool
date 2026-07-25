//! A real git repository on disk, for testing the gitoxide layer.
//!
//! The whole point of these tests is that gitoxide agrees with `git` about a
//! real repository, so the *fixtures* are built by `git` itself — using gix to
//! construct the state it is being tested against would prove only that it
//! agrees with itself.

use std::path::{Path, PathBuf};
use std::process::Command;

pub struct TestRepo {
    dir: tempfile::TempDir,
}

impl TestRepo {
    /// A repository on `main` with one commit and a `main`-tracking
    /// `refs/remotes/origin/main`, the shape every checkout in this workspace
    /// has.
    pub fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = Self { dir };
        repo.git(&["init", "--quiet", "-b", "main"]);
        repo.git(&["config", "user.email", "test@example.com"]);
        repo.git(&["config", "user.name", "Test"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        repo.commit_file("README.md", "hello\n");
        repo.git(&["update-ref", "refs/remotes/origin/main", "main"]);
        repo
    }

    pub fn path(&self) -> &Path {
        self.dir.path()
    }

    /// Run `git` in the repo, asserting success. Panics on failure — a broken
    /// fixture must fail loudly rather than produce a mysterious assertion.
    pub fn git(&self, args: &[&str]) -> String {
        self.git_in(self.path(), args)
    }

    pub fn git_in(&self, dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", self.path())
            .output()
            .expect("git runs");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// Write `path` and commit it, returning the new commit's sha.
    pub fn commit_file(&self, path: &str, contents: &str) -> String {
        self.write(path, contents);
        self.git(&["add", "-A"]);
        self.git(&["commit", "--quiet", "-m", &format!("add {path}")]);
        self.rev_parse("HEAD")
    }

    /// Write a file without committing it.
    pub fn write(&self, path: &str, contents: &str) {
        let full = self.path().join(path);
        if let Some(parent) = full.parent() {
            std::fs::create_dir_all(parent).expect("mkdir");
        }
        std::fs::write(full, contents).expect("write");
    }

    pub fn rev_parse(&self, spec: &str) -> String {
        self.git(&["rev-parse", spec])
    }

    /// Add a linked worktree at `<repo>/../<name>` on a new branch.
    pub fn add_worktree(&self, name: &str, branch: &str) -> PathBuf {
        let dir = self.path().join(name);
        let dir_s = dir.to_string_lossy().into_owned();
        self.git(&["worktree", "add", "-b", branch, &dir_s, "main"]);
        dir
    }
}
