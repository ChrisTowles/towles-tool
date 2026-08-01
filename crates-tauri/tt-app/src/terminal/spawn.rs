//! Standing a PTY up and tearing it down.
//!
//! `term_start` is the one place a terminal's whole shape is decided: the env
//! the shell sees, its IDE pairing, the vt engine's event sink, and the two
//! threads that outlive the call. The sink is where engine events become
//! `terminal://*` events and agentboard signals, so it is also where a new
//! `tt_vt::Event` gets wired in.
//!
//! A reader that reaches EOF reports an exit only if its id still holds the
//! generation it started with, so a replaced PTY can never close its successor.
//!
//! The env block is the subtle part. Three separate concerns overlap there: the
//! shell's *identity* (declared, never inherited, or behavior would depend on
//! how the app itself was launched), this instance's own vars *scrubbed* so a
//! nested `npm run dev` doesn't collide with the outer one (#39), and the
//! *stamps* that let a Claude session started in this pane find this pane's IDE
//! server and this window's MCP port. Order matters: scrub first, stamp after.

use std::io::{Read, Write};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::sync::{Arc, Mutex};

use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tt_vt::{EngineOptions, Event as VtEvent, Frame, Input as VtInput};

use super::open_path::pwd_from_file_uri;
use super::session::{PtyActivity, Session, TermState, next_generation};
use super::shell::{SHELL_ENV_VAR, default_shell, shell_kind_from_path, start_dir};
use super::view::TermTheme;
use super::{EXIT_EVENT, FRAME_EVENT, MAIN_WINDOW_LABEL, NOTIFY_EVENT};

/// Scrollback kept per terminal, in rows. Lives in the Rust engine, not the
/// webview (xterm.js used to hold this in the JS heap).
const MAX_SCROLLBACK: usize = 10_000;

/// Queued-keystroke cap per terminal. When the shell stops draining its PTY
/// (flow-stopped, stopped job) further input errors instead of blocking or
/// growing without bound.
const INPUT_QUEUE_CAP: usize = 1024;

/// Claude Code picks its notification channel from a fixed list of terminals and
/// sends **nothing** to any other, so OSC 777 used to arrive only when the app
/// happened to start from a Ghostty window. `ghostty` is honest — this VT engine
/// *is* libghostty — while `TERM` stays generic, since `xterm-ghostty` terminfo
/// isn't on every machine.
const TERMINAL_IDENTITY_ENV: [(&str, &str); 3] = [
    ("TERM", "xterm-256color"),
    ("TERM_PROGRAM", "ghostty"),
    ("COLORTERM", "truecolor"),
];

/// Unset for the same reason the others are set: an inherited value speaks for
/// capabilities we don't have. `TERM_PROGRAM_VERSION` ≥ 1.2.0 turns on OSC 9;4
/// progress, which nothing here consumes yet.
const TERMINAL_IDENTITY_ENV_UNSET: [&str; 1] = ["TERM_PROGRAM_VERSION"];

/// Render frame streamed to the frontend; `termId` routes it to the right
/// terminal view.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TermFrame {
    term_id: String,
    frame: Frame,
}

/// Emitted once when a shell exits. A signal death leaves `code` at
/// portable-pty's placeholder, so the frontend prefers `signal` when present.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TermExit {
    term_id: String,
    code: i32,
    signal: Option<String>,
}

/// The program raised attention — a BEL, or OSC 9/777 (Claude Code asking for
/// input). The agentboard badges the session and shows the body.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TermNotify {
    term_id: String,
    /// "bell" or "notify".
    kind: &'static str,
    /// Notification body; absent for a bell.
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<String>,
}

/// Spawn a shell in a fresh PTY rooted at `cwd` (falling back to `$HOME`),
/// replacing any terminal with the same `term_id`. Runs on a blocking task so
/// PTY setup never blocks the main thread.
#[tauri::command]
pub async fn term_start(
    app: AppHandle,
    term_id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    theme: Option<TermTheme>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        term_start_blocking(app, term_id, cols, rows, cwd, theme)
    })
    .await
    .map_err(|e| format!("terminal spawn task failed: {e}"))?
}

