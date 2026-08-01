//! Loopback HTTP transport for the MCP server ([`tt_mcp`]): the socket, the HTTP framing
//! and the request-admission rules. Every instance serves its own MCP on its own port,
//! claimed per checkout from `.env.example`'s `${tt:port 8787-8986}`, and a session started
//! in an app's terminal reaches *that* app because the app stamps [`tt_mcp::port::MCP_PORT_ENV`] into the
//! shell and the plugin's `.mcp.json` expands it. The machine-wide singleton this replaced
//! was wrong on correctness: `tt.db` is *instance* state per checkout, so whichever instance
//! won a fixed 8787 answered every session out of **its own** board while the rest served
//! nothing for life. The bind is still fail-soft, but a held port is now an anomaly.
//!
//! **[`check_admission`] is the entire security boundary** — no bearer token, no capability
//! gate (both removed 2026-07-20) — and a pure function, so it is tested directly. Loopback
//! keeps *remote hosts* out, not *web pages*: any site can POST to `127.0.0.1`, and CORS
//! only stops it reading the reply while a blind write is the whole attack. So: reject any
//! request carrying an `Origin`, and require `Content-Type: application/json`.

use std::net::{Ipv4Addr, SocketAddr, TcpListener as StdTcpListener};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter};
use tt_mcp::Dispatcher;
use tt_store::Store;

/// Process-global rather than managed Tauri state: one server per process.
static SERVING: AtomicBool = AtomicBool::new(false);
/// The port [`spawn`] attempted, whether or not the bind succeeded — the UI
/// needs it either way (to show the endpoint, or to say what's contended).
static PORT: AtomicU16 = AtomicU16::new(0);

/// The real bind outcome, not an inference from call recency — the two differ
/// exactly when it matters: a healthy server nobody called, and a lost port.
#[tauri::command]
pub fn mcp_status() -> serde_json::Value {
    serde_json::json!({
        "serving": SERVING.load(Ordering::Relaxed),
        "port": PORT.load(Ordering::Relaxed),
    })
}

/// The port this instance is actually serving on, or `None` if it never bound. The
/// distinction matters at one call site — stamping [`tt_mcp::port::MCP_PORT_ENV`] into a spawned
/// terminal, where advertising a port we don't serve points a session at nothing.
pub fn serving_port() -> Option<u16> {
    SERVING.load(Ordering::Relaxed).then(|| PORT.load(Ordering::Relaxed))
}

/// The MCP endpoint path. A single route: this is not a REST API.
const MCP_PATH: &str = "/mcp";

/// Largest request body accepted, enforced incrementally by `Limited` in [`read_body`] so
/// a stray upload can't balloon memory before being rejected. MCP requests are small —
/// `calendar_set` pushing a day of events is the biggest realistic payload.
const MAX_BODY_BYTES: usize = 1024 * 1024;

/// A type rather than inline strings, so [`check_admission`]'s tests assert on the
/// *reason* and not on prose that may be reworded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// Request carried an `Origin` header — i.e. it came from a web page.
    BrowserOrigin,
    NotJson,
    NotFound,
    MethodNotAllowed,
    TooLarge,
    /// Distinct from [`Refusal::TooLarge`] so a hangup isn't logged as an
    /// oversized upload.
    Unreadable,
}

impl Refusal {
    pub fn status(self) -> u16 {
        match self {
            Refusal::BrowserOrigin => 403,
            Refusal::NotJson => 415,
            Refusal::NotFound => 404,
            Refusal::MethodNotAllowed => 405,
            Refusal::TooLarge => 413,
            Refusal::Unreadable => 400,
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Refusal::BrowserOrigin => {
                "requests carrying an Origin header are refused (browser-originated)"
            }
            Refusal::NotJson => "Content-Type must be application/json",
            Refusal::NotFound => "not found",
            Refusal::MethodNotAllowed => "method not allowed",
            Refusal::TooLarge => "request body too large",
            Refusal::Unreadable => "could not read request body",
        }
    }
}

