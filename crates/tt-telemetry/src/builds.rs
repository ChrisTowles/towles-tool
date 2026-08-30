//! Build comparison: Braintrust's Experiments over `tt.build_sha`. Every record
//! names the commit its binary was built from, so a **build × UTC day** is an
//! immutable snapshot and two of them can be set side by side. The measures are
//! the Dashboard's, folded per snapshot rather than per range.
//!
//! Two rules that look like bugs and aren't. A snapshot's focus pairing runs over
//! its *own* records only, so a day split across two builds credits each build
//! with the stretches it actually saw (the other build's blur is a departure, not
//! a session). And the "per focused hour" denominator is withheld under
//! [`MIN_FOCUS_MS`]: divide a count by three minutes and any build looks wild.
//! A measure's *direction* is a property of the measure, never of the sign —
//! `compare` says which way is better and leaves colouring to the caller.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::TelemetryRecord;
use crate::attention::{
    ACTION_EVENT, FOCUS_EVENT, event_name, pair_focus, summarize_notifications,
};
use crate::dashboard::{executable_name, percentile, spawn_of};

/// Below this much focused time a per-hour rate is noise, not a measure.
pub const MIN_FOCUS_MS: i64 = 10 * 60_000;

/// Records with no `tt.build_sha` (or the literal `build.rs` fallback) still
/// belong to a day, so they get a bucket rather than vanishing.
const UNKNOWN_SHA: &str = "unknown";

