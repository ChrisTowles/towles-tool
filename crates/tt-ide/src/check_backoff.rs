//! When a folder's compiler check may run again. Every working-tree change asks for
//! one, so a folder whose check keeps returning the same answer — a broken tsconfig,
//! a stable error set — would rerun it on every edit. Each identical result doubles
//! the gap before the next change-driven run; a different result resets it. A
//! caller that needs an answer now (a CLI connecting) bypasses it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub const BASE_MS: i64 = 30_000;
pub const CAP_MS: i64 = 10 * 60_000;

#[derive(Default)]
pub struct CheckBackoff {
    folders: HashMap<PathBuf, Streak>,
}

#[derive(Clone, Copy)]
struct Streak {
    unchanged: u32,
    last_run_ms: i64,
}

impl CheckBackoff {
    /// The earliest a change-driven check of `folder` may run; `now_ms` when it's free.
    pub fn next_allowed_ms(&self, folder: &Path, now_ms: i64) -> i64 {
        match self.folders.get(folder) {
            Some(s) if s.unchanged > 0 => (s.last_run_ms + gap_ms(s.unchanged)).max(now_ms),
            _ => now_ms,
        }
    }

    /// Record a finished run and whether its result differed from the previous one.
    pub fn record(&mut self, folder: &Path, changed: bool, now_ms: i64) {
        let streak = self
            .folders
            .entry(folder.to_path_buf())
            .or_insert(Streak { unchanged: 0, last_run_ms: now_ms });
        streak.unchanged = if changed { 0 } else { streak.unchanged.saturating_add(1) };
        streak.last_run_ms = now_ms;
    }
}

fn gap_ms(unchanged: u32) -> i64 {
    BASE_MS.saturating_mul(1i64 << unchanged.saturating_sub(1).min(20)).min(CAP_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_folder_runs_now() {
        let b = CheckBackoff::default();
        assert_eq!(b.next_allowed_ms(Path::new("/r"), 100), 100);
    }

    #[test]
    fn identical_results_double_the_gap_up_to_the_cap() {
        let mut b = CheckBackoff::default();
        let f = Path::new("/r");
        let mut gaps = Vec::new();
        for _ in 0..8 {
            b.record(f, false, 0);
            gaps.push(b.next_allowed_ms(f, 0));
        }
        assert_eq!(
            gaps,
            [
                30_000, 60_000, 120_000, 240_000, 480_000, CAP_MS, CAP_MS, CAP_MS
            ]
        );
    }

    #[test]
    fn a_changed_result_resets_the_streak() {
        let mut b = CheckBackoff::default();
        let f = Path::new("/r");
        b.record(f, false, 0);
        b.record(f, false, 0);
        b.record(f, true, 5);
        assert_eq!(b.next_allowed_ms(f, 5), 5);
    }

    #[test]
    fn folders_back_off_independently() {
        let mut b = CheckBackoff::default();
        b.record(Path::new("/broken"), false, 0);
        assert_eq!(b.next_allowed_ms(Path::new("/other"), 0), 0);
    }
}
