//! Standing a PTY up and tearing it down.
//!
//! `term_start` decides a terminal's whole shape: the env the shell sees, its
//! IDE pairing, the vt event sink, and the two threads that outlive the call.
//! The sink is where a new `tt_vt::Event` gets wired in.
//!
//! Three concerns overlap in the env block, in this order: the shell's declared
//! *identity*, this instance's own vars *scrubbed* so a nested `bun run dev`
//! can't collide with the outer one (#39), then the *stamps* pointing a Claude
//! session here at this pane's IDE server and this window's MCP port.

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

const MAX_SCROLLBACK: usize = 10_000;

/// A shell that stops draining its PTY makes further input error rather than
/// block or grow without bound.
const INPUT_QUEUE_CAP: usize = 1024;

/// Claude Code picks its notification channel from a fixed list of terminals, so
/// OSC 777 used to arrive only when the app started from a Ghostty window.
/// `ghostty` is honest — this VT engine *is* libghostty — while `TERM` stays
/// generic, since `xterm-ghostty` terminfo isn't on every machine.
const TERMINAL_IDENTITY_ENV: [(&str, &str); 3] = [
    ("TERM", "xterm-256color"),
    ("TERM_PROGRAM", "ghostty"),
    ("COLORTERM", "truecolor"),
];

/// ≥ 1.2.0 turns on OSC 9;4 progress, which nothing here consumes yet.
const TERMINAL_IDENTITY_ENV_UNSET: [&str; 1] = ["TERM_PROGRAM_VERSION"];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TermFrame {
    term_id: String,
    frame: Frame,
}

/// A signal death leaves `code` at portable-pty's placeholder, so the frontend
/// prefers `signal` when present.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TermExit {
    term_id: String,
    code: i32,
    signal: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TermNotify {
    term_id: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<String>,
}

/// Replaces any terminal with the same `term_id`. Blocking task, so PTY setup
/// never blocks the main thread.
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
    let env_ports_at_spawn =
        dir.as_deref().map(tt_agentboard::env_drift::read_current_ports).unwrap_or_default();

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

    tt_exec::record_detached_spawn(&shell, &[], "pty");
    let mut cmd = CommandBuilder::new(shell);
    // PATH, HOME, SHELL survive; this instance's own identity does not.
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
    // Read back from /proc to attribute an agent to this session. The instance
    // stamp keeps two windows sharing one session record from claiming both.
    cmd.env(tt_agentboard::procenv::TT_SESSION_ENV, &term_id);
    cmd.env(tt_agentboard::procenv::TT_INSTANCE_ENV, tt_agentboard::procenv::instance_id());
    // Only when actually serving: a lost bind's port would send every session to
    // a dead address, where unset lets the default find one that does serve.
    if let Some(port) = crate::mcp_http::serving_port() {
        cmd.env(tt_mcp::port::MCP_PORT_ENV, port.to_string());
    }
    // Short-circuits Claude Code's lockfile pid/cwd checks, so pairing stays
    // deterministic with several tasks' panes open.
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
                // Set only on the frame where OSC 7 fired, so this holds the
                // last reported dir until the shell moves again.
                if let Some(uri) = frame.pwd.as_deref()
                    && let Some(dir) = pwd_from_file_uri(uri)
                {
                    *pwd.lock().unwrap() = Some(dir);
                }
                // The render loop is data-driven, so a frame is direct evidence
                // the agent is working. The emitter wakes only on a fresh burst.
                if activity.note_output(crate::agentboard::now_ms()) {
                    notify_agentboard(&app);
                }
                let _ = app.emit_to(
                    MAIN_WINDOW_LABEL,
                    FRAME_EVENT,
                    TermFrame { term_id: term_id.clone(), frame },
                );
            }
            // A full queue drops the reply; the program times out as on a slow tty.
            VtEvent::PtyReply(bytes) => {
                let _ = pty_input.try_send(bytes);
            }
            // OSC 777 fires the moment Claude Code wants the user — the fastest
            // evidence of a blocked agent, so it wakes the board immediately.
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
                // Focus-gated, but logged either way: a pane repeatedly *trying*
                // is what explains "something keeps overwriting my clipboard".
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
    // Before the first output, so an early OSC 10/11 probe (dark vs light
    // detection) already answers real colors.
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

    notify_agentboard(&app);

    // Drains into the PTY in arrival order. A stalled shell blocks only this
    // thread, and the channel cap bounds the backlog.
    std::thread::spawn(move || {
        while let Ok(bytes) = input_rx.recv() {
            if writer.write_all(&bytes).is_err() {
                break;
            }
        }
    });

    // Owns the engine handle, so the `drop(vt)` below joins that thread exactly
    // once. Feeding blocks when the engine is behind, flow-controlling the shell.
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
        // Only the generation still owning the id may report an exit.
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

pub(super) fn notify_agentboard(app: &AppHandle) {
    if let Some(ab) = app.try_state::<crate::agentboard::Ab>() {
        ab.emit.notify_one();
    }
}

#[tauri::command]
pub fn term_kill(app: AppHandle, term_id: String) {
    // So "which pane did the user close, and when" is a log query, not a repro.
    tracing::info!(%term_id, "terminal.killed");
    app.state::<TermState>().kill(&term_id);
    notify_agentboard(&app);
}

pub fn on_window_destroyed(app: &AppHandle, label: &str) {
    if label == MAIN_WINDOW_LABEL {
        app.state::<TermState>().kill_all();
    }
}

#[cfg(test)]
mod tests {
    use super::{TERMINAL_IDENTITY_ENV, TERMINAL_IDENTITY_ENV_UNSET};

    /// The shell's view must not depend on the app's env: the lists can't
    /// overlap, nor be scrubbed after stamping.
    #[test]
    fn terminal_identity_is_declared_not_inherited() {
        for (key, _) in TERMINAL_IDENTITY_ENV {
            assert!(!TERMINAL_IDENTITY_ENV_UNSET.contains(&key), "{key} both set and unset");
            assert!(!tt_exec::is_app_instance_env(key), "{key} would be scrubbed after stamping");
        }
        // The channel Claude Code needs, without the version that turns on a
        // protocol nothing here consumes.
        assert!(TERMINAL_IDENTITY_ENV.contains(&("TERM_PROGRAM", "ghostty")));
        assert!(TERMINAL_IDENTITY_ENV_UNSET.contains(&"TERM_PROGRAM_VERSION"));
    }
}
