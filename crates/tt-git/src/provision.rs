//! Bringing a repository onto disk: a fresh `git init`, or a clone from GitHub.
//! Both shell out — clone for the user's credential helpers and SSH agent, init
//! for the first commit, which needs the user's identity the way `git` resolves it.
//!
//! A fresh repo gets an empty first commit on `main` because a repo without a
//! commit has no base to cut a task worktree from.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::repo::{GitError, Result};

const INIT_TIMEOUT: Duration = Duration::from_secs(30);
const CLONE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// A clone source as typed: `owner/repo`, a `github.com/owner/repo` path, or any
/// URL `git clone` takes. Returns `(url, default directory name)`.
pub fn parse_clone_source(raw: &str) -> Option<(String, String)> {
    let source = raw.trim().trim_end_matches('/');
    if source.is_empty() {
        return None;
    }
    let is_url = source.contains("://") || source.starts_with("git@");
    let url = if is_url {
        source.to_string()
    } else {
        let path = source.strip_prefix("github.com/").unwrap_or(source);
        let mut parts = path.split('/');
        let (Some(owner), Some(name), None) = (parts.next(), parts.next(), parts.next()) else {
            return None;
        };
        if !valid_component(owner) || !valid_component(name.trim_end_matches(".git")) {
            return None;
        }
        format!("https://github.com/{owner}/{}.git", name.trim_end_matches(".git"))
    };
    let name = url.rsplit(['/', ':']).next()?.trim_end_matches(".git").to_string();
    valid_component(&name).then_some((url, name))
}

/// A single directory name: no separators, no `.`/`..`, no leading dash.
pub fn valid_component(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.starts_with('-')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn target_dir(parent: &Path, name: &str) -> Result<PathBuf> {
    if !valid_component(name) {
        return Err(GitError::Write(format!("\"{name}\" isn't a usable directory name")));
    }
    if !parent.is_dir() {
        return Err(GitError::Write(format!("{} isn't a directory", parent.display())));
    }
    let dir = parent.join(name);
    if dir.exists() {
        return Err(GitError::Write(format!("{} already exists", dir.display())));
    }
    Ok(dir)
}

fn git(args: &[&str], timeout: Duration) -> Result<()> {
    let out = tt_exec::run_with_timeout_env("git", args, tt_exec::GIT_NON_INTERACTIVE_ENV, timeout)
        .map_err(|e| GitError::Write(e.to_string()))?;
    if out.ok() { Ok(()) } else { Err(GitError::Write(out.stderr.trim().to_string())) }
}

/// `git init -b main` in `parent/name` plus an empty first commit.
pub fn init_repo(parent: &Path, name: &str) -> Result<PathBuf> {
    let dir = target_dir(parent, name)?;
    let dir_s = dir.to_string_lossy();
    let result = git(&["init", "--quiet", "-b", "main", &dir_s], INIT_TIMEOUT).and_then(|()| {
        git(
            &[
                "-C",
                &dir_s,
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "Initial commit",
            ],
            INIT_TIMEOUT,
        )
    });
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&dir);
    }
    result.map(|()| dir)
}

/// `git clone <url> parent/name`. A failed clone leaves nothing behind (git
/// removes its own partial directory).
pub fn clone_repo(url: &str, parent: &Path, name: &str) -> Result<PathBuf> {
    let dir = target_dir(parent, name)?;
    git(&["clone", "--quiet", "--", url, &dir.to_string_lossy()], CLONE_TIMEOUT)?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_slash_repo_becomes_a_github_https_url() {
        assert_eq!(
            parse_clone_source(" ChrisTowles/towles-tool "),
            Some(("https://github.com/ChrisTowles/towles-tool.git".into(), "towles-tool".into()))
        );
        assert_eq!(
            parse_clone_source("github.com/a/b.git/"),
            Some(("https://github.com/a/b.git".into(), "b".into()))
        );
    }

    #[test]
    fn urls_pass_through_and_name_the_directory() {
        assert_eq!(
            parse_clone_source("git@github.com:a/b.git"),
            Some(("git@github.com:a/b.git".into(), "b".into()))
        );
        assert_eq!(
            parse_clone_source("https://github.com/a/b"),
            Some(("https://github.com/a/b".into(), "b".into()))
        );
    }

    #[test]
    fn rejects_what_isnt_a_repo() {
        for bad in ["", "towles-tool", "a/b/c", "../x", "a/-rf"] {
            assert_eq!(parse_clone_source(bad), None, "{bad}");
        }
    }

    #[test]
    fn init_refuses_an_existing_directory() {
        let parent = tempfile::TempDir::new().unwrap();
        std::fs::create_dir(parent.path().join("taken")).unwrap();
        assert!(init_repo(parent.path(), "taken").is_err());
        assert!(init_repo(parent.path(), "../escape").is_err());
    }

    #[test]
    fn clone_copies_a_local_repo() {
        let src = crate::repo::testrepo::TestRepo::new();
        let parent = tempfile::TempDir::new().unwrap();
        let dir = clone_repo(&src.path().to_string_lossy(), parent.path(), "copy").expect("clone");
        assert_eq!(
            crate::repo::Repo::open(&dir).expect("open").head_branch().as_deref(),
            Some("main")
        );
        assert!(clone_repo("/nonexistent/repo", parent.path(), "missing").is_err());
        assert!(!parent.path().join("missing").exists());
    }
}
