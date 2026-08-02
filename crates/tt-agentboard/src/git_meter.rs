//! A bounded record of how much git work the pollers are actually doing.
//!
//! Git reads moved in-process (gitoxide), which took them out of the
//! `process.spawn` span — the one thing that used to make a runaway recompute
//! loop visible, and did: a cache-stamping bug once ran ~20 git spawns/sec
//! around the clock, and it was caught because every one of those spawns was a
//! logged subprocess. Nothing spawns now, so that same bug would be silent.
//!
//! This is the replacement, at a cost the old shape never had. One rolled-up
//! record per window rather than one per read: an idle window writes nothing at
//! all, and a runaway loop reads as a count in the thousands where a healthy one
//! reads in the tens.

/// How long a window collects before it can be taken.
const WINDOW_MS: i64 = 60_000;

/// One closed window's worth of recompute cost.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitWork {
    pub count: u32,
    pub total_ms: i64,
    /// The slowest single recompute, and where. A mean hides the one repo that
    /// is pathological, and a duration with no dir on it can't be acted on —
    /// the first real window measured 1.65s of its 1.81s in a single checkout.
    pub slowest_ms: i64,
    pub slowest_dir: String,
    /// How long the window actually ran, which is ≥ [`WINDOW_MS`] rather than
    /// equal to it: it closes on the next poll tick, not on a timer of its own.
    pub window_ms: i64,
}

/// Accumulates recompute cost between rollups. Clock-free — callers pass both
/// the measured duration and the current time, like everything else here.
#[derive(Debug)]
pub struct GitWorkMeter {
    count: u32,
    total_ms: i64,
    slowest_ms: i64,
    slowest_dir: String,
    window_started_ms: i64,
}

impl GitWorkMeter {
    pub fn new(now_ms: i64) -> Self {
        Self {
            count: 0,
            total_ms: 0,
            slowest_ms: 0,
            slowest_dir: String::new(),
            window_started_ms: now_ms,
        }
    }

    pub fn record(&mut self, dir: &str, duration_ms: i64) {
        self.count += 1;
        self.total_ms += duration_ms;
        if duration_ms > self.slowest_ms {
            self.slowest_ms = duration_ms;
            self.slowest_dir = dir.to_string();
        }
    }

    /// The finished window, once [`WINDOW_MS`] has elapsed and there was work in
    /// it; `None` while it is still open. An *empty* elapsed window rolls
    /// forward and reports nothing — an idle app writing a heartbeat every
    /// minute is exactly the log noise this exists to avoid, and it would also
    /// make the next single recompute look like a whole window's worth.
    pub fn take_due(&mut self, now_ms: i64) -> Option<GitWork> {
        let window_ms = now_ms - self.window_started_ms;
        if window_ms < WINDOW_MS {
            return None;
        }
        let work = (self.count > 0).then(|| GitWork {
            count: self.count,
            total_ms: self.total_ms,
            slowest_ms: self.slowest_ms,
            slowest_dir: std::mem::take(&mut self.slowest_dir),
            window_ms,
        });
        *self = Self::new(now_ms);
        work
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_700_000_000_000;

    #[test]
    fn collects_until_the_window_closes() {
        let mut m = GitWorkMeter::new(T0);
        m.record("/repo/quick", 12);
        m.record("/repo/slow", 30);
        assert_eq!(m.take_due(T0 + WINDOW_MS - 1), None, "window still open");

        let work = m.take_due(T0 + WINDOW_MS).expect("closed with work in it");
        assert_eq!(work.count, 2);
        assert_eq!(work.total_ms, 42);
        assert_eq!(work.slowest_ms, 30, "the worst repo, not the mean");
        assert_eq!(work.slowest_dir, "/repo/slow", "…and which one it was");
        assert_eq!(work.window_ms, WINDOW_MS);
    }

    #[test]
    fn taking_resets_so_windows_never_double_count() {
        let mut m = GitWorkMeter::new(T0);
        m.record("/repo/a", 5);
        assert!(m.take_due(T0 + WINDOW_MS).is_some());

        m.record("/repo/b", 7);
        assert_eq!(m.take_due(T0 + WINDOW_MS + 1), None, "the new window just opened");
        let work = m.take_due(T0 + WINDOW_MS * 2).expect("second window");
        assert_eq!(work.count, 1);
        assert_eq!(work.total_ms, 7);
        assert_eq!(work.slowest_dir, "/repo/b", "the previous window's worst didn't carry over");
    }

    /// An app nobody is using must not write a record a minute forever.
    #[test]
    fn an_idle_window_reports_nothing_but_still_rolls_forward() {
        let mut m = GitWorkMeter::new(T0);
        assert_eq!(m.take_due(T0 + WINDOW_MS), None);

        // Had the empty window not rolled forward, this single recompute would
        // close immediately and read as a full window's work.
        m.record("/repo/a", 9);
        assert_eq!(m.take_due(T0 + WINDOW_MS + 1), None);
        assert_eq!(m.take_due(T0 + WINDOW_MS * 2).map(|w| w.count), Some(1));
    }

    /// The shape the whole module exists to make visible.
    #[test]
    fn a_runaway_loop_reads_as_a_count_a_healthy_one_never_reaches() {
        let mut healthy = GitWorkMeter::new(T0);
        for _ in 0..15 {
            healthy.record("/repo/a", 4);
        }
        let mut runaway = GitWorkMeter::new(T0);
        for _ in 0..1_200 {
            runaway.record("/repo/a", 4);
        }
        let healthy = healthy.take_due(T0 + WINDOW_MS).unwrap();
        let runaway = runaway.take_due(T0 + WINDOW_MS).unwrap();
        assert!(runaway.count > healthy.count * 10, "{runaway:?} vs {healthy:?}");
    }
}
