//! Notes to an agent: the app writes one, the Claude mod in that session takes it over
//! MCP (`tt_mcp::InboxHost` is this module's other half) and hands it to the model.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tt_store::{AgentNote, NoteDelivery, NoteSource};

use crate::agentboard::now_ms;
use crate::store::{StoreState, with_store};
use crate::terminal::TermState;

/// Consumed by `apps/client/src/lib/inbox.ts`.
pub const INBOX_EVENT: &str = "inbox://changed";

/// A session whose mod polled within this is a note target.
const LISTENING_WINDOW_MS: i64 = 15_000;
/// A delivered note keeps its chip this long.
const DELIVERED_SHOWN_MS: i64 = 60_000;
const BODY_MAX_CHARS: usize = 4_000;

/// Session id → when its mod last polled. Memory only: a restart forgets, and the mod's next
/// poll (seconds away) restores it.
static LAST_TAKE: LazyLock<Mutex<HashMap<String, i64>>> = LazyLock::new(Mutex::default);

fn listening_at(now: i64) -> Vec<String> {
    let mut sessions: Vec<String> = LAST_TAKE
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, at)| now - **at <= LISTENING_WINDOW_MS)
        .map(|(id, _)| id.clone())
        .collect();
    sessions.sort();
    sessions
}

pub struct AppInboxHost {
    pub app: AppHandle,
}

impl tt_mcp::InboxHost for AppInboxHost {
    fn took(&self, session: &str, now_ms: i64) {
        let was = LAST_TAKE.lock().unwrap().insert(session.to_string(), now_ms);
        if was.is_none_or(|at| now_ms - at > LISTENING_WINDOW_MS) {
            let _ = self.app.emit(INBOX_EVENT, ());
        }
    }

    fn delivered(&self, session: &str, notes: &[AgentNote], how: NoteDelivery, now_ms: i64) {
        self.app.state::<TermState>().stamp_input(session);
        let oldest = notes.iter().map(|n| n.created_at).min().unwrap_or(now_ms);
        tracing::info!(
            session,
            how = ?how,
            notes = notes.len(),
            latency_ms = now_ms - oldest,
            "inbox.delivered"
        );
        let _ = self.app.emit(INBOX_EVENT, ());
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxState {
    /// Sessions whose mod is polling, so a note sent there is delivered.
    listening: Vec<String>,
    /// Pending notes, and those delivered in the last minute.
    notes: Vec<AgentNote>,
}

#[tauri::command]
pub fn inbox_state(state: tauri::State<StoreState>) -> Result<InboxState, String> {
    let now = now_ms();
    let notes = with_store(&state, |store| {
        store.recent_notes(now - DELIVERED_SHOWN_MS).map_err(|e| e.to_string())
    })?;
    Ok(InboxState { listening: listening_at(now), notes })
}

/// A user gesture: the note box's Send, or the annotate dialog's. Refuses a session whose mod
/// is not listening rather than queue a note nothing will read.
#[tauri::command]
pub fn inbox_send(
    app: AppHandle,
    state: tauri::State<StoreState>,
    session: String,
    body: String,
    images: Option<Vec<String>>,
    feedback: Option<bool>,
) -> Result<i64, String> {
    let images = images.unwrap_or_default();
    let source = if feedback == Some(true) { NoteSource::Feedback } else { NoteSource::Note };
    let source_name = if feedback == Some(true) { "feedback" } else { "note" };
    let body = body.trim();
    let now = now_ms();
    let result = if body.is_empty() && images.is_empty() {
        Err("the note is empty".to_string())
    } else if body.chars().count() > BODY_MAX_CHARS {
        Err(format!("notes are capped at {BODY_MAX_CHARS} characters"))
    } else if !listening_at(now).contains(&session) {
        Err("this session isn't running the tt mod, so nothing would read the note".to_string())
    } else {
        with_store(&state, |store| {
            store.add_note(&session, body, source, &images, now).map_err(|e| e.to_string())
        })
    };
    let outcome = if result.is_ok() { "ok" } else { "err" };
    tracing::info!(
        session = %session,
        source = source_name,
        len_chars = body.chars().count(),
        images = images.len(),
        outcome,
        "inbox.note_sent"
    );
    if result.is_ok() {
        let _ = app.emit(INBOX_EVENT, ());
    }
    result
}
