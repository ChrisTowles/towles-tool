//! The Telemetry screen's Agents tab: what the app's own `claude` calls cost, and
//! how long each checkout's agents spent working versus waiting on you. Both are
//! read off records the app already writes — any event carrying a numeric
//! `cost_usd` (`task_suggest`, `next_prompt.model_call`, `clip_suggest.asked`),
//! and `agent.status_changed`, one record per move of a session's shown status.
//!
//! Time is attributed per session: each status record opens a segment that runs
//! to that session's next record, its end (`session.closed`/`session.pruned_ended`)
//! or the range's last record, capped at [`MAX_SEGMENT_MS`] — an agent left
//! waiting overnight, or an app that was quit mid-run, is not hours of either.

use std::collections::{BTreeMap, HashMap};

use serde::Serialize;

use crate::TelemetryRecord;
use crate::attention::{event_name, field_str, parse_ts};

const STATUS_CHANGED: &str = "agent.status_changed";

/// Longest stretch one status record may account for.
pub const MAX_SEGMENT_MS: i64 = 60 * 60_000;

/// Statuses that block on the human: the agent asked, or it errored.
const NEEDS_YOU: [&str; 2] = ["waiting", "error"];

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsSummary {
    /// One row per requested day, empty days included.
    pub spend_by_day: Vec<DaySpend>,
    /// Every cost-carrying event over the range, by message, costliest first.
    pub spend_by_source: Vec<SourceSpend>,
    pub total_usd: f64,
    /// Checkouts by time accounted for, busiest first.
    pub time_by_folder: Vec<FolderTime>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaySpend {
    pub day: String,
    pub usd: f64,
    pub calls: usize,
    /// In `spend_by_source` order; sources with no calls that day are omitted.
    pub by_source: Vec<SourceSpend>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSpend {
    pub source: String,
    pub usd: f64,
    pub calls: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderTime {
    pub folder: String,
    pub working_ms: i64,
    pub waiting_ms: i64,
    pub sessions: usize,
}

fn cost_of(record: &TelemetryRecord) -> Option<f64> {
    record.fields.get("cost_usd")?.as_f64().filter(|usd| usd.is_finite() && *usd >= 0.0)
}

fn add(rows: &mut Vec<SourceSpend>, source: &str, usd: f64) {
    match rows.iter_mut().find(|r| r.source == source) {
        Some(row) => {
            row.usd += usd;
            row.calls += 1;
        }
        None => rows.push(SourceSpend { source: source.to_string(), usd, calls: 1 }),
    }
}

/// Reduce a range's records to the Agents tab. Pure — no clock, no filesystem.
/// `days` seeds the empty rows; records must be in write order.
pub fn summarize_agents(days: &[String], records: &[TelemetryRecord]) -> AgentsSummary {
    let mut by_day: BTreeMap<String, Vec<SourceSpend>> =
        days.iter().map(|d| (d.clone(), Vec::new())).collect();
    let mut by_source: Vec<SourceSpend> = Vec::new();
    for record in records {
        let Some(usd) = cost_of(record) else { continue };
        let source = event_name(record);
        add(&mut by_source, source, usd);
        add(by_day.entry(record.day().to_string()).or_default(), source, usd);
    }
    by_source.sort_by(|a, b| b.usd.total_cmp(&a.usd).then_with(|| a.source.cmp(&b.source)));
    let order = |source: &str| by_source.iter().position(|s| s.source == source);
    let spend_by_day = by_day
        .into_iter()
        .map(|(day, mut sources)| {
            sources.sort_by_key(|s| order(&s.source));
            DaySpend {
                usd: sources.iter().map(|s| s.usd).sum(),
                calls: sources.iter().map(|s| s.calls).sum(),
                day,
                by_source: sources,
            }
        })
        .collect();

    AgentsSummary {
        total_usd: by_source.iter().map(|s| s.usd).sum(),
        spend_by_day,
        spend_by_source: by_source,
        time_by_folder: time_by_folder(records),
    }
}

/// The open segment of one session: when it started, and what it counts as.
struct Open {
    folder: String,
    since_ms: i64,
    working: bool,
    needs_you: bool,
}

fn close(segment: Open, end_ms: i64, folders: &mut BTreeMap<String, FolderTime>) {
    let span = (end_ms - segment.since_ms).clamp(0, MAX_SEGMENT_MS);
    let row = folders.entry(segment.folder.clone()).or_insert_with(|| FolderTime {
        folder: segment.folder,
        working_ms: 0,
        waiting_ms: 0,
        sessions: 0,
    });
    if segment.working {
        row.working_ms += span;
    } else if segment.needs_you {
        row.waiting_ms += span;
    }
}

fn time_by_folder(records: &[TelemetryRecord]) -> Vec<FolderTime> {
    let mut folders: BTreeMap<String, FolderTime> = BTreeMap::new();
    let mut seen: HashMap<String, String> = HashMap::new();
    let mut open: HashMap<String, Open> = HashMap::new();

    let mut last_ms = None;
    for record in records {
        let Some(at_ms) = parse_ts(&record.ts).map(|t| t.timestamp_millis()) else {
            continue;
        };
        last_ms = Some(at_ms);
        match event_name(record) {
            STATUS_CHANGED => {
                let (Some(session), Some(folder)) =
                    (field_str(record, "session"), field_str(record, "folder"))
                else {
                    continue;
                };
                if let Some(prev) = open.remove(session) {
                    close(prev, at_ms, &mut folders);
                }
                seen.insert(session.to_string(), folder.to_string());
                let status = field_str(record, "to").unwrap_or("");
                open.insert(
                    session.to_string(),
                    Open {
                        folder: folder.to_string(),
                        since_ms: at_ms,
                        working: record.fields.get("working").and_then(|w| w.as_bool())
                            == Some(true),
                        needs_you: NEEDS_YOU.contains(&status),
                    },
                );
            }
            "session.closed" | "session.pruned_ended" => {
                let id = field_str(record, "id").or_else(|| field_str(record, "session_id"));
                if let Some(prev) = id.and_then(|id| open.remove(id)) {
                    close(prev, at_ms, &mut folders);
                }
            }
            _ => {}
        }
    }
    if let Some(end_ms) = last_ms {
        for (_, segment) in open.drain() {
            close(segment, end_ms, &mut folders);
        }
    }
    for folder in seen.values() {
        if let Some(row) = folders.get_mut(folder) {
            row.sessions += 1;
        }
    }

    let mut rows: Vec<FolderTime> =
        folders.into_values().filter(|f| f.working_ms + f.waiting_ms > 0).collect();
    rows.sort_by(|a, b| {
        (b.working_ms + b.waiting_ms)
            .cmp(&(a.working_ms + a.waiting_ms))
            .then_with(|| a.folder.cmp(&b.folder))
    });
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn event(ts: &str, message: &str, fields: Value) -> TelemetryRecord {
        let mut object = fields.as_object().cloned().unwrap_or_default();
        object.insert("message".into(), Value::from(message));
        TelemetryRecord {
            pid: None,
            ts: ts.to_string(),
            kind: "event".into(),
            level: "INFO".into(),
            target: "tt_app_lib".into(),
            name: "event crates-tauri/tt-app/src/agentboard.rs:136".into(),
            tt_task: None,
            tt_build_sha: None,
            duration_ms: None,
            fields: Value::Object(object),
            raw: String::new(),
        }
    }

    fn status(ts: &str, session: &str, folder: &str, to: &str, working: bool) -> TelemetryRecord {
        event(
            ts,
            STATUS_CHANGED,
            json!({ "session": session, "folder": folder, "to": to, "working": working }),
        )
    }

    fn days(list: &[&str]) -> Vec<String> {
        list.iter().map(|d| d.to_string()).collect()
    }

    #[test]
    fn spend_rolls_up_by_day_and_source() {
        let records = vec![
            event("2026-07-25T10:00:00Z", "task_suggest", json!({ "cost_usd": 0.25 })),
            event("2026-07-25T11:00:00Z", "task_suggest", json!({ "cost_usd": 0.5 })),
            event("2026-07-26T09:00:00Z", "next_prompt.model_call", json!({ "cost_usd": 1.0 })),
            event("2026-07-26T09:00:00Z", "task_suggest", json!({ "outcome": "error" })),
        ];
        let summary =
            summarize_agents(&days(&["2026-07-25", "2026-07-26", "2026-07-27"]), &records);

        assert_eq!(summary.total_usd, 1.75);
        let sources: Vec<(&str, f64, usize)> =
            summary.spend_by_source.iter().map(|s| (s.source.as_str(), s.usd, s.calls)).collect();
        assert_eq!(
            sources,
            vec![
                ("next_prompt.model_call", 1.0, 1),
                ("task_suggest", 0.75, 2)
            ]
        );
        let per_day: Vec<(&str, f64, usize)> =
            summary.spend_by_day.iter().map(|d| (d.day.as_str(), d.usd, d.calls)).collect();
        assert_eq!(
            per_day,
            vec![
                ("2026-07-25", 0.75, 2),
                ("2026-07-26", 1.0, 1),
                ("2026-07-27", 0.0, 0)
            ]
        );
    }

    #[test]
    fn splits_each_checkouts_time_into_working_and_waiting() {
        let records = vec![
            status("2026-07-25T10:00:00Z", "s1", "feat-a", "busy", true),
            status("2026-07-25T10:20:00Z", "s1", "feat-a", "waiting", false),
            status("2026-07-25T10:30:00Z", "s1", "feat-a", "busy", true),
            status("2026-07-25T10:35:00Z", "s2", "feat-b", "busy", true),
            status("2026-07-25T10:40:00Z", "s1", "feat-a", "complete", false),
            event("2026-07-25T10:45:00Z", "session.closed", json!({ "id": "s2" })),
            event("2026-07-25T11:00:00Z", "window.focus_changed", json!({ "focused": true })),
        ];
        let summary = summarize_agents(&days(&["2026-07-25"]), &records);

        let rows: Vec<(&str, i64, i64, usize)> = summary
            .time_by_folder
            .iter()
            .map(|f| (f.folder.as_str(), f.working_ms / 60_000, f.waiting_ms / 60_000, f.sessions))
            .collect();
        assert_eq!(rows, vec![("feat-a", 30, 10, 1), ("feat-b", 10, 0, 1)]);
    }

    #[test]
    fn an_open_segment_is_capped() {
        let records = vec![
            status("2026-07-25T10:00:00Z", "s1", "feat-a", "waiting", false),
            event("2026-07-25T20:00:00Z", "window.focus_changed", json!({ "focused": true })),
        ];
        let summary = summarize_agents(&days(&["2026-07-25"]), &records);

        assert_eq!(summary.time_by_folder[0].waiting_ms, MAX_SEGMENT_MS);
        assert_eq!(summary.time_by_folder[0].working_ms, 0);
    }
}
