//! Background agents a Claude Code session launched and has not heard back
//! from. A session at its prompt with one still out is not waiting on the user:
//! the agent's report will wake it.
//!
//! Read from the parent journal only. A launch is the `Agent` tool result with
//! `status` `async_launched` (keyed by `agentId`) or `teammate_spawned` (keyed
//! by `name`). It ends at a `<task-notification>` naming that `<task-id>`, or a
//! teammate's `idle_notification`. A delivered `SendMessage` starts one again:
//! its result names a `resumedAgentId`, or routes to `@<teammate>`. Unlike
//! `subagents/` mtimes, this holds through a silent ten-minute build.

use std::collections::HashMap;

use serde_json::Value;
use tt_claude_code::TranscriptEntry;

use super::claude_code::parse_timestamp_ms;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct BackgroundAgents {
    /// Every agent launched, keyed as above → when it last started, or `None`
    /// once it reported back.
    started: HashMap<String, Option<i64>>,
}

impl BackgroundAgents {
    pub fn observe(&mut self, entry: &TranscriptEntry) {
        let at = entry.timestamp.as_deref().and_then(parse_timestamp_ms).unwrap_or(0);
        if let Some(r) = &entry.tool_use_result {
            let launched = match r.status.as_deref() {
                Some("async_launched") => r.agent_id.clone(),
                Some("teammate_spawned") => r.name.clone(),
                _ => None,
            };
            if let Some(key) = launched.or_else(|| self.resumed(r)) {
                self.started.insert(key, Some(at));
            }
        }
        if entry.entry_type == "assistant" {
            return;
        }
        let message = entry.message.as_ref().and_then(|m| m.content.as_ref());
        let texts = entry
            .content
            .as_deref()
            .into_iter()
            .chain(message.and_then(|c| c.as_text()))
            .chain(message.into_iter().flat_map(|c| c.text_blocks()));
        for text in texts {
            for task_id in tag_values(text, "<task-id>", "</task-id>") {
                self.ended(task_id, None);
            }
            for (from, idle_at) in idle_notifications(text) {
                self.ended(&from, idle_at);
            }
        }
    }

    /// A message to an unreachable agent fails with `success: false`.
    fn resumed(&self, r: &tt_claude_code::ToolUseResult) -> Option<String> {
        if r.success != Some(true) {
            return None;
        }
        if let Some(id) = &r.resumed_agent_id {
            return Some(id.clone());
        }
        let target = r.routing_target.as_deref()?;
        let name = target.strip_prefix('@').unwrap_or(target);
        self.started.contains_key(name).then(|| name.to_string())
    }

    /// The same notification is re-logged on delivery; one sent before the
    /// latest start is not about this run.
    fn ended(&mut self, key: &str, reported_at: Option<i64>) {
        if let Some(started) = self.started.get_mut(key)
            && reported_at.is_none_or(|t| started.is_none_or(|s| t >= s))
        {
            *started = None;
        }
    }

    /// How many are still out. A launch older than the process now running
    /// the session died with the previous one.
    pub fn running(&self, process_started_at: Option<i64>) -> usize {
        let floor = process_started_at.unwrap_or(0);
        self.started.values().flatten().filter(|at| **at >= floor).count()
    }
}

fn tag_values<'a>(text: &'a str, open: &str, close: &str) -> impl Iterator<Item = &'a str> {
    text.split(open).skip(1).filter_map(move |rest| rest.split_once(close)).map(|(v, _)| v.trim())
}

