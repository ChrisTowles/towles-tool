//! Attention analytics: one day of raw event-log records reduced to the question the
//! log exists to answer — *where did the day go?* It already records the two things an
//! attention picture needs and nothing else on the machine records at all: the window's
//! OS-level focus history (`window.focus_changed`) and every discrete gesture
//! (`ui.action`, with its screen), plus interruptions (`notify_needs_you`) and
//! subprocess wait (`process.spawn`). [`summarize`] folds a day into
//! [`AttentionSummary`] — hundreds of bytes against 75,000+ records — in Rust.
//!
//! **Two things that look like bugs and aren't.** Event names are read from `message`,
//! not `name`: a `tracing` *event*'s `name` is the auto-generated `event <file>:<line>`
//! which moves with the emitting line, while its stable identity rides in `fields`
//! (see [`event_name`]). And hour buckets are local while the day file is UTC —
//! bucketing in UTC would keep the file's boundary but produce hours no human
//! recognises as "when I was working".

use chrono::{DateTime, FixedOffset, Local, Timelike};
use serde::Serialize;
use serde_json::Value;

use crate::TelemetryRecord;

/// A focus session shorter than this counts as fragmented — a glance at the
/// app rather than a stretch of work in it. Two minutes is deliberately
/// generous: checking a PR's checks or a running agent's last line is a real
/// use of the app, and shouldn't read as thrash below it.
const FRAGMENT_MS: i64 = 2 * 60 * 1000;

/// The message of the event that records the window gaining/losing OS focus
/// (`crates-tauri/tt-app/src/lib.rs`'s `WindowEvent::Focused`).
const FOCUS_EVENT: &str = "window.focus_changed";

/// The message of the frontend's one telemetry seam for user gestures
/// (`ui_action` in `crates-tauri/tt-app/src/lib.rs`).
const ACTION_EVENT: &str = "ui.action";

/// Needs-you notification events are `notify_needs_you: fired` /
/// `notify_needs_you: skipped, <reason>`, so they're matched by prefix.
const NOTIFY_PREFIX: &str = "notify_needs_you";

/// The span every subprocess opens (`tt-exec`'s run paths).
const SPAWN_SPAN: &str = "process.spawn";

/// Longest breakdown list returned for any category. The frontend renders a
/// bar chart per category; beyond this the bars are unreadable and the tail
/// is better answered by the Log tab's search.
const TOP_N: usize = 10;

/// One day's attention picture, derived from that day's event-log records.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionSummary {
    /// The log day this summarizes, echoed back so a stale response is
    /// recognisable as one.
    pub date: String,
    /// Records the day held, including the ones no section below counts.
    pub record_count: usize,
    /// First and last record timestamps — the outer bounds of the day's
    /// activity, which is not the same as the day's focused time.
    pub first_ts: Option<String>,
    pub last_ts: Option<String>,
    /// `last_ts - first_ts`: how long the app was *up*, the denominator
    /// focused time is a share of.
    pub elapsed_ms: i64,
    pub focus: FocusSummary,
    pub actions: ActionSummary,
    pub notifications: NotificationSummary,
    pub machine: MachineSummary,
    /// 24 buckets, `hour` in local time. Always all 24, including empty ones,
    /// so the frontend renders a fixed-width chart with real gaps in it
    /// rather than a compressed one that hides them.
    pub hours: Vec<HourBucket>,
}

/// Window focus: the only record of where the user's eyes actually were.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusSummary {
    /// Total time the window held OS focus.
    pub focused_ms: i64,
    /// Number of separate focused stretches.
    pub session_count: usize,
    /// The longest unbroken one — the day's best shot at deep work.
    pub longest_ms: i64,
    /// Sessions shorter than [`FRAGMENT_MS`]: glances, not work.
    pub fragment_count: usize,
    /// Times focus left the window. Each one is a context switch *away* from
    /// this app, whatever it switched to.
    pub departures: usize,
    /// Every session, in order, for the timeline strip.
    pub sessions: Vec<FocusSession>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusSession {
    pub start: String,
    pub end: String,
    pub duration_ms: i64,
    /// True when the day ended (or the app exited) with the window still
    /// focused, so `end` is the last record's timestamp rather than an
    /// observed blur. The stretch is a lower bound, not a measurement.
    pub open_ended: bool,
}

