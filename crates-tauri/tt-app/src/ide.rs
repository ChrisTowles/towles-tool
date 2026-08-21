//! Per-terminal Claude Code IDE servers (see `docs/CLAUDE-CODE-IDE.md`). Every embedded
//! terminal gets its own localhost WebSocket MCP server, a `~/.claude/ide/<port>.lock`
//! advertisement and a `CLAUDE_CODE_SSE_PORT` stamp in its PTY env, so a `claude` started
//! in a pane pairs with exactly that pane — it answers for that folder's workspace and
//! diagnostics, and `openFile` reaches that pane's checkout. Protocol logic lives in the
//! Tauri-free `tt_ide` crate; this module owns sockets, tokens and lifecycle.
//!
//! Connections are served concurrently: Claude Code >= 2.1 is multi-process — the TUI and
//! its session daemon each hold an IDE connection. The [`IdeServer`] handle lives in the
//! terminal's `Session`; dropping it aborts the server task and removes the lockfile.

use std::net::TcpListener as StdTcpListener;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::terminal::TermState;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::Message;

/// A CLI connected/disconnected, so a pane can show a live badge.
pub const STATUS_EVENT: &str = "ide://status";
pub(crate) const MAIN_WINDOW_LABEL: &str = "main";

/// The name Claude Code shows for this IDE (`/ide`, status line, lockfile).
pub const IDE_NAME: &str = "Towles Tool";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeStatus {
    pub term_id: String,
    pub dir: String,
    pub port: u16,
    pub connected: bool,
}

/// The mutexes here guard tiny in-memory reads/writes only — nothing IO-bound.
struct Shared {
    term_id: String,
    cwd: PathBuf,
    port: u16,
    auth_token: String,
    /// Queried per message for this folder's `getDiagnostics` payload.
    diagnostics: Arc<crate::diagnostics::DiagHub>,
    /// One per connected CLI process — Claude Code is multi-process.
    out: Mutex<Vec<UnboundedSender<Message>>>,
}

impl Shared {
    fn context(&self) -> tt_ide::ServerContext {
        tt_ide::ServerContext {
            ide_name: IDE_NAME.to_string(),
            workspace_folder: self.cwd.clone(),
            diagnostics: self.diagnostics.wire_for(&self.cwd),
        }
    }

    /// False when none is connected — the frame is simply dropped.
    fn push(&self, frame: String) -> bool {
        let mut guard = self.out.lock().unwrap();
        guard.retain(|tx| tx.send(Message::text(frame.clone())).is_ok());
        !guard.is_empty()
    }

    fn is_connected(&self) -> bool {
        !self.out.lock().unwrap().is_empty()
    }
}

