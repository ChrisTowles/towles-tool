//! Per-terminal Claude Code IDE servers (see `docs/CLAUDE-CODE-IDE.md`). Every embedded
//! terminal gets its own localhost WebSocket MCP server, a `~/.claude/ide/<port>.lock`
//! advertisement and a `CLAUDE_CODE_SSE_PORT` stamp in its PTY env, so a `claude` started
//! in a pane pairs with exactly that pane — highlights in the app's diff view become the
//! session's selection context. Protocol logic lives in the Tauri-free `tt_ide` crate;
//! this module owns sockets, tokens and lifecycle.
//!
//! Connections are served concurrently: Claude Code >= 2.1 is multi-process — the TUI and
//! its session daemon each hold an IDE connection, and both need the selection stream.
//! The [`IdeServer`] handle lives in the terminal's `Session`; dropping it aborts the
//! server task and removes the lockfile.

use std::collections::{HashMap, HashSet};
use std::net::TcpListener as StdTcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::Message;
use tt_agentboard::fs_notify::MultiFileNotifier;

use crate::terminal::TermState;

/// A CLI connected/disconnected, so the diff pane can show a live badge.
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
    /// Latest diff-pane selection; serves `getCurrentSelection`/`getLatestSelection`.
    selection: Mutex<Option<tt_ide::Selection>>,
    /// Dirty diff-pane files, an upsert/remove set — what `getOpenEditors` and
    /// `checkDocumentDirty` see.
    diff_dirty_files: Mutex<HashSet<String>>,
    /// Queried per message for this folder's `getDiagnostics` payload.
    diagnostics: Arc<crate::diagnostics::DiagHub>,
    /// One per connected CLI process — Claude Code is multi-process.
    out: Mutex<Vec<UnboundedSender<Message>>>,
}

impl Shared {
    fn context(&self) -> tt_ide::ServerContext {
        let open_files: Vec<tt_ide::OpenFile> = self
            .diff_dirty_files
            .lock()
            .unwrap()
            .iter()
            .map(|path| tt_ide::OpenFile { path: path.clone(), dirty: true })
            .collect();
        tt_ide::ServerContext {
            ide_name: IDE_NAME.to_string(),
            workspace_folder: self.cwd.clone(),
            selection: self.selection.lock().unwrap().clone(),
            open_files,
            diagnostics: self.diagnostics.wire_for(&self.cwd),
        }
    }

    /// False when none is connected: the frame is dropped, but selection state
    /// is still cached for a later connection's `getLatestSelection`.
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
            selection: Mutex::new(None),
            diff_dirty_files: Mutex::new(HashSet::new()),
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

    pub fn set_selection(&self, selection: tt_ide::Selection) {
        let frame = tt_ide::selection_changed_frame(&selection);
        *self.shared.selection.lock().unwrap() = Some(selection);
        self.shared.push(frame);
    }

    /// Returns whether a CLI was connected to receive it.
    pub fn at_mention(&self, file_path: &str, lines: Option<(u32, u32)>) -> bool {
        self.shared.push(tt_ide::at_mentioned_frame(file_path, lines))
    }

    /// Tell CLIs these diagnostics went stale; they re-pull via `getDiagnostics`.
    pub fn notify_diagnostics(&self, uris: &[String]) {
        self.shared.push(tt_ide::diagnostics::diagnostics_changed_frame(uris));
    }

