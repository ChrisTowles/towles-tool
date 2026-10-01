//! Which sub-agents a Claude Code session has running, read from the parent
//! journal only — the one answer for both the sub-agent list and the
//! background count. Unlike `subagents/` mtimes, this holds through a silent
//! ten-minute build.
//!
//! A foreground agent runs from its `Agent` tool call to that call's result. A
//! result with `status` `async_launched` (keyed by `agentId`) or
//! `teammate_spawned` (keyed by `name`) hands it to the background instead,
//! where it runs until a `<task-notification>` naming that `<task-id>`, or a
//! teammate's `idle_notification`. A delivered `SendMessage` starts one again:
//! its result names a `resumedAgentId`, or routes to `@<teammate>`.

use std::collections::HashMap;

use serde_json::Value;
use tt_claude_code::TranscriptEntry;

use super::claude_code::parse_timestamp_ms;

/// One sub-agent the session launched.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Launch {
    /// When it last started, or `None` once it finished or reported back.
    pub started_at: Option<i64>,
    pub background: bool,
    pub tool_use_id: Option<String>,
    pub agent_id: Option<String>,
    pub agent_type: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SubagentLedger {
    /// Foreground launches by tool-use id; background ones as above.
    launches: HashMap<String, Launch>,
}

impl SubagentLedger {
    pub fn observe(&mut self, entry: &TranscriptEntry) {
        let at = entry.timestamp.as_deref().and_then(parse_timestamp_ms).unwrap_or(0);
        let content = entry.message.as_ref().and_then(|m| m.content.as_ref());
        if entry.entry_type == "assistant" {
            for tool in content.into_iter().flat_map(|c| c.tool_uses()) {
                if let (Some("Agent" | "Task"), Some(id)) = (tool.name(), tool.id()) {
                    let input = |key| tool.input()?.get(key)?.as_str().map(str::to_string);
                    let launch = Launch {
                        started_at: Some(at),
                        tool_use_id: Some(id.to_string()),
                        agent_type: input("subagent_type"),
                        description: input("description"),
                        ..Launch::default()
                    };
                    self.launches.insert(id.to_string(), launch);
                }
            }
            return;
        }
        let mut answered = None;
        for id in content.into_iter().flat_map(|c| c.tool_result_ids()) {
            answered = answered.or(self.launches.remove(id));
        }
        if let Some(r) = &entry.tool_use_result {
            let handed_off = match r.status.as_deref() {
                Some("async_launched") => r.agent_id.clone(),
                Some("teammate_spawned") => r.name.clone(),
                _ => None,
            };
            if let Some(key) = handed_off {
                let launch = Launch {
                    started_at: Some(at),
                    background: true,
                    agent_id: r.agent_id.clone(),
                    ..answered.unwrap_or_default()
                };
                self.launches.insert(key, launch);
            } else if let Some(key) = self.resumed(r) {
                let launch = self.launches.entry(key).or_default();
                launch.started_at = Some(at);
                launch.background = true;
            }
        }
        let texts = entry
            .content
            .as_deref()
            .into_iter()
            .chain(content.and_then(|c| c.as_text()))
            .chain(content.into_iter().flat_map(|c| c.text_blocks()));
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
        self.launches.contains_key(name).then(|| name.to_string())
    }

    /// The same notification is re-logged on delivery; one sent before the
    /// latest start is not about this run.
    fn ended(&mut self, key: &str, reported_at: Option<i64>) {
        if let Some(launch) = self.launches.get_mut(key)
            && launch.background
            && reported_at.is_none_or(|t| launch.started_at.is_none_or(|s| t >= s))
        {
            launch.started_at = None;
        }
    }

    /// Every sub-agent still running, newest first. A launch older than the
    /// process now running the session died with the previous one.
    pub fn running(&self, process_started_at: Option<i64>) -> Vec<&Launch> {
        let floor = process_started_at.unwrap_or(0);
        let mut out: Vec<&Launch> =
            self.launches.values().filter(|l| l.started_at.is_some_and(|at| at >= floor)).collect();
        out.sort_by_key(|l| std::cmp::Reverse(l.started_at));
        out
    }