/// User gestures: what was actually done, and on which screen.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionSummary {
    pub total: usize,
    /// Consecutive actions landing on a different screen than the one before.
    /// A cheap proxy for in-app context switching, and deliberately *not* the
    /// same number as [`FocusSummary::departures`] — this counts moving around
    /// inside the app, that counts leaving it.
    pub screen_switches: usize,
    pub by_screen: Vec<Count>,
    pub by_action: Vec<Count>,
}

/// Needs-you notifications — the app interrupting the user on purpose.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSummary {
    /// Notifications that actually reached the OS.
    pub fired: usize,
    /// Ones suppressed (window already focused, notifications off). Kept
    /// separate because a high skip count is a healthy signal, not an
    /// interruption.
    pub skipped: usize,
}

/// Machine time: what the app spent on subprocesses while the user waited.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineSummary {
    pub spawn_count: usize,
    /// Summed span durations. Wall-clock *inside* spans, not of the day —
    /// concurrent spawns overlap, so this can exceed `elapsed_ms`.
    pub total_ms: i64,
    /// Spawns whose `outcome` field was anything but `ok`.
    pub failures: usize,
    pub by_executable: Vec<ExecutableStat>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutableStat {
    pub name: String,
    pub count: usize,
    pub total_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HourBucket {
    /// Local-time hour, `0..=23`.
    pub hour: u32,
    pub focused_ms: i64,
    pub actions: usize,
    pub spawns: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Count {
    pub key: String,
    pub count: usize,
}

/// The stable identity of a record: a span's own `name`, or — for an event,
/// whose `name` is the throwaway `event <file>:<line>` — its message. See the
/// module docs for why this isn't just `record.name`.
pub(crate) fn event_name(record: &TelemetryRecord) -> &str {
    match record.fields.get("message") {
        Some(Value::String(message)) => message,
        _ => &record.name,
    }
}

fn field_str<'a>(record: &'a TelemetryRecord, key: &str) -> Option<&'a str> {
    record.fields.get(key)?.as_str()
}

fn parse_ts(ts: &str) -> Option<DateTime<FixedOffset>> {
    DateTime::parse_from_rfc3339(ts).ok()
}

/// Reduce one day's records to its attention picture. Pure — no clock, no
/// filesystem — so the whole surface is unit-testable from a record list.
///
/// Records are assumed to be in write order (which is what [`crate::read_day`]
/// returns); the focus state machine and the screen-switch count both depend
/// on it. Out-of-order or malformed timestamps are skipped rather than
/// poisoning a total.
pub fn summarize(date: &str, records: &[TelemetryRecord]) -> AttentionSummary {
    let first_ts = records.first().map(|r| r.ts.clone());
    let last_ts = records.last().map(|r| r.ts.clone());
    let elapsed_ms =
        match (first_ts.as_deref().and_then(parse_ts), last_ts.as_deref().and_then(parse_ts)) {
            (Some(first), Some(last)) => (last - first).num_milliseconds().max(0),
            _ => 0,
        };

    let mut hours: Vec<HourBucket> =
        (0..24).map(|hour| HourBucket { hour, focused_ms: 0, actions: 0, spawns: 0 }).collect();

    let focus = summarize_focus(records, last_ts.as_deref(), &mut hours);
    let actions = summarize_actions(records, &mut hours);
    let notifications = summarize_notifications(records);
    let machine = summarize_machine(records, &mut hours);

    AttentionSummary {
        date: date.to_string(),
        record_count: records.len(),
        first_ts,
        last_ts,
        elapsed_ms,
        focus,
        actions,
        notifications,
        machine,
        hours,
    }
}

