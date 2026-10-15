//! Notes the user sent an agent from the app, taken by the Claude mod in that agent's
//! session. Only the app writes a note; nothing here can, so one agent can never put
//! words in front of another. Routed by the caller's `X-TT-Session`, never an argument.

use serde_json::{Value, json};
use tt_store::{AgentNote, NoteDelivery};

use crate::{Dispatcher, RequestContext};

/// A note the mod took but never acked is offered again after this.
pub const LEASE_MS: i64 = 30_000;
/// How often the mod polls; `0` tells a caller with no session to stop.
pub const POLL_MS: i64 = 3_000;
const ACK_MAX_IDS: usize = 50;

/// The app-side half: who is listening, and what to do once a note lands.
pub trait InboxHost: Send {
    /// The session's mod just polled; the app counts it as listening for a while.
    fn took(&self, session: &str, now_ms: i64);
    /// Stamp the session answered and tell the UI, as typing into it would.
    fn delivered(&self, session: &str, notes: &[AgentNote], how: NoteDelivery, now_ms: i64);
}

pub(crate) fn is_empty_take(value: &Value) -> bool {
    value.get("notes").and_then(Value::as_array).is_some_and(Vec::is_empty)
}

impl Dispatcher {
    pub(crate) fn inbox_take(&self, now_ms: i64, ctx: &RequestContext) -> Result<Value, String> {
        let Some(session) = ctx.session.as_deref() else {
            return Ok(json!({ "notes": [], "pollMs": 0 }));
        };
        if let Some(host) = &self.inbox_host {
            host.took(session, now_ms);
        }
        let notes = self.store.lease_notes(session, now_ms, LEASE_MS).map_err(|e| e.to_string())?;
        Ok(json!({ "notes": notes, "pollMs": POLL_MS }))
    }

    pub(crate) fn inbox_ack(
        &self,
        args: &Value,
        now_ms: i64,
        ctx: &RequestContext,
    ) -> Result<Value, String> {
        let session = ctx
            .session
            .as_deref()
            .ok_or_else(|| "inbox_ack needs the caller's app session".to_string())?;
        let how = match args.get("how").and_then(Value::as_str) {
            Some("midTurn") => NoteDelivery::MidTurn,
            Some("prompt") => NoteDelivery::Prompt,
            _ => return Err("how must be \"midTurn\" or \"prompt\"".to_string()),
        };
        let ids: Vec<i64> = args
            .get("ids")
            .and_then(Value::as_array)
            .ok_or_else(|| "missing required argument: ids".to_string())?
            .iter()
            .map(|v| v.as_i64().ok_or_else(|| "ids must be integers".to_string()))
            .collect::<Result<_, _>>()?;
        if ids.len() > ACK_MAX_IDS {
            return Err(format!("at most {ACK_MAX_IDS} ids per ack"));
        }
        let delivered = self
            .store
            .mark_notes_delivered(session, &ids, how, now_ms)
            .map_err(|e| e.to_string())?;
        if !delivered.is_empty()
            && let Some(host) = &self.inbox_host
        {
            host.delivered(session, &delivered, how, now_ms);
        }
        Ok(json!({ "acked": delivered.len() }))
    }
}
