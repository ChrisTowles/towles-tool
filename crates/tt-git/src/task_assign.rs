//! Guard logic for assigning an open issue to a worktree-task checkout (the
//! app's issue→task flow). The whole point of the feature is the guard — an
//! issue must never land in a task that is holding someone's in-progress
//! work, so the checks hard-fail with no `--force` escape hatch.
//!
//! Pure functions only: the caller reads the target task's repository (its
//! origin URL, changed-path count, stash count — see `tt_git::repo`) and hands
//! the facts here for the decision.

use thiserror::Error;

/// Why an issue may NOT be assigned into the target task.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum TaskBlocked {
    #[error(
        "task remote does not match this repo's remote\n  this repo: {expected}\n  task:      {found}"
    )]
    RemoteMismatch { expected: String, found: String },

    #[error("task working tree is not clean ({entries} changed/untracked path(s))")]
    DirtyTree { entries: usize },

    #[error("task has {count} stash entr{} — pop or drop them first", if *count == 1 { "y" } else { "ies" })]
    StashNotEmpty { count: usize },
}

/// Structural half of [`normalize_remote_url`], keeping the URL's own casing:
/// scheme/credentials stripped, trailing `.git` and `/` dropped, scp-like
/// `git@host:path` folded to `host/path`.
///
/// Case matters here because two different jobs read this. *Comparing* two
/// remotes wants case folded away (`normalize_remote_url`); recording a repo's
/// **identity** wants GitHub's own casing preserved, because that identity is
/// stored alongside slugs that came from `gh` (issues, PRs, task bindings) and
/// a folded copy would silently become a second, separate repo.
///
/// The prefix/suffix probes run against an `to_ascii_lowercase` copy — ASCII
/// folding is length-preserving, so its byte offsets index the original safely.
fn normalize_remote_url_preserving_case(url: &str) -> String {
    let mut s = url.trim().to_string();
    let lower = s.to_ascii_lowercase();
    // scp-like syntax: git@host:path → host/path
    if let Some(rest) = lower.strip_prefix("git@") {
        s = s[s.len() - rest.len()..].replacen(':', "/", 1);
    } else {
        // scheme://[user@]host/path → host/path
        if let Some(idx) = lower.find("://") {
            s = s[idx + 3..].to_string();
        }
        if let Some(idx) = s.find('@') {
            s = s[idx + 1..].to_string();
        }
    }
    let s = s.trim_end_matches('/');
    if s.to_ascii_lowercase().ends_with(".git") {
        s[..s.len() - 4].to_string()
    } else {
        s.to_string()
    }
}

/// Normalize a git remote URL for equality: `git@github.com:User/Repo.git`,
/// `https://github.com/user/repo/`, and `ssh://git@github.com/User/repo` all
/// name the same repo. Lowercased, scheme/credentials stripped, trailing
/// `.git` and `/` dropped.
fn normalize_remote_url(url: &str) -> String {
    normalize_remote_url_preserving_case(url).to_lowercase()
}

/// The trailing `owner/name` pair of an already-normalized remote
/// (`github.com/owner/name` → `owner/name`). `None` when fewer than two path
/// segments remain, e.g. a bare host or a local path.
fn slug_from_normalized(normalized: &str) -> Option<String> {
    let parts: Vec<&str> = normalized.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() < 2 {
        return None;
    }
    Some(format!("{}/{}", parts[parts.len() - 2], parts[parts.len() - 1]))
}

/// Extract the GitHub `owner/name` slug from a git remote URL. Reuses
/// [`normalize_remote_url`] to fold the ssh/https/scp forms, then keeps the last
/// two path segments (`github.com/owner/name` → `owner/name`), lowercased.
/// `None` when the URL lacks two path segments (e.g. a bare host or a local
/// path), so the caller can treat it as "not a GitHub checkout". Public: also
/// used by the Agentboard poll loop to reconcile `tt-store`'s tracked-repo
/// identity cache from each repo's git origin.
pub fn repo_slug_from_remote(url: &str) -> Option<String> {
    slug_from_normalized(&normalize_remote_url(url))
}

/// Extract the GitHub `owner/name` slug from a git remote URL, **keeping the
/// remote's own casing** — `ChrisTowles/towles-tool`, not
/// `christowles/towles-tool`.
///
/// This is the variant to use when recording a repo's *identity* (the
/// tracked-repo cache the app's `task_create` validates against). Every other
/// identity in the store — issue rows, PR rows, a task's repo binding — carries
/// the casing `gh` reports, and the Board groups its swimlanes by that string.
/// Folding case here therefore doesn't just look wrong: it mints a second repo
/// identity that splits one repo's cards across two identical-looking lanes.
/// Use [`repo_slug_from_remote`] instead when *comparing* two remotes, where
/// case must not matter.
pub fn repo_slug_from_remote_preserving_case(url: &str) -> Option<String> {
    slug_from_normalized(&normalize_remote_url_preserving_case(url))
}

/// The in-progress-work half of the guard, shared by both entry points: reject
/// a dirty working tree first, then a non-empty stash. Order matters — the
/// failures surface most-to-least obvious.
fn check_clean(dirty_entries: usize, stashes: usize) -> Result<(), TaskBlocked> {
    if dirty_entries > 0 {
        return Err(TaskBlocked::DirtyTree { entries: dirty_entries });
    }
    if stashes > 0 {
        return Err(TaskBlocked::StashNotEmpty { count: stashes });
    }
    Ok(())
}

