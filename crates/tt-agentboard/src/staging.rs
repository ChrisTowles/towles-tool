//! Staging mutations for the diff pane, as `Result<(), String>`: unlike the git
//! *reads* around them, which degrade to empty defaults, a failed stage must
//! reach the user's screen as the message it failed with.

use std::path::Path;

/// `git add <path>` — stage the file as it is on disk (or its deletion).
pub fn stage_file(dir: &str, path: &str) -> Result<(), String> {
    repo(dir)?.stage_path(path).map_err(|e| e.to_string())
}

/// `git reset -- <path>` — put the index entry back to HEAD's version.
pub fn unstage_file(dir: &str, path: &str) -> Result<(), String> {
    repo(dir)?.unstage_path(path).map_err(|e| e.to_string())
}

/// Stage `content` as the full index version of `path` — how a hunk is staged
/// or unstaged: the client synthesizes the resulting file and hands it over.
/// `expected_index` is the stage-0 content the synthesis started from (`None` =
/// no entry); the write refuses if the index moved since (see
/// [`tt_git::repo::Repo::stage_buffer`]).
pub fn stage_file_buffer(
    dir: &str,
    path: &str,
    content: &str,
    expected_index: Option<&str>,
) -> Result<(), String> {
    repo(dir)?
        .stage_buffer(path, content.as_bytes(), expected_index.map(str::as_bytes))
        .map_err(|e| e.to_string())
}

fn repo(dir: &str) -> Result<tt_git::repo::Repo, String> {
    tt_git::repo::open(Path::new(dir)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_non_repo_directory_reports_the_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let err = stage_file(dir.path().to_str().unwrap(), "f.txt").expect_err("not a repo");
        assert!(err.contains("not a git repository"), "{err}");
    }
}
