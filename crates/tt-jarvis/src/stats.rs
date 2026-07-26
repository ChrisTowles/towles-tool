//! Frame-time accounting for the embedded-vs-standalone benchmark.
//!
//! Pure module — no Bevy, no GPU, no clock. Durations are handed in, the same
//! way `tt-store` takes `now_ms` rather than reading the clock in logic, so the
//! percentile maths is testable without rendering anything.
//!
//! The benchmark's acceptance gate is stated in terms of *median* and *p99*
//! frame time rather than mean FPS on purpose. A mean hides exactly the failure
//! this experiment is looking for: a pane that matches the baseline on average
//! but stalls whenever the compositor and the render loop disagree about who
//! owns the frame. That reads as stutter, and averaging it away would let a
//! visibly worse pane pass.
//!
//! Note what p99 does and does not catch. It is a *sustained* stutter detector:
//! over a 3600-frame run it describes the worst 36 frames, so a pane that hitches
//! every other second shows up plainly, while a single isolated stall does not
//! move it at all. That single stall is what `max_us` is for. Both are reported;
//! only median and p99 gate, because a lone spike is as likely to be the OS
//! scheduler as the compositor.

use serde::{Deserialize, Serialize};

/// A recorded run: every frame's duration, in microseconds.
///
/// Microseconds rather than `Duration` so the samples stay `Copy`, sortable and
/// cheap to accumulate in the render loop's hot path.
#[derive(Debug, Default, Clone)]
pub struct FrameLog {
    samples_us: Vec<u32>,
}

/// The summary of a [`FrameLog`], and the shape the harness prints as JSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FrameStats {
    pub frames: usize,
    pub median_us: u32,
    pub p99_us: u32,
    pub min_us: u32,
    pub max_us: u32,
    /// Derived from the median, not the mean — see the module docs.
    pub fps_median: f64,
}

/// The verdict of comparing an embedded run against a standalone baseline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Comparison {
    /// Positive = the pane is *slower* than the baseline.
    pub median_regression_pct: f64,
    pub p99_regression_pct: f64,
    pub median_within_budget: bool,
    pub p99_within_budget: bool,
    pub passed: bool,
}

/// Acceptance thresholds, as percentages. Plan §1, Decision 1.
pub const MEDIAN_BUDGET_PCT: f64 = 5.0;
pub const P99_BUDGET_PCT: f64 = 10.0;

impl FrameLog {
    pub fn new() -> Self {
        Self::default()
    }

    /// Pre-size for a run of roughly `frames` frames, to keep reallocation out
    /// of the loop being measured.
    pub fn with_capacity(frames: usize) -> Self {
        Self { samples_us: Vec::with_capacity(frames) }
    }

    pub fn record_us(&mut self, micros: u32) {
        self.samples_us.push(micros);
    }

    pub fn len(&self) -> usize {
        self.samples_us.len()
    }

    pub fn is_empty(&self) -> bool {
        self.samples_us.is_empty()
    }

    /// Drop the first `n` frames.
    ///
    /// Startup frames are not representative and there are a lot of them:
    /// pipeline compilation, the first swapchain acquire, and — for the
    /// embedded case specifically — the compositor's first commit round-trip.
    /// Leaving them in would flatter the *embedded* run's p99 relative to the
    /// baseline in one direction and wreck it in the other, so both runs discard
    /// the same count.
    pub fn drop_warmup(&mut self, n: usize) {
        let n = n.min(self.samples_us.len());
        self.samples_us.drain(..n);
    }

    /// `None` when the log is empty — there is no meaningful zero here, and a
    /// zeroed `FrameStats` would compare as an infinitely fast run.
    pub fn stats(&self) -> Option<FrameStats> {
        if self.samples_us.is_empty() {
            return None;
        }
        let mut sorted = self.samples_us.clone();
        sorted.sort_unstable();

        let median_us = percentile(&sorted, 50.0);
        Some(FrameStats {
            frames: sorted.len(),
            median_us,
            p99_us: percentile(&sorted, 99.0),
            min_us: sorted[0],
            max_us: sorted[sorted.len() - 1],
            fps_median: if median_us == 0 {
                f64::INFINITY
            } else {
                1_000_000.0 / f64::from(median_us)
            },
        })
    }
}

/// Nearest-rank percentile over an already-sorted slice.
///
/// Nearest-rank rather than interpolating: every sample is a frame that really
/// happened, and at p99 over a 60s run the interpolated value would sit between
/// two real frames and belong to neither.
fn percentile(sorted: &[u32], pct: f64) -> u32 {
    debug_assert!(!sorted.is_empty());
    let rank = (pct / 100.0 * sorted.len() as f64).ceil() as usize;
    sorted[rank.saturating_sub(1).min(sorted.len() - 1)]
}

impl FrameStats {
    /// Compare this run (the embedded pane) against `baseline` (the standalone
    /// window).
    pub fn compare_to_baseline(&self, baseline: &FrameStats) -> Comparison {
        let median_regression_pct = regression_pct(baseline.median_us, self.median_us);
        let p99_regression_pct = regression_pct(baseline.p99_us, self.p99_us);
        let median_within_budget = median_regression_pct <= MEDIAN_BUDGET_PCT;
        let p99_within_budget = p99_regression_pct <= P99_BUDGET_PCT;
        Comparison {
            median_regression_pct,
            p99_regression_pct,
            median_within_budget,
            p99_within_budget,
            passed: median_within_budget && p99_within_budget,
        }
    }
}

