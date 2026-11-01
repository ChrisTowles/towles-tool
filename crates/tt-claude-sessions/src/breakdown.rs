//! Per-session turn/tool breakdown — the drill-down behind a Sessions-table
//! row ("why was *this* session huge?").
//!
//! Flat by design: a ranked tool list plus a turn list, not a nested tree.
//! The deep project→date→session→turn→tool treemap this replaces was an
//! explorer nobody explored; the one place per-session depth answers a live
//! question is when the user has already picked a session.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::Result;
use crate::analyzer::{aggregate_session_tools, analyze_session, get_model_name};
use crate::ledger::subagent_transcripts;
use crate::tools::extract_tool_data;
use crate::types::ToolData;
use tt_claude_code::{TranscriptEntry, parse_transcript_file};

pub fn find_session_path(projects_dir: &Path, session_id: &str) -> Result<Option<PathBuf>> {
    for project_entry in std::fs::read_dir(projects_dir)? {
        let project_path = project_entry?.path();
        if !project_path.is_dir() {
            continue;
        }
        let jsonl_path = project_path.join(format!("{session_id}.jsonl"));
        if jsonl_path.exists() {
            return Ok(Some(jsonl_path));
        }
    }
    Ok(None)
}

/// One prompt-or-response step of the session, named after what it did.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnBreakdown {
    /// Human name: `"Turn 3: User"`, `"Read: main.rs"`, `"Bash, Edit, Read"`.
    pub name: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    /// Dominant tool for color-coding; `None` for user prompts.
    pub tool_name: Option<String>,
    pub model: String,
    /// The subagent that took this step; `None` for the session itself.
    pub agent: Option<String>,
}

/// One Agent-tool subagent's share of the session's spend.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentSpend {
    /// The task description it was launched with, else its file stem.
    pub description: String,
    pub agent_type: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: f64,
}

/// Everything the breakdown dialog renders for one session.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBreakdown {
    /// Tools ranked by attributed tokens, with `"Nx"` call counts in `detail`.
    pub tools: Vec<ToolData>,
    /// Session steps in transcript order.
    pub turns: Vec<TurnBreakdown>,
    /// Subagents ranked by in+out tokens.
    pub subagents: Vec<SubagentSpend>,
}

/// The breakdown of the session at `session_path` together with its
/// subagents, so the drill-down accounts for the same spend as its Ledger row.
pub fn load_session_breakdown(session_path: &Path) -> SessionBreakdown {
    let mut all = parse_transcript_file(session_path);
    let mut turns = session_turns(&all, None);
    let mut subagents = Vec::new();
    for sub in subagent_transcripts(session_path) {
        let entries = parse_transcript_file(&sub);
        let meta = subagent_meta(&sub);
        let description = meta
            .description
            .or_else(|| task_line(&entries))
            .unwrap_or_else(|| sub.file_stem().unwrap_or_default().to_string_lossy().into_owned());
        let analysis = analyze_session(&entries);
        turns.extend(session_turns(&entries, Some(&description)));
        subagents.push(SubagentSpend {
            description,
            agent_type: meta.agent_type,
            input_tokens: analysis.input_tokens,
            output_tokens: analysis.output_tokens,
            cost_usd: analysis.cost_usd,
        });
        all.extend(entries);
    }
    subagents.sort_by_key(|s| std::cmp::Reverse(s.input_tokens + s.output_tokens));
    SessionBreakdown { tools: aggregate_session_tools(&all), turns, subagents }
}

/// The first plain line of a subagent's task prompt, for one launched before
/// Claude Code wrote `meta.json`; envelope tags like `<teammate-message>` skipped.
fn task_line(entries: &[TranscriptEntry]) -> Option<String> {
    let text = entries
        .iter()
        .filter(|e| e.entry_type == "user")
        .find_map(|e| e.message.as_ref()?.content.as_ref()?.first_text())?;
    let line = text.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('<'))?;
    Some(match line.char_indices().nth(TASK_LINE_MAX_CHARS) {
        Some((cut, _)) => format!("{}…", &line[..cut]),
        None => line.to_string(),
    })
}

const TASK_LINE_MAX_CHARS: usize = 60;

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubagentMeta {
    description: Option<String>,
    agent_type: Option<String>,
}