/// Pair `window.focus_changed` events into focused stretches — one state
/// machine over the whole day, not one per process. The app restarts several
/// times a day, and each restart's first event is a `focused: true` the
/// previous process never blurred; treating a repeat `true` as a no-op and
/// closing at the day's last record avoids double-counting either way.
fn summarize_focus(
    records: &[TelemetryRecord],
    last_ts: Option<&str>,
    hours: &mut [HourBucket],
) -> FocusSummary {
    let mut sessions: Vec<FocusSession> = Vec::new();
    let mut open: Option<DateTime<FixedOffset>> = None;
    let mut departures = 0usize;

    for record in records.iter().filter(|r| event_name(r) == FOCUS_EVENT) {
        let Some(focused) = record.fields.get("focused").and_then(Value::as_bool) else {
            continue;
        };
        let Some(at) = parse_ts(&record.ts) else {
            continue;
        };
        match (focused, open) {
            (true, None) => open = Some(at),
            (false, Some(start)) => {
                departures += 1;
                open = None;
                push_session(&mut sessions, hours, start, at, false);
            }
            // A repeat `true` (restart) keeps the earlier start; a `false`
            // with nothing open (blur before this file's first gain) is only
            // a departure.
            (true, Some(_)) => {}
            (false, None) => departures += 1,
        }
    }

    if let Some(start) = open
        && let Some(end) = last_ts.and_then(parse_ts)
        && end > start
    {
        push_session(&mut sessions, hours, start, end, true);
    }

    FocusSummary {
        focused_ms: sessions.iter().map(|s| s.duration_ms).sum(),
        session_count: sessions.len(),
        longest_ms: sessions.iter().map(|s| s.duration_ms).max().unwrap_or(0),
        fragment_count: sessions.iter().filter(|s| s.duration_ms < FRAGMENT_MS).count(),
        departures,
        sessions,
    }
}

fn push_session(
    sessions: &mut Vec<FocusSession>,
    hours: &mut [HourBucket],
    start: DateTime<FixedOffset>,
    end: DateTime<FixedOffset>,
    open_ended: bool,
) {
    let duration_ms = (end - start).num_milliseconds();
    if duration_ms <= 0 {
        return;
    }
    spread_over_hours(hours, start, end);
    sessions.push(FocusSession {
        start: start.to_rfc3339(),
        end: end.to_rfc3339(),
        duration_ms,
        open_ended,
    });
}

/// Split a focused stretch across the local hours it spans, so the hourly
/// chart shows a two-hour session as two full bars rather than one spike at
/// the minute it started.
///
/// Boundaries are found by stepping to the next whole hour in *elapsed*
/// milliseconds rather than by setting the hour field, so a DST shift inside
/// the stretch moves the bucket without losing or inventing time.
fn spread_over_hours(
    hours: &mut [HourBucket],
    start: DateTime<FixedOffset>,
    end: DateTime<FixedOffset>,
) {
    let mut cursor = start.with_timezone(&Local);
    let end = end.with_timezone(&Local);
    // A day holds at most 24 boundaries; the cap is a backstop against a
    // corrupt timestamp pair turning this into an unbounded loop.
    for _ in 0..26 {
        if cursor >= end {
            return;
        }
        let into_hour = (cursor.minute() as i64 * 60 + cursor.second() as i64) * 1000
            + cursor.timestamp_subsec_millis() as i64;
        let boundary = cursor + chrono::Duration::milliseconds(3_600_000 - into_hour);
        let segment_end = boundary.min(end);
        hours[cursor.hour() as usize].focused_ms += (segment_end - cursor).num_milliseconds();
        cursor = segment_end;
    }
}

