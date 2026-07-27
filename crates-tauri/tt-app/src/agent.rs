//! Agent screen backend: many `tt-agent` sessions, keyed by a
//! frontend-supplied `agent_id`.
//!
//! The transport half of [`tt_agent`] — everything Tauri-shaped that the
//! shared crate is forbidden to know about. Events reach the webview as
//! `agent://event` payloads tagged with `agentId`, the same pattern
//! [`crate::terminal`] uses for `terminal://frame`.
//!
//! Concurrency contract, inherited from the terminal host for the same
//! reason: the session-map lock is only ever held for map surgery, never
//! across a subprocess write or kill. A `claude` process that stops reading
//! its stdin must be able to back up only its own session.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tt_agent::{AgentEvent, AgentOptions, AgentSession, PermissionDecision, Verdict};

pub const AGENT_EVENT: &str = "agent://event";

#[derive(Default)]
pub struct AgentState {
    sessions: Mutex<HashMap<String, Arc<AgentSession>>>,
}

/// One `agent://event` payload: the event plus the id that routes it to a
/// pane. Flattened so the frontend matches on `kind` directly instead of
/// unwrapping a nested envelope.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentEventPayload {
    agent_id: String,
    #[serde(flatten)]
    event: AgentEvent,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartAgent {
    pub agent_id: String,
    pub cwd: String,
    pub prompt: Option<String>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub resume: Option<String>,
}

/// Start an agent and stream its events to the webview.
///
/// Restarting an existing `agent_id` kills the previous session first — the
/// pane is the identity, so leaking the old process would leave an
/// unreachable `claude` running against the same worktree.
#[tauri::command]
pub fn agent_start(
    app: AppHandle,
    state: State<'_, AgentState>,
    req: StartAgent,
) -> Result<(), String> {
    let span = tracing::info_span!(
        "agent.start",
        agent_id = %req.agent_id,
        cwd = %req.cwd,
        resumed = req.resume.is_some(),
    );
    let _enter = span.enter();

    if let Some(existing) = state.sessions.lock().map_err(lock_err)?.remove(&req.agent_id) {
        existing.kill();
    }

    let opts = AgentOptions {
        cwd: PathBuf::from(&req.cwd),
        model: req.model.clone(),
        permission_mode: req.permission_mode.clone(),
        resume: req.resume.clone(),
        allowed_tools: Vec::new(),
    };

    let agent_id = req.agent_id.clone();
    let emitter = app.clone();
    let session = AgentSession::spawn(&opts, move |event| {
        let payload = AgentEventPayload { agent_id: agent_id.clone(), event };
        // A failed emit means the window is gone; the session is torn down
        // through `agent_stop` on the way out, so there is nothing to do here.
        let _ = emitter.emit(AGENT_EVENT, payload);
    })
    .map_err(|e| e.to_string())?;

    let session = Arc::new(session);
    if let Some(prompt) = req.prompt.as_deref().filter(|p| !p.trim().is_empty()) {
        session.send(prompt).map_err(|e| e.to_string())?;
    }
    state.sessions.lock().map_err(lock_err)?.insert(req.agent_id, session);
    tracing::info!("agent started");
    Ok(())
}

/// Send a user turn to a running agent.
#[tauri::command]
pub fn agent_send(
    state: State<'_, AgentState>,
    agent_id: String,
    text: String,
) -> Result<(), String> {
    // Clone the handle out under the lock, then write outside it — see the
    // module's concurrency contract.
    let session = state
        .sessions
        .lock()
        .map_err(lock_err)?
        .get(&agent_id)
        .cloned()
        .ok_or_else(|| format!("no agent session {agent_id}"))?;
    session.send(&text).map_err(|e| e.to_string())
}

/// Answer a permission prompt (or a question tool) the agent is blocked on.
///
/// Instrumented like any other user gesture, and named for what changed rather
/// than reusing `ui.action` — the click already emitted that. The tool name and
/// the verdict are recorded; the tool's *input* deliberately is not, since it
/// carries file contents, commands and typed answers.
///
/// `verdict` is passed in rather than inferred from `decision`'s shape. The
/// caller already decided which of allow/answer/deny/cancel it meant, and the
/// wire shape doesn't recover it — a question answered by allowing the call
/// with no picks is indistinguishable from a plain allow, so re-deriving here
/// silently logged "Skip" as "allow" and fed the Telemetry screen a verdict the
/// user never chose. It arrives as a [`Verdict`] rather than a string so a
/// frontend typo fails the call instead of poisoning the log it feeds.
#[tauri::command]
pub fn agent_respond(
    state: State<'_, AgentState>,
    agent_id: String,
    request_id: String,
    tool_name: String,
    verdict: Verdict,
    decision: PermissionDecision,
) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .map_err(lock_err)?
        .get(&agent_id)
        .cloned()
        .ok_or_else(|| format!("no agent session {agent_id}"))?;
    session.respond(&request_id, &decision).map_err(|e| e.to_string())?;
    tracing::info!(agent_id = %agent_id, tool = %tool_name, %verdict, "agent.permission_answered");
    Ok(())
}

/// Stop an agent and forget it. Idempotent: stopping an already-exited
/// session is a no-op, because the pane close path can't know whether the
/// process died on its own first.
#[tauri::command]
pub fn agent_stop(state: State<'_, AgentState>, agent_id: String) -> Result<(), String> {
    let session = state.sessions.lock().map_err(lock_err)?.remove(&agent_id);
    if let Some(session) = session {
        session.kill();
        tracing::info!(agent_id = %agent_id, "agent stopped");
    }
    Ok(())
}

fn lock_err<E>(_: E) -> String {
    "agent state lock poisoned".to_string()
}