/// The assignment guard, keyed by a GitHub `owner/name` slug: the desktop
/// app's "expected" repo comes from an issue's `repo` field (`owner/name`),
/// not a current-directory checkout. Failure order: wrong repo first (the
/// assignment makes no sense at all), then in-progress work (uncommitted
/// changes, then stashes).
pub fn validate_task_for_repo(
    expected_repo: &str,
    task_remote: &str,
    dirty_entries: usize,
    stashes: usize,
) -> Result<(), TaskBlocked> {
    let expected = expected_repo.trim().to_lowercase();
    let found = repo_slug_from_remote(task_remote).unwrap_or_default();
    if expected != found {
        return Err(TaskBlocked::RemoteMismatch { expected, found });
    }
    check_clean(dirty_entries, stashes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_equates_ssh_https_and_scp_forms() {
        let forms = [
            "git@github.com:ChrisTowles/towles-tool.git",
            "https://github.com/ChrisTowles/towles-tool.git",
            "https://github.com/christowles/towles-tool",
            "https://github.com/ChrisTowles/towles-tool/",
            "ssh://git@github.com/ChrisTowles/towles-tool",
            "  git@github.com:ChrisTowles/towles-tool.git\n",
        ];
        for form in forms {
            assert_eq!(
                normalize_remote_url(form),
                "github.com/christowles/towles-tool",
                "failed for {form}"
            );
        }
    }

    #[test]
    fn normalize_keeps_distinct_repos_distinct() {
        assert_ne!(
            normalize_remote_url("git@github.com:a/repo.git"),
            normalize_remote_url("git@github.com:b/repo.git")
        );
        assert_ne!(
            normalize_remote_url("https://github.com/a/repo"),
            normalize_remote_url("https://gitlab.com/a/repo")
        );
    }

    /// The identity variant must hand back GitHub's own casing. Folding it is
    /// what minted a second `christowles/...` repo identity alongside the
    /// `gh`-reported `ChrisTowles/...` one and split the Board into two
    /// identically-labelled swimlanes.
    #[test]
    fn preserving_case_slug_keeps_the_remotes_own_casing() {
        let forms = [
            "git@github.com:ChrisTowles/towles-tool.git",
            "https://github.com/ChrisTowles/towles-tool.git",
            "https://github.com/ChrisTowles/towles-tool/",
            "ssh://git@github.com/ChrisTowles/towles-tool",
            "  git@github.com:ChrisTowles/towles-tool.git\n",
        ];
        for form in forms {
            assert_eq!(
                repo_slug_from_remote_preserving_case(form).as_deref(),
                Some("ChrisTowles/towles-tool"),
                "failed for {form}"
            );
            // The comparison variant still folds, so remote equality is unchanged.
            assert_eq!(
                repo_slug_from_remote(form).as_deref(),
                Some("christowles/towles-tool"),
                "failed for {form}"
            );
        }
    }

    #[test]
    fn preserving_case_slug_rejects_non_repo_urls() {
        assert_eq!(repo_slug_from_remote_preserving_case("github.com"), None);
        assert_eq!(repo_slug_from_remote_preserving_case(""), None);
    }

    #[test]
    fn repo_slug_extracts_owner_name_from_every_form() {
        let forms = [
            "git@github.com:ChrisTowles/towles-tool.git",
            "https://github.com/ChrisTowles/towles-tool.git",
            "https://github.com/christowles/towles-tool",
            "ssh://git@github.com/ChrisTowles/towles-tool",
        ];
        for form in forms {
            assert_eq!(
                repo_slug_from_remote(form).as_deref(),
                Some("christowles/towles-tool"),
                "failed for {form}"
            );
        }
    }

    #[test]
    fn repo_slug_is_none_without_two_segments() {
        assert_eq!(repo_slug_from_remote("github.com"), None);
        assert_eq!(repo_slug_from_remote(""), None);
    }

    #[test]
    fn validate_for_repo_matches_issue_slug_against_task_remote() {
        assert_eq!(
            validate_task_for_repo(
                "ChrisTowles/towles-tool",
                "git@github.com:christowles/towles-tool.git",
                0,
                0,
            ),
            Ok(())
        );
    }

    #[test]
    fn validate_for_repo_rejects_a_different_repo() {
        let err = validate_task_for_repo(
            "ChrisTowles/towles-tool",
            "git@github.com:someone/other-repo.git",
            0,
            0,
        )
        .unwrap_err();
        assert!(matches!(err, TaskBlocked::RemoteMismatch { .. }));
    }

    #[test]
    fn validate_for_repo_rejects_wrong_repo_before_dirty_checks() {
        // Repo mismatch wins over a dirty tree — the assignment is
        // nonsensical, not merely unsafe.
        let err = validate_task_for_repo("u/repo", "git@github.com:other/elsewhere.git", 1, 0)
            .unwrap_err();
        assert!(matches!(err, TaskBlocked::RemoteMismatch { .. }));
    }

    #[test]
    fn validate_for_repo_rejects_dirty_and_stashed_matching_tasks() {
        let dirty =
            validate_task_for_repo("u/repo", "https://github.com/u/repo.git", 2, 0).unwrap_err();
        assert_eq!(dirty, TaskBlocked::DirtyTree { entries: 2 });

        let stashed =
            validate_task_for_repo("u/repo", "https://github.com/u/repo.git", 0, 1).unwrap_err();
        assert_eq!(stashed, TaskBlocked::StashNotEmpty { count: 1 });
        // Error text is user-facing; keep the singular/plural readable.
        assert!(stashed.to_string().contains("1 stash entry"));
    }
}
