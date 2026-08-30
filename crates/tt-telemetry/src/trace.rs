//! Trace reconstruction for the drill-down. Spans are written when they
//! *close* and carry no span id, so a parent's line lands after its children
//! and nothing links them; the only evidence of nesting is time. A record
//! belongs under a span if the same process wrote it inside the span's window
//! (`[ts − duration_ms, ts]`) — good enough to show that a 58 s `task_delete`
//! spent 4 s in subprocesses and the rest in silence.

use chrono::{DateTime, Duration, FixedOffset};

use crate::TelemetryRecord;

/// The half-open time window a record covers: a span from its start to its
/// close, an event a single instant. `None` when `ts` isn't RFC 3339.
fn window(record: &TelemetryRecord) -> Option<(DateTime<FixedOffset>, DateTime<FixedOffset>)> {
    let end = DateTime::parse_from_rfc3339(&record.ts).ok()?;
    let start = end - Duration::milliseconds(record.duration_ms.unwrap_or(0).max(0));
    Some((start, end))
}

/// Every record the same process wrote during `parent`, oldest first — its
/// descendants, flattened. Excludes the parent itself and any span whose own
/// window contains the parent's, since that is an ancestor that happened to
/// close in the same millisecond. Records without a pid can't be placed and
/// are never returned; a `parent` that is not a span has no children.
pub fn children_of<'a>(
    parent: &TelemetryRecord,
    day: &'a [TelemetryRecord],
) -> Vec<&'a TelemetryRecord> {
    let (Some(pid), Some((start, end))) = (parent.pid, window(parent)) else {
        return Vec::new();
    };
    if parent.duration_ms.is_none() {
        return Vec::new();
    }
    let mut children: Vec<(DateTime<FixedOffset>, &TelemetryRecord)> = day
        .iter()
        .filter(|record| {
            record.pid == Some(pid) && !std::ptr::eq(*record, parent) && record.raw != parent.raw
        })
        .filter_map(|record| {
            let (child_start, child_end) = window(record)?;
            let inside = child_end >= start && child_end <= end;
            let is_ancestor =
                record.duration_ms.is_some() && child_start <= start && child_end >= end;
            (inside && !is_ancestor).then_some((child_start, record))
        })
        .collect();
    children.sort_by_key(|(child_start, _)| *child_start);
    children.into_iter().map(|(_, record)| record).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record(ts: &str, name: &str, duration_ms: Option<i64>, pid: Option<i64>) -> TelemetryRecord {
        TelemetryRecord {
            ts: ts.to_string(),
            kind: if duration_ms.is_some() { "span" } else { "event" }.into(),
            level: "INFO".into(),
            target: "tt_app".into(),
            name: name.into(),
            tt_task: None,
            tt_build_sha: None,
            duration_ms,
            pid,
            fields: json!({}),
            raw: format!("{ts} {name}"),
        }
    }

    #[test]
    fn finds_the_children_inside_the_window_and_skips_the_rest() {
        // task_delete ran 10:00:00–10:01:00 in pid 7.
        let parent = record("2026-07-25T10:01:00+00:00", "task_delete", Some(60_000), Some(7));
        let day = vec![
            record("2026-07-25T09:59:59+00:00", "process.spawn", Some(500), Some(7)),
            record("2026-07-25T10:00:03+00:00", "process.spawn", Some(2_000), Some(7)),
            record("2026-07-25T10:00:30+00:00", "window.focus_changed", None, Some(7)),
            record("2026-07-25T10:00:10+00:00", "process.spawn", Some(1_000), Some(8)),
            record("2026-07-25T10:00:20+00:00", "orphan", None, None),
            parent.clone(),
            record("2026-07-25T10:01:00+00:00", "outer", Some(120_000), Some(7)),
            record("2026-07-25T10:01:01+00:00", "process.spawn", Some(100), Some(7)),
        ];

        let names: Vec<&str> = children_of(&parent, &day).iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["process.spawn", "window.focus_changed"]);
    }

    #[test]
    fn events_and_pidless_parents_have_no_children() {
        let event = record("2026-07-25T10:01:00+00:00", "ui.action", None, Some(7));
        let day = vec![record("2026-07-25T10:01:00+00:00", "x", None, Some(7))];
        assert!(children_of(&event, &day).is_empty());

        let span = record("2026-07-25T10:01:00+00:00", "task_delete", Some(60_000), None);
        assert!(children_of(&span, &day).is_empty());
    }
}