    /// Upserts one path into a set — the diff pane can have several files dirty
    /// at once, and only dirty ones need to be visible to
    /// `getOpenEditors`/`checkDocumentDirty`.
    pub fn set_diff_file_dirty(&self, path: String, dirty: bool) {
        let mut files = self.shared.diff_dirty_files.lock().unwrap();
        if dirty {
            files.insert(path);
        } else {
            files.remove(&path);
        }
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
                        let reply = match intercept_app_tool(app, shared, &tx, text.as_str()) {
                            Intercept::Reply(reply) => Some(reply),
                            // Answered on the outbound channel once the user decides.
                            Intercept::Deferred => None,
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
/// The frontend shows an accept/reject review, resolved via `ide_diff_resolve`.
pub const OPEN_DIFF_EVENT: &str = "ide://open-diff";
/// The CLI closed diff tabs, so the frontend drops the matching overlays.
pub const CLOSE_DIFF_EVENT: &str = "ide://close-diff";

/// The wire response is deferred: a task per request waits on `respond` and
/// sends the tool result down the *requesting* connection when the user decides.
struct PendingDiff {
    request_id: u64,
    dir: PathBuf,
    tab_name: String,
    new_file_path: PathBuf,
    respond: tokio::sync::oneshot::Sender<serde_json::Value>,
}

/// Managed state — the resolving Tauri command only knows the request id.
#[derive(Default)]
pub struct DiffRequests {
    pending: Mutex<Vec<PendingDiff>>,
    next_id: AtomicU64,
}

impl DiffRequests {
    /// On accept, writes `final_contents` — the reviewer may have tweaked the
    /// proposed side. Errors when the id is unknown or already resolved.
    fn resolve(
        &self,
        request_id: u64,
        accepted: bool,
        final_contents: Option<String>,
    ) -> Result<(), String> {
        let entry = {
            let mut pending = self.pending.lock().unwrap();
            let index = pending
                .iter()
                .position(|p| p.request_id == request_id)
                .ok_or("diff review already resolved")?;
            pending.remove(index)
        };
        let result = if accepted {
            let contents = final_contents.unwrap_or_default();
            atomic_write(&entry.new_file_path, &contents)?;
            serde_json::json!({ "content": [
                { "type": "text", "text": "FILE_SAVED" },
                { "type": "text", "text": contents },
            ]})
        } else {
            rejected_result(&entry.tab_name)
        };
        let _ = entry.respond.send(result);
        Ok(())
    }

    /// Returns how many were closed.
    fn reject_matching(&self, dir: &Path, tab_name: Option<&str>) -> usize {
        let drained: Vec<PendingDiff> = {
            let mut pending = self.pending.lock().unwrap();
            let (matching, rest): (Vec<_>, Vec<_>) = pending
                .drain(..)
                .partition(|p| p.dir == dir && tab_name.is_none_or(|t| t == p.tab_name));
            *pending = rest;
            matching
        };
        let count = drained.len();
        for entry in drained {
            let _ = entry.respond.send(rejected_result(&entry.tab_name));
        }
        count
    }
}

fn rejected_result(tab_name: &str) -> serde_json::Value {
    serde_json::json!({ "content": [
        { "type": "text", "text": "DIFF_REJECTED" },
        { "type": "text", "text": tab_name },
    ]})
}

/// Returns the mtime taken from the tmp file *before* the rename (which
/// preserves it): stat-ing the destination afterwards could adopt a concurrent
/// writer's mtime as our save token, and the next save would clobber it.
fn atomic_write(abs: &Path, content: &str) -> Result<i64, String> {
    let parent = abs.parent().ok_or_else(|| format!("no parent dir for {}", abs.display()))?;
    let tmp = parent.join(format!(
        ".{}.tt-tmp",
        abs.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    ));
    std::fs::write(&tmp, content).map_err(|e| format!("cannot write {}: {e}", abs.display()))?;
    let written_mtime = std::fs::metadata(&tmp)
        .map(|meta| mtime_ms(&meta))
        .map_err(|e| format!("cannot stat {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, abs).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("cannot save {}: {e}", abs.display())
    })?;
    Ok(written_mtime)
}

enum Intercept {
    /// Not an app-side tool — run the pure dispatcher.
    NotOurs,
    /// Immediate response.
    Reply(String),
    /// Deferred to the review UI, which answers on the outbound sender.
    Deferred,
}

/// The payload is already the full MCP result, e.g. openDiff's two blocks.
fn raw_result_response(id: &serde_json::Value, result: &serde_json::Value) -> String {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

/// `tools/call`s that need the webview to act: `openFile`, `openDiff` (blocking
/// review), `close_tab`/`closeAllDiffTabs`.
fn intercept_app_tool(
    app: &AppHandle,
    shared: &Arc<Shared>,
    out: &UnboundedSender<Message>,
    message: &str,
) -> Intercept {
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
        "openDiff" => {
            let requests = app.state::<DiffRequests>();
            let request_id = requests.next_id.fetch_add(1, Ordering::Relaxed);
            let tab_name = arg_str("tab_name").to_string();
            let new_file_path = PathBuf::from(arg_str("new_file_path"));
            let (respond_tx, respond_rx) = tokio::sync::oneshot::channel();
            requests.pending.lock().unwrap().push(PendingDiff {
                request_id,
                dir: shared.cwd.clone(),
                tab_name: tab_name.clone(),
                new_file_path,
                respond: respond_tx,
            });
            let payload = serde_json::json!({
                "requestId": request_id,
                "dir": shared.cwd.to_string_lossy(),
                "oldFilePath": arg_str("old_file_path"),
                "newFilePath": arg_str("new_file_path"),
                "newFileContents": arg_str("new_file_contents"),
                "tabName": tab_name.clone(),
            });
            let _ = app.emit_to(MAIN_WINDOW_LABEL, OPEN_DIFF_EVENT, payload);
            // A dropped sender (teardown) degrades to a rejection, so the CLI
            // never hangs forever.
            let out = out.clone();
            tauri::async_runtime::spawn(async move {
                let result = respond_rx.await.unwrap_or_else(|_| rejected_result(&tab_name));
                let _ = out.send(Message::text(raw_result_response(&id, &result)));
            });
            Intercept::Deferred
        }
        "close_tab" => {
            let tab_name = arg_str("tab_name").to_string();
            app.state::<DiffRequests>().reject_matching(&shared.cwd, Some(&tab_name));
            let _ = app.emit_to(
                MAIN_WINDOW_LABEL,
                CLOSE_DIFF_EVENT,
                serde_json::json!({ "dir": shared.cwd.to_string_lossy(), "tabName": tab_name }),
            );
            let result =
                serde_json::json!({ "content": [{ "type": "text", "text": "TAB_CLOSED" }] });
            Intercept::Reply(raw_result_response(&id, &result))
        }
        "closeAllDiffTabs" => {
            let closed = app.state::<DiffRequests>().reject_matching(&shared.cwd, None);
            let _ = app.emit_to(
                MAIN_WINDOW_LABEL,
                CLOSE_DIFF_EVENT,
                serde_json::json!({ "dir": shared.cwd.to_string_lossy(), "tabName": null }),
            );
            let result = serde_json::json!({ "content": [
                { "type": "text", "text": format!("CLOSED_{closed}_DIFF_TABS") },
            ]});
            Intercept::Reply(raw_result_response(&id, &result))
        }
        _ => Intercept::NotOurs,
    }
}

/// Absent means yes — VS Code's tool schema defaults `makeFrontmost` to true.
fn wants_frontmost(args: &serde_json::Value) -> bool {
    args.get("makeFrontmost").and_then(serde_json::Value::as_bool).unwrap_or(true)
}

/// Errors when the request is unknown or already gone.
#[tauri::command]
pub fn ide_diff_resolve(
    requests: State<DiffRequests>,
    request_id: u64,
    accepted: bool,
    final_contents: Option<String>,
) -> Result<(), String> {
    tracing::info!(request_id, accepted, "ide.diff_resolved");
    requests.resolve(request_id, accepted, final_contents)
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

/// As Monaco reports it: 1-based inclusive lines, 0-based character columns.
/// Mirrors `StreamRange` in `apps/client/src/lib/ide-selection.ts`.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamRange {
    pub start_line: u32,
    pub end_line: u32,
    pub start_char: u32,
    pub end_char: u32,
}

/// **`text` is the editor's buffer, never the file on disk** (issue #309). The
/// Files viewer is editable, so with unsaved edits the bytes at those line
/// numbers on disk can be entirely different text than the user highlighted.
/// Both callers own a Monaco model, so there is no disk path to fall back to.
fn build_selection(abs: &Path, range: StreamRange, text: String) -> tt_ide::Selection {
    // Clamped to 1: a 0 from a miscounting caller would underflow below.
    let start = range.start_line.min(range.end_line).max(1);
    let end = range.start_line.max(range.end_line).max(start);
    let mut selection = tt_ide::Selection::range(abs, start - 1, end - 1, range.end_char, text);
    selection.selection.start.character = range.start_char;
    selection
}

/// Cache the highlight and push it to every terminal IDE server rooted at `dir`.
/// Returns whether any connected CLI got it live.
#[tauri::command]
pub fn ide_set_selection(
    state: State<TermState>,
    dir: String,
    file_path: String,
    range: StreamRange,
    text: String,
) -> Result<bool, String> {
    let dir = PathBuf::from(dir);
    let selection = build_selection(&dir.join(&file_path), range, text);
    let mut delivered = false;
    state.for_ide_servers(&dir, |server| {
        let frame_selection = selection.clone();
        let connected = server.connected();
        server.set_selection(frame_selection);
        delivered |= connected;
    });
    Ok(delivered)
}

/// An empty selection, as VS Code sends on a collapsed cursor, so stale context
/// doesn't ride the next prompt.
#[tauri::command]
pub fn ide_clear_selection(
    state: State<TermState>,
    dir: String,
    file_path: String,
) -> Result<(), String> {
    let dir = PathBuf::from(dir);
    let cleared = tt_ide::Selection::cleared(&dir.join(&file_path));
    state.for_ide_servers(&dir, |server| server.set_selection(cleared.clone()));
    Ok(())
}

/// Emits `at_mentioned`, which becomes an `@file#Lx-y` reference in the
/// session's prompt. Errors when no CLI is connected in that folder.
#[tauri::command]
pub fn ide_at_mention(
    state: State<TermState>,
    dir: String,
    file_path: String,
    start_line: Option<u32>,
    end_line: Option<u32>,
) -> Result<(), String> {
    let dir = PathBuf::from(dir);
    let abs = dir.join(&file_path);
    // Lines omitted = a whole-file mention; the wire drops both together.
    let lines = match (start_line, end_line) {
        (Some(s), Some(e)) => Some((s.min(e).max(1) - 1, s.max(e).max(1) - 1)),
        _ => None,
    };
    let mut delivered = false;
    state.for_ide_servers(&dir, |server| {
        delivered |= server.at_mention(&abs.to_string_lossy(), lines);
    });
    tracing::info!(dir = %dir.display(), delivered, "ide.at_mention");
    if delivered {
        Ok(())
    } else {
        Err("No Claude Code session is connected in this folder — run `claude` in its terminal first".into())
    }
}

/// Initial state only; live updates ride the `ide://status` event.
#[tauri::command]
pub fn ide_status(app: AppHandle) -> Vec<IdeStatus> {
    app.state::<TermState>().ide_statuses()
}

/// Reflected to CLIs via `getOpenEditors`/`checkDocumentDirty`; `dirty: false`
/// removes the entry.
#[tauri::command]
pub fn ide_set_diff_dirty(state: State<TermState>, dir: String, file_path: String, dirty: bool) {
    let path = PathBuf::from(&dir).join(file_path).to_string_lossy().into_owned();
    state
        .for_ide_servers(Path::new(&dir), |server| server.set_diff_file_dirty(path.clone(), dirty));
}

/// `mtime_ms` is the conflict token the save path checks against.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRead {
    pub content: String,
    pub mtime_ms: i64,
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Two ways out have to be closed: `..` walks up, and an *absolute* path is
/// worse — `Path::join` discards the base and returns the argument whole.
/// Lexical only: the path may not exist yet to canonicalize.
fn confined(dir: &Path, file_path: &str) -> Result<PathBuf, String> {
    let rel = Path::new(file_path);
    let escapes =
        rel.is_absolute() || rel.components().any(|c| matches!(c, std::path::Component::ParentDir));
    if escapes {
        return Err(format!("path escapes the folder: {file_path}"));
    }
    Ok(dir.join(file_path))
}

/// Size-capped and text-only — the viewer is for code, not assets.
#[tauri::command]
pub async fn ide_read_file(dir: String, file_path: String) -> Result<FileRead, String> {
    const MAX_BYTES: u64 = 2 * 1024 * 1024;
    tauri::async_runtime::spawn_blocking(move || {
        let abs = confined(Path::new(&dir), &file_path)?;
        let meta = std::fs::metadata(&abs).map_err(|e| format!("cannot open {file_path}: {e}"))?;
        if meta.len() > MAX_BYTES {
            return Err(format!("{file_path} is too large to preview ({} KB)", meta.len() / 1024));
        }
        let bytes = std::fs::read(&abs).map_err(|e| format!("cannot read {file_path}: {e}"))?;
        if bytes.contains(&0) {
            return Err(format!("{file_path} looks like a binary file"));
        }
        Ok(FileRead {
            content: String::from_utf8_lossy(&bytes).into_owned(),
            mtime_ms: mtime_ms(&meta),
        })
    })
    .await
    .map_err(|e| format!("read task failed: {e}"))?
}

/// Atomic, with an mtime conflict token: if the file changed on disk since it
/// was read, the save is refused rather than silently clobbering.
#[tauri::command]
pub async fn ide_write_file(
    dir: String,
    file_path: String,
    content: String,
    expected_mtime_ms: Option<i64>,
) -> Result<i64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let abs = confined(Path::new(&dir), &file_path)?;
        if let (Some(expected), Ok(meta)) = (expected_mtime_ms, std::fs::metadata(&abs))
            && mtime_ms(&meta) != expected
        {
            tracing::debug!(dir = %dir, file = %file_path, "viewer save refused: changed on disk");
            return Err(format!(
                "{file_path} changed on disk since it was opened — reopen it to pick up the new contents"
            ));
        }
        let written_mtime = atomic_write(&abs, &content)?;
        // Saves are no longer always a user gesture (the editors auto-save), so
        // "when did the app write this file?" must stay answerable from the log.
        tracing::debug!(dir = %dir, file = %file_path, bytes = content.len(), "viewer file saved");
        Ok(written_mtime)
    })
    .await
    .map_err(|e| format!("write task failed: {e}"))?
}

