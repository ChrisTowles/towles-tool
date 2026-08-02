//! Lets one trip to GitHub serve every open copy of the app. Each worktree runs its
//! own app with its own collectors, so four windows asked GitHub the same questions
//! four times — and the rate limit counts against the token, not the window: ~1,920
//! points an hour out of 5,000. Whoever asks first writes the answer down; anyone
//! starting while it is still recent reads that instead. Hence a cache, not a lock:
//! we share the answers, not the job.
//!
//! **The unit is `(collector, repo)`, not one sweep**, because that's the unit the
//! answer is true of. Keying by the sweep needs two rules this doesn't: a sweep
//! where one repo failed can't be published (a reader replaces whole tables from
//! it, so a missing repo reads back as "nothing"), and a reader would have to prove
//! the sweep covered exactly the repos it tracks. Writes are temp-then-rename.

use std::fs;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

/// One repo's answer to one collector's question, and when it was fetched.
///
/// Rows only: a missing folder or a failed `gh` call happened to *this* window
/// and belongs in its own run message, not replayed at everyone else.
///
/// Generic over the row container so reader and writer are one type — a
/// borrowed twin could drift on a field name and read back as "nothing cached".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct CachedRepo<R> {
    /// Epoch ms, handed in by the caller — nothing here reads the clock.
    pub fetched_at_ms: i64,
    pub rows: R,
}

/// Is an answer fetched at `fetched_at_ms` still usable at `now_ms`?
///
/// A timestamp from the future counts as too old, not forever young: clocks do
/// move backwards, and trusting one would stop collection until it caught up.
pub(crate) fn is_fresh(fetched_at_ms: i64, now_ms: i64, ttl_ms: i64) -> bool {
    let age = now_ms.saturating_sub(fetched_at_ms);
    (0..ttl_ms).contains(&age)
}

/// `<dir>/<kind>/<owner>/<repo>.json` — where `repo`'s answer to `kind`'s
/// question lives.
///
/// A name that isn't exactly `owner/repo` gets no path at all rather than a
/// guessed one; it can't be shared, so it gets fetched.
fn repo_path(dir: &Path, kind: &str, repo: &str) -> Option<PathBuf> {
    let (owner, name) = repo.split_once('/')?;
    let plain = |s: &str| !s.is_empty() && s != "." && s != ".." && !s.contains(['/', '\\']);
    (plain(owner) && plain(name)).then(|| dir.join(kind).join(owner).join(format!("{name}.json")))
}

/// Read what another window left about `repo`, if it's there and recent enough.
///
/// Missing, unreadable, garbled, too old — all `None`, which the caller reads as
/// "go ask GitHub yourself". A broken file costs one extra `gh` call, never an
/// error the collectors have to report. Hands back the whole entry so the caller
/// can log how old the answers it reused were.
pub(crate) fn read_fresh<T: DeserializeOwned>(
    dir: &Path,
    kind: &str,
    repo: &str,
    now_ms: i64,
    ttl_ms: i64,
) -> Option<CachedRepo<Vec<T>>> {
    let raw = fs::read_to_string(repo_path(dir, kind, repo)?).ok()?;
    let cached: CachedRepo<Vec<T>> = serde_json::from_str(&raw).ok()?;
    is_fresh(cached.fetched_at_ms, now_ms, ttl_ms).then_some(cached)
}