const MS_PER_HOUR: f64 = 3_600_000.0;
const MS_PER_MINUTE: f64 = 60_000.0;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildKey {
    pub sha: String,
    pub day: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildSnapshot {
    pub sha: String,
    pub day: String,
    pub record_count: usize,
    pub measures: Measures,
}

impl BuildSnapshot {
    pub fn key(&self) -> BuildKey {
        BuildKey { sha: self.sha.clone(), day: self.day.clone() }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Measures {
    pub gh_calls: usize,
    pub git_calls: usize,
    pub claude_calls: usize,
    /// `None` when there were no calls to fail.
    pub gh_failure_pct: Option<f64>,
    pub git_failure_pct: Option<f64>,
    /// Summed span durations; concurrent spawns overlap.
    pub subprocess_wait_ms: i64,
    pub p95_spawn_ms: i64,
    pub focus_flips: usize,
    pub needs_you_fired: usize,
    pub needs_you_skipped: usize,
    pub ui_actions: usize,
    pub warn_error_records: usize,
    /// The per-hour denominator; see [`MIN_FOCUS_MS`].
    pub focused_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    LowerIsBetter,
    HigherIsBetter,
    Neutral,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Unit {
    Count,
    Percent,
    Ms,
    Minutes,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Delta {
    pub measure: String,
    pub label: String,
    pub base: Option<f64>,
    pub other: Option<f64>,
    /// `other − base`; `None` when either side is undefined.
    pub delta: Option<f64>,
    pub direction: Direction,
    pub unit: Unit,
    /// Per focused hour. `None` for a rate or percentile, which is already
    /// intensive; `Some` with empty sides when a snapshot is under [`MIN_FOCUS_MS`].
    pub per_hour: Option<PerHour>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerHour {
    pub base: Option<f64>,
    pub other: Option<f64>,
    pub delta: Option<f64>,
}

struct MeasureSpec {
    id: &'static str,
    label: &'static str,
    direction: Direction,
    unit: Unit,
    /// Scales with focused time, so a per-hour rate means something.
    extensive: bool,
    value: fn(&Measures) -> Option<f64>,
}

fn count(n: usize) -> Option<f64> {
    Some(n as f64)
}

/// Table order is display order. Call counts are neutral: a busy day is
/// workload, not a regression — the cost measure is the wait.
const MEASURES: &[MeasureSpec] = &[
    MeasureSpec {
        id: "gh_calls",
        label: "gh calls",
        direction: Direction::Neutral,
        unit: Unit::Count,
        extensive: true,
        value: |m| count(m.gh_calls),
    },
    MeasureSpec {
        id: "git_calls",
        label: "git calls",
        direction: Direction::Neutral,
        unit: Unit::Count,
        extensive: true,
        value: |m| count(m.git_calls),
    },
    MeasureSpec {
        id: "claude_calls",
        label: "claude calls",
        direction: Direction::Neutral,
        unit: Unit::Count,
        extensive: true,
        value: |m| count(m.claude_calls),
    },
    MeasureSpec {
        id: "gh_failure_pct",
        label: "gh failure rate",
        direction: Direction::LowerIsBetter,
        unit: Unit::Percent,
        extensive: false,
        value: |m| m.gh_failure_pct,
    },
    MeasureSpec {
        id: "git_failure_pct",
        label: "git failure rate",
        direction: Direction::LowerIsBetter,
        unit: Unit::Percent,
        extensive: false,
        value: |m| m.git_failure_pct,
    },
    MeasureSpec {
        id: "subprocess_wait",
        label: "subprocess wait",
        direction: Direction::LowerIsBetter,
        unit: Unit::Minutes,
        extensive: true,
        value: |m| Some(m.subprocess_wait_ms as f64 / MS_PER_MINUTE),
    },
    MeasureSpec {
        id: "p95_spawn_ms",
        label: "p95 spawn duration",
        direction: Direction::LowerIsBetter,
        unit: Unit::Ms,
        extensive: false,
        value: |m| Some(m.p95_spawn_ms as f64),
    },
    MeasureSpec {
        id: "focus_flips",
        label: "focus flips",
        direction: Direction::LowerIsBetter,
        unit: Unit::Count,
        extensive: true,
        value: |m| count(m.focus_flips),
    },
    MeasureSpec {
        id: "needs_you_fired",
        label: "needs-you fired",
        direction: Direction::LowerIsBetter,
        unit: Unit::Count,
        extensive: true,
        value: |m| count(m.needs_you_fired),
    },
    MeasureSpec {
        id: "needs_you_skipped",
        label: "needs-you skipped",
        direction: Direction::Neutral,
        unit: Unit::Count,
        extensive: true,
        value: |m| count(m.needs_you_skipped),
    },
    MeasureSpec {
        id: "ui_actions",
        label: "ui.action count",
        direction: Direction::Neutral,
        unit: Unit::Count,
        extensive: true,
        value: |m| count(m.ui_actions),
    },
    MeasureSpec {
        id: "warn_error_records",
        label: "WARN+ERROR records",
        direction: Direction::LowerIsBetter,
        unit: Unit::Count,
        extensive: true,
        value: |m| count(m.warn_error_records),
    },
];

fn sha_of(record: &TelemetryRecord) -> &str {
    record.tt_build_sha.as_deref().filter(|s| !s.is_empty()).unwrap_or(UNKNOWN_SHA)
}

/// Fold a run of records into snapshots keyed by (sha, day), newest day first
/// and the busiest build first within a day. Pure — no clock, no filesystem.
/// Records must be in write order, since focus pairing depends on it.
pub fn snapshots(records: &[TelemetryRecord]) -> Vec<BuildSnapshot> {
    let mut groups: BTreeMap<BuildKey, Vec<&TelemetryRecord>> = BTreeMap::new();
    for record in records {
        let key = BuildKey { sha: sha_of(record).to_string(), day: record.day().to_string() };
        groups.entry(key).or_default().push(record);
    }
    let mut out: Vec<BuildSnapshot> = groups
        .into_iter()
        .map(|(key, records)| BuildSnapshot {
            sha: key.sha,
            day: key.day,
            record_count: records.len(),
            measures: measure(&records),
        })
        .collect();
    out.sort_by(|a, b| {
        b.day.cmp(&a.day).then(b.record_count.cmp(&a.record_count)).then(a.sha.cmp(&b.sha))
    });
    out
}

fn pct(failures: usize, total: usize) -> Option<f64> {
    (total > 0).then(|| failures as f64 / total as f64 * 100.0)
}

fn measure(records: &[&TelemetryRecord]) -> Measures {
    let mut calls: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
    let mut wait_ms = 0i64;
    let mut durations: Vec<i64> = Vec::new();
    let mut focus_flips = 0usize;
    let mut ui_actions = 0usize;
    let mut warn_error_records = 0usize;

    for record in records {
        if let Some(spawn) = spawn_of(record) {
            let entry = calls.entry(executable_name(record)).or_default();
            entry.0 += 1;
            entry.1 += usize::from(spawn.failed);
            if let Some(ms) = spawn.duration_ms {
                wait_ms += ms;
                durations.push(ms);
            }
        }
        match event_name(record) {
            FOCUS_EVENT => focus_flips += 1,
            ACTION_EVENT => ui_actions += 1,
            _ => {}
        }
        if record.level == "WARN" || record.level == "ERROR" {
            warn_error_records += 1;
        }
    }
    durations.sort_unstable();

    let pairing = pair_focus(records.iter().copied(), records.last().map(|r| r.ts.as_str()));
    let notifications = summarize_notifications(records.iter().copied());

    let of = |name: &str| calls.get(name).copied().unwrap_or_default();
    let (gh, git, claude) = (of("gh"), of("git"), of("claude"));
    Measures {
        gh_calls: gh.0,
        git_calls: git.0,
        claude_calls: claude.0,
        gh_failure_pct: pct(gh.1, gh.0),
        git_failure_pct: pct(git.1, git.0),
        subprocess_wait_ms: wait_ms,
        p95_spawn_ms: percentile(&durations, 0.95),
        focus_flips,
        needs_you_fired: notifications.fired,
        needs_you_skipped: notifications.skipped,
        ui_actions,
        warn_error_records,
        focused_ms: pairing.sessions.iter().map(|s| s.duration_ms).sum(),
    }
}

fn per_hour(value: Option<f64>, focused_ms: i64) -> Option<f64> {
    (focused_ms >= MIN_FOCUS_MS).then_some(value? / (focused_ms as f64 / MS_PER_HOUR))
}

fn diff(base: Option<f64>, other: Option<f64>) -> Option<f64> {
    Some(other? - base?)
}

/// Every measure of `other` against `base`, in display order. Deltas are
/// `other − base` throughout; whether that is good is `direction`'s to say.
pub fn compare(base: &BuildSnapshot, other: &BuildSnapshot) -> Vec<Delta> {
    MEASURES
        .iter()
        .map(|spec| {
            let b = (spec.value)(&base.measures);
            let o = (spec.value)(&other.measures);
            let per_hour = spec.extensive.then(|| {
                let b = per_hour(b, base.measures.focused_ms);
                let o = per_hour(o, other.measures.focused_ms);
                PerHour { base: b, other: o, delta: diff(b, o) }
            });
            Delta {
                measure: spec.id.to_string(),
                label: spec.label.to_string(),
                base: b,
                other: o,
                delta: diff(b, o),
                direction: spec.direction,
                unit: spec.unit,
                per_hour,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attention::SPAWN_SPAN;
    use serde_json::{Value, json};

    fn span(ts: &str, sha: Option<&str>, exe: &str, ms: i64, outcome: &str) -> TelemetryRecord {
        TelemetryRecord {
            pid: None,
            ts: ts.to_string(),
            kind: "span".into(),
            level: "DEBUG".into(),
            target: "tt_exec".into(),
            name: SPAWN_SPAN.into(),
            tt_task: None,
            tt_build_sha: sha.map(str::to_string),
            duration_ms: Some(ms),
            fields: json!({ "process.executable.name": exe, "outcome": outcome }),
            raw: String::new(),
        }
    }

    fn event(
        ts: &str,
        sha: Option<&str>,
        level: &str,
        message: &str,
        fields: Value,
    ) -> TelemetryRecord {
        let mut object = fields.as_object().cloned().unwrap_or_default();
        object.insert("message".into(), Value::from(message));
        TelemetryRecord {
            pid: None,
            ts: ts.to_string(),
            kind: "event".into(),
            level: level.into(),
            target: "tt_app_lib".into(),
            name: "event crates-tauri/tt-app/src/lib.rs:81".into(),
            tt_task: None,
            tt_build_sha: sha.map(str::to_string),
            duration_ms: None,
            fields: Value::Object(object),
            raw: String::new(),
        }
    }

    fn focus(ts: &str, sha: &str, focused: bool) -> TelemetryRecord {
        event(ts, Some(sha), "DEBUG", FOCUS_EVENT, json!({ "focused": focused }))
    }

    /// Day A (`aaaaaaa`): 4 gh calls, 2 failed, 30 min focused, one needs-you.
    /// Day B (`bbbbbbb`): 4 gh calls, 0 failed, 1 h focused, one needs-you.
    fn two_days() -> Vec<TelemetryRecord> {
        let a = Some("aaaaaaa");
        let b = Some("bbbbbbb");
        vec![
            focus("2026-08-28T10:00:00+00:00", "aaaaaaa", true),
            span("2026-08-28T10:01:00+00:00", a, "gh", 100, "ok"),
            span("2026-08-28T10:02:00+00:00", a, "gh", 200, "non_zero_exit"),
            span("2026-08-28T10:03:00+00:00", a, "gh", 300, "ok"),
            span("2026-08-28T10:04:00+00:00", a, "gh", 400, "timed_out"),
            event("2026-08-28T10:05:00+00:00", a, "INFO", "notify_needs_you: fired", json!({})),
            focus("2026-08-28T10:30:00+00:00", "aaaaaaa", false),
            focus("2026-08-30T09:00:00+00:00", "bbbbbbb", true),
            span("2026-08-30T09:01:00+00:00", b, "gh", 100, "ok"),
            span("2026-08-30T09:02:00+00:00", b, "gh", 200, "ok"),
            span("2026-08-30T09:03:00+00:00", b, "gh", 300, "ok"),
            span("2026-08-30T09:04:00+00:00", b, "gh", 400, "ok"),
            event("2026-08-30T09:05:00+00:00", b, "INFO", "notify_needs_you: fired", json!({})),
            focus("2026-08-30T10:00:00+00:00", "bbbbbbb", false),
        ]
    }

    fn delta<'a>(deltas: &'a [Delta], id: &str) -> &'a Delta {
        deltas.iter().find(|d| d.measure == id).unwrap_or_else(|| panic!("no {id}"))
    }

    #[test]
    fn snapshots_are_newest_first_and_carry_the_measures() {
        let snaps = snapshots(&two_days());
        assert_eq!(snaps.len(), 2);
        assert_eq!((snaps[0].sha.as_str(), snaps[0].day.as_str()), ("bbbbbbb", "2026-08-30"));
        assert_eq!(snaps[0].record_count, 7);
        let m = &snaps[1].measures;
        assert_eq!((m.gh_calls, m.git_calls), (4, 0));
        assert_eq!(m.gh_failure_pct, Some(50.0));
        assert_eq!(m.git_failure_pct, None);
        assert_eq!((m.subprocess_wait_ms, m.p95_spawn_ms), (1000, 400));
        assert_eq!((m.focus_flips, m.needs_you_fired, m.focused_ms), (2, 1, 30 * 60_000));
    }

    /// Sign and direction come from the measure: the failure rate fell (an
    /// improvement, negative delta, lower-is-better), the wait held steady, and
    /// the needs-you count is unchanged even though the other numbers moved.
    #[test]
    fn compare_signs_follow_the_measure_not_the_verdict() {
        let snaps = snapshots(&two_days());
        let (b, a) = (&snaps[0], &snaps[1]);
        let deltas = compare(a, b);

        let rate = delta(&deltas, "gh_failure_pct");
        assert_eq!((rate.base, rate.other, rate.delta), (Some(50.0), Some(0.0), Some(-50.0)));
        assert_eq!((rate.direction, rate.unit), (Direction::LowerIsBetter, Unit::Percent));
        assert!(rate.per_hour.is_none(), "a rate is already intensive");

        let wait = delta(&deltas, "subprocess_wait");
        assert_eq!(wait.delta, Some(0.0));
        assert_eq!(wait.unit, Unit::Minutes);

        let fired = delta(&deltas, "needs_you_fired");
        assert_eq!((fired.base, fired.other, fired.delta), (Some(1.0), Some(1.0), Some(0.0)));

        let calls = delta(&deltas, "gh_calls");
        assert_eq!(calls.direction, Direction::Neutral);
        assert_eq!(deltas.len(), MEASURES.len());
    }

    /// Same raw count on both days, but B was focused twice as long: per hour
    /// it is half the rate. That is the "day effect" the toggle exists to show.
    #[test]
    fn per_hour_divides_by_focused_time() {
        let snaps = snapshots(&two_days());
        let deltas = compare(&snaps[1], &snaps[0]);
        let fired = delta(&deltas, "needs_you_fired").per_hour.clone().expect("extensive");
        assert_eq!((fired.base, fired.other, fired.delta), (Some(2.0), Some(1.0), Some(-1.0)));
        let calls = delta(&deltas, "gh_calls").per_hour.clone().expect("extensive");
        assert_eq!((calls.base, calls.other), (Some(8.0), Some(4.0)));
    }

    #[test]
    fn per_hour_is_withheld_under_ten_focused_minutes() {
        let mut records = two_days();
        // Shrink day A's single session to five minutes.
        records[6].ts = "2026-08-28T10:05:00+00:00".into();
        let snaps = snapshots(&records);
        let deltas = compare(&snaps[1], &snaps[0]);
        let calls = delta(&deltas, "gh_calls").per_hour.clone().expect("extensive");
        assert_eq!(calls.base, None, "five minutes is not a denominator");
        assert_eq!(calls.other, Some(4.0));
        assert_eq!(calls.delta, None);
    }

    #[test]
    fn records_without_a_sha_bucket_under_unknown() {
        let records = vec![
            span("2026-08-30T09:01:00+00:00", None, "git", 5, "ok"),
            span("2026-08-30T09:02:00+00:00", Some(""), "git", 5, "ok"),
            span("2026-08-30T09:03:00+00:00", Some("unknown"), "git", 5, "ok"),
            span("2026-08-30T09:04:00+00:00", Some("ccccccc"), "git", 5, "ok"),
        ];
        let snaps = snapshots(&records);
        let keys: Vec<(&str, usize)> =
            snaps.iter().map(|s| (s.sha.as_str(), s.record_count)).collect();
        assert_eq!(keys, vec![("unknown", 3), ("ccccccc", 1)]);
    }

    #[test]
    fn a_day_split_across_builds_pairs_focus_per_build() {
        let records = vec![
            focus("2026-08-30T09:00:00+00:00", "aaaaaaa", true),
            event("2026-08-30T09:20:00+00:00", Some("aaaaaaa"), "WARN", "slow", json!({})),
            focus("2026-08-30T09:30:00+00:00", "bbbbbbb", false),
            focus("2026-08-30T09:31:00+00:00", "bbbbbbb", true),
            focus("2026-08-30T09:41:00+00:00", "bbbbbbb", false),
        ];
        let snaps = snapshots(&records);
        let a = snaps.iter().find(|s| s.sha == "aaaaaaa").unwrap();
        let b = snaps.iter().find(|s| s.sha == "bbbbbbb").unwrap();
        // A's open session closes at its own last record, not at B's blur.
        assert_eq!(a.measures.focused_ms, 20 * 60_000);
        assert_eq!(a.measures.warn_error_records, 1);
        assert_eq!(b.measures.focused_ms, 10 * 60_000);
        assert_eq!(b.measures.focus_flips, 3);
    }
}
