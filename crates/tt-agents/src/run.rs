//! Executing one turn end to end, minus Slack: memory, session, the sealed `claude`
//! process, and the bookkeeping that lets the next turn resume.

use std::path::Path;
use std::time::Duration;

use tt_config::AgentDef;
use tt_store::{AgentReminder, AgentSession, Store, TurnOutcome};

use crate::state::{memory_hash, read_memory, seed_state_dir, state_dir};
use crate::turn::{
    Error, Turn, TurnInput, TurnResult, parse_turn, render_system_prompt, render_turn_prompt,
};

/// All a turn's process inherits. Auth is the CLI's own login under `HOME`; the app's
/// tokens, ports and session stamps stay out.
pub const KEEP_ENV: &[&str] = &["HOME", "PATH", "USER", "LANG", "LC_ALL", "TERM", "TMPDIR"];

/// One batch of work for one agent in one Slack thread.
#[derive(Debug, Clone, PartialEq)]
pub struct Job {
    pub agent: String,
    pub channel: String,
    pub thread: String,
    pub inputs: Vec<TurnInput>,
    /// Slack ts of the messages in this batch, for reactions; empty for a reminder.
    pub message_ts: Vec<String>,
}

/// Run `job` as `agent`, recording the session, any reminder and the audit row.
pub fn execute(
    store: &Store,
    agents_dir: &Path,
    template: &str,
    agent: &AgentDef,
    job: &Job,
    timeout: Duration,
    now_ms: i64,
) -> Result<TurnResult, Error> {
    execute_with("claude", store, agents_dir, template, agent, job, timeout, now_ms)
}

/// [`execute`] with the binary injectable, so a test can stand in a fake `claude`.
#[allow(clippy::too_many_arguments)]
fn execute_with(
    bin: &str,
    store: &Store,
    agents_dir: &Path,
    template: &str,
    agent: &AgentDef,
    job: &Job,
    timeout: Duration,
    now_ms: i64,
) -> Result<TurnResult, Error> {
    let dir = state_dir(agents_dir, &agent.name);
    seed_state_dir(&dir, agent).map_err(|e| Error::Exec(format!("agent folder: {e}")))?;
    let turn_id = store.start_agent_turn(&agent.name, &job.channel, &job.thread, now_ms).ok();
    let session = store.agent_session(&agent.name).ok().flatten();

    let mut result = attempt(bin, agent, &dir, template, job, session.as_ref(), timeout, now_ms);
    if session.is_some() && result.as_ref().is_err_and(Error::is_lost_session) {
        let _ = store.clear_agent_session(&agent.name);
        result = attempt(bin, agent, &dir, template, job, None, timeout, now_ms);
    }

    if let Ok(turn) = &result {
        // Hashed *after* the turn: an edit the agent just made is one it already knows.
        let memory_hash = memory_hash(&read_memory(&dir));
        let session = AgentSession { session_id: turn.session_id.clone(), memory_hash };
        let _ = store.set_agent_session(&agent.name, &session, now_ms);
        if let Some(remind) = &turn.reply.remind {
            let reminder = AgentReminder {
                id: 0,
                agent: agent.name.clone(),
                channel: job.channel.clone(),
                thread_ts: job.thread.clone(),
                note: remind.note.clone(),
                due_at: now_ms + i64::from(remind.in_minutes) * 60_000,
            };
            let _ = store.add_agent_reminder(&reminder, now_ms);
        }
    }
    if let Some(id) = turn_id {
        let (outcome, cost, denials, error) = match &result {
            Ok(t) => (TurnOutcome::Ok, t.cost_usd, t.denials.clone(), None),
            Err(Error::Exec(m)) if m.contains("timed out") => {
                (TurnOutcome::Timeout, None, Vec::new(), Some(m.clone()))
            }
            Err(e) => (TurnOutcome::Error, None, Vec::new(), Some(e.brief())),
        };
        let _ = store.finish_agent_turn(id, outcome, cost, &denials, error.as_deref(), now_ms);
    }
    result
}

