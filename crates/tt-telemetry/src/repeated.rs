//! Warnings and errors that keep recurring. One failed write is noise; the same one
//! hundreds of times in a day is a feature silently broken (a store migration gone
//! wrong once failed every task-status sync for a day while nothing on screen
//! changed). The Doctor screen lists these, and the app toasts each one once.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use crate::{CRASH_EVENT, TelemetryRecord};

/// Occurrences inside the window before a warning counts as repeated.
pub const REPEAT_THRESHOLD: u64 = 20;

/// One recurring warning or error, grouped by where it was logged, what it says,
/// and its error text with the numbers taken out.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepeatedError {
    /// Stable across reads, so the app toasts a group once.
    pub key: String,
    pub level: String,
    pub target: String,
    pub message: String,
    /// The newest occurrence's error text.
    pub error: Option<String>,
    pub count: u64,
    pub first_ts: String,
    pub last_ts: String,
}

/// Repeated warnings and errors at or after `since_ts` (RFC 3339) in the newest two
/// log files under `dir`, most frequent first. Only WARN/ERROR lines are parsed.
pub fn read_repeated_errors(
    dir: &Path,
    since_ts: &str,
    threshold: u64,
) -> crate::Result<Vec<RepeatedError>> {
    let mut records = Vec::new();
    for date in crate::recent_days(dir, 2)? {
        let Ok(content) = std::fs::read_to_string(dir.join(format!("events-{date}.jsonl"))) else {
            continue;
        };
        records.extend(
            content
                .lines()
                .filter(|l| l.contains("\"level\":\"WARN\"") || l.contains("\"level\":\"ERROR\""))
                .filter_map(crate::reader::parse_line),
        );
    }
    Ok(repeated(&records, since_ts, threshold))
}

fn repeated(records: &[TelemetryRecord], since_ts: &str, threshold: u64) -> Vec<RepeatedError> {
    let mut groups: HashMap<String, RepeatedError> = HashMap::new();
    for r in records {
        if r.ts.as_str() < since_ts || !matches!(r.level.as_str(), "WARN" | "ERROR") {
            continue;
        }
        let field = |k: &str| r.fields.get(k).and_then(Value::as_str);
        let message = field("message").unwrap_or_default();
        if message == CRASH_EVENT {
            continue;
        }
        let error = field("error").map(str::to_string);
        let key = format!(
            "{}|{}|{}",
            r.target,
            message,
            error.as_deref().map(without_numbers).unwrap_or_default()
        );
        let group = groups.entry(key.clone()).or_insert_with(|| RepeatedError {
            key,
            level: r.level.clone(),
            target: r.target.clone(),
            message: message.to_string(),
            error: None,
            count: 0,
            first_ts: r.ts.clone(),
            last_ts: r.ts.clone(),
        });
        group.count += 1;
        if r.ts < group.first_ts {
            group.first_ts = r.ts.clone();
        }
        if r.ts >= group.last_ts {
            group.last_ts = r.ts.clone();
            group.error = error;
        }
    }
    let mut out: Vec<RepeatedError> =
        groups.into_values().filter(|g| g.count >= threshold).collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.key.cmp(&b.key)));
    out
}

/// Ids, ports and counts vary between occurrences of one failure.
fn without_numbers(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_number = false;
    for c in s.chars() {
        if c.is_ascii_digit() {
            if !in_number {
                out.push('#');
            }
            in_number = true;
        } else {
            out.push(c);
            in_number = false;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rec(ts: &str, level: &str, message: &str, error: Option<&str>) -> TelemetryRecord {
        let mut fields = json!({ "message": message });
        if let Some(e) = error {
            fields["error"] = json!(e);
        }
        TelemetryRecord {
            ts: ts.to_string(),
            kind: "event".to_string(),
            level: level.to_string(),
            target: "tt_app_lib::store".to_string(),
            name: "event store.rs:1".to_string(),
            tt_task: None,
            tt_build_sha: None,
            duration_ms: None,
            pid: None,
            fields,
            raw: String::new(),
        }
    }

    #[test]
    fn groups_a_recurring_warning_across_varying_numbers() {
        let mut records: Vec<_> = (0..25)
            .map(|i| {
                let ts = format!("2026-10-10T10:{i:02}:00Z");
                let error = format!("no such column: position (row {i})");
                rec(&ts, "WARN", "store: failed to sync", Some(error.as_str()))
            })
            .collect();
        records.push(rec("2026-10-10T11:00:00Z", "WARN", "one-off", None));
        let found = repeated(&records, "2026-10-10T00:00:00Z", 20);
        assert_eq!(found.len(), 1, "the one-off stays under the threshold");
        assert_eq!(found[0].count, 25);
        assert_eq!(found[0].first_ts, "2026-10-10T10:00:00Z");
        assert_eq!(found[0].last_ts, "2026-10-10T10:24:00Z");
        assert_eq!(found[0].error.as_deref(), Some("no such column: position (row 24)"));
    }

    #[test]
    fn ignores_old_records_info_lines_and_crashes() {
        let records: Vec<_> = (0..30)
            .flat_map(|i| {
                let ts = format!("2026-10-10T10:{i:02}:00Z");
                [
                    rec(&ts, "INFO", "noise", None),
                    rec(&ts, "ERROR", CRASH_EVENT, None),
                    rec("2026-10-09T00:00:00Z", "WARN", "yesterday", None),
                ]
            })
            .collect();
        assert!(repeated(&records, "2026-10-10T00:00:00Z", 20).is_empty());
    }

    #[test]
    fn numbers_collapse_to_one_marker() {
        assert_eq!(without_numbers("port 4423 busy after 12s"), "port # busy after #s");
    }
}