fn term_start_blocking(
    app: AppHandle,
    term_id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    theme: Option<TermTheme>,
) -> Result<(), String> {
    let state = app.state::<TermState>();
    state.kill(&term_id);

    let pty = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("failed to open pty: {e}"))?;

    let shell = default_shell(std::env::var(SHELL_ENV_VAR).ok());
    let shell_kind = shell_kind_from_path(&shell);
    let dir = start_dir(cwd);
    // Bookkeeping for the agentboard bridge only — the shell never reads it.
    let env_ports_at_spawn =
        dir.as_deref().map(tt_agentboard::env_drift::read_current_ports).unwrap_or_default();

    // Per-terminal WebSocket MCP server + lockfile (docs/CLAUDE-CODE-IDE.md).
    // Best-effort: a bind failure costs the pairing, never the shell.
    let diag_hub = app.state::<std::sync::Arc<crate::diagnostics::DiagHub>>().inner().clone();
    let ide = dir.as_ref().and_then(|d| {
        match crate::ide::IdeServer::start(app.clone(), term_id.clone(), d.clone(), diag_hub) {
            Ok(server) => Some(server),
            Err(error) => {
                eprintln!("warning: IDE server for terminal {term_id} unavailable: {error}");
                None
            }
        }
    });

    // No exit code to wait for, so tt_exec's span shape doesn't fit — but this
    // is the app's most consequential spawn.
    tt_exec::record_detached_spawn(&shell, &[], "pty");
    let mut cmd = CommandBuilder::new(shell);
    // PATH, HOME, SHELL and the rest survive; this instance's own identity
    // (dev-server port, session/instance stamps, Tauri build config) does not.
    let inherited: Vec<(String, String)> =
        cmd.iter_full_env_as_str().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    cmd.env_clear();
    for (key, value) in tt_exec::scrub_app_instance_env(inherited) {
        cmd.env(key, value);
    }
    for (key, value) in TERMINAL_IDENTITY_ENV {
        cmd.env(key, value);
    }
    for key in TERMINAL_IDENTITY_ENV_UNSET {
        cmd.env_remove(key);
    }
    // The agentboard engine reads these back from /proc to attribute an agent to
    // this session. The instance stamp disambiguates two app instances hosting
    // the same shared session record: each window reports only its own.
    cmd.env(tt_agentboard::procenv::TT_SESSION_ENV, &term_id);
    cmd.env(tt_agentboard::procenv::TT_INSTANCE_ENV, tt_agentboard::procenv::instance_id());
    // The plugin's `.mcp.json` expands `${TT_MCP_PORT:-8787}`, so this stamp is
    // what makes its tools reach the board the user is looking at. Only when
    // actually serving: a lost bind's port would send every session to a dead
    // address, where unset lets the default find whichever instance does serve.
    if let Some(port) = crate::mcp_http::serving_port() {
        cmd.env(tt_mcp::port::MCP_PORT_ENV, port.to_string());
    }
    // An env port match short-circuits Claude Code's lockfile pid/cwd checks, so
    // pairing stays deterministic with several tasks' panes open at once.
    if let Some(ide) = &ide {
        cmd.env("CLAUDE_CODE_SSE_PORT", ide.port().to_string());
    }
    if let Some(dir) = &dir {
        cmd.cwd(dir);
    }
    let child = pty.slave.spawn_command(cmd).map_err(|e| format!("failed to spawn shell: {e}"))?;

    let mut reader =
        pty.master.try_clone_reader().map_err(|e| format!("failed to clone pty reader: {e}"))?;
    let mut writer =
        pty.master.take_writer().map_err(|e| format!("failed to take pty writer: {e}"))?;

    let generation = next_generation();
    let (input_tx, input_rx): (SyncSender<Vec<u8>>, Receiver<Vec<u8>>) =
        sync_channel(INPUT_QUEUE_CAP);

    // Terminal state engine: consumes PTY bytes, produces render frames for
    // the frontend and reply bytes (DA1 etc.) for the shell.
    let activity = Arc::new(PtyActivity::default());
    let pwd: Arc<Mutex<Option<std::path::PathBuf>>> = Arc::default();
    let vt = tt_vt::Session::spawn(EngineOptions { cols, rows, max_scrollback: MAX_SCROLLBACK }, {
        let app = app.clone();
        let term_id = term_id.clone();
        let pty_input = input_tx.clone();
        let activity = Arc::clone(&activity);
        let pwd = Arc::clone(&pwd);
        move |event| match event {
            VtEvent::Frame(frame) => {
                // `Frame::pwd` is set only on the frame where OSC 7 fired, so
                // this holds the last reported dir until the shell moves again.
                if let Some(uri) = frame.pwd.as_deref()
                    && let Some(dir) = pwd_from_file_uri(uri)
                {
                    *pwd.lock().unwrap() = Some(dir);
                }
                // The vt render loop is data-driven, so a frame is direct
                // evidence the agent is working. One relaxed atomic per frame;
                // the emitter wakes only when a quiet pane starts up again.
                if activity.note_output(crate::agentboard::now_ms()) {
                    notify_agentboard(&app);
                }
                let _ = app.emit_to(
                    MAIN_WINDOW_LABEL,
                    FRAME_EVENT,
                    TermFrame { term_id: term_id.clone(), frame },
                );
            }
            // Best-effort: a full input queue drops the reply; the
            // querying program times out like it would on a slow tty.
            VtEvent::PtyReply(bytes) => {
                let _ = pty_input.try_send(bytes);
            }
            // Claude Code raises OSC 777 the moment it wants the user, the
            // fastest evidence of a blocked agent there is — so this wakes the
            // board rather than waiting on the 60s-cached `claude agents` poll.
            VtEvent::Bell => {
                PtyActivity::stamp(&activity.attention_at_ms, crate::agentboard::now_ms());
                notify_agentboard(&app);
                let _ = app.emit_to(
                    MAIN_WINDOW_LABEL,
                    NOTIFY_EVENT,
                    TermNotify { term_id: term_id.clone(), kind: "bell", body: None },
                );
            }
            VtEvent::Notify(body) => {
                PtyActivity::stamp(&activity.attention_at_ms, crate::agentboard::now_ms());
                notify_agentboard(&app);
                let _ = app.emit_to(
                    MAIN_WINDOW_LABEL,
                    NOTIFY_EVENT,
                    TermNotify { term_id: term_id.clone(), kind: "notify", body: Some(body) },
                );
            }
            VtEvent::Clipboard(text) => {
                use tauri_plugin_clipboard_manager::ClipboardExt;
                let focused = app.state::<TermState>().is_focused(&term_id);
                // Focus-gated so a background pane can't silently take the
                // clipboard. Logged either way — a pane repeatedly *trying* is
                // what explains "something keeps overwriting my clipboard".
                tracing::info!(
                    source = "osc52",
                    bytes = text.len(),
                    accepted = focused,
                    "clipboard.write"
                );
                if focused {
                    let _ = app.clipboard().write_text(text);
                }
            }
        }
    })
    .map_err(|e| format!("failed to start terminal engine: {e}"))?;
    let vt_tx = vt.sender();
    // Before the reader pumps the shell's first output, so an early OSC 10/11
    // probe (how Claude Code detects dark vs light) already answers real colors.
    if let Some(theme) = theme {
        let _ = vt_tx.send(VtInput::Theme(theme.into()));
    }

    state.insert(
        term_id.clone(),
        Session {
            master: pty.master,
            input: input_tx,
            vt: vt_tx,
            child,
            generation,
            shell_kind,
            ide,
            dir,
            pwd,
            env_ports_at_spawn,
            activity,
        },
    );

    // Liveness changed (a PTY appeared) — refresh the agentboard snapshot.
    notify_agentboard(&app);

    // Writer thread: drain the queue into the PTY in arrival order. A shell that
    // stops reading blocks only this thread, and the channel cap bounds it.
    std::thread::spawn(move || {
        while let Ok(bytes) = input_rx.recv() {
            if writer.write_all(&bytes).is_err() {
                break;
            }
        }
    });

    // Reader thread. Owns the engine handle, so dropping `vt` below joins that
    // thread exactly once either way. Feeding blocks when the engine is behind,
    // which flow-controls the shell — output can't balloon memory.
    std::thread::spawn(move || {
        let mut buf = [0u8; 65536];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if !vt.send(VtInput::Bytes(buf[..n].to_vec())) {
                        break;
                    }
                }
            }
        }
        // EOF means the shell exited, or this PTY was replaced/killed. Only the
        // generation that still owns the id may report an exit.
        let state = app.state::<TermState>();
        if let Some(mut session) = state.take_if_current(&term_id, generation) {
            let status = session.child.wait().ok();
            let code = status.as_ref().map(|s| s.exit_code() as i32).unwrap_or(0);
            let signal = status.as_ref().and_then(|s| s.signal().map(str::to_string));
            let _ = app.emit_to(MAIN_WINDOW_LABEL, EXIT_EVENT, TermExit { term_id, code, signal });
            notify_agentboard(&app); // shell exited — session no longer live
        }
        drop(vt);
    });

    Ok(())
}