#[allow(clippy::too_many_arguments)]
fn attempt(
    bin: &str,
    agent: &AgentDef,
    dir: &Path,
    template: &str,
    job: &Job,
    session: Option<&AgentSession>,
    timeout: Duration,
    now_ms: i64,
) -> Result<TurnResult, Error> {
    let memory = read_memory(dir);
    let fresh_memory = session.is_none_or(|s| s.memory_hash != memory_hash(&memory));
    let system = render_system_prompt(template, agent, dir);
    let prompt = render_turn_prompt(
        &job.thread,
        &job.inputs,
        fresh_memory.then_some(memory.as_str()),
        now_ms,
    );
    let turn = Turn { agent, session: session.map(|s| s.session_id.as_str()), system: &system };
    let argv = turn.argv();
    let args: Vec<&str> = argv.iter().map(String::as_str).collect();
    let out =
        tt_exec::run_sealed(bin, &args, dir, KEEP_ENV, &prompt, timeout).map_err(|e| match e {
            tt_exec::Error::Timeout { timeout, .. } => {
                Error::Exec(format!("timed out after {} min", timeout.as_secs() / 60))
            }
            other => Error::Exec(other.to_string()),
        })?;
    parse_turn(&out.stdout, &out.stderr, out.ok())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A stand-in `claude`: refuses the stale session `old`, otherwise answers with a
    /// reply and a reminder, and logs whether MEMORY.md reached its stdin.
    const FAKE: &str = r#"#!/bin/sh
input=$(cat)
case " $* " in *" --resume old "*) echo "No conversation found with session ID: old" >&2; exit 1;; esac
case "$input" in *"[MEMORY.md"*) echo memory >> calls.log;; *) echo bare >> calls.log;; esac
echo '{"is_error":false,"session_id":"new","total_cost_usd":0.01,"structured_output":{"reply":"hi","remind":{"in_minutes":10,"note":"n"}}}'
"#;

    fn setup() -> (tempfile::TempDir, String, AgentDef, Job) {
        let tmp = tempfile::TempDir::new().unwrap();
        let bin = tmp.path().join("claude");
        std::fs::write(&bin, FAKE).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let agent = AgentDef { name: "atlas".into(), ..Default::default() };
        let job = Job {
            agent: "atlas".into(),
            channel: "D1".into(),
            thread: "1.0".into(),
            inputs: vec![TurnInput::Message { text: "hello".into(), at_ms: 0 }],
            message_ts: vec!["1.0".into()],
        };
        (tmp, bin.display().to_string(), agent, job)
    }

    fn calls(tmp: &tempfile::TempDir) -> String {
        std::fs::read_to_string(tmp.path().join("agents/atlas/calls.log")).unwrap_or_default()
    }

    #[test]
    fn a_turn_saves_its_session_and_reminder_and_sends_memory_only_when_new() {
        let (tmp, bin, agent, job) = setup();
        let store = Store::open_in_memory().unwrap();
        let dir = tmp.path().join("agents");
        let t = Duration::from_secs(10);
        let r = execute_with(&bin, &store, &dir, "{name}", &agent, &job, t, 1_000).unwrap();
        assert_eq!(r.reply.reply, "hi");
        assert_eq!(store.agent_session("atlas").unwrap().unwrap().session_id, "new");
        let due = store.take_due_agent_reminders(1_000 + 10 * 60_000).unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].thread_ts, "1.0");

        execute_with(&bin, &store, &dir, "{name}", &agent, &job, t, 2_000).unwrap();
        assert_eq!(calls(&tmp), "memory\nbare\n", "unchanged memory is not resent");
    }

    #[test]
    fn a_lost_session_is_retried_fresh_with_memory() {
        let (tmp, bin, agent, job) = setup();
        let store = Store::open_in_memory().unwrap();
        let stale = AgentSession { session_id: "old".into(), memory_hash: "x".into() };
        store.set_agent_session("atlas", &stale, 0).unwrap();
        let dir = tmp.path().join("agents");
        execute_with(&bin, &store, &dir, "{name}", &agent, &job, Duration::from_secs(10), 1)
            .unwrap();
        assert_eq!(store.agent_session("atlas").unwrap().unwrap().session_id, "new");
        assert_eq!(calls(&tmp), "memory\n");
    }
}
