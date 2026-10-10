//! One agent turn: the `claude -p` argv that locks it down, the prompt it sees, and the
//! reply it must answer with.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use thiserror::Error;
use tt_config::AgentDef;

/// Tools every agent has. Pinned rather than `--restricted`'s default, which also
/// carries subagents, cron, notifications and worktree tools a Slack turn has no use for.
pub const BASE_TOOLS: &[&str] = &["Read", "Edit", "Write", "Glob", "Grep", "WebSearch"];

/// The reply contract: a turn is a question this app acts on, answered as JSON.
pub const REPLY_SCHEMA: &str = r#"{"type":"object","additionalProperties":false,"required":["reply"],"properties":{"reply":{"type":"string","description":"Posted to the Slack thread as-is (Slack mrkdwn)."},"remind":{"type":["object","null"],"additionalProperties":false,"required":["in_minutes","note"],"properties":{"in_minutes":{"type":"integer","minimum":1,"maximum":43200},"note":{"type":"string","description":"What to pick up when the reminder wakes you."}}}}}"#;

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Reply {
    pub reply: String,
    #[serde(default)]
    pub remind: Option<Remind>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Remind {
    pub in_minutes: u32,
    pub note: String,
}

/// What woke the agent, in arrival order.
#[derive(Debug, Clone, PartialEq)]
pub enum TurnInput {
    Message { text: String, at_ms: i64 },
    Reminder { note: String, due_ms: i64 },
}

/// The turn's prompt is not here: it goes in on stdin (see [`render_turn_prompt`]), so
/// Chris's words never land in argv, the spawn log or `ps`.
pub struct Turn<'a> {
    pub agent: &'a AgentDef,
    pub session: Option<&'a str>,
    pub system: &'a str,
}

impl Turn<'_> {
    /// Never `--dangerously-skip-permissions`: `--restricted` ignores every settings file
    /// and confines file tools to the cwd plus `dirs`, and with no one to answer a
    /// prompt anything not allowed is denied.
    pub fn argv(&self) -> Vec<String> {
        let mut tools: Vec<String> = BASE_TOOLS.iter().map(|t| t.to_string()).collect();
        for extra in &self.agent.tools {
            if !tools.contains(extra) {
                tools.push(extra.clone());
            }
        }
        let mut args: Vec<String> = [
            "-p",
            "--output-format",
            "json",
            "--json-schema",
            REPLY_SCHEMA,
            "--restricted",
            "--permission-prompts",
            "none",
            "--permission-mode",
            "acceptEdits",
            "--strict-mcp-config",
            "--append-system-prompt",
            self.system,
        ]
        .into_iter()
        .map(String::from)
        .collect();
        args.push("--tools".into());
        args.push(tools.join(","));
        if let Some(session) = self.session {
            args.extend(["--resume".into(), session.to_string()]);
        }
        if !self.agent.model.trim().is_empty() {
            args.extend(["--model".into(), self.agent.model.clone()]);
        }
        for dir in &self.agent.dirs {
            args.push(format!("--add-dir={}", expand_home(dir).display()));
        }
        if !self.agent.allow.is_empty() {
            let settings = serde_json::json!({ "permissions": { "allow": self.agent.allow } });
            args.extend(["--settings".into(), settings.to_string()]);
        }
        args
    }
}

fn expand_home(dir: &str) -> PathBuf {
    match (dir.strip_prefix("~/"), std::env::var_os("HOME")) {
        (Some(rest), Some(home)) => Path::new(&home).join(rest),
        _ => PathBuf::from(dir),
    }
}

pub fn render_system_prompt(template: &str, agent: &AgentDef, state_dir: &Path) -> String {
    template
        .replace("{name}", &agent.name)
        .replace("{description}", &agent.description)
        .replace("{stateDir}", &state_dir.display().to_string())
}

/// `memory` is `Some` only when MEMORY.md is new to this session. Times are local,
/// `now_ms` included, so "remind me at 9" can be turned into minutes.
pub fn render_turn_prompt(
    thread: &str,
    inputs: &[TurnInput],
    memory: Option<&str>,
    now_ms: i64,
) -> String {
    let mut out = format!("[now {} · Slack thread {thread}]\n", local(now_ms));
    if let Some(memory) = memory {
        out.push_str("\n[MEMORY.md, as it is now]\n");
        out.push_str(memory.trim_end());
        out.push_str("\n[end MEMORY.md]\n");
    }
    for input in inputs {
        match input {
            TurnInput::Message { text, at_ms } => {
                out.push_str(&format!("\nChris ({}): {}\n", local(*at_ms), unescape_slack(text)));
            }
            TurnInput::Reminder { note, due_ms } => {
                out.push_str(&format!("\n[reminder you set, due {}] {note}\n", local(*due_ms)));
            }
        }
    }
    out
}

