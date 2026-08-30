//! Loopback HTTP transport for the MCP server ([`tt_mcp`]): the socket, the HTTP framing
//! and the request-admission rules. Every instance serves its own MCP on its own port,
//! claimed per checkout, and a session started in an app's terminal reaches *that* app
//! because the app stamps [`tt_mcp::port::MCP_PORT_ENV`] into the shell. The machine-wide
//! singleton this replaced was wrong on correctness: `tt.db` is *instance* state, so
//! whichever instance won a fixed 8787 answered every session out of **its own** board.
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
/// The port [`spawn`] attempted, bound or not — the UI needs it either way.
static PORT: AtomicU16 = AtomicU16::new(0);

/// The real bind outcome, not an inference from call recency.
#[tauri::command]
pub fn mcp_status() -> serde_json::Value {
    serde_json::json!({
        "serving": SERVING.load(Ordering::Relaxed),
        "port": PORT.load(Ordering::Relaxed),
        "protocolVersion": tt_mcp::PROTOCOL_VERSION,
        "version": env!("CARGO_PKG_VERSION"),
    })
}

/// `None` if this instance never bound. The distinction matters where
/// [`tt_mcp::port::MCP_PORT_ENV`] is stamped into a spawned terminal: advertising a port
/// we don't serve points a session at nothing.
pub fn serving_port() -> Option<u16> {
    SERVING.load(Ordering::Relaxed).then(|| PORT.load(Ordering::Relaxed))
}

const MCP_PATH: &str = "/mcp";

/// Enforced incrementally by `Limited` in [`read_body`], so a stray upload can't
/// balloon memory before being rejected.
const MAX_BODY_BYTES: usize = 1024 * 1024;

/// A type rather than inline strings, so tests assert on the *reason*, not on prose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    BrowserOrigin,
    NotJson,
    NotFound,
    MethodNotAllowed,
    TooLarge,
    /// Distinct from [`Refusal::TooLarge`] so a hangup isn't logged as an upload.
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

/// Whether a request may reach the dispatcher. Pure and header-only so tests can
/// exercise it without a socket; `origin_present` is a bool because the rule is presence.
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

/// Tolerates parameters and case and nothing else. Rejecting `text/plain` is the point:
/// it is the only type a web page can send without triggering a preflight.
fn is_json_content_type(value: Option<&str>) -> bool {
    let Some(value) = value else { return false };
    let essence = value.split(';').next().unwrap_or("").trim();
    essence.eq_ignore_ascii_case("application/json")
}

