//! The `stream-json` wire protocol, as a pure parser — no process, no clock, no
//! IO, so it is testable against a recorded transcript.
//!
//! **We deliberately do not model the full protocol.** The SDK's `SDKMessage`
//! union has ~38 variants and grows every release. [`parse_line`] normalizes the
//! handful we render and files everything else under [`AgentEvent::Other`] with
//! its discriminant intact, so a release adding a message type leaves it inert
//! rather than breaking the parser — `Other` is load-bearing, not a TODO. One line
//! can yield several events (an `assistant` message carries thinking/tool_use/text
//! blocks, each rendering separately), hence `Vec<AgentEvent>`.
//!
//! **`Other` is the wrong home for `control_request`** — those are the CLI
//! blocking on an answer (see [`crate::control`]); filing them as inert noise is
//! what makes a session appear to hang.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::control::{ControlRequest, PermissionRequest};
use crate::json::{opt_str_field, str_field};

/// A slash command the session will accept.
///
/// **Two sources with different richness, deliberately one type.** `system/
/// init` lists only names (`slash_commands: string[]`), while `system/
/// commands_changed` sends full objects. Rather than model that split, a
/// name-only command simply has `None` for the rest — so a UI reads one list
/// and gets better labels if and when the richer message arrives.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
    /// Without the leading slash (`tt:plan`, `context`).
    pub name: String,
    pub description: Option<String>,
    /// e.g. `<file>` — what the command expects after its name.
    pub argument_hint: Option<String>,
    /// Alternate names resolving to this command (`/cost` → `/usage`).
    #[serde(default)]
    pub aliases: Vec<String>,
}

impl SlashCommand {
    /// A command known only by name — the `system/init` case.
    fn bare(name: &str) -> Self {
        Self { name: name.to_string(), description: None, argument_hint: None, aliases: Vec::new() }
    }
}

/// A normalized, renderable event from the agent.
///
/// Serialized camelCase because the frontend consumes these verbatim over
/// the Tauri event channel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentEvent {
    /// `system`/`init` — the session handshake. `session_id` is what
    /// `--resume` takes, so it is the one field a caller must retain.
    #[serde(rename_all = "camelCase")]
    Init {
        session_id: String,
        model: String,
        cwd: String,
        tools: Vec<String>,
        permission_mode: String,
        /// Name-only at this point — see [`SlashCommand`].
        slash_commands: Vec<SlashCommand>,
    },
    /// `system`/`commands_changed` — the command set was rebuilt mid-session
    /// (`/reload-skills`, a plugin install). Replaces the list wholesale, and
    /// carries descriptions and argument hints that `init` does not.
    #[serde(rename_all = "camelCase")]
    CommandsChanged { commands: Vec<SlashCommand> },
    /// A complete assistant text block.
    #[serde(rename_all = "camelCase")]
    Text {
        text: String,
        parent_tool_use_id: Option<String>,
    },
    /// An assistant thinking block. The `signature` field is dropped — it is
    /// an opaque attestation blob with nothing to render.
    #[serde(rename_all = "camelCase")]
    Thinking {
        text: String,
        parent_tool_use_id: Option<String>,
    },
    /// The model asking to run a tool.
    #[serde(rename_all = "camelCase")]
    ToolUse {
        id: String,
        name: String,
        input: Value,
        parent_tool_use_id: Option<String>,
    },
    /// The harness reporting what the tool returned. Arrives as a `user`
    /// message, which is why tool results are not on the `assistant` path.
    #[serde(rename_all = "camelCase")]
    ToolResult {
        tool_use_id: String,
        content: String,
        is_error: bool,
    },
    /// `result` — the turn is over. Terminal for a turn, not for the session.
    #[serde(rename_all = "camelCase")]
    Turn {
        subtype: String,
        is_error: bool,
        duration_ms: u64,
        num_turns: u64,
        total_cost_usd: f64,
    },
    /// The CLI is blocked asking whether a tool may run — or, when
    /// `requiresUserInteraction` is set, asking the human a question outright.
    /// **Must be answered** ([`crate::AgentSession::respond`]); until it is,
    /// the agent makes no further progress.
    PermissionRequest(PermissionRequest),
    /// A control request whose subtype we don't serve (`hook_callback`,
    /// `mcp_message`, an elicitation, something added next release).
    /// [`crate::session`] answers it with an error the moment it is parsed —
    /// this variant exists so the feed records that it happened, not so a
    /// caller can handle it.
    #[serde(rename_all = "camelCase")]
    UnsupportedControlRequest { request_id: String, subtype: String },
    /// A protocol message we do not render. Kept so the UI can show a raw
    /// feed and so an unknown message is never a parse error.
    #[serde(rename_all = "camelCase")]
    Other { discriminant: String, raw: Value },
    /// The line was not JSON at all. Claude Code writes diagnostics to stderr,
    /// not stdout, so this means something is genuinely wrong with the pipe.
    #[serde(rename_all = "camelCase")]
    Malformed { line: String },
    /// The agent process ended. **Synthesized by the host** ([`crate::session`]),
    /// not a wire message — it shares this enum so the UI has one ordered feed
    /// rather than a second channel it would have to interleave by hand.
    #[serde(rename_all = "camelCase")]
    Exited { code: Option<i32> },
}