/// The `<agent>.meta.json` Claude Code writes beside each subagent transcript.
fn subagent_meta(transcript: &Path) -> SubagentMeta {
    std::fs::read_to_string(transcript.with_extension("meta.json"))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn build_session_breakdown(entries: &[TranscriptEntry]) -> SessionBreakdown {
    SessionBreakdown {
        tools: aggregate_session_tools(entries),
        turns: session_turns(entries, None),
        subagents: Vec::new(),
    }
}

fn session_turns(entries: &[TranscriptEntry], agent: Option<&str>) -> Vec<TurnBreakdown> {
    let mut turns = Vec::new();
    let mut turn_number = 0;
    let mut seen = std::collections::HashSet::new();

    for entry in entries {
        if entry.entry_type != "user" && entry.entry_type != "assistant" {
            continue;
        }
        let Some(message) = &entry.message else {
            continue;
        };
        // Skip streaming re-logs of an already-counted assistant message, the
        // same dedup rule `analyze_session` applies — without it a heavy turn
        // shows up two or three times.
        if let Some(key) = entry.dedup_key()
            && !seen.insert(key)
        {
            continue;
        }
        let role = message.role.as_deref().unwrap_or("");
        if role == "user" {
            turn_number += 1;
        }

        let Some(usage) = &message.usage else {
            continue;
        };
        let input_tokens = usage.input_tokens.unwrap_or(0);
        let output_tokens = usage.output_tokens.unwrap_or(0);
        if input_tokens + output_tokens == 0 {
            continue;
        }

        let tools = extract_tool_data(message.content.as_ref(), input_tokens, output_tokens);
        let (name, tool_name): (String, Option<String>) = if role == "user" {
            (format!("Turn {turn_number}: User"), None)
        } else if tools.len() == 1 {
            let t = &tools[0];
            let name = match &t.detail {
                Some(d) => format!("{}: {}", t.name, d),
                None => t.name.clone(),
            };
            (name, Some(t.name.clone()))
        } else if tools.len() > 1 {
            let mut unique: Vec<String> = Vec::new();
            for t in &tools {
                if !unique.contains(&t.name) {
                    unique.push(t.name.clone());
                }
            }
            let joined = unique.iter().take(3).cloned().collect::<Vec<_>>().join(", ");
            let name = if unique.len() > 3 { format!("{joined}…") } else { joined };
            (name, Some(tools[0].name.clone()))
        } else {
            (format!("Turn {turn_number}: Response"), Some("Response".to_string()))
        };

        turns.push(TurnBreakdown {
            name,
            input_tokens,
            output_tokens,
            tool_name,
            model: get_model_name(message.model.as_deref()),
            agent: agent.map(str::to_string),
        });
    }
    turns
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use tt_claude_code::{Content, Message, Usage};

    fn tool_use_block(name: &str, input: Value) -> Value {
        json!({ "type": "tool_use", "id": "t", "name": name, "input": input })
    }

    fn assistant_entry(input: i64, output: i64, content: Vec<Value>) -> TranscriptEntry {
        TranscriptEntry {
            entry_type: "assistant".to_string(),
            message: Some(Message {
                role: Some("assistant".to_string()),
                model: Some("claude-fable-5".to_string()),
                usage: Some(Usage {
                    input_tokens: Some(input),
                    output_tokens: Some(output),
                    ..Default::default()
                }),
                content: Some(Content::Blocks(content)),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn user_entry(input: i64, output: i64) -> TranscriptEntry {
        TranscriptEntry {
            entry_type: "user".to_string(),
            message: Some(Message {
                role: Some("user".to_string()),
                usage: Some(Usage {
                    input_tokens: Some(input),
                    output_tokens: Some(output),
                    ..Default::default()
                }),
                content: Some(Content::Text("hi".to_string())),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn empty_session_is_empty() {
        let b = build_session_breakdown(&[]);
        assert!(b.turns.is_empty());
        assert!(b.tools.is_empty());
    }

    #[test]
    fn zero_token_turns_are_skipped() {
        let b = build_session_breakdown(&[assistant_entry(0, 0, vec![])]);
        assert!(b.turns.is_empty());
    }

    #[test]
    fn single_tool_turn_named_after_tool() {
        let entries = [
            user_entry(100, 50),
            assistant_entry(200, 100, vec![tool_use_block("Read", json!({"file_path": "/a.rs"}))]),
        ];
        let b = build_session_breakdown(&entries);
        assert_eq!(b.turns.len(), 2);
        assert_eq!(b.turns[0].name, "Turn 1: User");
        assert_eq!(b.turns[0].tool_name, None);
        assert_eq!(b.turns[1].name, "Read: a.rs");
        assert_eq!(b.turns[1].tool_name.as_deref(), Some("Read"));
        assert_eq!(b.turns[1].model, "Fable");
        // Tool aggregation rides the same entries.
        assert_eq!(b.tools.len(), 1);
        assert_eq!(b.tools[0].name, "Read");
        assert_eq!(b.tools[0].detail.as_deref(), Some("1x"));
    }

    #[test]
    fn multi_tool_turn_joins_unique_names() {
        let entries = [assistant_entry(
            300,
            100,
            vec![
                tool_use_block("Read", json!({"file_path": "/a.rs"})),
                tool_use_block("Edit", json!({"file_path": "/a.rs"})),
                tool_use_block("Read", json!({"file_path": "/b.rs"})),
            ],
        )];
        let b = build_session_breakdown(&entries);
        assert_eq!(b.turns[0].name, "Read, Edit");
        assert_eq!(b.turns[0].tool_name.as_deref(), Some("Read"));
    }

    #[test]
    fn streaming_relogs_are_deduped() {
        let mut e = assistant_entry(100, 40, vec![json!({"type": "text", "text": "hi"})]);
        e.request_id = Some("req_1".to_string());
        e.message.as_mut().unwrap().id = Some("msg_1".to_string());
        let entries = [e.clone(), e.clone(), e];
        assert_eq!(build_session_breakdown(&entries).turns.len(), 1);
    }

    #[test]
    fn find_session_path_locates_file() {
        let tmp = tempfile::tempdir().unwrap();
        let proj = tmp.path().join("-home-code-demo");
        std::fs::create_dir(&proj).unwrap();
        let file = proj.join("wanted.jsonl");
        std::fs::write(&file, "{}").unwrap();

        assert_eq!(find_session_path(tmp.path(), "wanted").unwrap(), Some(file));
        assert_eq!(find_session_path(tmp.path(), "missing").unwrap(), None);
    }

    #[test]
    fn load_attributes_subagent_turns_and_spend() {
        let tmp = tempfile::tempdir().unwrap();
        let session = tmp.path().join("abc.jsonl");
        let subagents = tmp.path().join("abc").join("subagents");
        std::fs::create_dir_all(&subagents).unwrap();
        let line = |id: &str, input: i64| {
            format!(
                "{{\"type\":\"assistant\",\"requestId\":\"r-{id}\",\"message\":{{\"id\":\"{id}\",\"role\":\"assistant\",\"model\":\"claude-fable-5\",\"usage\":{{\"input_tokens\":{input},\"output_tokens\":0}},\"content\":[{{\"type\":\"text\",\"text\":\"x\"}}]}}}}\n"
            )
        };
        std::fs::write(&session, line("m0", 10)).unwrap();
        std::fs::write(subagents.join("agent-a.jsonl"), line("m1", 100)).unwrap();
        std::fs::write(
            subagents.join("agent-a.meta.json"),
            r#"{"agentType":"Explore","description":"Find the cable"}"#,
        )
        .unwrap();
        std::fs::write(
            subagents.join("agent-b.jsonl"),
            format!(
                "{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"<teammate-message>\\nTrim the assets tree\\nmore\"}}}}\n{}",
                line("m2", 500)
            ),
        )
        .unwrap();
        std::fs::write(subagents.join("agent-c.jsonl"), line("m3", 1)).unwrap();

        let b = load_session_breakdown(&session);
        let agents: Vec<_> = b.turns.iter().map(|t| t.agent.as_deref()).collect();
        assert_eq!(
            agents,
            [
                None,
                Some("Find the cable"),
                Some("Trim the assets tree"),
                Some("agent-c")
            ]
        );
        assert_eq!(b.subagents.len(), 3);
        assert_eq!(b.subagents[0].description, "Trim the assets tree");
        assert_eq!(b.subagents[0].agent_type, None);
        assert_eq!(b.subagents[1].agent_type.as_deref(), Some("Explore"));
        assert_eq!(b.subagents[1].input_tokens, 100);
        // Fable: 100 * $10 / 1e6
        assert!((b.subagents[1].cost_usd - 0.001).abs() < 1e-9);
    }

    #[test]
    fn plain_response_turn_named_response() {
        let entries = [assistant_entry(
            100,
            40,
            vec![json!({"type": "text", "text": "done"})],
        )];
        let b = build_session_breakdown(&entries);
        assert_eq!(b.turns[0].name, "Turn 0: Response");
        assert_eq!(b.turns[0].tool_name.as_deref(), Some("Response"));
    }
}