/// Whether a request may reach the dispatcher. Pure and header-only: it is the whole
/// security boundary, so tests must exercise it without a socket. `origin_present` is
/// a **bool, not a value** — the rule is presence, so the type says presence.
pub fn check_admission(
    method: &str,
    path: &str,
    origin_present: bool,
    content_type: Option<&str>,
) -> Result<(), Refusal> {
    // Origin first: a more specific error would leak which checks it passed.
    if origin_present {
        return Err(Refusal::BrowserOrigin);
    }
    if path != MCP_PATH {
        return Err(Refusal::NotFound);
    }
    if !method.eq_ignore_ascii_case("POST") {
        return Err(Refusal::MethodNotAllowed);
    }
    if !is_json_content_type(content_type) {
        return Err(Refusal::NotJson);
    }
    Ok(())
}

/// Tolerates parameters and case (`application/json; charset=utf-8`) and nothing
/// else. `text/plain` is rejected, which is the point: it is the only type a web
/// page can send without triggering a preflight.
fn is_json_content_type(value: Option<&str>) -> bool {
    let Some(value) = value else { return false };
    let essence = value.split(';').next().unwrap_or("").trim();
    essence.eq_ignore_ascii_case("application/json")
}

/// A real request to this instance's endpoint, for the app's "test this tool"
/// affordance. **In Rust, not a webview `fetch`**: that carries an `Origin`, which
/// [`check_admission`] rejects, so the frontend cannot call its own endpoint.
/// `simulate_browser_origin` attaches one to *demonstrate* the rejection.
#[tauri::command]
pub async fn mcp_test_call(
    body: String,
    simulate_browser_origin: bool,
) -> Result<serde_json::Value, String> {
    use http_body_util::BodyExt;
    use hyper::Request;
    use hyper_util::rt::TokioIo;

    // Refuse unless *this* instance serves: `PORT` is set before the bind, so on an
    // instance that lost the race it names another checkout's live socket — and a
    // write tool would land on a board this window never displays.
    if !SERVING.load(Ordering::Relaxed) {
        return Err("this instance is not serving MCP (another instance holds the port), so \
                    there is nothing here to test"
            .to_string());
    }
    let port = PORT.load(Ordering::Relaxed);
    if port == 0 {
        return Err("MCP port is not configured".to_string());
    }
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let started = std::time::Instant::now();

    let stream = tokio::net::TcpStream::connect(addr)
        .await
        .map_err(|e| format!("could not reach {addr}: {e}"))?;
    let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|e| format!("HTTP handshake failed: {e}"))?;
    // The connection future must be driven for the request to make progress.
    tauri::async_runtime::spawn(async move {
        let _ = conn.await;
    });

    let mut request = Request::builder()
        .method("POST")
        .uri(format!("http://127.0.0.1:{port}{MCP_PATH}"))
        .header(hyper::header::CONTENT_TYPE, "application/json");
    if simulate_browser_origin {
        request = request.header(hyper::header::ORIGIN, "https://example.invalid");
    }
    let request = request.body(body).map_err(|e| format!("could not build request: {e}"))?;

    let response =
        sender.send_request(request).await.map_err(|e| format!("request failed: {e}"))?;
    let status = response.status().as_u16();
    let bytes = response
        .into_body()
        .collect()
        .await
        .map_err(|e| format!("could not read response: {e}"))?
        .to_bytes();

    let duration_ms = started.elapsed().as_millis() as u64;
    tracing::info!(status, duration_ms, sent_origin = simulate_browser_origin, "mcp.test_call");

    Ok(serde_json::json!({
        "status": status,
        "body": String::from_utf8_lossy(&bytes),
        "durationMs": duration_ms,
        "sentOrigin": simulate_browser_origin,
    }))
}

