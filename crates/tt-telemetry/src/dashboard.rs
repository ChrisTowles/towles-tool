//! Dashboard analytics: a range of days folded into the Telemetry screen's Dashboard
//! tab — Braintrust's "cost and quality" board with seconds waited on subprocesses
//! standing in for dollars. Same two rules as `attention.rs`: an event's identity is
//! its `message`, and hour buckets are *local* time while the files are UTC days.
//!
//! So [`Bucket::Day`] keys and `wait_by_day` are the UTC file date
//! ([`TelemetryRecord::day`]) — exactly the days asked for — while [`Bucket::Hour`]
//! keys are `YYYY-MM-DD HH` on the local clock, 24 per requested day starting where
//! that UTC day begins locally, so a one-day range is a run of 24 bars whose labels
//! match the wall clock. Percentiles are nearest-rank on the sorted durations
//! (`sorted[ceil(p·n) − 1]`): the p50 of `[1, 2, 3, 4]` is 2, a value that was
//! actually observed rather than an interpolated one.

use std::collections::BTreeMap;

use chrono::{Duration, Local, NaiveDate, TimeZone, Utc};
use serde::Serialize;

use crate::TelemetryRecord;
use crate::attention::{
    NotificationSummary, SPAWN_SPAN, field_str, pair_focus, parse_ts, summarize_notifications,
};

/// Series kept apart in the bucket breakdown; everything past the top five by
/// count folds into [`OTHER`], since a stack of a dozen slivers is unreadable.
const MAX_SERIES: usize = 5;

const OTHER: &str = "other";

/// Executables profiled individually (duration percentiles); the tail is noise.
const TOP_EXECUTABLES: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Bucket {
    Hour,
    Day,
}

/// What a bucket's series are keyed by.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GroupBy {
    Executable,
    Task,
    WorkingDirectory,
}