/// Flip `SessionData.live` now rather than at the next 2s scan tick.
pub(super) fn notify_agentboard(app: &AppHandle) {
    if let Some(ab) = app.try_state::<crate::agentboard::Ab>() {
        ab.emit.notify_one();
    }
}

/// Kill one shell (the frontend calls this when a terminal unmounts — an
/// explicit close).
#[tauri::command]
pub fn term_kill(app: AppHandle, term_id: String) {
    // Its own record, so "which pane did the user close, and when" is a log
    // query rather than a repro. The spawn side is recorded in `term_start`.
    tracing::info!(%term_id, "terminal.killed");
    app.state::<TermState>().kill(&term_id);
    notify_agentboard(&app);
}

/// Drop every PTY when the main window goes away (wired to the window
/// Destroyed event in lib.rs) — shells don't survive the app closing.
pub fn on_window_destroyed(app: &AppHandle, label: &str) {
    if label == MAIN_WINDOW_LABEL {
        app.state::<TermState>().kill_all();
    }
}

#[cfg(test)]
mod tests {
    use super::{TERMINAL_IDENTITY_ENV, TERMINAL_IDENTITY_ENV_UNSET};

    /// The point of declaring these is that the shell's view can't depend on
    /// the app's env: the lists must not overlap, nor be scrubbed after.
    #[test]
    fn terminal_identity_is_declared_not_inherited() {
        for (key, _) in TERMINAL_IDENTITY_ENV {
            assert!(!TERMINAL_IDENTITY_ENV_UNSET.contains(&key), "{key} both set and unset");
            assert!(!tt_exec::is_app_instance_env(key), "{key} would be scrubbed after stamping");
        }
        // Set the channel Claude Code needs, without claiming the version that
        // turns on a protocol nothing here consumes.
        assert!(TERMINAL_IDENTITY_ENV.contains(&("TERM_PROGRAM", "ghostty")));
        assert!(TERMINAL_IDENTITY_ENV_UNSET.contains(&"TERM_PROGRAM_VERSION"));
    }
}
