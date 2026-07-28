//! Loopback HTTP transport for the MCP server ([`tt_mcp`]).
//!
//! [`tt_mcp`] turns a JSON-RPC request string into a response string and
//! nothing else; this module is the socket, the HTTP framing and the
//! request-admission rules. Same split as [`crate::ide`] over [`tt_ide`].
//!
//! Every instance serves its own MCP on its own port, claimed per checkout from
//! `.env.example`'s `${tt:port 8787-8986}` ([`port_for_this_instance`]). A
//! session started in an app's terminal reaches *that* app, because the app
//! stamps [`MCP_PORT_ENV`] into the shell and the plugin's `.mcp.json` expands
//! it. The machine-wide singleton this replaced was wrong on correctness, not
//! ergonomics: `tt.db` is *instance* state scoped per checkout, so the one
//! instance that won a fixed 8787 answered every session out of **its own**
//! board, while the rest served nothing for their whole lives. The bind is
//! still fail-soft — a held port logs and serves nothing rather than taking the
//! app down — but that is now a real anomaly, so [`spawn`] warns. A session
//! with no `TT_MCP_PORT` falls back to 8787, which is why the range starts there.
//!
//! **[`check_admission`] is the entire security boundary** — no bearer token,
//! no capability gate (both removed 2026-07-20; see [`tt_mcp`]) — and a pure
//! function, so it is tested directly rather than through a live socket.
//! Loopback keeps *remote hosts* out, not *web pages*: any site can POST to
//! `127.0.0.1`, and CORS only stops it reading the reply, while a blind write
//! is the whole attack. So: **reject any request carrying an `Origin` header**
//! (browsers always send one, real MCP clients never — the DNS-rebinding
//! mitigation, rejecting on *presence*, since an allowlist invites trusting an
//! attacker-controlled string), and **require `Content-Type:
//! application/json`** (not a CORS-simple type, so a page cannot send it
//! without a preflight the browser refuses).

use std::net::{Ipv4Addr, SocketAddr, TcpListener as StdTcpListener};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter};
use tt_mcp::Dispatcher;
use tt_store::Store;

/// Whether *this* instance bound its port and is serving MCP.
///
/// Process-global rather than managed Tauri state because it is written from
/// [`spawn`] during setup and read by a command; there is exactly one server
/// per process, so there is nothing to key it by.
static SERVING: AtomicBool = AtomicBool::new(false);
/// The port [`spawn`] attempted, whether or not the bind succeeded — the UI
/// needs it either way (to show the endpoint, or to say what's contended).
static PORT: AtomicU16 = AtomicU16::new(0);

/// Whether this instance is serving MCP, and on which port.
///
/// Reported to the app's MCP screen so the status it shows is the real bind
/// outcome rather than an inference from call recency — those differ exactly
/// when it matters: a healthy server nobody has called yet, and an instance
/// whose port was already taken and is serving nothing at all.
#[tauri::command]
pub fn mcp_status() -> serde_json::Value {
    serde_json::json!({
        "serving": SERVING.load(Ordering::Relaxed),
        "port": PORT.load(Ordering::Relaxed),
    })
}

/// The port this instance is actually serving on, or `None` if it never bound.
///
/// The distinction matters at exactly one call site — stamping [`MCP_PORT_ENV`]
/// into a spawned terminal, where advertising a port we don't serve would point
/// a session at nothing.
pub fn serving_port() -> Option<u16> {
    SERVING.load(Ordering::Relaxed).then(|| PORT.load(Ordering::Relaxed))
}

/// The MCP endpoint path. A single route: this is not a REST API.
const MCP_PATH: &str = "/mcp";

/// Names the MCP port an app instance serves on, in that instance's own
/// environment and in every terminal it spawns.
///
/// Rendered per checkout from the `${tt:port 8787-8986}` claim in
/// `.env.example`, like every other port here. The plugin's `.mcp.json` expands
/// it as `${TT_MCP_PORT:-8787}`, so a session started in an app terminal reaches
/// the app that spawned it.
pub const MCP_PORT_ENV: &str = "TT_MCP_PORT";