/// One event per debounce batch, carrying every touched path; the viewer
/// re-checks each and either reloads in place or raises its conflict banner.
pub const FILE_CHANGED_EVENT: &str = "ide://file-changed";

/// **One** [`MultiFileNotifier`] per checkout dir (inotify instances are a
/// scarce per-user resource), with per-file refcounts inside it, so a 50-file
/// diff pane and a viewer on the same file share one OS watcher.
#[derive(Default)]
pub struct ViewerWatches(Mutex<HashMap<String, MultiFileNotifier>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FilesChangedPayload {
    dir: String,
    file_paths: Vec<String>,
}

/// Takes the whole list in one call — a 50-file diff pane must not pay 50 sync
/// round-trips on the GTK main thread. Pair with `ide_unwatch_files` on close.
#[tauri::command]
pub fn ide_watch_files(
    app: AppHandle,
    watches: State<ViewerWatches>,
    dir: String,
    file_paths: Vec<String>,
) -> Result<(), String> {
    let mut map = watches.0.lock().unwrap();
    let notifier = match map.entry(dir.clone()) {
        std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
        std::collections::hash_map::Entry::Vacant(v) => {
            let app = app.clone();
            let event_dir = dir.clone();
            let notifier = MultiFileNotifier::new(move |paths| {
                let file_paths: Vec<String> = paths
                    .iter()
                    .filter_map(|abs| abs.strip_prefix(&event_dir).ok())
                    .map(|rel| rel.to_string_lossy().into_owned())
                    .collect();
                if file_paths.is_empty() {
                    return;
                }
                tracing::debug!(dir = %event_dir, files = ?file_paths, "viewer files changed on disk");
                let payload = FilesChangedPayload { dir: event_dir.clone(), file_paths };
                let _ = app.emit_to(MAIN_WINDOW_LABEL, FILE_CHANGED_EVENT, payload);
            })
            .map_err(|e| format!("cannot start watching {dir}: {e}"))?;
            tracing::debug!(dir = %dir, "viewer watch instance started");
            v.insert(notifier)
        }
    };
    // A per-path failure must not doom the batch — an unwatched file degrades
    // to the poll-driven safety net, and teardown passes the same full list.
    for file_path in &file_paths {
        match confined(Path::new(&dir), file_path).map(|abs| notifier.add(&abs)) {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                tracing::debug!(dir = %dir, file = %file_path, error = %e, "viewer watch skipped")
            }
            Err(e) => {
                tracing::debug!(dir = %dir, file = %file_path, error = %e, "viewer watch skipped")
            }
        }
    }
    Ok(())
}