/// Owned by the terminal's `Session`; drop tears everything down.
pub struct IdeServer {
    port: u16,
    shared: Arc<Shared>,
    lock_dir: Option<PathBuf>,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl IdeServer {
    /// OS-assigned port — never hardcoded, since tasks run concurrently.
    pub fn start(
        app: AppHandle,
        term_id: String,
        cwd: PathBuf,
        diagnostics: Arc<crate::diagnostics::DiagHub>,
    ) -> Result<IdeServer, String> {
        let listener = StdTcpListener::bind(("127.0.0.1", 0))
            .map_err(|e| format!("failed to bind IDE server socket: {e}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("failed to configure IDE server socket: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("failed to read IDE server port: {e}"))?
            .port();

        let auth_token = new_auth_token();
        let lock_dir = dirs::home_dir().map(|home| tt_ide::lockfile::lock_dir(&home));
        if let Some(dir) = &lock_dir {
            let lockfile = tt_ide::Lockfile::new(std::process::id(), &cwd, IDE_NAME, &auth_token);
            tt_ide::lockfile::write(dir, port, &lockfile)
                .map_err(|e| format!("failed to write IDE lockfile: {e}"))?;
        }

        let shared = Arc::new(Shared {
            term_id,
            cwd,
            port,
            auth_token,
            diagnostics,
            out: Mutex::new(Vec::new()),
        });

        let task = tauri::async_runtime::spawn(accept_loop(app, listener, shared.clone()));
        Ok(IdeServer { port, shared, lock_dir, task })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn cwd(&self) -> &Path {
        &self.shared.cwd
    }

    pub fn connected(&self) -> bool {
        self.shared.is_connected()
    }

    pub fn status(&self) -> IdeStatus {
        IdeStatus {
            term_id: self.shared.term_id.clone(),
            dir: self.shared.cwd.to_string_lossy().into_owned(),
            port: self.port,
            connected: self.connected(),
        }
    }

    /// Tell CLIs these diagnostics went stale; they re-pull via `getDiagnostics`.
    pub fn notify_diagnostics(&self, uris: &[String]) {
        self.shared.push(tt_ide::diagnostics::diagnostics_changed_frame(uris));
    }
}

impl Drop for IdeServer {
    fn drop(&mut self) {
        self.task.abort();
        if let Some(dir) = &self.lock_dir {
            tt_ide::lockfile::remove(dir, self.port);
        }
    }
}

/// Random bearer token for the lockfile — UUID-shaped like the extension's.
fn new_auth_token() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Errors on an individual connection just recycle the loop.
async fn accept_loop(app: AppHandle, listener: StdTcpListener, shared: Arc<Shared>) {
    let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
        eprintln!("warning: IDE server for terminal {} failed to start", shared.term_id);
        return;
    };
    loop {
        let Ok((stream, _addr)) = listener.accept().await else {
            return;
        };
        // Claude Code >= 2.1.x is multi-process (TUI plus session daemon) and
        // each may hold its own connection; all get the same dispatcher state.
        let app = app.clone();
        let shared = shared.clone();
        tauri::async_runtime::spawn(async move {
            serve_connection(&app, stream, &shared).await;
        });
    }
}

/// Authenticated handshake, then a frame loop bridging JSON-RPC in and
/// diff-pane notifications out.
// The Err size is tungstenite's Callback trait, not ours to shrink.
#[allow(clippy::result_large_err)]
async fn serve_connection(app: &AppHandle, stream: tokio::net::TcpStream, shared: &Arc<Shared>) {
    let auth = shared.auth_token.clone();
    let callback = move |req: &Request, mut resp: Response| {
        let presented = req
            .headers()
            .get("x-claude-code-ide-authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        if presented != auth {
            let mut denied = ErrorResponse::new(Some("Unauthorized".to_string()));
            *denied.status_mut() = StatusCode::UNAUTHORIZED;
            return Err(denied);
        }
        // Some WS stacks drop the connection without this echo; the CLI always asks.
        let requested_mcp = req
            .headers()
            .get("sec-websocket-protocol")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.split(',').any(|p| p.trim() == "mcp"));
        if requested_mcp && let Ok(value) = "mcp".parse() {
            resp.headers_mut().insert("sec-websocket-protocol", value);
        }
        Ok(resp)
    };

    let Ok(ws) = tokio_tungstenite::accept_hdr_async(stream, callback).await else {
        return;
    };
    let (mut sink, mut source) = ws.split();
    let (tx, mut rx) = unbounded_channel::<Message>();
    shared.out.lock().unwrap().push(tx.clone());
    emit_status(app, shared);
    // A fresh CLI wants fresh diagnostics — kick a (debounced) check run.
    shared.diagnostics.request(&shared.cwd);

    loop {
        tokio::select! {
            incoming = source.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        // Tools with app-side effects are answered here so the
                        // webview can act; the rest go to the pure dispatcher.
                        let reply = match intercept_app_tool(app, shared, text.as_str()) {
                            Intercept::Reply(reply) => Some(reply),
                            Intercept::NotOurs => {
                                tt_ide::handle_message(text.as_str(), &shared.context())
                            }
                        };
                        if let Some(reply) = reply
                            && sink.send(Message::text(reply)).await.is_err()
                        {
                            break;
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if sink.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => {}
                }
            }
            outgoing = rx.recv() => {
                match outgoing {
                    Some(frame) => {
                        if sink.send(frame).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
        }
    }

    shared.out.lock().unwrap().retain(|sender| !sender.same_channel(&tx));
    emit_status(app, shared);
}

/// `openFile` *asking for the foreground*. A `makeFrontmost: false` call —
/// Claude Code's pre-edit bookkeeping, see the intercept — emits nothing,
/// because creating a pane there is a UI change no user asked for.
pub const OPEN_FILE_EVENT: &str = "ide://open-file";
enum Intercept {
    /// Not an app-side tool — run the pure dispatcher.
    NotOurs,
    /// Immediate response.
    Reply(String),
}

/// The one `tools/call` that needs the webview to act: `openFile`.
fn intercept_app_tool(app: &AppHandle, shared: &Arc<Shared>, message: &str) -> Intercept {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(message) else {
        return Intercept::NotOurs;
    };
    if value.get("method").and_then(serde_json::Value::as_str) != Some("tools/call") {
        return Intercept::NotOurs;
    }
    let Some(name) = value.pointer("/params/name").and_then(serde_json::Value::as_str) else {
        return Intercept::NotOurs;
    };
    let id = value.get("id").cloned().unwrap_or(serde_json::Value::Null);
    let args = value.pointer("/params/arguments").cloned().unwrap_or_else(|| serde_json::json!({}));
    let arg_str = |key: &str| args.get(key).and_then(serde_json::Value::as_str).unwrap_or_default();

    match name {
        "openFile" => {
            let file_path = arg_str("filePath").to_string();
            // `makeFrontmost: false` is Claude Code's *background* open — its
            // diagnostics tracker calls `openFile` before every edit, only so
            // the IDE holds the document. Acting on it put a files pane on
            // screen on every agent edit, with no user gesture in the chain.
            if wants_frontmost(&args) {
                let payload = serde_json::json!({
                    "dir": shared.cwd.to_string_lossy(),
                    "filePath": file_path,
                });
                let _ = app.emit_to(MAIN_WINDOW_LABEL, OPEN_FILE_EVENT, payload);
                let result = serde_json::json!({
                    "success": true,
                    "message": format!("Opening {file_path} in Towles Tool"),
                });
                return Intercept::Reply(tt_ide::tool_result_response(id, &result));
            }
            tracing::debug!(dir = %shared.cwd.display(), file = %file_path, "ide.open_file_background");
            let result = serde_json::json!({
                "success": true,
                "message": format!("Tracking {file_path} in Towles Tool (not brought forward)"),
            });
            Intercept::Reply(tt_ide::tool_result_response(id, &result))
        }
        _ => Intercept::NotOurs,
    }
}

/// Absent means yes — VS Code's tool schema defaults `makeFrontmost` to true.
fn wants_frontmost(args: &serde_json::Value) -> bool {
    args.get("makeFrontmost").and_then(serde_json::Value::as_bool).unwrap_or(true)
}

fn emit_status(app: &AppHandle, shared: &Arc<Shared>) {
    let status = IdeStatus {
        term_id: shared.term_id.clone(),
        dir: shared.cwd.to_string_lossy().into_owned(),
        port: shared.port,
        connected: shared.is_connected(),
    };
    let _ = app.emit_to(MAIN_WINDOW_LABEL, STATUS_EVENT, status);
}

/// Remove lockfiles left by towles-tool processes that died without cleanup;
/// other IDEs' are never touched. Liveness is only checkable via /proc, so
/// elsewhere the sweep is skipped — the CLI's own pid check covers it.
pub fn sweep_stale_lockfiles() {
    #[cfg(target_os = "linux")]
    if let Some(home) = dirs::home_dir() {
        let dir = tt_ide::lockfile::lock_dir(&home);
        let alive = |pid: u32| Path::new(&format!("/proc/{pid}")).exists();
        tt_ide::lockfile::sweep_stale(&dir, IDE_NAME, &alive);
    }
}

/// Initial state only; live updates ride the `ide://status` event.
#[tauri::command]
pub fn ide_status(app: AppHandle) -> Vec<IdeStatus> {
    app.state::<TermState>().ide_statuses()
}

#[cfg(test)]
mod intercept_tests {
    use super::*;

    /// The exact payload Claude Code's diagnostics tracker sends before every
    /// edit (`ensureFileOpened`) — it must never put a pane on screen.
    #[test]
    fn background_open_file_does_not_want_the_foreground() {
        let args = serde_json::json!({
            "filePath": "/w/src/main.rs",
            "preview": false,
            "startText": "",
            "endText": "",
            "selectToEndOfLine": false,
            "makeFrontmost": false,
        });
        assert!(!wants_frontmost(&args));
    }

    #[test]
    fn open_file_defaults_to_the_foreground() {
        assert!(wants_frontmost(&serde_json::json!({ "filePath": "/w/src/main.rs" })));
        assert!(wants_frontmost(&serde_json::json!({ "makeFrontmost": true })));
    }
}