/// A real request to this instance's endpoint. **In Rust, not a webview `fetch`**: that
/// carries an `Origin`, so the frontend cannot call its own endpoint.
#[tauri::command]
pub async fn mcp_test_call(
    body: String,
    simulate_browser_origin: bool,
) -> Result<serde_json::Value, String> {
    use http_body_util::BodyExt;
    use hyper::Request;
    use hyper_util::rt::TokioIo;

    // `PORT` is set before the bind, so on an instance that lost the race it names
    // another checkout's live socket — a write would land on a board nobody displays.
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
        .header(hyper::header::CONTENT_TYPE, "application/json")
        .header(hyper::header::ACCEPT, "application/json, text/event-stream");
    // Mirrored from the body the way a real client does it, so a body without `_meta`
    // is refused exactly as a legacy client's would be.
    let sent: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
    let meta = &sent["params"]["_meta"];
    for (header, value) in [
        (tt_mcp::PROTOCOL_VERSION_HEADER, meta[tt_mcp::META_PROTOCOL_VERSION].as_str()),
        (tt_mcp::METHOD_HEADER, sent["method"].as_str()),
        (tt_mcp::NAME_HEADER, sent["params"]["name"].as_str()),
    ] {
        if let Some(value) = value {
            request = request.header(header, value);
        }
    }
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

/// Never errors to the caller: failing to serve MCP must not stop startup.
pub fn spawn(app: AppHandle, port: u16) {
    PORT.store(port, Ordering::Relaxed);
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let listener = match StdTcpListener::bind(addr) {
        Ok(listener) => listener,
        Err(error) => {
            // Each checkout claims its own port, so this is a genuine collision and
            // this instance's sessions will silently talk to whoever holds it.
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
    // From the socket, not the requested value: `port: 0` legally binds an ephemeral
    // port, and the UI would then advertise `127.0.0.1:0`.
    if let Ok(bound) = listener.local_addr() {
        PORT.store(bound.port(), Ordering::Relaxed);
    }

    // Its own SQLite connection rather than the app's `StoreState` mutex, so MCP calls
    // and UI reads never block each other. The cost is the re-emit below.
    let store = match Store::open_default() {
        Ok(store) => store,
        Err(error) => {
            tracing::warn!(%error, "mcp.http: store unavailable; not serving");
            return;
        }
    };
    // Retention otherwise runs only as a side effect of a write, and the push model has
    // no guaranteed writer — a week-old calendar would count down from stale rows.
    let _ = store.sweep_old_events(crate::store::now_ms());

    let dispatcher = Arc::new(Mutex::new(
        Dispatcher::new(store, env!("CARGO_PKG_VERSION"))
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

/// The same delete path the app's UI uses, holding the dispatcher's mutex throughout: a
/// slow delete serializes other calls, which beats a half-deleted store being read.
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
                // The same `Blocker` the frontend dialog renders. A conversion failure
                // errors here rather than putting `null` in a refusal an agent acts on.
                let blockers = serde_json::to_value(&blockers)
                    .ok()
                    .and_then(|value| value.as_array().cloned())
                    .ok_or_else(|| format!("could not encode blockers for task {id}"))?;
                Ok(tt_mcp::TaskDeletion::Refused { name, blockers, messages })
            }
        }
    }

    /// The worktree is deliberately *not* made here: the `+` flow already bakes in the
    /// serial-drain and no-PTY-until-rendered rules, and a half-in-Rust path would drift.
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

/// Puts a file the agent points at on screen. Emits and returns, like `start_task`.
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

/// Lets the `file_open` MCP tool reveal a path in a folder's Files pane.
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

/// Consumed by `apps/client/src/lib/editor-open.ts`, on the same files-pane route as a
/// terminal file link and the IDE protocol's `openFile`.
pub const EDITOR_OPEN_FILE_EVENT: &str = "editor://open-file";

/// `camelCase` to match the frontend's Zod schema.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FileOpenPayload {
    path: String,
    /// Decided in Rust because the webview cannot `stat`.
    is_dir: bool,
    line: Option<u32>,
    /// The frontend routes on this, falling back to the longest tracked-folder prefix.
    session: Option<String>,
}

/// Consumed by `apps/client/src/lib/preview-artifact.ts`.
pub const PREVIEW_SHOW_EVENT: &str = "preview://show";

/// The PTY session a request came from — `TT_SESSION_ID`, filled in by the MCP client
/// and never by the model: a value it must remember to pass is one it can get wrong,
/// and the failure mode is a page in another task's window. Grants nothing.
pub const SESSION_HEADER: &str = "x-tt-session";

/// An **undecodable** header reads as absent — the opposite of `Origin`'s presence
/// rule, since a garbled value should cost a preferred pane, not the call.
fn caller_context(headers: &hyper::HeaderMap) -> tt_mcp::RequestContext {
    let get = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
    tt_mcp::RequestContext::for_session(headers.get(SESSION_HEADER).and_then(|v| v.to_str().ok()))
        .with_headers(tt_mcp::MirroredHeaders {
            protocol_version: get(tt_mcp::PROTOCOL_VERSION_HEADER),
            method: get(tt_mcp::METHOD_HEADER),
            name: get(tt_mcp::NAME_HEADER),
        })
}

/// The path only, never the file's contents; `preview.rs` documents why.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewShowPayload {
    path: String,
    title: String,
    /// The frontend routes on this, falling back to the path when `None`.
    session: Option<String>,
}

/// Mint a worktree and launch an agent on `prompt`. Consumed by
/// `apps/client/src/lib/task-start.ts`.
pub const TASK_START_EVENT: &str = "task://start";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskStartPayload {
    task_id: i64,
    repo_root: String,
    branch: String,
    base: Option<String>,
    prompt: String,
}

/// Accept until aborted; returning would leave the socket bound with nothing serving,
/// so transient `accept` failures retry and `SERVING` clears only where we give up.
async fn accept_loop(app: AppHandle, listener: StdTcpListener, dispatcher: Arc<Mutex<Dispatcher>>) {
    let Ok(listener) = tokio::net::TcpListener::from_std(listener) else {
        tracing::warn!("mcp.http: listener could not join the runtime; not serving");
        SERVING.store(false, Ordering::Relaxed);
        return;
    };
    // A genuinely broken listener (its fd closed under us) would spin this loop hot.
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
                // Yield so a hard-failing accept can't starve the runtime.
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
            // Presence only — a header we can't decode is still a header.
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

            // The dispatcher is blocking (SQLite) and its guard must not be held across
            // an await, so the whole call runs on a blocking thread.
            let reply = tokio::task::spawn_blocking(move || {
                let mut dispatcher = match dispatcher.lock() {
                    Ok(guard) => guard,
                    // Recover from a poisoning panic: every tool is a self-contained
                    // store call, so there's no half-broken invariant to inherit.
                    Err(poisoned) => poisoned.into_inner(),
                };
                dispatcher.dispatch(&body, &ctx)
            })
            .await;

            match reply {
                // A notification: no response body, and 202 is what MCP specifies.
                Ok(handled) if handled.response.is_none() => {
                    Ok(status_response(StatusCode::ACCEPTED, String::new()))
                }
                Ok(handled) => {
                    // Only for a call that wrote: the rebuild is the whole snapshot and
                    // takes the `StoreState` lock this transport exists to avoid.
                    if handled.wrote {
                        let app = app.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            crate::store::emit_snapshot_from_app(&app);
                        });
                    }
                    let status = status_for(handled.error_code);
                    Ok(json_response(status, handled.response.unwrap_or_default()))
                }
                Err(error) => {
                    tracing::error!(%error, "mcp.http: dispatch task failed");
                    Ok(text_response(500, "internal error"))
                }
            }
        }
    });

    // `.timer(...)` is load-bearing: with no timer installed hyper silently drops its
    // header-read timeout, and a peer that stalls mid-headers holds an fd forever.
    let mut builder = hyper::server::conn::http1::Builder::new();
    builder
        .timer(hyper_util::rt::TokioTimer::new())
        .header_read_timeout(std::time::Duration::from_secs(30));
    if let Err(error) = builder.serve_connection(io, service).await {
        // Client hangups are routine; debug keeps the detail without the noise.
        tracing::debug!(%error, "mcp.http: connection ended");
    }
}