/// Unmatched calls — a watch that never started — are a no-op.
#[tauri::command]
pub fn ide_unwatch_files(watches: State<ViewerWatches>, dir: String, file_paths: Vec<String>) {
    let mut map = watches.0.lock().unwrap();
    let Some(notifier) = map.get_mut(&dir) else {
        return;
    };
    for file_path in &file_paths {
        if let Ok(abs) = confined(Path::new(&dir), file_path) {
            notifier.remove(&abs);
        }
    }
    if notifier.is_empty() {
        tracing::debug!(dir = %dir, "viewer watch instance stopped");
        map.remove(&dir);
    }
}

/// Minimal stat for the editor's filesystem-provider bridge (monaco-fs.ts).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsStat {
    pub is_dir: bool,
    pub size: u64,
    pub mtime_ms: i64,
}

/// Stat one path for the VS Code filesystem provider. Same confinement rule
/// as [`ide_read_file`].
#[tauri::command]
pub async fn ide_stat(dir: String, file_path: String) -> Result<FsStat, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let abs = confined(Path::new(&dir), &file_path)?;
        let meta = std::fs::metadata(&abs).map_err(|e| format!("cannot stat {file_path}: {e}"))?;
        Ok(FsStat { is_dir: meta.is_dir(), size: meta.len(), mtime_ms: mtime_ms(&meta) })
    })
    .await
    .map_err(|e| format!("stat task failed: {e}"))?
}