/// Bind and serve until the app exits, or do nothing if something holds the port.
/// Never errors to the caller: failing to serve MCP must not stop startup.
pub fn spawn(app: AppHandle, port: u16) {
    PORT.store(port, Ordering::Relaxed);
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let listener = match StdTcpListener::bind(addr) {
        Ok(listener) => listener,
        Err(error) => {
            // Each checkout claims its own port, so this is a genuine collision
            // (a stale instance, a hand-set `mcp.port`) and this instance's
            // sessions will silently talk to whoever holds it.
            tracing::warn!(
                %addr,
                %error,
                "mcp.http: port already held; this instance serves no MCP"
            );
            return;
        }
    };
    if let Err(error) = listener.set_nonblocking(true) {
        tracing::warn!(%error, "mcp.http: could not set non-blocking; not serving");
        return;
    }
    // From the socket, not the requested value: `port: 0` is a legal `u16` that
    // binds an ephemeral port, so the UI would advertise `127.0.0.1:0` and
    // `mcp_test_call`'s sentinel would refuse a server that is listening.
    if let Ok(bound) = listener.local_addr() {
        PORT.store(bound.port(), Ordering::Relaxed);
    }

    // Its own SQLite connection rather than the app's `StoreState` mutex, so MCP
    // calls and UI reads never block each other. The cost: a write here doesn't
    // refresh the UI, hence the re-emit below.
    let store = match Store::open_default() {
        Ok(store) => store,
        Err(error) => {
            tracing::warn!(%error, "mcp.http: store unavailable; not serving");
            return;
        }
    };
    // Age out stale calendar rows at startup: retention otherwise runs only as a
    // side effect of a write, and the push model has no guaranteed writer (the pull
    // collector is off by default). Without it, an app reopened after a quiet week
    // counts down to a meeting from whenever anything was last written.
    let _ = store.sweep_old_events(crate::store::now_ms());

    let dispatcher = Arc::new(Mutex::new(
        Dispatcher::new(store)
            .with_task_host(Box::new(AppTaskHost { app: app.clone() }))
            .with_preview_host(Box::new(AppPreviewHost { app: app.clone() }))
            .with_editor_host(Box::new(AppEditorHost { app: app.clone() })),
    ));

    SERVING.store(true, Ordering::Relaxed);
    tracing::info!(%addr, "mcp.http: serving");
    tauri::async_runtime::spawn(async move {
        accept_loop(app, listener, dispatcher).await;
    });
}

/// The same delete path the app's UI uses ([`tt_mcp::TaskHost`]), on the connection's
/// `spawn_blocking` thread and holding the dispatcher's mutex throughout: a slow
/// delete serializes other calls, which beats a half-deleted store being read.
struct AppTaskHost {
    app: AppHandle,
}

impl tt_mcp::TaskHost for AppTaskHost {
    fn delete_task(
        &self,
        id: i64,
        force: bool,
        outcome: Option<tt_store::TaskOutcome>,
    ) -> Result<tt_mcp::TaskDeletion, String> {
        use crate::task::{DeleteTarget, TaskDeleteOutcome};

        match crate::task::delete_task_blocking(
            &self.app,
            DeleteTarget::Board(id),
            force,
            outcome,
            false,
        )? {
            TaskDeleteOutcome::Deleted { name, messages } => {
                Ok(tt_mcp::TaskDeletion::Deleted { name, messages })
            }
            TaskDeleteOutcome::Blocked { name, blockers, messages } => {
                // The same `Blocker` the frontend dialog renders, so agent and
                // human read the same fields. One conversion for the list, so a
                // failure is an error here rather than a `null` standing in for a
                // blocker in the refusal an agent acts on.
                let blockers = serde_json::to_value(&blockers)
                    .ok()
                    .and_then(|value| value.as_array().cloned())
                    .ok_or_else(|| format!("could not encode blockers for task {id}"))?;
                Ok(tt_mcp::TaskDeletion::Refused { name, blockers, messages })
            }
        }
    }

    /// Emit [`TASK_START_EVENT`] and return. The worktree is deliberately *not* made
    /// here: the `+` flow already runs create → card → pane → setup → agent with the
    /// serial-drain and no-PTY-until-rendered rules baked in, so a half-in-Rust path
    /// would drift from them. Hence `"starting"` — emitting can't know the outcome.
    fn start_task(&self, req: tt_mcp::TaskStartRequest) -> Result<(), String> {
        let payload = TaskStartPayload {
            task_id: req.id,
            repo_root: req.repo_root,
            branch: req.branch,
            base: req.base,
            prompt: req.prompt,
        };
        tracing::info!(
            task_id = req.id,
            text = %req.text,
            branch = %payload.branch,
            "task.start_requested"
        );
        self.app
            .emit(TASK_START_EVENT, &payload)
            .map_err(|e| format!("couldn't ask the app to start task {}: {e}", req.id))
    }
}

/// Puts a file the agent points at on screen. Emits and returns, like
/// [`AppTaskHost::start_task`] — see [`tt_mcp::PreviewHost`] for why.
struct AppPreviewHost {
    app: AppHandle,
}