/// The port this instance should serve on, most specific source first:
///
/// 1. `TT_MCP_PORT` in the process's own environment — an explicit override, and
///    what a nested app inherits nothing of (the PTY scrub drops `TT_*`).
/// 2. The checkout's `TT_MCP_PORT` claim from its rendered `.env` — the normal
///    case, and the per-checkout claim that makes instances stop colliding.
/// 3. The settings `mcp.port` — a machine-wide default for a packaged app
///    running outside any checkout.
///
/// Pure so the precedence is tested directly: it is the kind of ordering that
/// looks obviously right and silently isn't, and getting it wrong points every
/// session at one instance again — the exact failure this replaced.
///
/// A `0` is rejected along with unparseable junk: binding port 0 takes an
/// ephemeral port no `.mcp.json` could ever name.
fn resolve_port(process_env: Option<&str>, dotenv_claim: Option<u16>, settings_port: u16) -> u16 {
    process_env
        .map(str::trim)
        .and_then(|v| v.parse::<u16>().ok())
        .filter(|&port| port > 0)
        .or(dotenv_claim)
        .unwrap_or(settings_port)
}

/// [`resolve_port`] against the real environment: this process's env, then the
/// `.env` of the checkout it is running in (`None` outside one).
///
/// The `.env` value is read as a **port claim**
/// ([`tt_tasks::envfile::port_claims_by_key`]) rather than parsed here, so the
/// app binds exactly the port its siblings see as taken. Reading it any other
/// way lets the two disagree — a value the claim scanner skips is one no
/// sibling avoids, yet this app would happily bind it.
pub fn port_for_this_instance() -> u16 {
    let settings_port =
        tt_config::load().map(|s| s.mcp.port).unwrap_or(tt_config::DEFAULT_MCP_PORT);
    let dotenv_claim = std::env::current_dir()
        .ok()
        .and_then(|dir| tt_config::checkout_root_from_dir(&dir))
        .and_then(|root| std::fs::read_to_string(root.join(".env")).ok())
        .and_then(|text| tt_tasks::envfile::port_claims_by_key(&text).get(MCP_PORT_ENV).copied());
    resolve_port(std::env::var(MCP_PORT_ENV).ok().as_deref(), dotenv_claim, settings_port)
}

/// Largest request body accepted. Enforced incrementally by `Limited` in
/// [`read_body`] — the body is never buffered past this, so a stray upload
/// can't balloon memory rather than merely being rejected after the fact. MCP
/// requests are small; `calendar_set` pushing a full day of events is the
/// biggest realistic payload and is far under this.
const MAX_BODY_BYTES: usize = 1024 * 1024;

/// Why a request was refused before it ever reached the dispatcher.
///
/// Each maps to an HTTP status and a short body. Kept as a type rather than
/// inline strings so [`check_admission`]'s tests assert on the *reason*, not on
/// prose that might be reworded later.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// Request carried an `Origin` header — i.e. it came from a web page.
    BrowserOrigin,
    /// Missing or non-JSON `Content-Type`.
    NotJson,
    /// Wrong path.
    NotFound,
    /// Wrong method (only POST is served).
    MethodNotAllowed,
    /// Body exceeded [`MAX_BODY_BYTES`].
    TooLarge,
    /// The body could not be read to the end (e.g. the client hung up).
    /// Distinct from [`Refusal::TooLarge`] so the logs don't report a hangup as
    /// an oversized upload.
    Unreadable,
}

impl Refusal {
    /// HTTP status to answer with.
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