/// How an agent's words appear in Slack. Agents post as Chris, so the bold name is
/// also what [`crate::route`] recognises as one of their own posts.
pub fn slack_text(agent: &str, reply: &Reply, now_ms: i64) -> String {
    let mut text = format!("{} {}", signature(agent), reply.reply.trim());
    if let Some(remind) = &reply.remind {
        let due = now_ms + i64::from(remind.in_minutes) * 60_000;
        text.push_str(&format!("\n⏰ back here {}", local(due)));
    }
    text
}

pub fn slack_error(agent: &str, error: &Error) -> String {
    format!("{} ⚠️ {}", signature(agent), error.brief())
}

pub(crate) fn signature(agent: &str) -> String {
    format!("*{agent}* ·")
}

fn local(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| t.with_timezone(&chrono::Local).format("%a %Y-%m-%d %H:%M").to_string())
        .unwrap_or_default()
}

/// Slack escapes exactly these three in message text.
fn unescape_slack(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

#[derive(Debug, Error)]
pub enum Error {
    /// Never ran to completion: missing binary, spawn failure, timeout.
    #[error("claude: {0}")]
    Exec(String),
    /// Ran and reported a failure; the payload is the CLI's own message.
    #[error("claude -p failed: {0}")]
    Failed(String),
    #[error("claude answered, but not in the reply shape: {0}")]
    Unparseable(String),
}

impl Error {
    /// The saved session is gone (cleared history, another machine); start a fresh one.
    pub fn is_lost_session(&self) -> bool {
        matches!(self, Error::Failed(m) if m.contains("No conversation found"))
    }

    /// One line for a Slack ⚠️ reply.
    pub fn brief(&self) -> String {
        let text = self.to_string();
        text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("claude failed").to_string()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TurnResult {
    pub session_id: String,
    pub reply: Reply,
    pub cost_usd: Option<f64>,
    /// Tool names the permission floor refused, for the audit log.
    pub denials: Vec<String>,
}

#[derive(Deserialize)]
struct Envelope {
    #[serde(default)]
    is_error: bool,
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    result: Option<String>,
    #[serde(default)]
    structured_output: Option<serde_json::Value>,
    #[serde(default)]
    total_cost_usd: Option<f64>,
    #[serde(default)]
    permission_denials: Vec<Denial>,
}

#[derive(Deserialize)]
struct Denial {
    tool_name: String,
}

/// `stdout`/`stderr`/`ok` of a finished `claude -p --output-format json`.
pub fn parse_turn(stdout: &str, stderr: &str, ok: bool) -> Result<TurnResult, Error> {
    let env: Envelope = match serde_json::from_str(stdout.trim()) {
        Ok(env) => env,
        Err(_) if !ok => {
            let msg = if stderr.trim().is_empty() { stdout } else { stderr };
            return Err(Error::Failed(msg.trim().to_string()));
        }
        Err(e) => return Err(Error::Unparseable(format!("not a claude -p JSON envelope ({e})"))),
    };
    if env.is_error || !ok {
        return Err(Error::Failed(env.result.unwrap_or_default().trim().to_string()));
    }
    let value = env
        .structured_output
        .ok_or_else(|| Error::Unparseable("the envelope carried no structured output".into()))?;
    let reply: Reply =
        serde_json::from_value(value).map_err(|e| Error::Unparseable(e.to_string()))?;
    Ok(TurnResult {
        session_id: env.session_id,
        reply,
        cost_usd: env.total_cost_usd,
        denials: env.permission_denials.into_iter().map(|d| d.tool_name).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent() -> AgentDef {
        AgentDef { name: "atlas".into(), description: "Helper".into(), ..Default::default() }
    }

    fn value_after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        args.iter().position(|a| a == flag).map(|i| args[i + 1].as_str())
    }

    #[test]
    fn the_floor_is_restricted_with_prompts_denied_and_no_mcp() {
        let a = agent();
        let args = Turn { agent: &a, session: None, system: "sys" }.argv();
        assert_eq!(args[0..3], ["-p", "--output-format", "json"]);
        assert!(args.contains(&"--restricted".to_string()));
        assert!(args.contains(&"--strict-mcp-config".to_string()));
        assert_eq!(value_after(&args, "--permission-prompts"), Some("none"));
        assert_eq!(value_after(&args, "--permission-mode"), Some("acceptEdits"));
        assert_eq!(value_after(&args, "--tools"), Some("Read,Edit,Write,Glob,Grep,WebSearch"));
        assert_eq!(value_after(&args, "--json-schema"), Some(REPLY_SCHEMA));
        assert!(!args.iter().any(|a| a.contains("dangerously") || a == "bypassPermissions"));
        assert!(!args.contains(&"--resume".to_string()));
        assert!(!args.contains(&"--settings".to_string()));
        assert!(!args.contains(&"--model".to_string()));
    }

    #[test]
    fn opt_ins_widen_only_what_the_agent_names() {
        let a = AgentDef {
            model: "sonnet".into(),
            dirs: vec!["/srv/repo".into()],
            tools: vec!["Bash".into(), "Read".into()],
            allow: vec!["Bash(git log:*)".into()],
            ..agent()
        };
        let args = Turn { agent: &a, session: Some("sid"), system: "s" }.argv();
        assert_eq!(value_after(&args, "--resume"), Some("sid"));
        assert_eq!(value_after(&args, "--model"), Some("sonnet"));
        assert_eq!(value_after(&args, "--tools"), Some("Read,Edit,Write,Glob,Grep,WebSearch,Bash"));
        assert!(args.contains(&"--add-dir=/srv/repo".to_string()));
        assert_eq!(
            value_after(&args, "--settings"),
            Some(r#"{"permissions":{"allow":["Bash(git log:*)"]}}"#)
        );
    }

    #[test]
    fn the_reply_schema_is_valid_json() {
        let v: serde_json::Value = serde_json::from_str(REPLY_SCHEMA).unwrap();
        assert_eq!(v["required"][0], "reply");
    }

    #[test]
    fn system_prompt_fills_placeholders() {
        let s = render_system_prompt(
            "{name}: {description} @ {stateDir}",
            &agent(),
            Path::new("/a/atlas"),
        );
        assert_eq!(s, "atlas: Helper @ /a/atlas");
    }

    #[test]
    fn turn_prompt_carries_memory_only_when_given_and_unescapes_slack() {
        let inputs = [
            TurnInput::Message { text: "a &lt;b&gt; &amp; c".into(), at_ms: 0 },
            TurnInput::Reminder { note: "book the car".into(), due_ms: 0 },
        ];
        let with = render_turn_prompt("1.0", &inputs, Some("# atlas"), 0);
        assert!(with.contains("[MEMORY.md, as it is now]\n# atlas\n"));
        assert!(with.contains("): a <b> & c\n"));
        assert!(with.contains("] book the car\n"));
        assert!(with.contains("Slack thread 1.0"));
        assert!(!render_turn_prompt("1.0", &inputs, None, 0).contains("MEMORY.md"));
    }

    #[test]
    fn parses_reply_session_cost_and_denials() {
        let raw = r#"{"is_error":false,"session_id":"s1","total_cost_usd":0.03,
            "structured_output":{"reply":"done","remind":{"in_minutes":60,"note":"check"}},
            "permission_denials":[{"tool_name":"Read","tool_input":{}}]}"#;
        let t = parse_turn(raw, "", true).unwrap();
        assert_eq!(t.session_id, "s1");
        assert_eq!(t.reply.reply, "done");
        assert_eq!(t.reply.remind, Some(Remind { in_minutes: 60, note: "check".into() }));
        assert_eq!(t.cost_usd, Some(0.03));
        assert_eq!(t.denials, ["Read"]);
        let plain = r#"{"session_id":"s1","structured_output":{"reply":"ok","remind":null}}"#;
        assert_eq!(parse_turn(plain, "", true).unwrap().reply.remind, None);
    }

    #[test]
    fn failures_keep_the_clis_reason() {
        let e = parse_turn("", "No conversation found with session ID: x\n", false).unwrap_err();
        assert!(e.is_lost_session(), "{e}");
        let e = parse_turn(r#"{"is_error":true,"result":"rate limit"}"#, "", true).unwrap_err();
        assert_eq!(e.brief(), "claude -p failed: rate limit");
        assert!(!e.is_lost_session());
        let e = parse_turn(r#"{"is_error":false,"result":"prose"}"#, "", true).unwrap_err();
        assert!(matches!(e, Error::Unparseable(_)));
    }
}

#[cfg(test)]
mod slack_tests {
    use super::*;

    #[test]
    fn replies_are_signed_and_show_a_set_reminder() {
        let plain = Reply { reply: " done ".into(), remind: None };
        assert_eq!(slack_text("atlas", &plain, 0), "*atlas* · done");
        let reminded =
            Reply { reply: "ok".into(), remind: Some(Remind { in_minutes: 5, note: "n".into() }) };
        assert!(slack_text("atlas", &reminded, 0).contains("\n⏰ back here "));
        let e = Error::Failed("rate limit".into());
        assert_eq!(slack_error("atlas", &e), "*atlas* · ⚠️ claude -p failed: rate limit");
    }
}