fn summarize_actions(records: &[TelemetryRecord], hours: &mut [HourBucket]) -> ActionSummary {
    let mut by_screen: Vec<Count> = Vec::new();
    let mut by_action: Vec<Count> = Vec::new();
    let mut total = 0usize;
    let mut screen_switches = 0usize;
    let mut previous_screen: Option<String> = None;

    for record in records.iter().filter(|r| event_name(r) == ACTION_EVENT) {
        total += 1;
        if let Some(at) = parse_ts(&record.ts) {
            hours[at.with_timezone(&Local).hour() as usize].actions += 1;
        }
        if let Some(screen) = field_str(record, "screen").filter(|s| !s.is_empty()) {
            if previous_screen.as_deref().is_some_and(|prev| prev != screen) {
                screen_switches += 1;
            }
            previous_screen = Some(screen.to_string());
            bump(&mut by_screen, screen);
        }
        if let Some(action) = field_str(record, "action").filter(|s| !s.is_empty()) {
            bump(&mut by_action, action);
        }
    }

    ActionSummary { total, screen_switches, by_screen: top(by_screen), by_action: top(by_action) }
}

fn summarize_notifications(records: &[TelemetryRecord]) -> NotificationSummary {
    let mut fired = 0usize;
    let mut skipped = 0usize;
    for record in records {
        let Some(rest) = event_name(record).strip_prefix(NOTIFY_PREFIX) else {
            continue;
        };
        if rest.contains("fired") {
            fired += 1;
        } else if rest.contains("skipped") {
            skipped += 1;
        }
    }
    NotificationSummary { fired, skipped }
}

fn summarize_machine(records: &[TelemetryRecord], hours: &mut [HourBucket]) -> MachineSummary {
    let mut by_executable: Vec<ExecutableStat> = Vec::new();
    let mut spawn_count = 0usize;
    let mut total_ms = 0i64;
    let mut failures = 0usize;

    for record in records.iter().filter(|r| r.kind == "span" && r.name == SPAWN_SPAN) {
        spawn_count += 1;
        let duration = record.duration_ms.unwrap_or(0).max(0);
        total_ms += duration;
        if field_str(record, "outcome").is_some_and(|o| o != "ok") {
            failures += 1;
        }
        if let Some(at) = parse_ts(&record.ts) {
            hours[at.with_timezone(&Local).hour() as usize].spawns += 1;
        }
        let name = field_str(record, "process.executable.name").unwrap_or("unknown");
        match by_executable.iter_mut().find(|e| e.name == name) {
            Some(entry) => {
                entry.count += 1;
                entry.total_ms += duration;
            }
            None => by_executable.push(ExecutableStat {
                name: name.to_string(),
                count: 1,
                total_ms: duration,
            }),
        }
    }

    // Ranked by time, not count: the point is where the waiting went, and a
    // thousand 2ms `git status` calls cost less than a handful of fetches.
    by_executable.sort_unstable_by(|a, b| b.total_ms.cmp(&a.total_ms).then(b.count.cmp(&a.count)));
    by_executable.truncate(TOP_N);

    MachineSummary { spawn_count, total_ms, failures, by_executable }
}

/// Increment `key`'s tally, appending it if new. Linear scan on purpose:
/// these categories are screens and action ids — a few dozen at most — and a
/// `Vec` keeps insertion order stable for equal counts, which a `HashMap`
/// would not.
fn bump(counts: &mut Vec<Count>, key: &str) {
    match counts.iter_mut().find(|c| c.key == key) {
        Some(entry) => entry.count += 1,
        None => counts.push(Count { key: key.to_string(), count: 1 }),
    }
}