    /// Short human-readable reason, returned as the response body.
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

/// Decide whether a request may reach the dispatcher.
///
/// Pure and header-only on purpose: this is the whole security boundary (see
/// the module doc), so it is exercised directly by unit tests rather than only
/// through a live socket.
///
/// `origin_present` is deliberately a **bool, not the header's value**. The
/// rule is presence, so the type says presence — passing the parsed value
/// invites the fail-open this signature now makes unrepresentable: reading the
/// header with `.to_str().ok()` yields `None` for a present-but-non-UTF8
/// `Origin`, which would have been admitted as though the header were absent.
/// Callers must ask `headers().contains_key(ORIGIN)` and nothing else.
///
/// `content_type` is the raw `Content-Type` header, where the value *does*
/// matter.
pub fn check_admission(
    method: &str,
    path: &str,
    origin_present: bool,
    content_type: Option<&str>,
) -> Result<(), Refusal> {
    // Origin first: a browser-originated request is refused whatever else it
    // says, and answering it with a more specific error would leak which of the
    // other checks it passed.
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

/// Whether a `Content-Type` header names JSON.
///
/// Tolerates parameters (`application/json; charset=utf-8`) and case, since
/// those are legitimate and a real client may send them — but nothing else.
/// Notably `text/plain` is rejected, which is the point: it is the only content
/// type a web page can send without triggering a preflight.
fn is_json_content_type(value: Option<&str>) -> bool {
    let Some(value) = value else { return false };
    let essence = value.split(';').next().unwrap_or("").trim();
    essence.eq_ignore_ascii_case("application/json")
}

/// Make a real HTTP request to this machine's MCP endpoint, for the app's
/// "test this tool" affordance.
///
/// **Why this lives in Rust rather than a `fetch` in the webview:** the webview
/// is a browser context, so any `fetch` it makes to `127.0.0.1` carries an
/// `Origin` header — and [`check_admission`] rejects exactly that. The app
/// genuinely cannot call its own MCP endpoint from the frontend, which is the
/// defense working as designed, not a bug to route around. Issuing the request
/// from here (no `Origin`, like a real MCP client) is the only way to exercise
/// the true path end to end: socket, admission checks, dispatcher, and back.
///
/// `simulate_browser_origin` deliberately attaches an `Origin` header so the UI
/// can *demonstrate* the rejection rather than merely claim it. That makes the
/// security boundary something the user can watch work.
///
/// Returns the HTTP status and raw body either way — a refusal is a result to
/// display, not an error, so the caller sees precisely what a real client would.
#[tauri::command]
pub async fn mcp_test_call(
    body: String,
    simulate_browser_origin: bool,
) -> Result<serde_json::Value, String> {
    use http_body_util::BodyExt;
    use hyper::Request;
    use hyper_util::rt::TokioIo;

    // Refuse unless *this* instance is the one serving. `PORT` is set before the
    // bind is attempted, so on an instance that lost the race it still names a
    // live socket — belonging to a different app instance, whose `Store` is a
    // different checkout's `tt.db`. Dialing it anyway would run a write tool
    // against a board this window will never display, under a dialog that says
    // the call succeeded.
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

/// Bind this instance's MCP port and serve until the app exits, or do nothing
/// if something already holds it.
///
/// Never returns an error to the caller: failing to serve MCP must not stop the
/// app from starting.
pub fn spawn(app: AppHandle, port: u16) {
    PORT.store(port, Ordering::Relaxed);
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let listener = match StdTcpListener::bind(addr) {
        Ok(listener) => listener,
        Err(error) => {
            // Each checkout claims its own port, so reaching here is a genuine
            // collision — a stale instance, two checkouts claiming the same
            // port, or a hand-set `mcp.port` — and this instance's sessions
            // will silently talk to whoever holds it instead. Hence a warning;
            // the module doc covers why it used to be routine.
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
    // Re-read the port from the socket rather than trusting the requested one.
    // `port: 0` is a legal `u16` that settings accepts, and binding it succeeds
    // on an OS-assigned ephemeral port — so without this the UI would advertise
    // `127.0.0.1:0` as the endpoint to paste into `.mcp.json`, and
    // `mcp_test_call`'s `port == 0` sentinel would refuse to reach a server that
    // is in fact listening.
    if let Ok(bound) = listener.local_addr() {
        PORT.store(bound.port(), Ordering::Relaxed);
    }

    // The dispatcher owns its own SQLite connection rather than sharing the
    // app's `StoreState` mutex: MCP calls and UI reads then never block each
    // other, and SQLite handles the concurrent connections. The cost is that a
    // write here doesn't automatically refresh the UI, which is why a mutating
    // call re-emits the snapshot through the app's own state below.
    let store = match Store::open_default() {
        Ok(store) => store,
        Err(error) => {
            tracing::warn!(%error, "mcp.http: store unavailable; not serving");
            return;
        }
    };
    // Age out stale calendar rows once at startup. Retention otherwise only runs
    // as a side effect of a calendar *write*, and the push model this server
    // exists to serve has no guaranteed writer: the pull collector is off by
    // default, so a machine whose events all arrive over `calendar_set` sweeps
    // nothing at all while nobody is pushing. Without this, an app reopened
    // after a quiet week counts down to a meeting from the last day anything
    // was written.
    let _ = store.sweep_old_events(crate::store::now_ms());

    let dispatcher = Arc::new(Mutex::new(
        Dispatcher::new(store)
            .with_task_host(Box::new(AppTaskHost { app: app.clone() }))
            .with_preview_host(Box::new(AppPreviewHost { app: app.clone() })),
    ));

    SERVING.store(true, Ordering::Relaxed);
    tracing::info!(%addr, "mcp.http: serving");
    tauri::async_runtime::spawn(async move {
        accept_loop(app, listener, dispatcher).await;
    });
}

/// Lets the `task_delete` MCP tool reach the same delete path the app's own UI
/// uses — see [`tt_mcp::TaskHost`] for why the tool can't do this itself.
///
/// Runs on the connection's `spawn_blocking` thread (the dispatcher call
/// already is one), which is right for work that is entirely git subprocesses.
/// It does hold the dispatcher's mutex for the duration, so a slow delete
/// serializes other MCP calls behind it — acceptable for a single-user local
/// server, and the alternative (releasing the lock mid-call) would let a
/// concurrent tool observe the store halfway through a delete.
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
                // Serialize through the same `Blocker` the frontend dialog
                // renders, so an agent reading the refusal and a human reading
                // the dialog are looking at the same fields. One conversion for
                // the whole list, so a serialization failure is one error here
                // rather than a `null` silently taking a blocker's place in the
                // refusal an agent acts on.
                let blockers = serde_json::to_value(&blockers)
                    .ok()
                    .and_then(|value| value.as_array().cloned())
                    .ok_or_else(|| format!("could not encode blockers for task {id}"))?;
                Ok(tt_mcp::TaskDeletion::Refused { name, blockers, messages })
            }
        }
    }

    /// Hand the start off to the frontend by emitting [`TASK_START_EVENT`].
    ///
    /// This does *not* create the worktree here, even though that half is
    /// ordinary blocking work the host could do. Creating it in Rust and then
    /// asking the frontend to launch the agent would fork the start path in two:
    /// the app's own `+` flow already runs create → pending card → `task_create`
    /// → pane → setup → agent, in that order, with the serial-drain and
    /// no-PTY-until-rendered rules baked in (see `apps/client/CLAUDE.md`). A
    /// second half-in-Rust path would have to restate those, and would drift.
    /// So the frontend runs the whole thing, and this only says "start task N".
    ///
    /// The trade-off is deliberate and is why the tool answers `"starting"`:
    /// emitting can't report whether the worktree appeared.
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

/// Lets the `preview_show` MCP tool put an agent-authored HTML artifact on
/// screen. Emits and returns, like [`AppTaskHost::start_task`] — see
/// [`tt_mcp::PreviewHost`] for why the hand-off has to work this way.
struct AppPreviewHost {
    app: AppHandle,
}

impl tt_mcp::PreviewHost for AppPreviewHost {
    fn show(&self, artifact: tt_mcp::PreviewArtifact) -> Result<(), String> {
        let payload = PreviewShowPayload {
            path: artifact.path,
            title: artifact.title,
            session: artifact.session,
        };
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

/// Asks the frontend to display an HTML artifact in a folder's Preview pane.
/// Consumed by `apps/client/src/lib/preview-artifact.ts`.
pub const PREVIEW_SHOW_EVENT: &str = "preview://show";

/// Names the app PTY session a request came from — `TT_SESSION_ID`, which
/// `terminal.rs` stamps on every shell the app spawns.
///
/// The `towles-tool-app` plugin's `.mcp.json` sets it with Claude Code's
/// `${TT_SESSION_ID:-}` expansion, so it is filled in by the MCP client from
/// the agent's own environment rather than by the agent. That distinction is
/// the point: a value the model has to remember to look up and pass is one it
/// can omit or get wrong, and `preview_show`'s failure mode is a page appearing
/// in a different task's window — which looks like it worked.
///
/// An `X-`-prefixed name because it is ours and non-standard. It is not
/// authentication and grants nothing: [`check_admission`] is still the entire
/// security boundary, and a request with a forged or absent session gets a
/// pane, not access. (It does add one incidental defence — a custom header
/// isn't CORS-simple, so a web page can't send it without a preflight the
/// server never answers.)
pub const SESSION_HEADER: &str = "x-tt-session";

/// What this transport knows about the caller: the app PTY session it is
/// running in, read off [`SESSION_HEADER`].
///
/// Pure and header-only for the same reason [`check_admission`] is: it is
/// exercised directly rather than through a live socket. Unlike admission this
/// grants nothing, so an **undecodable** header is treated as absent — the
/// opposite of `Origin`'s presence-only rule, because a garbled value here
/// should cost the caller its preferred pane, not its call.
///
/// Blank values collapse to "didn't say" inside
/// [`tt_mcp::RequestContext::for_session`], which owns that rule for every
/// transport rather than each restating it — and it is the common case, not a
/// defensive flourish: `${TT_SESSION_ID:-}` expands to an empty header for
/// every Claude Code session started outside an app terminal.
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
    /// The requesting agent's PTY session, when it identified itself. The
    /// frontend routes on this and falls back to the path when it's `None` —
    /// see `preview-artifact.ts`.
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

/// Accept connections until the task is aborted. One failed connection recycles
/// the loop rather than taking the server down.
///
/// That distinction is load-bearing here in a way it isn't for a typical server:
/// this process holds the port for the whole machine, so returning from this
/// loop takes MCP down for *every* Claude Code session with no other instance
/// able to take over — while the socket stays bound, so nothing can even notice.
/// `accept` fails for reasons that are per-connection and transient (the peer
/// RSTs between SYN and accept; the process is momentarily out of file
/// descriptors, plausible with a PTY per terminal plus `gh`/`git`/`claude`
/// subprocesses), so those are logged and retried. `SERVING` is cleared on the
/// paths that really do give up, so `mcp_status` stops claiming to serve.
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
                    // A panic in a previous call poisoned the lock. Recover the
                    // guard rather than propagating: the dispatcher holds no
                    // invariant that a panic could have half-broken (every tool
                    // is a self-contained store call), and taking the server
                    // down for the rest of the session is the worse failure.
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
                    // Refresh the UI only for a call that actually wrote. The
                    // dispatcher writes through its own connection, so the app
                    // wouldn't otherwise notice — but `emit_snapshot_from_app`
                    // rebuilds the *entire* snapshot and takes `StoreState`'s
                    // lock, which is the lock this transport opened a second
                    // connection to stay off. Doing that per read would hand
                    // back the contention the separate connection bought, and a
                    // session's opening `initialize` + `tools/list` alone would
                    // pay for two full rebuilds that changed nothing.
                    //
                    // Detached onto the blocking pool, and deliberately not
                    // awaited: the rebuild is blocking SQLite work behind a
                    // `std::sync::Mutex` that sync Tauri commands also hold, so
                    // running it inline would park a tokio worker for the whole
                    // contended hold — the very thing the `spawn_blocking` above
                    // exists to avoid — and would make the caller wait on a UI
                    // refresh it has no stake in.
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

    // `.timer(...)` is not optional decoration: hyper's default 30s
    // header-read timeout is silently dropped (with only an internal warning)
    // when no timer is installed, and without it a peer that opens a socket and
    // never finishes its request headers holds a task and an fd forever. On a
    // machine-wide singleton that is enough to take MCP down for every session
    // on the box, so the timeout is what bounds a half-open connection.
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

/// Read the whole request body, refusing anything past [`MAX_BODY_BYTES`]
/// **without buffering it first**.
///
/// The cap is enforced by `Limited`, which stops reading once the budget is
/// exhausted, rather than by checking the length after `collect()` — collecting
/// first would materialize an oversized upload in full and only then reject it,
/// which is the opposite of what the cap is for.
///
/// A read that fails for any other reason (a client hanging up mid-body) is
/// reported as [`Refusal::Unreadable`], not as "too large" — mislabelling a
/// hangup 413 would make the refusal logs actively misleading.
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

/// A response with an explicit status, built without a fallible step.
///
/// `Response::builder()` defers every error to `.body()`, and the natural
/// `.unwrap_or_else(|_| Response::new(body))` fallback yields a **200 OK** —
/// which would quietly turn a security refusal into an acceptance. Setting the
/// parts on an already-constructed response has no failure mode, so there is no
/// error left to mishandle.
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

    /// The DNS-rebinding mitigation: refuse on the header's *presence*. A real
    /// MCP client never sends one, so there is nothing to allowlist — and an
    /// allowlist would mean trusting an attacker-controlled string.
    /// The DNS-rebinding mitigation refuses on the header's *presence*, so
    /// there is nothing to allowlist — and an allowlist would mean trusting an
    /// attacker-controlled string.
    ///
    /// The signature takes a bool rather than the header value precisely so the
    /// fail-open this used to have is unrepresentable: reading the header with
    /// `.to_str().ok()` yields `None` for a present-but-non-UTF8 `Origin`, and
    /// passing that through would have admitted the request as though no header
    /// were sent. Presence is the rule, so presence is the parameter.
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

    /// Both browser defenses have to hold together: a page that omits
    /// `Content-Type` still gets caught, and one that sets it still gets caught
    /// by Origin. Neither check is load-bearing alone.
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

    /// An OPTIONS preflight must not be answered with anything permissive —
    /// there are no CORS headers on any response, so a browser preflight fails
    /// closed. Pinned because "helpfully" adding CORS headers later would
    /// silently undo the whole defense.
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

    // --- port resolution ---

    #[test]
    fn the_checkouts_dotenv_claim_beats_the_shared_settings_default() {
        assert_eq!(resolve_port(None, Some(8801), 8787), 8801);
    }

    /// An explicit env var is a deliberate override (a script, a hand-run
    /// binary), so it outranks the file.
    #[test]
    fn the_process_environment_wins_over_the_dotenv() {
        assert_eq!(resolve_port(Some("9000"), Some(8801), 8787), 9000);
    }

    /// A packaged app launched from the desktop is in no checkout and has no
    /// `.env` to read.
    #[test]
    fn settings_answer_outside_a_checkout() {
        assert_eq!(resolve_port(None, None, 9191), 9191);
    }

    /// An override can be a blank, junk, or out of range. Falling *through* to
    /// the next source keeps the app serving on a sane port. `0` is the one
    /// that parses and still has to be rejected — binding it takes an ephemeral
    /// port no `.mcp.json` could name.
    ///
    /// The `.env` side needs no equivalent: it arrives as an already-validated
    /// claim from `envfile::port_claims_by_key`, which is tested in `tt-tasks`
    /// and is what rejects an unsubstituted `${tt:port 8787-8986}` token there.
    #[test]
    fn an_unusable_override_falls_through_instead_of_binding_nonsense() {
        for bad in [
            "",
            "   ",
            "${tt:port 8787-8986}",
            "eight thousand",
            "70000",
            "-1",
            "0",
        ] {
            assert_eq!(resolve_port(Some(bad), None, 8787), 8787, "should reject {bad:?}");
            assert_eq!(resolve_port(Some(bad), Some(8801), 8787), 8801, "should reject {bad:?}");
        }
    }

    #[test]
    fn surrounding_whitespace_is_tolerated() {
        assert_eq!(resolve_port(Some(" 9000 "), None, 8787), 9000);
    }

    // --- caller identity (`preview_show` routing) ---

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

    /// What every Claude Code session outside an app terminal sends, since
    /// `${TT_SESSION_ID:-}` expands to nothing. It has to read as "no session",
    /// or the artifact routes to a pane that cannot exist instead of falling
    /// back to its path. The rule itself lives in `RequestContext::for_session`;
    /// this pins that the transport actually goes through it.
    #[test]
    fn an_empty_session_header_means_no_session() {
        assert_eq!(caller_context(&headers(Some(""))).session, None);
        assert_eq!(caller_context(&headers(Some("   "))).session, None);
    }

    #[test]
    fn a_request_without_the_header_has_no_session() {
        assert_eq!(caller_context(&headers(None)).session, None);
    }

    /// The inverse of `Origin`'s presence-only rule, deliberately: this header
    /// grants nothing, so an undecodable value costs the caller its preferred
    /// pane rather than its request.
    #[test]
    fn an_undecodable_session_header_is_treated_as_absent() {
        let mut raw = hyper::HeaderMap::new();
        raw.insert(SESSION_HEADER, hyper::header::HeaderValue::from_bytes(b"\xff\xfe").unwrap());
        assert_eq!(caller_context(&raw).session, None);
    }
}