/// `(from, timestamp)` of each teammate `idle_notification` in `text`.
fn idle_notifications(text: &str) -> impl Iterator<Item = (String, Option<i64>)> + '_ {
    tag_values(text, "<teammate-message", "</teammate-message>").filter_map(|body| {
        let msg: Value = serde_json::from_str(&body[body.find('{')?..]).ok()?;
        if msg.get("type")?.as_str()? != "idle_notification" {
            return None;
        }
        let at = msg.get("timestamp").and_then(Value::as_str).and_then(parse_timestamp_ms);
        Some((msg.get("from")?.as_str()?.to_string(), at))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn line(v: Value) -> String {
        v.to_string()
    }

    fn async_launch(id: &str, ts: &str) -> String {
        line(json!({"type": "user", "timestamp": ts,
            "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_1"}]},
            "toolUseResult": {"status": "async_launched", "agentId": id, "isAsync": true}}))
    }

    fn teammate_launch(name: &str, ts: &str) -> String {
        line(json!({"type": "user", "timestamp": ts,
            "toolUseResult": {"status": "teammate_spawned", "name": name, "agent_id": format!("{name}@s")}}))
    }

    fn task_done(id: &str, ts: &str) -> String {
        line(json!({"type": "queue-operation", "operation": "enqueue", "timestamp": ts,
            "content": format!("<task-notification>\n<task-id>{id}</task-id>\n<status>completed</status>\n</task-notification>")}))
    }

    fn teammate_idle(name: &str, idle_at: &str, ts: &str) -> String {
        let inner = json!({"type": "idle_notification", "from": name, "timestamp": idle_at,
            "idleReason": "available", "result": "done"});
        line(json!({"type": "user", "timestamp": ts, "message": {"role": "user",
            "content": format!("<teammate-message teammate_id=\"{name}\" color=\"blue\">\n{inner}\n</teammate-message>")}}))
    }

    fn send_message(to: &str, ts: &str) -> String {
        line(json!({"type": "user", "timestamp": ts, "toolUseResult": {"success": true,
            "message": format!("Message sent to {to}'s inbox"), "routing": {"target": format!("@{to}")}}}))
    }

    fn observe(bg: &mut BackgroundAgents, line: &str) {
        bg.observe(&serde_json::from_str(line).unwrap());
    }

    fn feed(lines: &[String]) -> BackgroundAgents {
        let mut bg = BackgroundAgents::default();
        lines.iter().for_each(|l| observe(&mut bg, l));
        bg
    }

    const T0: &str = "2026-09-30T22:00:00Z";
    const T1: &str = "2026-09-30T22:10:00Z";
    const T2: &str = "2026-09-30T22:20:00Z";
    const T3: &str = "2026-09-30T22:30:00Z";

    #[test]
    fn a_launch_runs_until_its_notification() {
        let mut bg = feed(&[async_launch("a1", T0), async_launch("a2", T0)]);
        assert_eq!(bg.running(None), 2);
        observe(&mut bg, &task_done("a1", T1));
        assert_eq!(bg.running(None), 1);
        observe(&mut bg, &task_done("a2", T1));
        assert_eq!(bg.running(None), 0);
    }

    /// The screenshot's session: 5a had already gone idle, 5b was still out.
    #[test]
    fn a_teammate_runs_until_it_goes_idle() {
        let bg = feed(&[
            teammate_launch("effect-stage-5a", T0),
            teammate_launch("effect-stage-5b", T1),
            teammate_idle("effect-stage-5a", T1, T1),
        ]);
        assert_eq!(bg.running(None), 1);
    }

    #[test]
    fn a_message_to_an_idle_teammate_starts_it_again() {
        let mut bg = feed(&[
            teammate_launch("t", T0),
            teammate_idle("t", T1, T1),
            send_message("t", T2),
        ]);
        assert_eq!(bg.running(None), 1);
        // The old notification, re-logged on delivery after the resume.
        observe(&mut bg, &teammate_idle("t", T1, T3));
        assert_eq!(bg.running(None), 1);
        observe(&mut bg, &teammate_idle("t", T3, T3));
        assert_eq!(bg.running(None), 0);
    }

    /// Observed: "no agent named 'ci-review' is reachable" left it running.
    #[test]
    fn an_undelivered_message_starts_nothing() {
        let failed =
            line(json!({"type": "user", "timestamp": T2, "toolUseResult": {"success": false,
            "message": "No agent named 't' is reachable.", "routing": {"target": "@t"}}}));
        assert_eq!(
            feed(&[teammate_launch("t", T0), teammate_idle("t", T1, T1), failed]).running(None),
            0
        );
    }

    #[test]
    fn resuming_a_finished_async_agent_runs_it_until_it_reports_again() {
        let resumed =
            line(json!({"type": "user", "timestamp": T2, "toolUseResult": {"success": true,
            "message": "Resuming agent x", "resumedAgentId": "a1"}}));
        let mut bg = feed(&[async_launch("a1", T0), task_done("a1", T1), resumed]);
        assert_eq!(bg.running(None), 1);
        observe(&mut bg, &task_done("a1", T3));
        assert_eq!(bg.running(None), 0);
    }

    #[test]
    fn a_message_to_a_stranger_starts_nothing() {
        assert_eq!(feed(&[send_message("someone", T0)]).running(None), 0);
    }

    #[test]
    fn an_assistant_quoting_a_notification_ends_nothing() {
        let quote =
            line(json!({"type": "assistant", "timestamp": T1, "message": {"role": "assistant",
            "content": [{"type": "text", "text": "<task-notification><task-id>a1</task-id>"}]}}));
        assert_eq!(feed(&[async_launch("a1", T0), quote]).running(None), 1);
    }

    #[test]
    fn launches_from_before_the_process_started_are_dead() {
        let bg = feed(&[async_launch("old", T0), async_launch("new", T2)]);
        assert_eq!(bg.running(parse_timestamp_ms(T1)), 1);
    }

    #[test]
    fn a_completed_foreground_agent_is_not_background() {
        let done = line(json!({"type": "user", "timestamp": T0,
            "toolUseResult": {"status": "completed", "agentId": "fg", "content": []}}));
        assert_eq!(feed(&[done]).running(None), 0);
    }
}
