//! The screen coming back: geometry, scrollback, selection, search, theme,
//! focus.
//!
//! These are almost all one-liners over a [`TermState`] accessor, because the
//! engine owns every policy they touch — the view reports a gesture and the
//! engine decides what it means. Copy, search and clipboard reads run in Rust
//! rather than the webview: `navigator.clipboard` is unreliable under
//! WebKitGTK, which silently broke copy-on-select and the context menu's Paste.

use serde::Deserialize;
use tauri::{AppHandle, Manager, State};
use tt_vt::{Input as VtInput, SearchMatch, Select as VtSelect};

use super::session::TermState;

/// Cap on scrollback search results per query — enough for "n/N matches"
/// navigation without shipping a megabyte of positions for `query = "e"`.
const SEARCH_MATCH_LIMIT: usize = 1000;

/// UI theme for a terminal engine (mirrors `tt_vt::Theme`). Sent at spawn, so
/// color queries answer correctly from the first byte, and on every theme
/// change via [`term_theme`].
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

/// Keep the PTY and the terminal engine in sync with the rendered grid.
/// `cell_width`/`cell_height` are the renderer's cell size in px (used for
/// pixel size reports; 0 when unknown).
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

/// Scroll the terminal viewport into scrollback (`delta` rows, up is
/// negative); `None` jumps back to the live bottom.
#[tauri::command]
pub fn term_scroll(
    state: State<TermState>,
    term_id: String,
    delta: Option<isize>,
) -> Result<(), String> {
    state.send(&term_id, VtInput::Scroll(delta))
}

/// A mouse-wheel gesture at viewport cell (`x`, `y`), `lines` rows (up is
/// negative). The view always forwards it; the engine owns the whole policy —
/// scrollback paging, wheel reports, alternate-scroll arrows, or plain scroll.
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

/// Scroll the viewport so the given absolute row (0 = oldest scrollback row)
/// is visible — search prev/next navigation jumps the viewport to a match.
#[tauri::command]
pub fn term_scroll_to(state: State<TermState>, term_id: String, row: usize) -> Result<(), String> {
    state.send(&term_id, VtInput::ScrollTo(row))
}

/// Ask the engine to emit one full frame regardless of dirty state. The view
/// calls this when a pane transitions from hidden (`display:none`) back to
/// visible: dirty-only frames never resend rows the engine considers clean,
/// so a stale canvas would otherwise stay stale until a scroll (#47).
#[tauri::command]
pub fn term_request_full(state: State<TermState>, term_id: String) -> Result<(), String> {
    state.send(&term_id, VtInput::RequestFull)
}

/// Report whether the pane is on-screen. Frontend panes never unmount, so
/// without this a session streaming output keeps rendering at the interactive
/// frame cap for a canvas nothing paints. [`term_request_full`] catches it up.
#[tauri::command]
pub fn term_visibility(
    state: State<TermState>,
    term_id: String,
    visible: bool,
) -> Result<(), String> {
    state.send(&term_id, VtInput::Visibility(visible))
}

/// Drop the terminal's scrollback history, keeping the visible screen
/// (right-click "Clear scrollback"). The engine forces a full frame so the
/// view learns the scrollback depth collapsed.
#[tauri::command]
pub fn term_clear(state: State<TermState>, term_id: String) -> Result<(), String> {
    state.send(&term_id, VtInput::ClearScrollback)
}

/// Apply a selection gesture from the terminal view, in viewport cell
/// coordinates. `kind`: drag (anchor→head range), word (double-click),
/// line (triple-click), all, clear.
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

/// Copy the active selection to the system clipboard, entirely in Rust.
/// User-initiated, so unlike OSC 52 it isn't focus-gated. A dead engine yields
/// an error rather than a hang.
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

/// Case-insensitive substring search over the terminal's full scrollback +
/// active area. Returns match positions (absolute row, column, width) top to
/// bottom, capped at [`SEARCH_MATCH_LIMIT`]. The engine thread answers over
/// a bounded channel; a dead engine yields an error rather than a hang.
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

/// Push the UI theme (default colors, ANSI palette, dark/light) into a
/// running terminal's engine — called on app theme changes so OSC 10/11 and
/// color-scheme queries keep answering the truth. The engine forces a full
/// frame, so the canvas repaints in the new colors without a separate nudge.
#[tauri::command]
pub fn term_theme(
    state: State<TermState>,
    term_id: String,
    theme: TermTheme,
) -> Result<(), String> {
    state.send(&term_id, VtInput::Theme(theme.into()))
}

/// Record which terminal holds keyboard focus. This is what gates OSC 52, so a
/// background pane can't hijack the clipboard.
#[tauri::command]
pub fn term_focus(state: State<TermState>, term_id: String, focused: bool) {
    // Also tell the engine: a program that asked for focus events (mode
    // 1004) gets CSI I / CSI O; the engine is silent otherwise. A terminal
    // whose PTY is already gone still updates the focus gate below.
    let _ = state.send(&term_id, VtInput::Focus(focused));
    state.set_focus(term_id, focused);
}