/// Refuses anything past [`MAX_BODY_BYTES`] **without buffering it first**: checking
/// length after `collect()` would materialize the whole upload and only then reject it.
async fn read_body(body: hyper::body::Incoming) -> Result<String, Refusal> {
    use http_body_util::{BodyExt, Limited};

    let limited = Limited::new(body, MAX_BODY_BYTES);
    match limited.collect().await {
        Ok(collected) => Ok(String::from_utf8_lossy(&collected.to_bytes()).into_owned()),
        // `Limited` boxes the overflow as its own error; anything else is transport.
        Err(error) if error.is::<http_body_util::LengthLimitError>() => Err(Refusal::TooLarge),
        Err(_) => Err(Refusal::Unreadable),
    }
}

/// An explicit status with no fallible step: `Response::builder()` defers errors to
/// `.body()`, whose natural fallback yields a **200 OK** — a refusal turned acceptance.
fn status_response(status: hyper::StatusCode, body: String) -> hyper::Response<String> {
    let mut response = hyper::Response::new(body);
    *response.status_mut() = status;
    response
}

/// 2026-07-28 gives the refusals a client keys its fallback on a status of their own, a
/// request missing its required `_meta` included; everything else — a tool's `isError`
/// answer, the `-32602` for an unknown tool, which carries no code — is a 200 with a JSON-RPC body.
fn status_for(error_code: Option<i64>) -> hyper::StatusCode {
    match error_code {
        Some(tt_mcp::METHOD_NOT_FOUND) => hyper::StatusCode::NOT_FOUND,
        Some(
            tt_mcp::HEADER_MISMATCH
            | tt_mcp::UNSUPPORTED_PROTOCOL_VERSION
            | tt_mcp::INVALID_PARAMS
            | tt_mcp::INVALID_REQUEST
            | tt_mcp::PARSE_ERROR,
        ) => hyper::StatusCode::BAD_REQUEST,
        _ => hyper::StatusCode::OK,
    }
}