impl tt_mcp::PreviewHost for AppPreviewHost {
    fn show(&self, file: tt_mcp::PreviewFile) -> Result<(), String> {
        let payload =
            PreviewShowPayload { path: file.path, title: file.title, session: file.session };
        tracing::info!(
            path = %payload.path,
            title = %payload.title,
            session = payload.session.as_deref().unwrap_or("-"),
            "preview.show_requested"
        );
        self.app
            .emit(PREVIEW_SHOW_EVENT, &payload)
            .map_err(|e| format!("couldn't ask the app to show {}: {e}", payload.path))
    }
}

/// Lets the `file_open` MCP tool reveal a path in a folder's Files pane. Emits and
/// returns like [`AppPreviewHost::show`] — see [`tt_mcp::EditorHost`].
struct AppEditorHost {
    app: AppHandle,
}

impl tt_mcp::EditorHost for AppEditorHost {
    fn open_file(&self, req: tt_mcp::FileToOpen) -> Result<(), String> {
        let payload = FileOpenPayload {
            path: req.path,
            is_dir: req.is_dir,
            line: req.line,
            session: req.session,
        };
        tracing::info!(
            path = %payload.path,
            is_dir = payload.is_dir,
            line = payload.line.unwrap_or(0),
            session = payload.session.as_deref().unwrap_or("-"),
            "editor.open_file_requested"
        );
        self.app
            .emit(EDITOR_OPEN_FILE_EVENT, &payload)
            .map_err(|e| format!("couldn't ask the app to open {}: {e}", payload.path))
    }
}

/// Asks the frontend to reveal a path in a folder's Files pane. Consumed by
/// `apps/client/src/lib/editor-open.ts`, which lands it on the same files-pane
/// route as a terminal file link and the IDE protocol's `openFile`.
pub const EDITOR_OPEN_FILE_EVENT: &str = "editor://open-file";

/// The [`EDITOR_OPEN_FILE_EVENT`] payload. `camelCase` to match the frontend's
/// Zod schema for it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FileOpenPayload {
    path: String,
    /// Decided in Rust because the webview cannot `stat` — see
    /// [`tt_mcp::FileToOpen::is_dir`].
    is_dir: bool,
    line: Option<u32>,
    /// The caller's PTY session when it identified itself; the frontend routes
    /// on it and falls back to the longest tracked-folder prefix of `path`.
    session: Option<String>,
}

/// Asks the frontend to display a file in a folder's Preview pane.
/// Consumed by `apps/client/src/lib/preview-artifact.ts`.
pub const PREVIEW_SHOW_EVENT: &str = "preview://show";

/// The PTY session a request came from — `TT_SESSION_ID`, filled in by the MCP client
/// via `.mcp.json`'s `${TT_SESSION_ID:-}` and never by the model: a value it must
/// remember to pass is one it can get wrong, and the failure mode is a page in another
/// task's window. Grants nothing; [`check_admission`] is the whole boundary.
pub const SESSION_HEADER: &str = "x-tt-session";

/// The caller's PTY session, off [`SESSION_HEADER`]. Granting nothing, an
/// **undecodable** header reads as absent — the opposite of `Origin`'s presence rule:
/// a garbled value should cost a preferred pane, not the call. Blank collapses to
/// "didn't say", the common case outside an app terminal.
fn caller_context(headers: &hyper::HeaderMap) -> tt_mcp::RequestContext {
    tt_mcp::RequestContext::for_session(headers.get(SESSION_HEADER).and_then(|v| v.to_str().ok()))
}

/// The [`PREVIEW_SHOW_EVENT`] payload — the path only, never the file's
/// contents; `preview.rs` documents why.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewShowPayload {
    path: String,
    title: String,
    /// The frontend routes on this, falling back to the path when `None`.
    session: Option<String>,
}

/// Asks the frontend to start a board task — mint its worktree and launch an
/// agent on `prompt`. Consumed by `apps/client/src/lib/task-start.ts`.
pub const TASK_START_EVENT: &str = "task://start";

/// The [`TASK_START_EVENT`] payload. `camelCase` to match the frontend's Zod
/// schema for it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskStartPayload {
    task_id: i64,
    repo_root: String,
    branch: String,
    base: Option<String>,
    prompt: String,
}