/// Percentage by which `measured` exceeds `baseline`. Negative = faster.
fn regression_pct(baseline_us: u32, measured_us: u32) -> f64 {
    if baseline_us == 0 {
        return 0.0;
    }
    (f64::from(measured_us) - f64::from(baseline_us)) / f64::from(baseline_us) * 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log_of(samples: &[u32]) -> FrameLog {
        let mut log = FrameLog::new();
        for &s in samples {
            log.record_us(s);
        }
        log
    }

    #[test]
    fn empty_log_has_no_stats() {
        assert!(FrameLog::new().stats().is_none());
    }

    #[test]
    fn median_and_extremes() {
        let stats = log_of(&[100, 300, 200, 500, 400]).stats().unwrap();
        assert_eq!(stats.frames, 5);
        assert_eq!(stats.median_us, 300);
        assert_eq!(stats.min_us, 100);
        assert_eq!(stats.max_us, 500);
    }

    #[test]
    fn p99_picks_the_tail_not_the_body() {
        // 2% of frames stalling: the median must not notice, the p99 must.
        // This is the whole reason the gate has two thresholds.
        let mut samples = vec![1_000u32; 98];
        samples.extend([100_000, 100_000]);
        let stats = log_of(&samples).stats().unwrap();
        assert_eq!(stats.median_us, 1_000);
        assert_eq!(stats.p99_us, 100_000);
    }

    #[test]
    fn a_single_outlier_in_a_hundred_does_not_move_p99() {
        // Not a bug — nearest-rank p99 over 100 samples is the 99th value, and
        // one bad frame in 100 is by definition a p99.9 event, not a p99 one.
        // Pinned so nobody "fixes" the percentile to make a lone spike visible:
        // `max_us` is what reports isolated stalls, and inflating p99 to catch
        // them would make the gate fire on a single scheduler hiccup during a
        // 3600-frame run.
        let mut samples = vec![1_000u32; 99];
        samples.push(100_000);
        let stats = log_of(&samples).stats().unwrap();
        assert_eq!(stats.p99_us, 1_000);
        assert_eq!(stats.max_us, 100_000);
    }

    #[test]
    fn fps_is_derived_from_the_median() {
        let stats = log_of(&[16_666, 16_666, 16_666]).stats().unwrap();
        assert!((stats.fps_median - 60.0).abs() < 0.01, "got {}", stats.fps_median);
    }

    #[test]
    fn warmup_frames_are_dropped_from_the_front() {
        let mut log = log_of(&[9_999, 9_999, 100, 200, 300]);
        log.drop_warmup(2);
        assert_eq!(log.len(), 3);
        assert_eq!(log.stats().unwrap().max_us, 300);
    }

    #[test]
    fn dropping_more_warmup_than_exists_is_not_a_panic() {
        let mut log = log_of(&[100]);
        log.drop_warmup(50);
        assert!(log.is_empty());
        assert!(log.stats().is_none());
    }

    #[test]
    fn a_pane_matching_the_baseline_passes() {
        let baseline = log_of(&[16_600; 100]).stats().unwrap();
        let embedded = log_of(&[16_700; 100]).stats().unwrap();
        let cmp = embedded.compare_to_baseline(&baseline);
        assert!(cmp.passed, "{cmp:?}");
        assert!(cmp.median_regression_pct < 1.0);
    }

    #[test]
    fn a_pane_six_percent_slower_on_median_fails() {
        let baseline = log_of(&[10_000; 100]).stats().unwrap();
        let embedded = log_of(&[10_600; 100]).stats().unwrap();
        let cmp = embedded.compare_to_baseline(&baseline);
        assert!(!cmp.median_within_budget);
        assert!(!cmp.passed);
    }

    #[test]
    fn a_pane_that_matches_on_median_but_stutters_fails() {
        // The failure mode the gate exists to catch: identical median, ruined
        // tail. A mean-FPS gate would pass this and it would look terrible.
        let baseline = log_of(&[10_000; 100]).stats().unwrap();
        let mut stuttery = vec![10_000u32; 98];
        stuttery.extend([80_000, 80_000]);
        let embedded = log_of(&stuttery).stats().unwrap();

        let cmp = embedded.compare_to_baseline(&baseline);
        assert!(cmp.median_within_budget, "median should be unaffected");
        assert!(!cmp.p99_within_budget, "p99 should catch the stall");
        assert!(!cmp.passed);
    }

    #[test]
    fn a_faster_pane_reports_negative_regression_and_passes() {
        let baseline = log_of(&[20_000; 50]).stats().unwrap();
        let embedded = log_of(&[10_000; 50]).stats().unwrap();
        let cmp = embedded.compare_to_baseline(&baseline);
        assert!(cmp.median_regression_pct < 0.0);
        assert!(cmp.passed);
    }
}
