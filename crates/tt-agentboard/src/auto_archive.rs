//! Which repos have gone quiet long enough to archive on their own
//! (`agentboard.autoArchiveAfterHours`). Pure over a stamped payload: the host
//! decides when to ask, the engine does the archiving.
//!
//! Restoring a repo stamps its root checkout as worked in (see
//! `Engine::set_repo_archived`), so a restore buys a full window before it can go again.

use crate::rail_sort::repo_activity_ms;
use crate::types::RepoData;

pub const HOUR_MS: i64 = 3_600_000;

/// Repo dirs idle for at least `after_ms`. `~` needs no check: archiving refuses
/// an untracked dir, and the home row exists only while `~` is untracked.
/// Anything the rail can't vouch for is kept: a checkout git hasn't been read for yet has no activity time to judge,
/// and a repo with a live shell, something waiting on you, or a worktree being
/// made or removed is in use whatever its timestamps say.
pub fn auto_archive_candidates(repos: &[RepoData], after_ms: i64, now: i64) -> Vec<String> {
    repos
        .iter()
        .filter(|r| !r.archived && r.needs == 0)
        .filter(|r| {
            r.folders.iter().all(|f| {
                f.phase.is_none()
                    && (f.computed_at_ms > 0 || f.dir_missing)
                    && f.sessions.iter().all(|s| !s.live)
            })
        })
        .filter(|r| now - repo_activity_ms(r) >= after_ms)
        .map(|r| r.dir.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{FolderData, RowPhase, RowRecord, SessionData};

    const NOW: i64 = 1_000 * HOUR_MS;
    const DAY: i64 = 24 * HOUR_MS;

    fn folder(worked_at_ms: i64) -> FolderData {
        FolderData {
            dir: "/r".into(),
            record: RowRecord::Checkout,
            worked_at_ms,
            computed_at_ms: 1,
            ..Default::default()
        }
    }

    fn repo(dir: &str, folders: Vec<FolderData>) -> RepoData {
        RepoData {
            key: format!("path:{dir}"),
            dir: dir.into(),
            name: dir.into(),
            origin_url: None,
            folders,
            needs: 0,
            meta: None,
            color: Default::default(),
            archived: false,
        }
    }

    #[test]
    fn archives_only_what_has_been_idle_for_the_whole_window() {
        let repos = [
            repo("/stale", vec![folder(NOW - 8 * DAY)]),
            repo("/fresh", vec![folder(NOW - DAY)]),
        ];
        assert_eq!(auto_archive_candidates(&repos, 7 * DAY, NOW), ["/stale"]);
    }

    #[test]
    fn one_busy_task_keeps_the_whole_repo() {
        let repos = [repo(
            "/r",
            vec![folder(NOW - 30 * DAY), folder(NOW - HOUR_MS)],
        )];
        assert!(auto_archive_candidates(&repos, 7 * DAY, NOW).is_empty());
    }

    #[test]
    fn anything_in_use_is_kept_however_old() {
        let old = NOW - 30 * DAY;
        let mut live = folder(old);
        live.sessions = vec![SessionData { live: true, ..Default::default() }];
        let mut creating = folder(old);
        creating.phase = Some(RowPhase::Creating { label: "x".into() });
        let mut waiting = repo("/waiting", vec![folder(old)]);
        waiting.needs = 1;
        let mut archived = repo("/archived", vec![folder(old)]);
        archived.archived = true;

        let repos = [
            repo("/live", vec![live]),
            repo("/creating", vec![creating]),
            waiting,
            archived,
        ];
        assert!(auto_archive_candidates(&repos, DAY, NOW).is_empty());
    }

    #[test]
    fn a_checkout_git_has_not_read_yet_is_not_judged() {
        // Before the first git pass `worked_at_ms` is 0, which would read as
        // "idle since 1970" and archive every repo on launch.
        let mut unread = folder(0);
        unread.computed_at_ms = 0;
        assert!(auto_archive_candidates(&[repo("/r", vec![unread])], DAY, NOW).is_empty());

        let mut gone = folder(0);
        gone.computed_at_ms = 0;
        gone.dir_missing = true;
        assert_eq!(auto_archive_candidates(&[repo("/r", vec![gone])], DAY, NOW), ["/r"]);
    }
}
