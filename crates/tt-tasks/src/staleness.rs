//! The "activity recency" axis for `tt task ls --stale`.
//!
//! Separate from [`crate::landed`]: a branch can be days-stale yet hold unlanded work
//! (what `--stale` surfaces), and a landed branch is finished, never stale.

const SECS_PER_DAY: i64 = 86_400;

pub const DEFAULT_STALE_DAYS: u64 = 7;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Staleness {
    /// Whole days since the branch's newest own commit. `None` when the branch
    /// has added no commits of its own (nothing to age — an empty task, or a
    /// checkout sitting on the base branch), which is never stale.
    pub age_days: Option<u64>,
    /// The branch's newest own commit is at or past the threshold **and** the
    /// branch has not landed.
    pub stale: bool,
}

/// Assess staleness from the branch's newest own-commit time (epoch seconds), or `None`
pub fn assess(
    last_commit_unix: Option<i64>,
    now_unix: i64,
    threshold_days: u64,
    landed: bool,
) -> Staleness {
    let age_days = last_commit_unix.map(|t| ((now_unix - t).max(0) / SECS_PER_DAY) as u64);
    let stale = !landed && age_days.is_some_and(|d| d >= threshold_days);
    Staleness { age_days, stale }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_000 * SECS_PER_DAY; // day 1000, midnight UTC.

    fn days_ago(n: i64) -> i64 {
        NOW - n * SECS_PER_DAY
    }

    #[test]
    fn no_commits_is_never_stale() {
        let s = assess(None, NOW, 7, false);
        assert_eq!(s.age_days, None);
        assert!(!s.stale);
    }

    #[test]
    fn recent_commit_is_not_stale() {
        let s = assess(Some(days_ago(3)), NOW, 7, false);
        assert_eq!(s.age_days, Some(3));
        assert!(!s.stale);
    }

    #[test]
    fn old_unlanded_commit_is_stale() {
        let s = assess(Some(days_ago(9)), NOW, 7, false);
        assert_eq!(s.age_days, Some(9));
        assert!(s.stale);
    }

    #[test]
    fn exactly_at_threshold_is_stale() {
        let s = assess(Some(days_ago(7)), NOW, 7, false);
        assert_eq!(s.age_days, Some(7));
        assert!(s.stale);
    }

    #[test]
    fn landed_is_never_stale_however_old() {
        let s = assess(Some(days_ago(90)), NOW, 7, true);
        assert_eq!(s.age_days, Some(90)); // age is still reported…
        assert!(!s.stale); // …but a finished branch is not stale.
    }

    #[test]
    fn a_commit_in_the_future_ages_to_zero() {
        let s = assess(Some(NOW + 5 * SECS_PER_DAY), NOW, 7, false);
        assert_eq!(s.age_days, Some(0));
        assert!(!s.stale);
    }

    #[test]
    fn age_floors_to_whole_days() {
        let almost_two = NOW - (2 * SECS_PER_DAY - 1);
        let s = assess(Some(almost_two), NOW, 1, false);
        assert_eq!(s.age_days, Some(1));
        assert!(s.stale);
    }
}