    /// How many of [`Self::running`] are in the background.
    pub fn background_running(&self, process_started_at: Option<i64>) -> usize {
        self.running(process_started_at).iter().filter(|l| l.background).count()
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

    fn observe(bg: &mut SubagentLedger, line: &str) {
        bg.observe(&serde_json::from_str(line).unwrap());
    }

    fn feed(lines: &[String]) -> SubagentLedger {
        let mut bg = SubagentLedger::default();
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
        assert_eq!(bg.background_running(None), 2);
        observe(&mut bg, &task_done("a1", T1));
        assert_eq!(bg.background_running(None), 1);
        observe(&mut bg, &task_done("a2", T1));
        assert_eq!(bg.background_running(None), 0);
    }

    /// The screenshot's session: 5a had already gone idle, 5b was still out.
    #[test]
    fn a_teammate_runs_until_it_goes_idle() {
        let bg = feed(&[
            teammate_launch("effect-stage-5a", T0),
            teammate_launch("effect-stage-5b", T1),
            teammate_idle("effect-stage-5a", T1, T1),
        ]);
        assert_eq!(bg.background_running(None), 1);
    }

    #[test]
    fn a_message_to_an_idle_teammate_starts_it_again() {
        let mut bg = feed(&[
            teammate_launch("t", T0),
            teammate_idle("t", T1, T1),
            send_message("t", T2),
        ]);
        assert_eq!(bg.background_running(None), 1);
        // The old notification, re-logged on delivery after the resume.
        observe(&mut bg, &teammate_idle("t", T1, T3));
        assert_eq!(bg.background_running(None), 1);
        observe(&mut bg, &teammate_idle("t", T3, T3));
        assert_eq!(bg.background_running(None), 0);
    }

    /// Observed: "no agent named 'ci-review' is reachable" left it running.
    #[test]
    fn an_undelivered_message_starts_nothing() {
        let failed =
            line(json!({"type": "user", "timestamp": T2, "toolUseResult": {"success": false,
            "message": "No agent named 't' is reachable.", "routing": {"target": "@t"}}}));
        assert_eq!(
            feed(&[teammate_launch("t", T0), teammate_idle("t", T1, T1), failed])
                .background_running(None),
            0
        );
    }

    #[test]
    fn resuming_a_finished_async_agent_runs_it_until_it_reports_again() {
        let resumed =
            line(json!({"type": "user", "timestamp": T2, "toolUseResult": {"success": true,
            "message": "Resuming agent x", "resumedAgentId": "a1"}}));
        let mut bg = feed(&[async_launch("a1", T0), task_done("a1", T1), resumed]);
        assert_eq!(bg.background_running(None), 1);
        observe(&mut bg, &task_done("a1", T3));
        assert_eq!(bg.background_running(None), 0);
    }

    #[test]
    fn a_message_to_a_stranger_starts_nothing() {
        assert_eq!(feed(&[send_message("someone", T0)]).background_running(None), 0);
    }

    #[test]
    fn an_assistant_quoting_a_notification_ends_nothing() {
        let quote =
            line(json!({"type": "assistant", "timestamp": T1, "message": {"role": "assistant",
            "content": [{"type": "text", "text": "<task-notification><task-id>a1</task-id>"}]}}));
        assert_eq!(feed(&[async_launch("a1", T0), quote]).background_running(None), 1);
    }

    #[test]
    fn launches_from_before_the_process_started_are_dead() {
        let bg = feed(&[async_launch("old", T0), async_launch("new", T2)]);
        assert_eq!(bg.background_running(parse_timestamp_ms(T1)), 1);
    }

    fn agent_call(id: &str, ts: &str) -> String {
        line(json!({"type": "assistant", "timestamp": ts, "message": {"role": "assistant",
            "content": [{"type": "tool_use", "id": id, "name": "Agent",
                "input": {"description": "Find the bug", "subagent_type": "Explore"}}]}}))
    }

    fn agent_result(id: &str, ts: &str, result: Value) -> String {
        line(json!({"type": "user", "timestamp": ts, "message": {"role": "user",
            "content": [{"type": "tool_result", "tool_use_id": id}]}, "toolUseResult": result}))
    }

    #[test]
    fn a_foreground_agent_runs_until_its_tool_result() {
        let mut bg = feed(&[agent_call("toolu_f", T0)]);
        let running = bg.running(None);
        assert_eq!(running.len(), 1);
        assert_eq!(running[0].tool_use_id.as_deref(), Some("toolu_f"));
        assert_eq!(running[0].agent_type.as_deref(), Some("Explore"));
        assert_eq!(running[0].description.as_deref(), Some("Find the bug"));
        assert_eq!(bg.background_running(None), 0);

        let done = json!({"status": "completed", "agentId": "af"});
        observe(&mut bg, &agent_result("toolu_f", T1, done));
        assert!(bg.running(None).is_empty());
    }

    #[test]
    fn a_backgrounded_call_keeps_what_it_was_launched_as() {
        let launched = json!({"status": "async_launched", "agentId": "a1", "isAsync": true});
        let mut bg = feed(&[
            agent_call("toolu_b", T0),
            agent_result("toolu_b", T1, launched),
        ]);
        let running = bg.running(None);
        assert_eq!(running.len(), 1);
        assert!(running[0].background);
        assert_eq!(running[0].agent_id.as_deref(), Some("a1"));
        assert_eq!(running[0].tool_use_id.as_deref(), Some("toolu_b"));
        assert_eq!(running[0].description.as_deref(), Some("Find the bug"));
        observe(&mut bg, &task_done("a1", T2));
        assert!(bg.running(None).is_empty());
    }

    #[test]
    fn a_foreground_call_from_a_previous_process_is_dead() {
        let bg = feed(&[agent_call("toolu_old", T0), agent_call("toolu_new", T2)]);
        let running = bg.running(parse_timestamp_ms(T1));
        assert_eq!(running.len(), 1);
        assert_eq!(running[0].tool_use_id.as_deref(), Some("toolu_new"));
    }

    #[test]
    fn a_completed_foreground_agent_is_not_background() {
        let done = line(json!({"type": "user", "timestamp": T0,
            "toolUseResult": {"status": "completed", "agentId": "fg", "content": []}}));
        assert_eq!(feed(&[done]).background_running(None), 0);
    }
}