fn top(mut counts: Vec<Count>) -> Vec<Count> {
    // Stable sort, so ties keep the order they were first seen in — the point
    // of `bump`'s `Vec` over a `HashMap`.
    counts.sort_by_key(|c| std::cmp::Reverse(c.count));
    counts.truncate(TOP_N);
    counts
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use serde_json::json;

    /// Builds the record shape the reader produces for a `tracing` *event*:
    /// a throwaway `name`, with the real identity in `message`.
    fn event(ts: &str, message: &str, fields: Value) -> TelemetryRecord {
        let mut object = fields.as_object().cloned().unwrap_or_default();
        object.insert("message".into(), Value::from(message));
        TelemetryRecord {
            ts: ts.to_string(),
            kind: "event".into(),
            level: "INFO".into(),
            target: "tt_app_lib".into(),
            name: "event crates-tauri/tt-app/src/lib.rs:81".into(),
            tt_task: None,
            tt_build_sha: None,
            duration_ms: None,
            fields: Value::Object(object),
            raw: String::new(),
        }
    }

    fn spawn(ts: &str, executable: &str, duration_ms: i64, outcome: &str) -> TelemetryRecord {
        TelemetryRecord {
            ts: ts.to_string(),
            kind: "span".into(),
            level: "DEBUG".into(),
            target: "tt_exec".into(),
            name: SPAWN_SPAN.into(),
            tt_task: None,
            tt_build_sha: None,
            duration_ms: Some(duration_ms),
            fields: json!({ "process.executable.name": executable, "outcome": outcome }),
            raw: String::new(),
        }
    }

    fn focus(ts: &str, focused: bool) -> TelemetryRecord {
        event(ts, FOCUS_EVENT, json!({ "focused": focused, "window": "main" }))
    }

    fn action(ts: &str, id: &str, screen: &str) -> TelemetryRecord {
        event(ts, ACTION_EVENT, json!({ "action": id, "screen": screen, "detail": "" }))
    }

    #[test]
    fn pairs_focus_events_into_sessions() {
        let records = vec![
            focus("2026-07-25T10:00:00+00:00", true),
            focus("2026-07-25T10:30:00+00:00", false),
            focus("2026-07-25T11:00:00+00:00", true),
            focus("2026-07-25T11:00:30+00:00", false),
        ];
        let summary = summarize("2026-07-25", &records);

        assert_eq!(summary.focus.session_count, 2);
        assert_eq!(summary.focus.focused_ms, 30 * 60 * 1000 + 30 * 1000);
        assert_eq!(summary.focus.longest_ms, 30 * 60 * 1000);
        assert_eq!(summary.focus.departures, 2);
        // The 30-second stretch is a glance, the half hour is not.
        assert_eq!(summary.focus.fragment_count, 1);
        assert!(summary.focus.sessions.iter().all(|s| !s.open_ended));
    }

    /// An app restart emits a second `focused: true` with no intervening
    /// blur. The earlier start must win rather than the stretch restarting.
    #[test]
    fn repeated_focus_gain_does_not_restart_the_session() {
        let records = vec![
            focus("2026-07-25T10:00:00+00:00", true),
            focus("2026-07-25T10:10:00+00:00", true),
            focus("2026-07-25T10:30:00+00:00", false),
        ];
        let summary = summarize("2026-07-25", &records);

        assert_eq!(summary.focus.session_count, 1);
        assert_eq!(summary.focus.focused_ms, 30 * 60 * 1000);
    }

    /// The app can exit (or the day can end) while focused, leaving a gain
    /// with no matching blur. The stretch is closed at the last record and
    /// flagged as the lower bound it is.
    #[test]
    fn unclosed_focus_runs_to_the_last_record() {
        let records = vec![
            focus("2026-07-25T10:00:00+00:00", true),
            action("2026-07-25T10:45:00+00:00", "board.open", "board"),
        ];
        let summary = summarize("2026-07-25", &records);

        assert_eq!(summary.focus.session_count, 1);
        assert_eq!(summary.focus.focused_ms, 45 * 60 * 1000);
        assert!(summary.focus.sessions[0].open_ended);
    }

    #[test]
    fn counts_actions_by_screen_and_id_and_tracks_switches() {
        let records = vec![
            action("2026-07-25T10:00:00+00:00", "board.open", "board"),
            action("2026-07-25T10:00:10+00:00", "board.open", "board"),
            action("2026-07-25T10:00:20+00:00", "agentboard.new_task", "agentboard"),
            action("2026-07-25T10:00:30+00:00", "board.open", "board"),
        ];
        let summary = summarize("2026-07-25", &records);

        assert_eq!(summary.actions.total, 4);
        assert_eq!(summary.actions.screen_switches, 2);
        assert_eq!(
            summary.actions.by_screen,
            vec![
                Count { key: "board".into(), count: 3 },
                Count { key: "agentboard".into(), count: 1 },
            ]
        );
        assert_eq!(summary.actions.by_action[0], Count { key: "board.open".into(), count: 3 });
    }

    #[test]
    fn separates_fired_notifications_from_suppressed_ones() {
        let records = vec![
            event("2026-07-25T10:00:00+00:00", "notify_needs_you: fired", json!({ "edges": 2 })),
            event(
                "2026-07-25T10:01:00+00:00",
                "notify_needs_you: skipped, window focused",
                json!({ "edges": 1 }),
            ),
            event(
                "2026-07-25T10:02:00+00:00",
                "notify_needs_you: skipped, notifications off",
                json!({ "edges": 1 }),
            ),
        ];
        let summary = summarize("2026-07-25", &records);

        assert_eq!(summary.notifications.fired, 1);
        assert_eq!(summary.notifications.skipped, 2);
    }

    #[test]
    fn ranks_executables_by_time_not_call_count() {
        let records = vec![
            spawn("2026-07-25T10:00:00+00:00", "git", 2, "ok"),
            spawn("2026-07-25T10:00:01+00:00", "git", 3, "ok"),
            spawn("2026-07-25T10:00:02+00:00", "git", 2, "ok"),
            spawn("2026-07-25T10:00:03+00:00", "gh", 4000, "non_zero_exit"),
        ];
        let summary = summarize("2026-07-25", &records);

        assert_eq!(summary.machine.spawn_count, 4);
        assert_eq!(summary.machine.total_ms, 4007);
        assert_eq!(summary.machine.failures, 1);
        assert_eq!(summary.machine.by_executable[0].name, "gh");
        assert_eq!(
            summary.machine.by_executable[1],
            ExecutableStat { name: "git".into(), count: 3, total_ms: 7 }
        );
    }

    /// A focused stretch crossing an hour boundary belongs to both hours in
    /// proportion, not entirely to the one it started in.
    #[test]
    fn focus_time_is_split_across_the_hours_it_spans() {
        // Anchored in the local zone so the assertion doesn't depend on where
        // the test runs.
        let start = Local.with_ymd_and_hms(2026, 7, 25, 10, 30, 0).unwrap();
        let end = Local.with_ymd_and_hms(2026, 7, 25, 11, 15, 0).unwrap();
        let records = vec![
            focus(&start.to_rfc3339(), true),
            focus(&end.to_rfc3339(), false),
        ];
        let summary = summarize("2026-07-25", &records);

        assert_eq!(summary.hours[10].focused_ms, 30 * 60 * 1000);
        assert_eq!(summary.hours[11].focused_ms, 15 * 60 * 1000);
        assert_eq!(summary.focus.focused_ms, 45 * 60 * 1000);
    }

    #[test]
    fn always_returns_all_twenty_four_hour_buckets() {
        let summary = summarize("2026-07-25", &[]);

        assert_eq!(summary.hours.len(), 24);
        assert_eq!(summary.record_count, 0);
        assert_eq!(summary.elapsed_ms, 0);
        assert_eq!(summary.first_ts, None);
        assert!(summary.focus.sessions.is_empty());
    }

    /// The reader leaves a span's identity in `name` and an event's in
    /// `message`; a span must never be looked up by `message`, and an event
    /// never by its file:line `name`.
    #[test]
    fn event_identity_comes_from_message_not_name() {
        let record = action("2026-07-25T10:00:00+00:00", "board.open", "board");
        assert_eq!(event_name(&record), ACTION_EVENT);

        let record = spawn("2026-07-25T10:00:00+00:00", "git", 5, "ok");
        assert_eq!(event_name(&record), SPAWN_SPAN);
    }

    #[test]
    fn elapsed_spans_the_first_and_last_record() {
        let records = vec![
            action("2026-07-25T09:00:00+00:00", "board.open", "board"),
            action("2026-07-25T17:30:00+00:00", "board.open", "board"),
        ];
        assert_eq!(summarize("2026-07-25", &records).elapsed_ms, 8 * 3_600_000 + 30 * 60_000);
    }
}
