//! Lets one trip to GitHub serve every open copy of the app.
//!
//! # Why
//!
//! Each worktree runs its own app, with its own `tt.db` and its own PR and
//! issue collectors, so with four windows open we asked GitHub the same
//! questions four times. GitHub's rate limit counts against the token, not the
//! window: four windows spent about 1,920 points an hour out of 5,000.
//!
//! [`dedupe_repo_dirs`](crate::dedupe_repo_dirs) already stops one collector
//! from visiting the same repo twice. This stops the second collector from
//! asking at all.
//!
//! Whoever asks first writes the answer down. Anyone who starts while that
//! answer is still recent reads it instead of calling GitHub, and copies the
//! rows into their own `tt.db` as usual — so every window's Cockpit and Board
//! still fill up. That's also why this isn't a lock like `slack_socket` uses: a
//! Slack notification only needs to happen once, but each window needs its own
//! copy of the rows. We share the answers, not the job.
//!
//! # One file per repo, not per sweep
//!
//! The unit is `(collector, repo)`, because that's the unit the answer is true
//! of: "`owner/repo` has these open PRs" doesn't depend on who asked, or on
//! what else they happened to ask about in the same pass.
//!
//! Keying by the sweep instead takes two rules that keying by the repo doesn't
//! need at all. A sweep where one repo failed can't be shared, because the
//! reader replaces whole tables from it and a missing repo reads back as "that
//! repo has nothing" — clearing rows that were fine. And a reader has to check
//! the sweep covered exactly the repos it tracks, or a window that just added
//! one would clear the new repo's rows the same way. Per repo, neither question
//! comes up: a repo that failed has no file, which is the same thing to a
//! reader as never having been asked about, and a reader looks up the repos it
//! tracks and gets answers about those repos.
//!
//! It also shares more. Three of four repos already answered means one call,
//! not four — a window fetches exactly the repos nobody has covered for it
//! lately.
//!
//! And two windows publishing at once write different files, so neither can
//! lose the other's work. One shared document couldn't promise that without a
//! lock.
//!
//! # How stale is too stale
//!
//! An answer is good until it's older than the caller's own refresh interval,
//! so the machine makes one round of calls per interval however many windows
//! are open. Find an old one and you go ask GitHub yourself — there's no lock
//! and nobody's in charge. Two windows can both end up asking in the gap
//! between an answer expiring and the first new one landing. That's an
//! occasional extra call instead of the permanent 4× it replaces, and it beats
//! a lock that could stop collection entirely if whoever held it died.
//!
//! Writes go to a temp file and then get renamed, so nobody reads half a file,
//! and the newest write wins — everyone is writing the answer to the same
//! question anyway.

use std::fs;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

/// One repo's answer to one collector's question, and when it was fetched.
///
/// Rows only — a repo folder that's missing, or a `gh` call that failed, is
/// something that happened to *this* window, and belongs in this window's own
/// run message rather than being replayed at everyone else. There is nowhere in
/// here to say a repo failed, and nothing needs one: a repo that failed simply
/// has no file.
///
/// Generic over the row container so the reader and the writer are one type:
/// [`read_fresh`] deserializes the owned form, [`write`] serializes a borrowed
/// slice and so publishes without cloning every row first. A separate borrowed
/// twin would let the two halves' field names drift, and a rename on one side
/// reads back as "nothing cached" — a silent return to asking GitHub, never an
/// error anyone would see.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct CachedRepo<R> {
    /// Epoch ms, handed in by the caller. Nothing in here reads the clock, so
    /// the age check is easy to test.
    pub fetched_at_ms: i64,
    /// The rows, exactly as the collector produced them.
    pub rows: R,
}

/// Is an answer fetched at `fetched_at_ms` still usable at `now_ms`?
///
/// A timestamp from the future counts as too old, not forever young. Clocks do
/// move backwards — an NTP correction, a resumed VM — and if we trusted one,
/// collection would quietly stop until the clock caught up.
pub(crate) fn is_fresh(fetched_at_ms: i64, now_ms: i64, ttl_ms: i64) -> bool {
    let age = now_ms.saturating_sub(fetched_at_ms);
    (0..ttl_ms).contains(&age)
}

/// `<dir>/<kind>/<owner>/<repo>.json` — where `repo`'s answer to `kind`'s
/// question lives.
///
/// `owner` and `repo` are each one path segment: GitHub allows only
/// alphanumerics, `-`, `_` and `.` in them, so neither can hold a separator or
/// climb out of `dir`. A name that isn't exactly `owner/repo` gets no path at
/// all rather than a guessed one — it can't be shared, so it gets fetched.
fn repo_path(dir: &Path, kind: &str, repo: &str) -> Option<PathBuf> {
    let (owner, name) = repo.split_once('/')?;
    let plain = |s: &str| !s.is_empty() && s != "." && s != ".." && !s.contains(['/', '\\']);
    (plain(owner) && plain(name)).then(|| dir.join(kind).join(owner).join(format!("{name}.json")))
}

/// Read what another window left about `repo`, if it's there and recent enough.
///
/// Missing, unreadable, garbled, too old — all of it comes back as `None`,
/// which the caller reads as "go ask GitHub about this one yourself". A broken
/// file should cost one extra `gh` call, never an error the collectors have to
/// report.
///
/// Hands back the whole entry rather than just the rows so the caller can log
/// how old the answers it reused were.
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
/// windows.
///
/// If the write fails, the next window just asks GitHub itself — what it did
/// before any of this existed. Nothing worth reporting.
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
    // A borrowed row slice, so publishing doesn't clone every row first.
    let cached = CachedRepo { fetched_at_ms: now_ms, rows };
    let Ok(json) = serde_json::to_string(&cached) else {
        return;
    };
    // Write a temp file beside the real one and rename it over the top, so
    // anyone reading mid-write gets the old answer or the new one, never half of
    // one. A temp file left behind by a killed process is harmless — readers
    // only ever open `<repo>.json`.
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
        // Clocks move backwards. Trusting a future timestamp would stop
        // collection until the clock caught up to it.
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
        // The point of keying by repo rather than by sweep: a window reuses the
        // repos that are still fresh and asks about only the one that isn't,
        // instead of the whole set expiring together.
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
        // A later build changing the row shape must not jam an older one.
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "prs", "o/a", 1_000, &["text"]);
        let got = read_fresh::<i64>(dir.path(), "prs", "o/a", 1_100, 500);
        assert!(got.is_none());
    }

    #[test]
    fn an_empty_result_is_kept_rather_than_asked_again() {
        // "This repo has no open PRs" is a real answer worth sharing. Asking
        // again every tick is exactly the cost this file exists to remove.
        let dir = tempfile::tempdir().unwrap();
        let empty: [i64; 0] = [];
        write(dir.path(), "prs", "o/a", 1_000, &empty);
        let got = read_fresh::<i64>(dir.path(), "prs", "o/a", 1_100, 500).unwrap();
        assert!(got.rows.is_empty());
    }

    #[test]
    fn a_name_that_is_not_owner_slash_repo_is_never_a_path() {
        // Nothing here builds a path it can't vouch for. An unusable name just
        // means that repo gets fetched instead of shared.
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