/// Accept until aborted; a failed connection recycles the loop. Load-bearing here:
/// returning leaves the socket bound with nothing serving, so nothing can notice.
/// `accept` fails transiently (an RST between SYN and accept, fd exhaustion), so those
/// retry; `SERVING` clears only where we give up.
async fn accept_loop(app: AppHandle, listener: StdTcpListener, dispatcher: Arc<Mutex<Dispatcher>>) {
    let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
        tracing::warn!("mcp.http: listener could not join the runtime; not serving");
        SERVING.store(false, Ordering::Relaxed);
        return;
    };
    // Consecutive failures, reset by any success. A listener that is genuinely
    // broken (its fd closed under us) would otherwise spin this loop hot.
    let mut consecutive_errors = 0u32;
    loop {
        let (stream, _peer) = match listener.accept().await {
            Ok(accepted) => {
                consecutive_errors = 0;
                accepted
            }
            Err(error) => {
                consecutive_errors += 1;
                tracing::warn!(%error, consecutive_errors, "mcp.http: accept failed");
                if consecutive_errors >= 64 {
                    tracing::error!("mcp.http: accept failing persistently; stopping");
                    SERVING.store(false, Ordering::Relaxed);
                    return;
                }
                // Yield before retrying so a hard-failing accept can't starve
                // the runtime.
                tokio::task::yield_now().await;
                continue;
            }
        };
        let app = app.clone();
        let dispatcher = dispatcher.clone();
        tauri::async_runtime::spawn(async move {
            serve_connection(app, stream, dispatcher).await;
        });
    }
}

/// Serve one connection: parse requests, admit or refuse them, and hand the
/// admitted bodies to the dispatcher.
async fn serve_connection(
    app: AppHandle,
    stream: tokio::net::TcpStream,
    dispatcher: Arc<Mutex<Dispatcher>>,
) {
    use hyper::service::service_fn;
    use hyper::{Request, StatusCode};
    use hyper_util::rt::TokioIo;

    let io = TokioIo::new(stream);
    let service = service_fn(move |req: Request<hyper::body::Incoming>| {
        let app = app.clone();
        let dispatcher = dispatcher.clone();
        async move {
            let method = req.method().as_str().to_string();
            let path = req.uri().path().to_string();
            // Presence only — a header we can't decode is still a header, and
            // treating it as absent would admit the request.
            let origin_present = req.headers().contains_key(hyper::header::ORIGIN);
            let content_type = req
                .headers()
                .get(hyper::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            let ctx = caller_context(req.headers());

            if let Err(refusal) =
                check_admission(&method, &path, origin_present, content_type.as_deref())
            {
                tracing::warn!(
                    %method, %path, refusal = ?refusal,
                    "mcp.http: request refused"
                );
                return Ok::<_, std::convert::Infallible>(text_response(
                    refusal.status(),
                    refusal.message(),
                ));
            }

            let body = match read_body(req.into_body()).await {
                Ok(body) => body,
                Err(refusal) => {
                    return Ok(text_response(refusal.status(), refusal.message()));
                }
            };

            // The dispatcher is blocking (SQLite) and its guard must not be
            // held across an await, so the whole call runs on a blocking thread.
            let reply = tokio::task::spawn_blocking(move || {
                let mut dispatcher = match dispatcher.lock() {
                    Ok(guard) => guard,
                    // A previous panic poisoned the lock. Recover rather than
                    // propagate: every tool is a self-contained store call, so
                    // there's no half-broken invariant, and losing MCP is worse.
                    Err(poisoned) => poisoned.into_inner(),
                };
                dispatcher.dispatch(&body, &ctx)
            })
            .await;

            match reply {
                // A notification: no response body. 202 is what MCP's
                // streamable-HTTP transport specifies for this case.
                Ok(handled) if handled.response.is_none() => {
                    Ok(status_response(StatusCode::ACCEPTED, String::new()))
                }
                Ok(handled) => {
                    // Only for a call that wrote: the rebuild is the whole snapshot
                    // and takes the `StoreState` lock this transport opened a second
                    // connection to avoid. Detached, being blocking SQLite behind a
                    // mutex sync commands also hold.
                    if handled.wrote {
                        let app = app.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            crate::store::emit_snapshot_from_app(&app);
                        });
                    }
                    Ok(json_response(handled.response.unwrap_or_default()))
                }
                Err(error) => {
                    tracing::error!(%error, "mcp.http: dispatch task failed");
                    Ok(text_response(500, "internal error"))
                }
            }
        }
    });

    // `.timer(...)` is load-bearing: with no timer installed, hyper silently drops
    // its 30s header-read timeout, and a peer that never finishes its headers then
    // holds a task and an fd forever. It is what bounds a half-open connection.
    let mut builder = hyper::server::conn::http1::Builder::new();
    builder
        .timer(hyper_util::rt::TokioTimer::new())
        .header_read_timeout(std::time::Duration::from_secs(30));
    if let Err(error) = builder.serve_connection(io, service).await {
        // Client hangups are routine; log at debug so the event log keeps the
        // detail without the terminal turning into noise.
        tracing::debug!(%error, "mcp.http: connection ended");
    }
}

