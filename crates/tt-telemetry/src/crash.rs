//! Crashes land in the event log like everything else: a Rust panic through the
//! hook [`install_panic_hook`] chains in front of the default one, a WebView
//! error through the app's `crash_report` command. Both write one `app.crash`
//! event, which [`read_crashes`] reads back for the Doctor screen.

use std::panic::PanicHookInfo;
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use crate::TelemetryRecord;

/// The `message` every crash record carries, whatever produced it.
pub const CRASH_EVENT: &str = "app.crash";

/// Longest message or stack a crash record keeps: enough to place the failure,
/// short enough that a crash loop can't bloat the day's file.
pub const CRASH_TEXT_CAP: usize = 2000;

/// One crash, as the Doctor screen lists it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashRecord {
    pub ts: String,
    /// `panic`, `webview-error` or `unhandled-rejection`.
    pub kind: String,
    pub message: String,
    /// `file:line` for a panic, the script URL and position for a WebView error.
    pub location: Option<String>,
    pub stack: Option<String>,
    pub tt_task: Option<String>,
    pub tt_build_sha: Option<String>,
}

/// Chains in front of the current hook, so the default stderr report still
/// prints. Called by [`crate::init`] once the subscriber is up.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // A panic inside the log writer still holds its lock; logging from
        // here would deadlock the dying thread.
        if !crate::layer::writing_on_this_thread() {
            record_panic(info);
        }
        previous(info);
    }));
}

fn record_panic(info: &PanicHookInfo<'_>) {
    let location =
        info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
    let thread = std::thread::current().name().unwrap_or("unnamed").to_string();
    let message = cap_crash_text(panic_message(info));
    tracing::error!(
        crash.kind = "panic",
        crash.message = message.as_str(),
        crash.location = location.as_str(),
        crash.thread = thread.as_str(),
        "app.crash"
    );
}

fn panic_message(info: &PanicHookInfo<'_>) -> String {
    let payload = info.payload();
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "non-string panic payload".to_string()
    }
}

/// Truncates on a char boundary, marking the cut.
pub fn cap_crash_text(text: impl Into<String>) -> String {
    let mut text = text.into();
    if text.len() > CRASH_TEXT_CAP {
        let mut end = CRASH_TEXT_CAP;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push('…');
    }
    text
}

/// Crashes in the newest `days` log files under `dir`, newest first. Only lines
/// naming [`CRASH_EVENT`] are parsed, so a week of busy days stays cheap.
pub fn read_crashes(dir: &Path, days: usize, limit: usize) -> crate::Result<Vec<CrashRecord>> {
    let mut records = Vec::new();
    for date in crate::recent_days(dir, days)? {
        let path = dir.join(format!("events-{date}.jsonl"));
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        records.extend(
            content
                .lines()
                .filter(|line| line.contains(CRASH_EVENT))
                .filter_map(crate::reader::parse_line),
        );
    }
    Ok(recent_crashes(&records, limit))
}

/// Newest first, at most `limit`.
fn recent_crashes(records: &[TelemetryRecord], limit: usize) -> Vec<CrashRecord> {
    let mut crashes: Vec<CrashRecord> = records.iter().filter_map(crash_of).collect();
    crashes.sort_by(|a, b| b.ts.cmp(&a.ts));
    crashes.truncate(limit);
    crashes
}

fn crash_of(record: &TelemetryRecord) -> Option<CrashRecord> {
    let field = |key: &str| record.fields.get(key).and_then(Value::as_str);
    if field("message") != Some(CRASH_EVENT) {
        return None;
    }
    let present = |key: &str| field(key).filter(|v| !v.is_empty()).map(str::to_string);
    Some(CrashRecord {
        ts: record.ts.clone(),
        kind: present("crash.kind").unwrap_or_else(|| "unknown".to_string()),
        message: present("crash.message").unwrap_or_default(),
        location: present("crash.location"),
        stack: present("crash.stack"),
        tt_task: record.tt_task.clone(),
        tt_build_sha: record.tt_build_sha.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record(ts: &str, fields: Value) -> TelemetryRecord {
        TelemetryRecord {
            ts: ts.to_string(),
            kind: "event".to_string(),
            level: "ERROR".to_string(),
            target: "tt_telemetry".to_string(),
            name: "event crash.rs:1".to_string(),
            tt_task: Some("feat-x".to_string()),
            tt_build_sha: Some("abc".to_string()),
            duration_ms: None,
            pid: None,
            fields,
            raw: String::new(),
        }
    }

    #[test]
    fn reads_back_only_crash_events_newest_first() {
        let records = vec![
            record(
                "2026-10-16T10:00:00Z",
                json!({"message": "app.crash", "crash.kind": "panic",
                       "crash.message": "boom", "crash.location": "src/a.rs:3"}),
            ),
            record("2026-10-16T11:00:00Z", json!({"message": "task.created"})),
            record(
                "2026-10-16T12:00:00Z",
                json!({"message": "app.crash", "crash.kind": "webview-error",
                       "crash.message": "x is undefined", "crash.location": "",
                       "crash.stack": "at f (app.js:1:2)"}),
            ),
        ];
        let crashes = recent_crashes(&records, 10);
        assert_eq!(crashes.len(), 2);
        assert_eq!(crashes[0].kind, "webview-error");
        assert_eq!(crashes[0].location, None, "an empty location reads as absent");
        assert_eq!(crashes[0].stack.as_deref(), Some("at f (app.js:1:2)"));
        assert_eq!(crashes[1].location.as_deref(), Some("src/a.rs:3"));
        assert_eq!(crashes[1].tt_task.as_deref(), Some("feat-x"));
        assert_eq!(recent_crashes(&records, 1).len(), 1);
    }

    #[test]
    fn cap_cuts_on_a_char_boundary() {
        let long = "é".repeat(CRASH_TEXT_CAP);
        let capped = cap_crash_text(long);
        assert!(capped.ends_with('…'));
        assert!(capped.len() <= CRASH_TEXT_CAP + '…'.len_utf8());
        assert_eq!(cap_crash_text("short"), "short");
    }

    #[test]
    fn a_panic_is_written_as_a_crash_event() {
        use crate::{EventLog, EventLogLayer};
        use tracing_subscriber::prelude::*;

        let _serialized = crate::serialize_subscriber_tests();
        let dir = tempfile::tempdir().unwrap();
        let layer = EventLogLayer::new(EventLog::new(dir.path(), 7), serde_json::Map::new());
        tracing::subscriber::with_default(tracing_subscriber::registry().with(layer), || {
            let previous = std::panic::take_hook();
            std::panic::set_hook(Box::new(record_panic));
            let _ = std::panic::catch_unwind(|| panic!("kaboom {}", 7));
            std::panic::set_hook(previous);
        });
        let crashes = read_crashes(dir.path(), 7, 10).unwrap();
        assert_eq!(crashes.len(), 1);
        assert_eq!(crashes[0].kind, "panic");
        assert_eq!(crashes[0].message, "kaboom 7");
        assert!(crashes[0].location.as_deref().unwrap().contains("crash.rs"));
    }
}