/// Leave `rows` as the answer about `repo`, stamped `now_ms`, for the other
/// windows. If the write fails the next window just asks GitHub itself, so
/// there is nothing worth reporting.
pub(crate) fn write<T: Serialize>(dir: &Path, kind: &str, repo: &str, now_ms: i64, rows: &[T]) {
    let Some(path) = repo_path(dir, kind, repo) else {
        return;
    };
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let cached = CachedRepo { fetched_at_ms: now_ms, rows };
    let Ok(json) = serde_json::to_string(&cached) else {
        return;
    };
    // Temp-then-rename, so a reader mid-write gets the old answer or the new
    // one, never half of one.
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    if fs::write(&tmp, json).is_ok() && fs::rename(&tmp, &path).is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_within_the_ttl_and_stale_at_or_past_it() {
        assert!(is_fresh(1_000, 1_000, 500), "just written");
        assert!(is_fresh(1_000, 1_499, 500));
        assert!(!is_fresh(1_000, 1_500, 500), "exactly the ttl is already too old");
        assert!(!is_fresh(1_000, 9_999, 500));
    }

    #[test]
    fn a_future_stamp_is_stale_not_immortal() {
        assert!(!is_fresh(5_000, 1_000, 500));
    }

    #[test]
    fn a_zero_ttl_never_reuses() {
        assert!(!is_fresh(1_000, 1_000, 0));
    }

    #[test]
    fn round_trips_a_written_answer() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "prs", "o/a", 1_000, &[7_i64]);
        let got = read_fresh::<i64>(dir.path(), "prs", "o/a", 1_200, 500).expect("still fresh");
        assert_eq!(got.rows, vec![7]);
        assert_eq!(got.fetched_at_ms, 1_000, "the reader can tell how old this is");
    }

    #[test]
    fn reports_nothing_once_stale() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "prs", "o/a", 1_000, &[7_i64]);
        let got = read_fresh::<i64>(dir.path(), "prs", "o/a", 9_000, 500);
        assert!(got.is_none(), "an old answer must send the caller to GitHub");
    }

    #[test]
    fn kinds_do_not_share_an_entry() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "prs", "o/a", 1_000, &[7_i64]);
        let got = read_fresh::<i64>(dir.path(), "issues", "o/a", 1_100, 500);
        assert!(got.is_none(), "the issue collector must not read the PR answer");
    }

    #[test]
    fn repos_do_not_share_an_entry() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "prs", "o/a", 1_000, &[7_i64]);
        let got = read_fresh::<i64>(dir.path(), "prs", "o/b", 1_100, 500);
        assert!(got.is_none(), "one repo's answer says nothing about another's");
    }

    #[test]
    fn one_repo_going_stale_leaves_the_others_reusable() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "prs", "o/fresh", 1_000, &[1_i64]);
        write(dir.path(), "prs", "o/stale", 100, &[2_i64]);
        assert!(read_fresh::<i64>(dir.path(), "prs", "o/fresh", 1_100, 500).is_some());
        assert!(read_fresh::<i64>(dir.path(), "prs", "o/stale", 1_100, 500).is_none());
    }

    #[test]
    fn a_later_write_replaces_an_earlier_one() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "prs", "o/a", 1_000, &[1_i64]);
        write(dir.path(), "prs", "o/a", 2_000, &[2_i64]);
        let got = read_fresh::<i64>(dir.path(), "prs", "o/a", 2_100, 500).unwrap();
        assert_eq!(got.rows, vec![2], "newest write wins — same question, newer answer");
    }

    #[test]
    fn a_missing_file_is_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let got = read_fresh::<i64>(dir.path(), "prs", "o/a", 1_000, 500);
        assert!(got.is_none());
    }

    #[test]
    fn garbled_json_just_means_asking_github() {
        let dir = tempfile::tempdir().unwrap();
        let path = repo_path(dir.path(), "prs", "o/a").unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{ not json").unwrap();
        let got = read_fresh::<i64>(dir.path(), "prs", "o/a", 1_000, 500);
        assert!(got.is_none(), "a broken file must never surface as an error");
    }

    #[test]
    fn a_file_from_a_different_build_just_means_asking_github() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "prs", "o/a", 1_000, &["text"]);
        let got = read_fresh::<i64>(dir.path(), "prs", "o/a", 1_100, 500);
        assert!(got.is_none());
    }

    #[test]
    fn an_empty_result_is_kept_rather_than_asked_again() {
        // "No open PRs" is a real answer worth sharing.
        let dir = tempfile::tempdir().unwrap();
        let empty: [i64; 0] = [];
        write(dir.path(), "prs", "o/a", 1_000, &empty);
        let got = read_fresh::<i64>(dir.path(), "prs", "o/a", 1_100, 500).unwrap();
        assert!(got.rows.is_empty());
    }

    #[test]
    fn a_name_that_is_not_owner_slash_repo_is_never_a_path() {
        // An unusable name means that repo gets fetched instead of shared.
        let dir = Path::new("/cache");
        for bad in [
            "",
            "noslash",
            "o/",
            "/a",
            "../../etc/passwd",
            "o/..",
            "./a",
            "o/a/b",
        ] {
            assert!(repo_path(dir, "prs", bad).is_none(), "{bad:?} must not resolve to a path");
        }
        assert_eq!(
            repo_path(dir, "prs", "o/a").unwrap(),
            Path::new("/cache/prs/o/a.json"),
            "a normal name nests owner and repo under the collector"
        );
    }
}