/// Refuses anything past [`MAX_BODY_BYTES`] **without buffering it first**: `Limited`
/// stops reading at the budget, where checking length after `collect()` would
/// materialize the whole upload and only then reject it. Any other failure is
/// [`Refusal::Unreadable`] — a hangup logged as 413 would mislead.
async fn read_body(body: hyper::body::Incoming) -> Result<String, Refusal> {
    use http_body_util::{BodyExt, Limited};

    let limited = Limited::new(body, MAX_BODY_BYTES);
    match limited.collect().await {
        Ok(collected) => Ok(String::from_utf8_lossy(&collected.to_bytes()).into_owned()),
        // `Limited` surfaces the overflow as its own boxed error; anything else
        // is a genuine transport failure.
        Err(error) if error.is::<http_body_util::LengthLimitError>() => Err(Refusal::TooLarge),
        Err(_) => Err(Refusal::Unreadable),
    }
}

/// An explicit status with no fallible step: `Response::builder()` defers errors to
/// `.body()`, and the natural `.unwrap_or_else(|_| Response::new(body))` yields a
/// **200 OK**, turning a security refusal into an acceptance. Setting parts on an
/// already-built response cannot fail.
fn status_response(status: hyper::StatusCode, body: String) -> hyper::Response<String> {
    let mut response = hyper::Response::new(body);
    *response.status_mut() = status;
    response
}

fn json_response(body: String) -> hyper::Response<String> {
    let mut response = status_response(hyper::StatusCode::OK, body);
    response.headers_mut().insert(
        hyper::header::CONTENT_TYPE,
        hyper::header::HeaderValue::from_static("application/json"),
    );
    response
}

