//! The screen coming back: geometry, scrollback, selection, search, theme.
//!
//! One-liners over a [`TermState`] accessor, because the engine owns every
//! policy they touch. Copy and clipboard reads run in Rust rather than the
//! webview: `navigator.clipboard` is unreliable under WebKitGTK.

use serde::Deserialize;
use tauri::{AppHandle, Manager, State};
use tt_vt::{Input as VtInput, SearchMatch, Select as VtSelect};

use super::session::TermState;

/// Enough for "n/N matches" without shipping a megabyte of positions for "e".
const SEARCH_MATCH_LIMIT: usize = 1000;

/// Sent at spawn too, so color queries answer correctly from the first byte.
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TermTheme {
    fg: u32,
    bg: u32,
    #[serde(default)]
    cursor: Option<u32>,
    palette16: [u32; 16],
    dark: bool,
}

impl From<TermTheme> for tt_vt::Theme {
    fn from(t: TermTheme) -> Self {
        tt_vt::Theme { fg: t.fg, bg: t.bg, cursor: t.cursor, palette16: t.palette16, dark: t.dark }
    }
}

/// `cell_width`/`cell_height` are the renderer's cell size in px, 0 if unknown.
#[tauri::command]
pub fn term_resize(
    state: State<TermState>,
    term_id: String,
    cols: u16,
    rows: u16,
    cell_width: Option<u16>,
    cell_height: Option<u16>,
) -> Result<(), String> {
    state.resize(&term_id, cols, rows, cell_width.unwrap_or(0), cell_height.unwrap_or(0))
}

/// `delta` rows, up negative; `None` jumps back to the live bottom.
#[tauri::command]
pub fn term_scroll(
    state: State<TermState>,
    term_id: String,
    delta: Option<isize>,
) -> Result<(), String> {
    state.send(&term_id, VtInput::Scroll(delta))
}

/// Always forwarded; the engine decides whether it means scrollback paging, a
/// wheel report, alternate-scroll arrows, or plain scroll.
#[tauri::command]
pub fn term_wheel(
    state: State<TermState>,
    term_id: String,
    x: u16,
    y: u16,
    lines: i32,
) -> Result<(), String> {
    state.send(&term_id, VtInput::Wheel { x, y, lines })
}

/// `row` is absolute (0 = oldest scrollback row).
#[tauri::command]
pub fn term_scroll_to(state: State<TermState>, term_id: String, row: usize) -> Result<(), String> {
    state.send(&term_id, VtInput::ScrollTo(row))
}

/// One full frame regardless of dirty state. A pane coming back from
/// `display:none` needs it: dirty-only frames never resend clean rows, so the
/// stale canvas would stay stale until a scroll (#47).
#[tauri::command]
pub fn term_request_full(state: State<TermState>, term_id: String) -> Result<(), String> {
    state.send(&term_id, VtInput::RequestFull)
}

/// Frontend panes never unmount, so without this a streaming session renders at
/// the interactive frame cap for a canvas nothing paints.
#[tauri::command]
pub fn term_visibility(
    state: State<TermState>,
    term_id: String,
    visible: bool,
) -> Result<(), String> {
    state.send(&term_id, VtInput::Visibility(visible))
}

/// Drop scrollback, keep the visible screen. The engine forces a full frame so
/// the view learns the depth collapsed.
#[tauri::command]
pub fn term_clear(state: State<TermState>, term_id: String) -> Result<(), String> {
    state.send(&term_id, VtInput::ClearScrollback)
}

/// Viewport cell coordinates. `kind`: drag, word, line, all, clear.
#[tauri::command]
pub fn term_select(
    state: State<TermState>,
    term_id: String,
    kind: String,
    ax: Option<u16>,
    ay: Option<u16>,
    bx: Option<u16>,
    by: Option<u16>,
) -> Result<(), String> {
    let op = match kind.as_str() {
        "drag" => VtSelect::Range {
            ax: ax.unwrap_or(0),
            ay: ay.unwrap_or(0),
            bx: bx.unwrap_or(0),
            by: by.unwrap_or(0),
        },
        "word" => VtSelect::Word { x: ax.unwrap_or(0), y: ay.unwrap_or(0) },
        "line" => VtSelect::Line { x: ax.unwrap_or(0), y: ay.unwrap_or(0) },
        "all" => VtSelect::All,
        "clear" => VtSelect::Clear,
        other => return Err(format!("unknown selection kind: {other}")),
    };
    state.send(&term_id, VtInput::Select(op))
}

/// User-initiated, so unlike OSC 52 it isn't focus-gated.
#[tauri::command]
pub async fn term_copy(app: AppHandle, term_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (reply_tx, reply_rx) = std::sync::mpsc::sync_channel::<Option<String>>(1);
        app.state::<TermState>().send_expecting_reply(&term_id, false, VtInput::Copy(reply_tx))?;
        let text = reply_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .map(|text| text.unwrap_or_default())
            .map_err(|_| "terminal engine did not answer".to_string())?;
        if !text.is_empty() {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            tracing::info!(source = "terminal_copy", bytes = text.len(), "clipboard.write");
            app.clipboard()
                .write_text(text.clone())
                .map_err(|e| format!("clipboard write failed: {e}"))?;
        }
        Ok(text)
    })
    .await
    .map_err(|e| format!("copy task failed: {e}"))?
}

/// Case-insensitive, over scrollback + active area, top to bottom, capped at
/// [`SEARCH_MATCH_LIMIT`].
#[tauri::command]
pub async fn term_search(
    app: AppHandle,
    term_id: String,
    query: String,
) -> Result<Vec<SearchMatch>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (reply_tx, reply_rx) = std::sync::mpsc::sync_channel::<Vec<SearchMatch>>(1);
        app.state::<TermState>().send_expecting_reply(
            &term_id,
            false,
            VtInput::Search { query, limit: SEARCH_MATCH_LIMIT, reply: reply_tx },
        )?;
        reply_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .map_err(|_| "terminal engine did not answer".to_string())
    })
    .await
    .map_err(|e| format!("search task failed: {e}"))?
}

/// On app theme changes, so OSC 10/11 and color-scheme queries keep answering
/// the truth. The engine forces a full frame, so the canvas repaints too.
#[tauri::command]
pub fn term_theme(
    state: State<TermState>,
    term_id: String,
    theme: TermTheme,
) -> Result<(), String> {
    state.send(&term_id, VtInput::Theme(theme.into()))
}

/// The OSC 52 gate: a background pane can't hijack the clipboard.
#[tauri::command]
pub fn term_focus(state: State<TermState>, term_id: String, focused: bool) {
    // A program that asked for focus events (mode 1004) gets CSI I / CSI O. An
    // already-dead PTY still updates the focus gate below.
    let _ = state.send(&term_id, VtInput::Focus(focused));
    state.set_focus(term_id, focused);
}