/// The discriminant we file an unrendered message under: `type` plus
/// `subtype` when present (`system/init`), or the inner event type for a
/// `stream_event` envelope (`stream_event/content_block_delta`).
fn discriminant(v: &Value) -> String {
    let ty = v.get("type").and_then(Value::as_str).unwrap_or("unknown");
    if ty == "stream_event" {
        let inner =
            v.get("event").and_then(|e| e.get("type")).and_then(Value::as_str).unwrap_or("unknown");
        return format!("stream_event/{inner}");
    }
    match v.get("subtype").and_then(Value::as_str) {
        Some(sub) => format!("{ty}/{sub}"),
        None => ty.to_string(),
    }
}

/// A `tool_result` block's `content` is either a bare string or an array of
/// content blocks. Flatten to the text a human reads.
fn tool_result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

fn string_list(v: &Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

/// One entry of `commands_changed`. A nameless command is dropped rather than
/// rendered as an unselectable blank row.
fn slash_command(v: &Value) -> Option<SlashCommand> {
    let name = opt_str_field(v, "name")?;
    Some(SlashCommand {
        name,
        description: opt_str_field(v, "description"),
        argument_hint: opt_str_field(v, "argumentHint"),
        aliases: string_list(v, "aliases"),
    })
}

/// Parse one line of the agent's stdout into zero or more renderable events.
///
/// Never fails: an unparseable line becomes [`AgentEvent::Malformed`] and an
/// unrecognized message becomes [`AgentEvent::Other`]. A renderer driven by a
/// long-lived subprocess must not have a error path that silently drops
/// output.
pub fn parse_line(line: &str) -> Vec<AgentEvent> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let Ok(mut v) = serde_json::from_str::<Value>(trimmed) else {
        return vec![AgentEvent::Malformed { line: trimmed.to_string() }];
    };

    // Before the message-stream match: a control request is the one kind of
    // line where doing nothing has a consequence.
    if let Some(req) = ControlRequest::from_value(&mut v) {
        return vec![if req.subtype == "can_use_tool" {
            AgentEvent::PermissionRequest(PermissionRequest::from_control(req))
        } else {
            AgentEvent::UnsupportedControlRequest {
                request_id: req.request_id,
                subtype: req.subtype,
            }
        }];
    }

    match v.get("type").and_then(Value::as_str) {
        Some("system") if v.get("subtype").and_then(Value::as_str) == Some("init") => {
            vec![AgentEvent::Init {
                session_id: str_field(&v, "session_id"),
                model: str_field(&v, "model"),
                cwd: str_field(&v, "cwd"),
                tools: string_list(&v, "tools"),
                permission_mode: str_field(&v, "permissionMode"),
                slash_commands: string_list(&v, "slash_commands")
                    .iter()
                    .map(|n| SlashCommand::bare(n))
                    .collect(),
            }]
        }
        Some("system") if v.get("subtype").and_then(Value::as_str) == Some("commands_changed") => {
            vec![AgentEvent::CommandsChanged {
                commands: v
                    .get("commands")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(slash_command).collect())
                    .unwrap_or_default(),
            }]
        }
        Some("assistant") => {
            let parent = v.get("parent_tool_use_id").and_then(Value::as_str).map(str::to_string);
            content_blocks(&v).iter().filter_map(|b| assistant_block(b, parent.clone())).collect()
        }
        Some("user") => content_blocks(&v).iter().filter_map(user_block).collect(),
        Some("result") => vec![AgentEvent::Turn {
            subtype: str_field(&v, "subtype"),
            is_error: v.get("is_error").and_then(Value::as_bool).unwrap_or(false),
            duration_ms: v.get("duration_ms").and_then(Value::as_u64).unwrap_or(0),
            num_turns: v.get("num_turns").and_then(Value::as_u64).unwrap_or(0),
            total_cost_usd: v.get("total_cost_usd").and_then(Value::as_f64).unwrap_or(0.0),
        }],
        _ => vec![AgentEvent::Other { discriminant: discriminant(&v), raw: v }],
    }
}