fn text_response(status: u16, message: &str) -> hyper::Response<String> {
    // Fails *closed* if a status ever fails to convert: 500 says something went
    // wrong, where the builder's default 200 would have said "admitted".
    let status =
        hyper::StatusCode::from_u16(status).unwrap_or(hyper::StatusCode::INTERNAL_SERVER_ERROR);
    let mut response = status_response(status, message.to_string());
    response.headers_mut().insert(
        hyper::header::CONTENT_TYPE,
        hyper::header::HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    // These tests are the security boundary's only direct coverage. With the
    // capability gate gone, nothing else stands between a web page and a write.

    #[test]
    fn a_normal_mcp_client_request_is_admitted() {
        assert_eq!(check_admission("POST", "/mcp", false, Some("application/json")), Ok(()));
    }

    #[test]
    fn content_type_parameters_and_casing_are_tolerated() {
        for value in [
            "application/json; charset=utf-8",
            "Application/JSON",
            "application/json ",
            "application/json;charset=UTF-8",
        ] {
            assert_eq!(
                check_admission("POST", "/mcp", false, Some(value)),
                Ok(()),
                "should admit {value}"
            );
        }
    }

    /// Refuses on the header's *presence*: a real MCP client never sends one, so
    /// there is nothing to allowlist and an allowlist would trust an
    /// attacker-controlled string. A bool makes the old fail-open unrepresentable —
    /// `.to_str().ok()` is `None` for a non-UTF8 `Origin`, once admitted as absent.
    #[test]
    fn a_present_origin_header_is_refused_whatever_its_value() {
        assert_eq!(
            check_admission("POST", "/mcp", true, Some("application/json")),
            Err(Refusal::BrowserOrigin)
        );
        // …and an absent one is the only way through.
        assert_eq!(check_admission("POST", "/mcp", false, Some("application/json")), Ok(()));
    }

    /// `text/plain` is the one content type a page can POST without a preflight,
    /// so rejecting it is what forces a browser into a preflight it will fail.
    #[test]
    fn non_json_content_types_are_refused() {
        for value in [
            "text/plain",
            "text/plain;charset=UTF-8",
            "application/x-www-form-urlencoded",
            "multipart/form-data; boundary=x",
            "application/json-patch+json",
        ] {
            assert_eq!(
                check_admission("POST", "/mcp", false, Some(value)),
                Err(Refusal::NotJson),
                "should refuse {value}"
            );
        }
    }

    #[test]
    fn a_missing_content_type_is_refused() {
        assert_eq!(check_admission("POST", "/mcp", false, None), Err(Refusal::NotJson));
    }

    /// Both defenses hold together: neither check is load-bearing alone.
    #[test]
    fn a_browser_request_is_refused_by_whichever_check_it_trips() {
        // Simple request: no preflight, but text/plain.
        assert_eq!(
            check_admission("POST", "/mcp", true, Some("text/plain")),
            Err(Refusal::BrowserOrigin)
        );
        // Even if some future client somehow omitted Origin, the content type
        // a no-preflight page can send is still refused.
        assert_eq!(
            check_admission("POST", "/mcp", false, Some("text/plain")),
            Err(Refusal::NotJson)
        );
    }

    #[test]
    fn only_post_to_the_mcp_path_is_served() {
        assert_eq!(
            check_admission("GET", "/mcp", false, Some("application/json")),
            Err(Refusal::MethodNotAllowed)
        );
        assert_eq!(
            check_admission("POST", "/", false, Some("application/json")),
            Err(Refusal::NotFound)
        );
        assert_eq!(
            check_admission("POST", "/mcp/extra", false, Some("application/json")),
            Err(Refusal::NotFound)
        );
        // Method casing is not meaningful in HTTP routing here.
        assert_eq!(check_admission("post", "/mcp", false, Some("application/json")), Ok(()));
    }

    /// No response carries CORS headers, so a preflight fails closed. Pinned
    /// because "helpfully" adding them later would undo the whole defense.
    #[test]
    fn preflight_is_not_specially_accommodated() {
        assert_eq!(check_admission("OPTIONS", "/mcp", true, None), Err(Refusal::BrowserOrigin));
        assert_eq!(check_admission("OPTIONS", "/mcp", false, None), Err(Refusal::MethodNotAllowed));
    }

    #[test]
    fn refusal_statuses_are_distinct_and_sane() {
        assert_eq!(Refusal::BrowserOrigin.status(), 403);
        assert_eq!(Refusal::NotJson.status(), 415);
        assert_eq!(Refusal::NotFound.status(), 404);
        assert_eq!(Refusal::MethodNotAllowed.status(), 405);
        assert_eq!(Refusal::TooLarge.status(), 413);
        assert_eq!(Refusal::Unreadable.status(), 400);
    }

    // --- caller identity (`preview_file` routing) ---

    fn headers(session: Option<&str>) -> hyper::HeaderMap {
        let mut headers = hyper::HeaderMap::new();
        if let Some(session) = session {
            headers.insert(SESSION_HEADER, session.parse().unwrap());
        }
        headers
    }

    #[test]
    fn the_session_header_names_the_callers_terminal() {
        assert_eq!(
            caller_context(&headers(Some("s64abebd44298447d"))).session.as_deref(),
            Some("s64abebd44298447d")
        );
    }

    /// What every session outside an app terminal sends, `${TT_SESSION_ID:-}`
    /// expanding to nothing. It must read as "no session", or the file routes to a
    /// pane that cannot exist instead of falling back to its path.
    #[test]
    fn an_empty_session_header_means_no_session() {
        assert_eq!(caller_context(&headers(Some(""))).session, None);
        assert_eq!(caller_context(&headers(Some("   "))).session, None);
    }

    #[test]
    fn a_request_without_the_header_has_no_session() {
        assert_eq!(caller_context(&headers(None)).session, None);
    }

    /// The inverse of `Origin`'s presence rule: granting nothing, an undecodable
    /// value costs a preferred pane rather than the request.
    #[test]
    fn an_undecodable_session_header_is_treated_as_absent() {
        let mut raw = hyper::HeaderMap::new();
        raw.insert(SESSION_HEADER, hyper::header::HeaderValue::from_bytes(b"\xff\xfe").unwrap());
        assert_eq!(caller_context(&raw).session, None);
    }
}