fn json_response(status: hyper::StatusCode, body: String) -> hyper::Response<String> {
    let mut response = status_response(status, body);
    response.headers_mut().insert(
        hyper::header::CONTENT_TYPE,
        hyper::header::HeaderValue::from_static("application/json"),
    );
    response
}

fn text_response(status: u16, message: &str) -> hyper::Response<String> {
    // Fails *closed* on an unconvertible status, where a default 200 says "admitted".
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

    // The security boundary's only direct coverage: with the capability gate gone,
    // nothing else stands between a web page and a write.

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

    /// Refuses on the header's *presence*: a real MCP client never sends one, so an
    /// allowlist would only trust an attacker-controlled string.
    #[test]
    fn a_present_origin_header_is_refused_whatever_its_value() {
        assert_eq!(
            check_admission("POST", "/mcp", true, Some("application/json")),
            Err(Refusal::BrowserOrigin)
        );
        assert_eq!(check_admission("POST", "/mcp", false, Some("application/json")), Ok(()));
    }

    /// `text/plain` is the one type a page can POST without a preflight, so rejecting
    /// it forces a browser into a preflight it will fail.
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
        assert_eq!(
            check_admission("POST", "/mcp", true, Some("text/plain")),
            Err(Refusal::BrowserOrigin)
        );
        // Even without Origin, a no-preflight page's content type is still refused.
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

    /// No response carries CORS headers, so a preflight fails closed. Pinned because
    /// "helpfully" adding them later would undo the whole defense.
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

    /// The dispatcher's refusals get the status the spec assigns; a tool's own
    /// `isError` answer (no code) and any other JSON-RPC error stay a 200.
    #[test]
    fn dispatcher_refusals_map_to_the_specs_statuses() {
        use hyper::StatusCode;
        assert_eq!(status_for(None), StatusCode::OK);
        assert_eq!(status_for(Some(tt_mcp::METHOD_NOT_FOUND)), StatusCode::NOT_FOUND);
        assert_eq!(status_for(Some(tt_mcp::HEADER_MISMATCH)), StatusCode::BAD_REQUEST);
        assert_eq!(status_for(Some(tt_mcp::UNSUPPORTED_PROTOCOL_VERSION)), StatusCode::BAD_REQUEST);
        assert_eq!(status_for(Some(tt_mcp::PARSE_ERROR)), StatusCode::BAD_REQUEST);
        assert_eq!(status_for(Some(tt_mcp::INVALID_PARAMS)), StatusCode::BAD_REQUEST);
        assert_eq!(status_for(Some(-32603)), StatusCode::OK);
    }

    #[test]
    fn the_mirrored_headers_reach_the_dispatcher() {
        let mut headers = hyper::HeaderMap::new();
        headers.insert(tt_mcp::PROTOCOL_VERSION_HEADER, "2026-07-28".parse().unwrap());
        headers.insert(tt_mcp::METHOD_HEADER, "tools/call".parse().unwrap());
        headers.insert(tt_mcp::NAME_HEADER, "file_open".parse().unwrap());
        assert_eq!(
            caller_context(&headers).headers,
            Some(tt_mcp::MirroredHeaders {
                protocol_version: Some("2026-07-28".into()),
                method: Some("tools/call".into()),
                name: Some("file_open".into()),
            })
        );
        // Always a header layer here, even with nothing in it: absence is what gets refused.
        assert_eq!(caller_context(&hyper::HeaderMap::new()).headers, Some(Default::default()));
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

    /// What every session outside an app terminal sends. It must read as "no session",
    /// or the file routes to a pane that cannot exist instead of to its path.
    #[test]
    fn an_empty_session_header_means_no_session() {
        assert_eq!(caller_context(&headers(Some(""))).session, None);
        assert_eq!(caller_context(&headers(Some("   "))).session, None);
    }

    #[test]
    fn a_request_without_the_header_has_no_session() {
        assert_eq!(caller_context(&headers(None)).session, None);
    }

    /// The inverse of `Origin`'s rule: an undecodable value costs a pane, not the call.
    #[test]
    fn an_undecodable_session_header_is_treated_as_absent() {
        let mut raw = hyper::HeaderMap::new();
        raw.insert(SESSION_HEADER, hyper::header::HeaderValue::from_bytes(b"\xff\xfe").unwrap());
        assert_eq!(caller_context(&raw).session, None);
    }
}