impl GroupBy {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "executable" => Some(Self::Executable),
            "task" => Some(Self::Task),
            "working_directory" => Some(Self::WorkingDirectory),
            _ => None,
        }
    }

    fn key(self, record: &TelemetryRecord) -> String {
        match self {
            Self::Executable => executable_name(record).to_string(),
            Self::Task => record.tt_task.clone().unwrap_or_else(|| "(none)".to_string()),
            Self::WorkingDirectory => field_str(record, "process.working_directory")
                .filter(|dir| !dir.is_empty())
                .unwrap_or("(none)")
                .to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSummary {
    /// The UTC days asked for, oldest first.
    pub days: Vec<String>,
    pub bucket: Bucket,
    pub group_by: GroupBy,
    pub record_count: usize,
    pub spawn_count: usize,
    /// Series names in stacking order (busiest first, [`OTHER`] last if any folded),
    /// so a series keeps its colour when a bucket lacks it.
    pub series: Vec<String>,
    pub buckets: Vec<BucketRow>,
    /// Always by executable regardless of `group_by`.
    pub by_executable: Vec<ExecutableProfile>,
    pub wait_by_day: Vec<DayWait>,
    pub focus: DashboardFocus,
    pub notifications: NotificationSummary,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketRow {
    pub key: String,
    /// Keyed by `group_by`, in `series` order; series with no spawns are omitted.
    pub spawns_by_exec: Vec<SeriesStat>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesStat {
    pub name: String,
    pub count: usize,
    /// Spawns whose `outcome` was neither `ok` nor `detached`.
    pub failures: usize,
    pub total_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutableProfile {
    pub name: String,
    pub count: usize,
    pub failures: usize,
    pub p50_ms: i64,
    pub p95_ms: i64,
    pub max_ms: i64,
    pub total_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayWait {
    pub day: String,
    pub count: usize,
    /// Summed span durations; concurrent spawns overlap, so a day can exceed 24h.
    pub total_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardFocus {
    pub focused_ms: i64,
    pub longest_ms: i64,
}

/// One subprocess record: a finished `process.spawn` span, or the single event a
/// detached launch (PTY, code-server, editor) emits in its place.
struct Spawn<'a> {
    record: &'a TelemetryRecord,
    duration_ms: Option<i64>,
    failed: bool,
}

fn spawn_of(record: &TelemetryRecord) -> Option<Spawn<'_>> {
    let outcome = field_str(record, "outcome");
    let detached = record.kind == "event" && outcome == Some("detached");
    if !(detached || (record.kind == "span" && record.name == SPAWN_SPAN)) {
        return None;
    }
    Some(Spawn {
        record,
        duration_ms: if detached { None } else { Some(record.duration_ms.unwrap_or(0).max(0)) },
        failed: outcome.is_some_and(|o| o != "ok" && o != "detached"),
    })
}

/// `/usr/bin/zsh` and `zsh` are the same tool; a detached PTY records the full path.
fn executable_name(record: &TelemetryRecord) -> &str {
    field_str(record, "process.executable.name")
        .map(|name| name.rsplit('/').next().unwrap_or(name))
        .filter(|name| !name.is_empty())
        .unwrap_or("unknown")
}

fn bucket_key(bucket: Bucket, record: &TelemetryRecord) -> Option<String> {
    match bucket {
        Bucket::Day => Some(record.day().to_string()),
        Bucket::Hour => {
            Some(parse_ts(&record.ts)?.with_timezone(&Local).format("%Y-%m-%d %H").to_string())
        }
    }
}

/// Every key a range should show, empty ones included — a gap is data.
fn seed_keys(bucket: Bucket, days: &[String]) -> Vec<String> {
    match bucket {
        Bucket::Day => days.to_vec(),
        Bucket::Hour => days
            .iter()
            .filter_map(|day| NaiveDate::parse_from_str(day, "%Y-%m-%d").ok())
            .flat_map(|day| {
                let start = Utc.from_utc_datetime(&day.and_hms_opt(0, 0, 0).unwrap_or_default());
                (0..24).map(move |h| {
                    (start + Duration::hours(h))
                        .with_timezone(&Local)
                        .format("%Y-%m-%d %H")
                        .to_string()
                })
            })
            .collect(),
    }
}

/// Reduce a range's records to the dashboard. Pure — no clock, no filesystem.
/// `days` are the UTC file dates the records came from, oldest first, and are
/// what seeds the empty buckets.
pub fn summarize_dashboard(
    days: &[String],
    records: &[TelemetryRecord],
    bucket: Bucket,
    group_by: GroupBy,
) -> DashboardSummary {
    let spawns: Vec<Spawn<'_>> = records.iter().filter_map(spawn_of).collect();

    let mut totals: BTreeMap<String, usize> = BTreeMap::new();
    for spawn in &spawns {
        *totals.entry(group_by.key(spawn.record)).or_default() += 1;
    }
    let mut ranked: Vec<(String, usize)> = totals.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let mut series: Vec<String> = ranked.iter().take(MAX_SERIES).map(|(k, _)| k.clone()).collect();
    let folded = ranked.len() > MAX_SERIES;
    if folded {
        series.push(OTHER.to_string());
    }
    let series_of = |key: String| if series.contains(&key) { key } else { OTHER.to_string() };

    let mut buckets: BTreeMap<String, Vec<SeriesStat>> =
        seed_keys(bucket, days).into_iter().map(|k| (k, Vec::new())).collect();
    let mut wait: BTreeMap<String, DayWait> = days
        .iter()
        .map(|d| (d.clone(), DayWait { day: d.clone(), count: 0, total_ms: 0 }))
        .collect();
    let mut durations: BTreeMap<String, Vec<i64>> = BTreeMap::new();
    let mut profiles: BTreeMap<String, ExecutableProfile> = BTreeMap::new();

    for spawn in &spawns {
        let duration = spawn.duration_ms.unwrap_or(0);
        if let Some(key) = bucket_key(bucket, spawn.record) {
            let name = series_of(group_by.key(spawn.record));
            let row = buckets.entry(key).or_default();
            let stat = match row.iter_mut().find(|s| s.name == name) {
                Some(stat) => stat,
                None => {
                    row.push(SeriesStat { name, count: 0, failures: 0, total_ms: 0 });
                    row.last_mut().expect("just pushed")
                }
            };
            stat.count += 1;
            stat.failures += usize::from(spawn.failed);
            stat.total_ms += duration;
        }

        let day = spawn.record.day().to_string();
        let day_wait = wait.entry(day.clone()).or_insert(DayWait { day, count: 0, total_ms: 0 });
        day_wait.count += 1;
        day_wait.total_ms += duration;

        let exec = executable_name(spawn.record).to_string();
        if let Some(ms) = spawn.duration_ms {
            durations.entry(exec.clone()).or_default().push(ms);
        }
        let profile = profiles.entry(exec.clone()).or_insert(ExecutableProfile {
            name: exec,
            count: 0,
            failures: 0,
            p50_ms: 0,
            p95_ms: 0,
            max_ms: 0,
            total_ms: 0,
        });
        profile.count += 1;
        profile.failures += usize::from(spawn.failed);
        profile.total_ms += duration;
    }

    let mut by_executable: Vec<ExecutableProfile> = profiles
        .into_values()
        .map(|mut profile| {
            if let Some(sorted) = durations.get_mut(&profile.name) {
                sorted.sort_unstable();
                profile.p50_ms = percentile(sorted, 0.50);
                profile.p95_ms = percentile(sorted, 0.95);
                profile.max_ms = *sorted.last().unwrap_or(&0);
            }
            profile
        })
        .collect();
    by_executable.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));
    by_executable.truncate(TOP_EXECUTABLES);

    let order = |name: &str| series.iter().position(|s| s == name).unwrap_or(usize::MAX);
    let buckets = buckets
        .into_iter()
        .map(|(key, mut spawns_by_exec)| {
            spawns_by_exec.sort_by_key(|s| order(&s.name));
            BucketRow { key, spawns_by_exec }
        })
        .collect();

    let pairing = pair_focus(records, records.last().map(|r| r.ts.as_str()));

    DashboardSummary {
        days: days.to_vec(),
        bucket,
        group_by,
        record_count: records.len(),
        spawn_count: spawns.len(),
        series,
        buckets,
        by_executable,
        wait_by_day: wait.into_values().collect(),
        focus: DashboardFocus {
            focused_ms: pairing.sessions.iter().map(|s| s.duration_ms).sum(),
            longest_ms: pairing.sessions.iter().map(|s| s.duration_ms).max().unwrap_or(0),
        },
        notifications: summarize_notifications(records),
    }
}

/// Nearest-rank percentile of an ascending slice; see the module docs.
fn percentile(sorted: &[i64], p: f64) -> i64 {
    if sorted.is_empty() {
        return 0;
    }
    let rank = (p * sorted.len() as f64).ceil() as usize;
    sorted[rank.clamp(1, sorted.len()) - 1]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn span(ts: &str, executable: &str, duration_ms: i64, outcome: &str) -> TelemetryRecord {
        TelemetryRecord {
            ts: ts.to_string(),
            kind: "span".into(),
            level: "DEBUG".into(),
            target: "tt_exec".into(),
            name: SPAWN_SPAN.into(),
            tt_task: Some("feat-x".into()),
            tt_build_sha: None,
            duration_ms: Some(duration_ms),
            fields: json!({
                "process.executable.name": executable,
                "process.working_directory": "/repo",
                "outcome": outcome,
            }),
            raw: String::new(),
        }
    }

    fn event(ts: &str, message: &str, fields: Value) -> TelemetryRecord {
        let mut object = fields.as_object().cloned().unwrap_or_default();
        object.insert("message".into(), Value::from(message));
        TelemetryRecord {
            ts: ts.to_string(),
            kind: "event".into(),
            level: "DEBUG".into(),
            target: "tt_exec".into(),
            name: "event crates/tt-exec/src/lib.rs:141".into(),
            tt_task: None,
            tt_build_sha: None,
            duration_ms: None,
            fields: Value::Object(object),
            raw: String::new(),
        }
    }

    fn detached(ts: &str, executable: &str) -> TelemetryRecord {
        event(
            ts,
            "spawned detached process",
            json!({ "process.executable.name": executable, "outcome": "detached" }),
        )
    }

    fn days(list: &[&str]) -> Vec<String> {
        list.iter().map(|d| d.to_string()).collect()
    }

    #[test]
    fn percentiles_are_nearest_rank() {
        assert_eq!(percentile(&[1, 2, 3, 4], 0.50), 2);
        assert_eq!(percentile(&[1, 2, 3, 4], 0.95), 4);
        assert_eq!(percentile(&[7], 0.50), 7);
        assert_eq!(percentile(&[], 0.50), 0);
        let hundred: Vec<i64> = (1..=100).collect();
        assert_eq!(percentile(&hundred, 0.95), 95);
    }

    #[test]
    fn profiles_each_executable_with_failures_and_percentiles() {
        let records = vec![
            span("2026-07-25T10:00:00+00:00", "gh", 100, "ok"),
            span("2026-07-25T10:00:01+00:00", "gh", 300, "non_zero_exit"),
            span("2026-07-25T10:00:02+00:00", "gh", 200, "timed_out"),
            span("2026-07-25T10:00:03+00:00", "gh", 4000, "ok"),
            span("2026-07-25T10:00:04+00:00", "git", 5, "ok"),
        ];
        let summary =
            summarize_dashboard(&days(&["2026-07-25"]), &records, Bucket::Day, GroupBy::Executable);

        assert_eq!(summary.spawn_count, 5);
        let gh = &summary.by_executable[0];
        assert_eq!(gh.name, "gh");
        assert_eq!((gh.count, gh.failures), (4, 2));
        assert_eq!((gh.p50_ms, gh.p95_ms, gh.max_ms, gh.total_ms), (200, 4000, 4000, 4600));
        assert_eq!(
            summary.wait_by_day,
            vec![DayWait { day: "2026-07-25".into(), count: 5, total_ms: 4605 }]
        );
    }

    /// A detached launch is a spawn that never finishes: it counts, fails never,
    /// and contributes no duration to the percentiles.
    #[test]
    fn detached_events_count_as_spawns_without_duration() {
        let records = vec![
            detached("2026-07-25T10:00:00+00:00", "/usr/bin/zsh"),
            span("2026-07-25T10:00:01+00:00", "zsh", 50, "ok"),
        ];
        let summary =
            summarize_dashboard(&days(&["2026-07-25"]), &records, Bucket::Day, GroupBy::Executable);

        let zsh = &summary.by_executable[0];
        assert_eq!(zsh.name, "zsh");
        assert_eq!((zsh.count, zsh.failures, zsh.p50_ms, zsh.max_ms), (2, 0, 50, 50));
        assert_eq!(summary.buckets[0].spawns_by_exec[0].count, 2);
    }

    /// Hour buckets are local: a UTC day is 24 consecutive local hours, and a
    /// record lands in the local hour its wall clock says, not its UTC one.
    #[test]
    fn hour_buckets_follow_the_local_clock_across_the_utc_seam() {
        let records = vec![
            span("2026-07-25T00:30:00+00:00", "git", 5, "ok"),
            span("2026-07-25T23:30:00+00:00", "gh", 5, "ok"),
        ];
        let summary = summarize_dashboard(
            &days(&["2026-07-25"]),
            &records,
            Bucket::Hour,
            GroupBy::Executable,
        );

        assert_eq!(summary.buckets.len(), 24);
        let first_local = parse_ts("2026-07-25T00:00:00+00:00")
            .unwrap()
            .with_timezone(&Local)
            .format("%Y-%m-%d %H")
            .to_string();
        assert_eq!(summary.buckets[0].key, first_local);
        assert_eq!(summary.buckets[0].spawns_by_exec[0].name, "git");
        assert_eq!(summary.buckets[23].spawns_by_exec[0].name, "gh");
        assert!(summary.buckets[1..23].iter().all(|b| b.spawns_by_exec.is_empty()));
    }

    #[test]
    fn day_buckets_are_seeded_from_the_requested_days() {
        let records = vec![span("2026-07-26T10:00:00+00:00", "git", 5, "ok")];
        let range = days(&["2026-07-25", "2026-07-26", "2026-07-27"]);
        let summary = summarize_dashboard(&range, &records, Bucket::Day, GroupBy::Executable);

        let keys: Vec<&str> = summary.buckets.iter().map(|b| b.key.as_str()).collect();
        assert_eq!(keys, vec!["2026-07-25", "2026-07-26", "2026-07-27"]);
        assert_eq!(summary.wait_by_day.iter().map(|w| w.count).collect::<Vec<_>>(), vec![0, 1, 0]);
    }

    #[test]
    fn groups_series_by_task_and_folds_the_tail_into_other() {
        let mut records = vec![span("2026-07-25T10:00:00+00:00", "git", 5, "ok")];
        records[0].tt_task = None;
        for (i, task) in ["a", "b", "c", "d", "e", "f"].iter().enumerate() {
            for _ in 0..(10 - i) {
                let mut r = span("2026-07-25T10:00:00+00:00", "git", 5, "ok");
                r.tt_task = Some(task.to_string());
                records.push(r);
            }
        }
        let summary =
            summarize_dashboard(&days(&["2026-07-25"]), &records, Bucket::Day, GroupBy::Task);

        assert_eq!(summary.series, vec!["a", "b", "c", "d", "e", "other"]);
        let row = &summary.buckets[0].spawns_by_exec;
        assert_eq!(row.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), summary.series);
        // "f" (5) and the taskless record (1) both fold.
        assert_eq!(row.last().unwrap().count, 6);
        assert_eq!(summary.by_executable[0].name, "git");
    }

    #[test]
    fn focus_and_notifications_span_the_range() {
        let records = vec![
            event("2026-07-25T10:00:00+00:00", "window.focus_changed", json!({ "focused": true })),
            event("2026-07-25T10:30:00+00:00", "window.focus_changed", json!({ "focused": false })),
            event("2026-07-26T09:00:00+00:00", "notify_needs_you: fired", json!({})),
            event("2026-07-26T09:00:00+00:00", "window.focus_changed", json!({ "focused": true })),
            event(
                "2026-07-26T09:10:00+00:00",
                "notify_needs_you: skipped, window focused",
                json!({}),
            ),
            event("2026-07-26T09:10:00+00:00", "window.focus_changed", json!({ "focused": false })),
        ];
        let summary = summarize_dashboard(
            &days(&["2026-07-25", "2026-07-26"]),
            &records,
            Bucket::Day,
            GroupBy::Executable,
        );

        assert_eq!(summary.focus.focused_ms, 40 * 60_000);
        assert_eq!(summary.focus.longest_ms, 30 * 60_000);
        assert_eq!((summary.notifications.fired, summary.notifications.skipped), (1, 1));
        assert_eq!(summary.spawn_count, 0);
    }
}