fn content_blocks(v: &Value) -> Vec<Value> {
    v.get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn assistant_block(b: &Value, parent_tool_use_id: Option<String>) -> Option<AgentEvent> {
    match b.get("type").and_then(Value::as_str)? {
        "text" => Some(AgentEvent::Text { text: str_field(b, "text"), parent_tool_use_id }),
        "thinking" => {
            Some(AgentEvent::Thinking { text: str_field(b, "thinking"), parent_tool_use_id })
        }
        "tool_use" => Some(AgentEvent::ToolUse {
            id: str_field(b, "id"),
            name: str_field(b, "name"),
            input: b.get("input").cloned().unwrap_or(Value::Null),
            parent_tool_use_id,
        }),
        _ => None,
    }
}

fn user_block(b: &Value) -> Option<AgentEvent> {
    match b.get("type").and_then(Value::as_str)? {
        "tool_result" => Some(AgentEvent::ToolResult {
            tool_use_id: str_field(b, "tool_use_id"),
            content: tool_result_text(b.get("content")),
            is_error: b.get("is_error").and_then(Value::as_bool).unwrap_or(false),
        }),
        _ => None,
    }
}

/// Encode a user turn for the agent's stdin. One JSON object, one line —
/// the newline is the framing, so callers must not add another.
pub fn encode_user_message(text: &str) -> String {
    json!({
        "type": "user",
        "message": { "role": "user", "content": text },
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../tests/fixtures/tool-use-session.jsonl");

    fn parse_fixture() -> Vec<AgentEvent> {
        FIXTURE.lines().flat_map(parse_line).collect()
    }

    #[test]
    fn parses_a_real_tool_using_session() {
        let events = parse_fixture();

        let init = events
            .iter()
            .find(|e| matches!(e, AgentEvent::Init { .. }))
            .expect("recorded session opens with system/init");
        let AgentEvent::Init { session_id, model, permission_mode, tools, slash_commands, .. } =
            init
        else {
            unreachable!()
        };
        assert!(!session_id.is_empty(), "session_id is what --resume takes");
        assert_eq!(model, "claude-haiku-4-5-20251001");
        assert_eq!(permission_mode, "acceptEdits");
        assert!(tools.contains(&"Read".to_string()));
        // init carries names only — the richer form arrives via
        // `commands_changed`, if at all.
        assert!(slash_commands.iter().any(|c| c.name == "context"));
        assert!(
            slash_commands.iter().all(|c| c.description.is_none()),
            "init has no descriptions to give"
        );

        // The tool call and its result are on different message types
        // (assistant vs user) — the pairing is by id, and the renderer
        // depends on it.
        let tool_id = events
            .iter()
            .find_map(|e| match e {
                AgentEvent::ToolUse { id, name, .. } if name == "Read" => Some(id.clone()),
                _ => None,
            })
            .expect("fixture reads note.txt");
        let result = events
            .iter()
            .find_map(|e| match e {
                AgentEvent::ToolResult { tool_use_id, content, .. } if *tool_use_id == tool_id => {
                    Some(content.clone())
                }
                _ => None,
            })
            .expect("the Read result pairs back to its tool_use id");
        assert!(result.contains("hello"));

        assert!(events.iter().any(|e| matches!(e, AgentEvent::Thinking { .. })));
        assert!(
            events
                .iter()
                .any(|e| matches!(e, AgentEvent::Text { text, .. } if text.contains("note.txt")))
        );

        let turn = events
            .iter()
            .find(|e| matches!(e, AgentEvent::Turn { .. }))
            .expect("session ends with a result message");
        let AgentEvent::Turn { subtype, is_error, num_turns, total_cost_usd, .. } = turn else {
            unreachable!()
        };
        assert_eq!(subtype, "success");
        assert!(!is_error);
        assert_eq!(*num_turns, 2);
        assert!(*total_cost_usd > 0.0);
    }

    #[test]
    fn never_drops_a_line() {
        // Every non-blank fixture line must produce at least one event, so a
        // protocol addition can never silently vanish from the feed.
        for line in FIXTURE.lines().filter(|l| !l.trim().is_empty()) {
            assert!(!parse_line(line).is_empty(), "line produced no events: {line}");
        }
    }

    #[test]
    fn commands_changed_upgrades_a_command_to_its_full_form() {
        let events = parse_line(
            r#"{"type":"system","subtype":"commands_changed","commands":[
                 {"name":"usage","description":"Show usage","argumentHint":"","aliases":["cost","stats"]},
                 {"name":"tt:plan","description":"Plan it","argumentHint":"<goal>"},
                 {"description":"nameless, dropped"}
               ]}"#,
        );
        let AgentEvent::CommandsChanged { commands } = &events[0] else {
            panic!("expected CommandsChanged, got {:?}", events[0])
        };
        assert_eq!(commands.len(), 2, "a nameless entry is dropped, not rendered blank");
        assert_eq!(
            commands[0],
            SlashCommand {
                name: "usage".into(),
                description: Some("Show usage".into()),
                // An empty hint collapses to None rather than a blank label.
                argument_hint: None,
                aliases: vec!["cost".into(), "stats".into()],
            }
        );
        assert_eq!(commands[1].argument_hint.as_deref(), Some("<goal>"));
        assert!(commands[1].aliases.is_empty(), "aliases are optional");
    }

    #[test]
    fn unknown_messages_keep_their_discriminant() {
        let events = parse_line(r#"{"type":"system","subtype":"status","message":"hi"}"#);
        assert_eq!(
            events,
            vec![AgentEvent::Other {
                discriminant: "system/status".to_string(),
                raw: serde_json::from_str(r#"{"type":"system","subtype":"status","message":"hi"}"#)
                    .unwrap(),
            }]
        );
    }

    #[test]
    fn stream_events_are_discriminated_by_inner_type() {
        let events =
            parse_line(r#"{"type":"stream_event","event":{"type":"content_block_delta"}}"#);
        let AgentEvent::Other { discriminant, .. } = &events[0] else {
            panic!("expected Other, got {:?}", events[0])
        };
        assert_eq!(discriminant, "stream_event/content_block_delta");
    }

    #[test]
    fn a_brand_new_message_type_is_inert_not_fatal() {
        let events = parse_line(r#"{"type":"some_future_thing","payload":42}"#);
        assert!(
            matches!(&events[0], AgentEvent::Other { discriminant, .. } if discriminant == "some_future_thing")
        );
    }

    #[test]
    fn non_json_becomes_malformed_rather_than_being_dropped() {
        assert_eq!(
            parse_line("not json at all"),
            vec![AgentEvent::Malformed { line: "not json at all".to_string() }]
        );
        assert!(parse_line("   ").is_empty(), "blank lines are framing, not content");
    }

    #[test]
    fn tool_result_content_flattens_both_shapes() {
        assert_eq!(tool_result_text(Some(&json!("plain"))), "plain");
        assert_eq!(
            tool_result_text(Some(&json!([{"type":"text","text":"a"},{"type":"text","text":"b"}]))),
            "a\nb"
        );
        assert_eq!(tool_result_text(None), "");
    }

    #[test]
    fn encoded_user_message_is_one_line_and_round_trips() {
        let line = encode_user_message("hello\nworld");
        assert!(!line.contains('\n'), "the newline is the framing");
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["role"], "user");
        assert_eq!(v["message"]["content"], "hello\nworld");
    }

    #[test]
    fn a_permission_request_is_a_first_class_event_not_other() {
        let events = parse_line(
            r#"{"type":"control_request","request_id":"r1","request":{
                 "subtype":"can_use_tool","tool_name":"Bash",
                 "input":{"command":"ls"},"tool_use_id":"toolu_1"}}"#,
        );
        let AgentEvent::PermissionRequest(req) = &events[0] else {
            panic!("expected PermissionRequest, got {:?}", events[0])
        };
        assert_eq!(req.request_id, "r1");
        assert_eq!(req.tool_name, "Bash");
        assert_eq!(req.tool_use_id.as_deref(), Some("toolu_1"));
    }

    #[test]
    fn an_unservable_control_request_keeps_the_id_needed_to_refuse_it() {
        // It must not become `Other`: the session has to answer this one, and
        // it can only do that if the request_id survives parsing.
        let events = parse_line(
            r#"{"type":"control_request","request_id":"r7","request":{"subtype":"hook_callback"}}"#,
        );
        assert_eq!(
            events,
            vec![AgentEvent::UnsupportedControlRequest {
                request_id: "r7".to_string(),
                subtype: "hook_callback".to_string(),
            }]
        );
    }

    #[test]
    fn the_clis_reply_to_our_own_requests_is_ordinary_noise() {
        // control_response flows the other way — nothing is blocked on it.
        // Its `subtype` sits inside `response`, not at the top level, so the
        // discriminant is the bare type.
        let events = parse_line(r#"{"type":"control_response","response":{"subtype":"success"}}"#);
        assert!(
            matches!(&events[0], AgentEvent::Other { discriminant, .. } if discriminant == "control_response")
        );
    }

    #[test]
    fn subagent_output_carries_its_parent_tool_use_id() {
        let events = parse_line(
            r#"{"type":"assistant","parent_tool_use_id":"toolu_parent",
                "message":{"content":[{"type":"text","text":"from a subagent"}]}}"#,
        );
        assert_eq!(
            events[0],
            AgentEvent::Text {
                text: "from a subagent".to_string(),
                parent_tool_use_id: Some("toolu_parent".to_string()),
            }
        );
    }
}
