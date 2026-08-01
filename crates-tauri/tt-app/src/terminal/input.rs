//! Everything travelling toward the shell: keystrokes, pointer events, pastes.
//!
//! The frontend never builds escape sequences. It reports DOM-shaped events and
//! the engine encodes them against live terminal state (kitty keyboard, DECCKM,
//! keypad mode, the negotiated mouse protocol), which is why the types here are
//! plain mirrors of `tt_vt`'s with a `From` impl and nothing else.
//!
//! Every command in this file goes through a `stamp_and_*` accessor, because
//! each is a write on the user's behalf and so must stamp `input_at_ms` — the
//! clock that marks an attention notification answered.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tt_vt::{Input as VtInput, KeyAction, KeyEvent, MouseAction, MouseButton, MouseInput};

use super::session::TermState;

/// Forward raw text to the shell (IME-composed input, the image-paste signal
/// byte) — the plain-text escape hatch, not an escape-sequence path; keystrokes
/// ride [`term_key`]. Queues onto the writer thread, so it never blocks even
/// against a shell that stopped reading.
#[tauri::command]
pub fn term_write(state: State<TermState>, term_id: String, data: String) -> Result<(), String> {
    state.queue_write(&term_id, data.into_bytes())
}

/// A keystroke from the terminal view, in DOM `KeyboardEvent` terms
/// (mirrors `tt_vt::KeyEvent`).
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TermKey {
    code: String,
    key: String,
    action: TermKeyAction,
    #[serde(default)]
    shift: bool,
    #[serde(default)]
    alt: bool,
    #[serde(default)]
    ctrl: bool,
    #[serde(default)]
    meta: bool,
    #[serde(default)]
    caps_lock: bool,
    #[serde(default)]
    num_lock: bool,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum TermKeyAction {
    Press,
    Repeat,
    Release,
}

impl From<TermKey> for KeyEvent {
    fn from(k: TermKey) -> Self {
        KeyEvent {
            code: k.code,
            key: k.key,
            action: match k.action {
                TermKeyAction::Press => KeyAction::Press,
                TermKeyAction::Repeat => KeyAction::Repeat,
                TermKeyAction::Release => KeyAction::Release,
            },
            shift: k.shift,
            alt: k.alt,
            ctrl: k.ctrl,
            meta: k.meta,
            caps_lock: k.caps_lock,
            num_lock: k.num_lock,
        }
    }
}

/// Encode a keystroke in the terminal engine and write the bytes to the
/// shell. Control-channel send: never blocked behind queued output.
#[tauri::command]
pub fn term_key(state: State<TermState>, term_id: String, event: TermKey) -> Result<(), String> {
    state.stamp_and_send(&term_id, VtInput::Key(event.into()))
}

/// A pointer event from the terminal view (mirrors `tt_vt::MouseInput`). The
/// view only sends these while the frame's mode hints say the mouse is tracked,
/// but the engine re-checks, so a stale hint can't inject input.
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TermMouse {
    action: TermMouseAction,
    #[serde(default)]
    button: Option<TermMouseButton>,
    x: u16,
    y: u16,
    #[serde(default)]
    shift: bool,
    #[serde(default)]
    alt: bool,
    #[serde(default)]
    ctrl: bool,
    #[serde(default)]
    any_button: bool,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum TermMouseAction {
    Press,
    Release,
    Motion,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum TermMouseButton {
    Left,
    Middle,
    Right,
}

impl From<TermMouse> for MouseInput {
    fn from(m: TermMouse) -> Self {
        MouseInput {
            action: match m.action {
                TermMouseAction::Press => MouseAction::Press,
                TermMouseAction::Release => MouseAction::Release,
                TermMouseAction::Motion => MouseAction::Motion,
            },
            button: m.button.map(|b| match b {
                TermMouseButton::Left => MouseButton::Left,
                TermMouseButton::Middle => MouseButton::Middle,
                TermMouseButton::Right => MouseButton::Right,
            }),
            x: m.x,
            y: m.y,
            shift: m.shift,
            alt: m.alt,
            ctrl: m.ctrl,
            any_button: m.any_button,
        }
    }
}

/// Forward a pointer event to the program in its negotiated mouse protocol.
#[tauri::command]
pub fn term_mouse(
    state: State<TermState>,
    term_id: String,
    event: TermMouse,
) -> Result<(), String> {
    state.send(&term_id, VtInput::Mouse(event.into()))
}

/// Whether the engine wants confirmation before writing anything: bracketed
/// paste off plus a newline means the paste executes on landing. The caller
/// confirms and retries with `force: true`.
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteReply {
    needs_confirm: bool,
}

/// Paste through the engine's encoder, which strips bytes that could escape the
/// paste bracket (no `ESC[201~` injection) and honors the negotiated bracketed
/// paste mode. A dead engine yields an error rather than a hang.
#[tauri::command]
pub async fn term_paste(
    app: AppHandle,
    term_id: String,
    text: String,
    force: Option<bool>,
) -> Result<PasteReply, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (reply_tx, reply_rx) = std::sync::mpsc::sync_channel::<tt_vt::PasteOutcome>(1);
        app.state::<TermState>().send_expecting_reply(
            &term_id,
            true,
            VtInput::Paste { text, force: force.unwrap_or(false), reply: reply_tx },
        )?;
        reply_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .map(|outcome| PasteReply {
                needs_confirm: outcome == tt_vt::PasteOutcome::NeedsConfirm,
            })
            .map_err(|_| "terminal engine did not answer".to_string())
    })
    .await
    .map_err(|e| format!("paste task failed: {e}"))?
}

/// Reply of [`term_paste_clipboard`]: the clipboard text that was pasted (or
/// held back) plus the same needs-confirm flag as [`term_paste`]. The caller
/// shows the confirm dialog over `text` and retries `term_paste` with
/// `force: true`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardPasteReply {
    needs_confirm: bool,
    text: String,
}

/// Paste the system clipboard into the shell, reading the clipboard in Rust.
/// The webview's `navigator.clipboard.readText()` rejects with
/// `NotAllowedError` under WebKitGTK — the same reason `term_copy` writes the
/// clipboard in Rust — which silently broke the context menu's Paste.
/// The text routes through the same engine paste encoder as [`term_paste`].
#[tauri::command]
pub async fn term_paste_clipboard(
    app: AppHandle,
    term_id: String,
) -> Result<ClipboardPasteReply, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        // An empty or non-text clipboard is a no-op paste, not an error.
        let text = app.clipboard().read_text().unwrap_or_default();
        if text.is_empty() {
            return Ok(ClipboardPasteReply { needs_confirm: false, text });
        }
        let (reply_tx, reply_rx) = std::sync::mpsc::sync_channel::<tt_vt::PasteOutcome>(1);
        app.state::<TermState>().send_expecting_reply(
            &term_id,
            true,
            VtInput::Paste { text: text.clone(), force: false, reply: reply_tx },
        )?;
        reply_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .map(|outcome| ClipboardPasteReply {
                needs_confirm: outcome == tt_vt::PasteOutcome::NeedsConfirm,
                text,
            })
            .map_err(|_| "terminal engine did not answer".to_string())
    })
    .await
    .map_err(|e| format!("paste task failed: {e}"))?
}