#[cfg(test)]
mod selection_tests {
    use super::*;

    fn range(start_line: u32, end_line: u32, start_char: u32, end_char: u32) -> StreamRange {
        StreamRange { start_line, end_line, start_char, end_char }
    }

    /// Issue #309: the viewer is editable, so the buffer — not the file on
    /// disk — is what the user highlighted. This is the regression: a file
    /// whose on-disk line 2 says something else entirely must not leak into
    /// `Selection.text`.
    #[test]
    fn selection_text_is_the_buffer_not_the_file_on_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let abs = tmp.path().join("src/main.rs");
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        std::fs::write(&abs, "stale one\nstale two\nstale three\n").unwrap();

        let sel = build_selection(&abs, range(2, 2, 0, 9), "fresh two".to_string());

        assert_eq!(sel.text, "fresh two");
        assert!(!sel.text.contains("stale"), "{}", sel.text);
    }

    /// A selection nowhere near the file's contents (the shape an insertion
    /// above the highlight produces) still travels verbatim — nothing clips
    /// it against disk lines that no longer correspond to those numbers.
    #[test]
    fn selection_survives_a_buffer_longer_than_the_saved_file() {
        let tmp = tempfile::tempdir().unwrap();
        let abs = tmp.path().join("notes.md");
        std::fs::write(&abs, "one\n").unwrap();

        let sel = build_selection(&abs, range(40, 42, 2, 4), "typed\nbut\nunsaved".to_string());

        assert_eq!(sel.text, "typed\nbut\nunsaved");
    }

    /// Lines arrive 1-based inclusive and leave 0-based; the columns pass
    /// through untouched (Monaco's are already valid for its own buffer).
    #[test]
    fn range_converts_to_zero_based_lines_and_keeps_columns() {
        let sel = build_selection(Path::new("/w/a.rs"), range(3, 7, 4, 11), "x".to_string());

        assert_eq!(sel.selection.start.line, 2);
        assert_eq!(sel.selection.end.line, 6);
        assert_eq!(sel.selection.start.character, 4);
        assert_eq!(sel.selection.end.character, 11);
        assert!(!sel.selection.is_empty);
    }

    /// A backwards drag (caret above the anchor) and a line 0 from a caller
    /// that miscounted both have to land on a sane range rather than
    /// underflowing the 1→0-based subtraction.
    #[test]
    fn range_normalizes_backwards_and_zero_lines() {
        let sel = build_selection(Path::new("/w/a.rs"), range(9, 4, 0, 2), "x".to_string());
        assert_eq!((sel.selection.start.line, sel.selection.end.line), (3, 8));

        let zero = build_selection(Path::new("/w/a.rs"), range(0, 0, 0, 0), String::new());
        assert_eq!((zero.selection.start.line, zero.selection.end.line), (0, 0));
    }
}

#[cfg(test)]
mod fs_command_tests {
    use super::*;

    #[test]
    fn confined_rejects_parent_traversal() {
        let err = confined(Path::new("/w"), "../etc/passwd").unwrap_err();
        assert!(err.contains("path escapes the folder"), "{err}");
    }

    #[test]
    fn confined_rejects_traversal_in_the_middle_of_a_path() {
        assert!(confined(Path::new("/w"), "src/../../etc/passwd").is_err());
    }

    /// `Path::join` throws the base away when the argument is absolute, so
    /// without this check `confined` hands back a path outside the folder and
    /// `ide_delete` would happily trash it.
    #[test]
    fn confined_rejects_an_absolute_path() {
        let err = confined(Path::new("/w"), "/etc/passwd").unwrap_err();
        assert!(err.contains("path escapes the folder"), "{err}");
        assert_ne!(
            confined(Path::new("/w"), "/etc/passwd").ok(),
            Some(PathBuf::from("/etc/passwd"))
        );
    }

    #[test]
    fn confined_joins_a_plain_relative_path() {
        assert_eq!(confined(Path::new("/w"), "src/main.rs").unwrap(), Path::new("/w/src/main.rs"));
    }

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
