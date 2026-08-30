//! A Model Context Protocol (MCP) server for towles-tool — **the transport-free
//! half**. [`Dispatcher::dispatch_at`] takes one JSON-RPC request string and returns
//! one response string, knowing nothing about sockets, HTTP, ports or the wall clock.
//! Same split as [`tt_ide`]: the transport lives in `crates-tauri/tt-app`, so the
//! whole tool surface is unit-testable with no server to stand up.
//!
//! Speaks **MCP 2026-07-28 only** — no `initialize` handshake, no session: every request
//! carries its version and the caller's identity in `params._meta`, `server/discover`
//! says so up front, and a client opening with `initialize` is refused by an error
//! naming the version, all the spec asks of a modern-only server.
//!
//! No capability gate on writes: they are local and reversible, and any session with
//! shell access could `sqlite3` tt.db regardless. What *is* guarded — a web page POSTing
//! to `127.0.0.1` — belongs to the transport's admission checks.

use std::borrow::Cow;
use std::time::Instant;

use chrono::{Local, NaiveDate, TimeZone};

mod output;
pub mod port;

use serde_json::{Value, json};
use tt_store::{EventInput, McpCallInput, Store};

/// The one revision served, shared with the CLI so both ends of `tt open` move together.
pub const PROTOCOL_VERSION: &str = "2026-07-28";
/// `params._meta` keys — the version a request must carry, its `clientInfo`, and ours on results.
pub const META_PROTOCOL_VERSION: &str = "io.modelcontextprotocol/protocolVersion";
pub const META_CLIENT_INFO: &str = "io.modelcontextprotocol/clientInfo";
pub const META_CLIENT_CAPABILITIES: &str = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER_INFO: &str = "io.modelcontextprotocol/serverInfo";
/// Streamable HTTP mirrors body fields into these; a mismatch is refused ([`HEADER_MISMATCH`]).
pub const PROTOCOL_VERSION_HEADER: &str = "mcp-protocol-version";
pub const METHOD_HEADER: &str = "mcp-method";
pub const NAME_HEADER: &str = "mcp-name";

pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const HEADER_MISMATCH: i64 = -32020;
pub const UNSUPPORTED_PROTOCOL_VERSION: i64 = -32022;

/// Cap on the args rendering kept per call-log row, so a huge payload can't bloat tt.db.
const CALL_LOG_ARGS_MAX: usize = 400;

/// The app-side half of `task_delete`: panes and worktree are invisible from this Tauri-free
/// crate, so the transport injects `tt-app`'s `task::delete_task_blocking`. With no host the
/// tool refuses outright — a row-only delete is the half-delete it exists to stop.
pub trait TaskHost: Send {
    /// Close task `id` and delete everything bound to it, keeping the row with `outcome` (`None`:
    /// infer from the row). `force` skips the work-preserving guards; `Ok(Refused)` is an answer.
    fn delete_task(
        &self,
        id: i64,
        force: bool,
        outcome: Option<tt_store::TaskOutcome>,
    ) -> Result<TaskDeletion, String>;

    /// Mint `req`'s worktree and launch an agent on its goal. Hands the work off and returns —
    /// see [`TaskStartRequest`] for why the completion isn't awaited.
    fn start_task(&self, req: TaskStartRequest) -> Result<(), String>;
}

/// The app-side half of `preview_file`, the agent→human direction of the Preview pane. A
/// hand-off like [`TaskHost::start_task`]: the tool answers `"showing"`, not that the user saw
/// it. Routed by caller, not path — see [`PreviewFile::session`].
pub trait PreviewHost: Send {
    fn show(&self, file: PreviewFile) -> Result<(), String>;
}

/// A validated file to display — see [`PreviewHost`].
pub struct PreviewFile {
    /// Absolute path to an existing readable file, checked by the dispatcher.
    pub path: String,
    /// What to label the pane with; the file name when the caller gave none.
    pub title: String,
    /// The routing key: the PTY session the agent runs in, resolved by the app to the folder owning
    /// it. `None` (no app terminal) falls back to matching the path, which picks wrong for a file
    /// under no tracked folder — hence the session on the request.
    pub session: Option<String>,
}

/// The app-side half of `file_open`: reveal a path already on disk in the caller's Files pane.
/// A hand-off for [`PreviewHost`]'s reason, hence `"opening"`. Routed by caller first, path
/// second — and here the path fallback is a good guess, since a file names its checkout.
pub trait EditorHost: Send {
    fn open_file(&self, request: FileToOpen) -> Result<(), String>;
}

/// A validated path to reveal in the Files pane — see [`EditorHost`].
pub struct FileToOpen {
    /// Absolute, canonical path to an existing file or directory.
    pub path: String,
    /// Sent because the frontend cannot `stat`: a directory opens the pane on the folder, a file
    /// opens the pane *and* selects the file.
    pub is_dir: bool,
    /// 1-based line to reveal, when the caller named one.
    pub line: Option<u32>,
    /// The PTY session the caller runs in — the routing key, see [`EditorHost`].
    pub session: Option<String>,
}

/// Absolute and canonical for [`validate_preview_path`]'s reasons.
fn validate_open_path(raw: &str) -> Result<(String, bool), String> {
    let path = std::path::Path::new(raw.trim());
    if path.as_os_str().is_empty() {
        return Err("missing required argument: path".to_string());
    }
    if !path.is_absolute() {
        return Err(format!(
            "path must be absolute — {raw:?} is relative, and this server serves every session on \
             the machine, so it has no working directory to resolve it against"
        ));
    }
    let resolved = std::fs::canonicalize(path).map_err(|e| format!("can't open {raw:?}: {e}"))?;
    let is_dir = resolved.is_dir();
    Ok((resolved.to_string_lossy().into_owned(), is_dir))
}

/// The frontend inlines the whole file, so a huge path must fail as an answer, not a frozen window.
const PREVIEW_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// Every rejection is one the agent can fix and would otherwise meet as a blank pane: relative,
/// missing, a directory, too big. File *type* is not one — the pane renders HTML, Markdown and
/// text alike. Canonical on the way out, so pane and agent agree on one spelling.
fn validate_preview_path(raw: &str) -> Result<String, String> {
    let path = std::path::Path::new(raw.trim());
    if path.as_os_str().is_empty() {
        return Err("missing required argument: path".to_string());
    }
    if !path.is_absolute() {
        return Err(format!(
            "path must be absolute — {raw:?} is relative, and this server serves every session on \
             the machine, so it has no working directory to resolve it against"
        ));
    }
    let meta = std::fs::metadata(path).map_err(|e| format!("can't read {raw:?}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{raw:?} is not a file"));
    }
    if meta.len() > PREVIEW_MAX_BYTES {
        return Err(format!(
            "{raw:?} is {} bytes — the preview inlines the whole file, so keep it under {} bytes",
            meta.len(),
            PREVIEW_MAX_BYTES
        ));
    }
    // Already passed `stat`; a canonicalize failure is exotic and not worth refusing over.
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    Ok(resolved.to_string_lossy().into_owned())
}

/// The caller's title, else the file name — never an empty header, which reads as broken.
fn preview_title(path: &str, title: Option<&str>) -> String {
    match title.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => t.to_string(),
        None => std::path::Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Preview".to_string()),
    }
}

/// Everything the host needs to start a task, resolved from the row so the host reads nothing.
/// A hand-off, not a completed action: a pane has no PTY until the frontend renders it, so the
/// tool reports `status: "starting"` and `task_list`/`task_status` confirm the worktree.
pub struct TaskStartRequest {
    pub id: i64,
    pub text: String,
    /// The checkout the worktree branches from — the row's bound repo root.
    pub repo_root: String,
    /// Derived from `text` when the caller doesn't name one — a task is named after its branch.
    pub branch: String,
    /// Base ref, or `None` for the repo's default branch.
    pub base: Option<String>,
    /// The row's `goal` plus its `notes`, where a task's real handoff context lives.
    pub prompt: String,
}

/// What a [`TaskHost::delete_task`] attempt produced. The refusal is an `Ok` variant for the
/// reason it is one in `tt_tasks::ops::RemoveOutcome`: "uncommitted work" is an answer with a
/// next step, and as an error it invites a forced retry. Both carry `name` to spare a re-read.
pub enum TaskDeletion {
    /// The task is gone: panes, worktree, and board row.
    Deleted { name: String, messages: Vec<String> },
    /// Each blocker carries `losesWork`: "stop your dev server" vs "forcing destroys commits".
    Refused {
        name: String,
        blockers: Vec<Value>,
        messages: Vec<String>,
    },
}

/// The core of the server: owns the [`Store`] and dispatches JSON-RPC to tool handlers.
pub struct Dispatcher {
    store: Store,
    /// `serverInfo` on every result. The version is the *app's*, passed in: this crate's own
    /// says nothing to a client, and only the app knows which build is serving.
    server_info: Value,
    /// Injected by the transport; `None` in tests, where `task_delete` refuses.
    task_host: Option<Box<dyn TaskHost>>,
    /// Injected by the transport; `None` in tests, where `preview_file` refuses.
    preview_host: Option<Box<dyn PreviewHost>>,
    /// Injected by the transport; `None` in tests, where `file_open` refuses.
    editor_host: Option<Box<dyn EditorHost>>,
    /// Test hook: fixed lane ids, keeping `calendar_set` off the real settings file.
    calendar_sources: Option<Vec<String>>,
}

/// What the transport knows that the body cannot say: which app terminal the agent sits in
/// (`TT_SESSION_ID`, forwarded by the plugin's `.mcp.json` as `X-TT-Session`), so `preview_file`
/// lands in the caller's own task. Passed through, never stashed: one dispatcher serves everyone.
#[derive(Debug, Clone, Default)]
pub struct RequestContext {
    /// `TT_SESSION_ID` — also the rail's session id and the `term_id` of its pane.
    pub session: Option<String>,
    /// The HTTP binding's copies of body fields; `None` on a transport with no header layer.
    pub headers: Option<MirroredHeaders>,
}

/// `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` as received.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MirroredHeaders {
    pub protocol_version: Option<String>,
    pub method: Option<String>,
    pub name: Option<String>,
}

impl RequestContext {
    /// No caller identity — the Tauri-free drivers and most tests.
    pub fn none() -> RequestContext {
        RequestContext::default()
    }

    /// Blank collapses to `None`: `${TT_SESSION_ID:-}` expands empty outside an app terminal, and
    /// that must read as "didn't say", not as a bad id.
    pub fn for_session(session: Option<&str>) -> RequestContext {
        RequestContext {
            session: session.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string),
            headers: None,
        }
    }

    pub fn with_headers(mut self, headers: MirroredHeaders) -> RequestContext {
        self.headers = Some(headers);
        self
    }
}

/// What one dispatched request produced. `wrote` answers "must the transport repaint?", not
/// "did this mutate?": refusals, failed writes, reads and [`SELF_REFRESHING_TOOLS`] all say false.
pub struct Handled {
    pub response: Option<String>,
    pub wrote: bool,
    /// Set when the request was refused before any tool ran; decides the HTTP status.
    pub error_code: Option<i64>,
}

impl Handled {
    fn read(response: Option<String>) -> Handled {
        Handled { response, wrote: false, error_code: None }
    }

    fn refused(response: String, code: i64) -> Handled {
        Handled { response: Some(response), wrote: false, error_code: Some(code) }
    }
}

/// The tools whose success means the transport must repaint: a store write the app's UI has
/// not seen. Not [`Effect`]'s `readOnlyHint` — `task_start` writes nothing here (the frontend
/// runs its own start path and repaints) yet is anything but read-only to a client.
const WRITING_TOOLS: &[&str] = &["task_create", "task_summary", "task_delete", "calendar_set"];

pub fn tool_writes(name: &str) -> bool {
    WRITING_TOOLS.contains(&name)
}

/// Writing tools that repaint the UI themselves, so the transport must not. `task_delete` runs
/// the app's own delete path, which emits a snapshot as the row goes; a second rebuild would
/// take the `StoreState` mutex even for a refused delete. Still a [`WRITING_TOOLS`] entry.
const SELF_REFRESHING_TOOLS: &[&str] = &["task_delete"];

/// What a tool does to the world, as the four `annotations` hints a client reads before
/// calling. 2026-07-28 reads an omitted hint as the risky answer (`destructiveHint` and
/// `openWorldHint` default to true) and Claude Code keys its permission prompt on them, so
/// every tool states all four; `openWorldHint` is false throughout, nothing here leaves the
/// machine.
#[derive(Clone, Copy)]
enum Effect {
    /// Modifies nothing — a pane opening is display, not a change to the environment.
    Read,
    /// Creates something new each call.
    Write,
    /// Replaces its own previous value: repeating it changes nothing further, and what it
    /// overwrites (a cache day, an agent's own summary) is nothing the user authored.
    Replace,
    /// Can lose work nothing re-derives.
    Destroy,
}

impl Effect {
    fn annotations(self, title: &str) -> Value {
        let (read_only, destructive, idempotent) = match self {
            Effect::Read => (true, false, true),
            Effect::Write => (false, false, false),
            Effect::Replace => (false, false, true),
            Effect::Destroy => (false, true, false),
        };
        json!({
            "title": title,
            "readOnlyHint": read_only,
            "destructiveHint": destructive,
            "idempotentHint": idempotent,
            "openWorldHint": false,
        })
    }
}

/// Every tool's display title and [`Effect`]; [`tool_definitions`] refuses a tool missing here.
const TOOL_HINTS: &[(&str, &str, Effect)] = &[
    ("task_list", "List board tasks", Effect::Read),
    ("task_status", "Task status", Effect::Read),
    ("task_create", "Create board task", Effect::Write),
    ("task_summary", "Record task summary", Effect::Replace),
    ("task_delete", "Delete task", Effect::Destroy),
    ("task_start", "Start task", Effect::Write),
    ("preview_file", "Preview file", Effect::Read),
    ("file_open", "Open file", Effect::Read),
    ("calendar_today", "Today's meetings", Effect::Read),
    ("calendar_next", "Next meeting", Effect::Read),
    ("calendar_set", "Set a calendar day", Effect::Replace),
];

/// Why a tool call produced no result — [`Dispatcher::tools_call`] says what each becomes.
enum ToolError {
    Unknown,
    Failed(String),
}

/// One dispatched request: the response line, plus what the call log needs — tool name and
/// compacted args for `tools/call`, and `error` set exactly when the call failed.
struct Outcome {
    response: String,
    tool: Option<String>,
    args: Option<String>,
    error: Option<String>,
    /// Set only for a JSON-RPC-level refusal — see [`Handled::error_code`].
    code: Option<i64>,
}

impl Outcome {
    fn ok(response: String) -> Outcome {
        Outcome { response, tool: None, args: None, error: None, code: None }
    }

    fn err(response: String, error: String) -> Outcome {
        Outcome { response, tool: None, args: None, error: Some(error), code: None }
    }

    fn refused(response: String, code: i64, error: String) -> Outcome {
        Outcome { response, tool: None, args: None, error: Some(error), code: Some(code) }
    }

    fn with_tool(mut self, tool: String, args: String) -> Outcome {
        self.tool = Some(tool);
        self.args = Some(args);
        self
    }
}

impl Dispatcher {
    /// `version` is the serving app's — see [`Dispatcher::server_info`].
    pub fn new(store: Store, version: &str) -> Dispatcher {
        Dispatcher {
            store,
            server_info: json!({ "name": "towles-tool", "version": version }),
            task_host: None,
            preview_host: None,
            editor_host: None,
            calendar_sources: None,
        }
    }

    /// Injected by the serving transport — see [`TaskHost`].
    pub fn with_task_host(mut self, host: Box<dyn TaskHost>) -> Dispatcher {
        self.task_host = Some(host);
        self
    }

    /// Injected by the serving transport — see [`PreviewHost`].
    pub fn with_preview_host(mut self, host: Box<dyn PreviewHost>) -> Dispatcher {
        self.preview_host = Some(host);
        self
    }

    /// Injected by the serving transport — see [`EditorHost`].
    pub fn with_editor_host(mut self, host: Box<dyn EditorHost>) -> Dispatcher {
        self.editor_host = Some(host);
        self
    }

    /// Test hook — see [`Dispatcher::calendar_sources`].
    pub fn with_calendar_sources(mut self, sources: Vec<String>) -> Dispatcher {
        self.calendar_sources = Some(sources);
        self
    }

    /// The injected override, else the settings file re-read per call so a calendar added in Settings
    /// is writable without a restart. An unreadable file yields none, which fails closed.
    fn calendar_source_ids(&self) -> Vec<String> {
        if let Some(ids) = &self.calendar_sources {
            return ids.clone();
        }
        tt_config::load()
            .map(|settings| {
                settings
                    .collectors
                    .calendar
                    .sources
                    .into_iter()
                    // Trimmed like `calendar_set` trims `source`, or a padded id is listed yet never matchable.
                    .map(|source| source.id.trim().to_string())
                    .filter(|id| !id.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Test-only: the transport needs [`Handled::wrote`], so discarding it is never right in
    /// production, and gating it here keeps a lossy second entry point from appearing.
    #[cfg(test)]
    fn handle_at(&mut self, request_json: &str, now_ms: i64) -> Option<String> {
        self.dispatch_at(request_json, now_ms, &RequestContext::none()).response
    }

    /// Handle one request line and report what it did: the transport needs [`Handled::wrote`] to
    /// decide whether to refresh, and a guessed refresh rebuilds a whole snapshot under the store lock.
    pub fn dispatch(&mut self, request_json: &str, ctx: &RequestContext) -> Handled {
        self.dispatch_at(request_json, now_ms(), ctx)
    }

    /// [`Dispatcher::dispatch`] with an injected `now_ms` (deterministic tests).
    pub fn dispatch_at(
        &mut self,
        request_json: &str,
        now_ms: i64,
        ctx: &RequestContext,
    ) -> Handled {
        let value: Value = match serde_json::from_str(request_json) {
            Ok(value) => value,
            Err(_) => {
                let response = error_response(Value::Null, PARSE_ERROR, "Parse error");
                return Handled::refused(response, PARSE_ERROR);
            }
        };

        // A batch, gone since MCP 2025-06-18: refuse, rather than drop it and hang the client.
        if value.is_array() {
            let response = error_response(Value::Null, INVALID_REQUEST, "Invalid Request");
            return Handled::refused(response, INVALID_REQUEST);
        }

        // Requests carry an `id`; notifications do not, and receive no response.
        let id = match value.get("id") {
            Some(id) if !id.is_null() => id.clone(),
            _ => return Handled::read(None),
        };

        let method = match value.get("method").and_then(Value::as_str) {
            Some(method) => method,
            None => {
                let response = error_response(id, INVALID_REQUEST, "Invalid Request");
                return Handled::refused(response, INVALID_REQUEST);
            }
        };

        // Elapsed time only; the row's `ts` is the injected `now_ms`.
        let started = Instant::now();
        let outcome = match admit(&value, method, ctx) {
            Err(rejection) => rejection.into_outcome(id),
            Ok(()) => match method {
                "server/discover" => Outcome::ok(self.result_response(id, discover_result())),
                "tools/list" => Outcome::ok(self.result_response(id, tools_list_result())),
                "tools/call" => self.tools_call(id, &value, now_ms, ctx),
                _ => Outcome::refused(
                    error_response(id, METHOD_NOT_FOUND, "Method not found"),
                    METHOD_NOT_FOUND,
                    "Method not found".to_string(),
                ),
            },
        };

        let call = McpCallInput {
            method: method.to_string(),
            tool: outcome.tool,
            args: outcome.args,
            ok: outcome.error.is_none(),
            error: outcome.error,
            duration_ms: Some(started.elapsed().as_millis() as i64),
            client: client_label(&value),
        };
        if let Err(error) = self.store.record_mcp_call(&call, now_ms) {
            log::warn!("tt-mcp: failed to record call log: {error}");
        }

        // Refusals and failures changed nothing; [`SELF_REFRESHING_TOOLS`] already repainted.
        let wrote = call.ok
            && call
                .tool
                .as_deref()
                .is_some_and(|tool| tool_writes(tool) && !SELF_REFRESHING_TOOLS.contains(&tool));
        Handled { response: Some(outcome.response), wrote, error_code: outcome.code }
    }

    /// Two failure shapes, as the spec draws them: a tool that ran and refused answers with an
    /// `isError` result the model can act on; a request naming no tool, or one that doesn't
    /// exist, is a protocol error (`-32602`) — nothing about it is the model's to fix by retrying.
    fn tools_call(
        &mut self,
        id: Value,
        request: &Value,
        now_ms: i64,
        ctx: &RequestContext,
    ) -> Outcome {
        let params = request.get("params");
        let name = match params.and_then(|p| p.get("name")).and_then(Value::as_str) {
            Some(name) => name.to_string(),
            None => {
                let message = "tools/call is missing the tool name".to_string();
                return Outcome::err(error_response(id, INVALID_PARAMS, &message), message);
            }
        };
        let args = params.and_then(|p| p.get("arguments")).cloned().unwrap_or_else(|| json!({}));
        let logged_args = compact_args(&args);
        let outcome = match self.call_tool(&name, &args, now_ms, ctx) {
            Ok(value) => Outcome::ok(self.tool_result_response(id, &value)),
            Err(ToolError::Failed(message)) => {
                Outcome::err(self.tool_error_response(id, &message), message)
            }
            Err(ToolError::Unknown) => {
                let message = format!("Unknown tool: {name}");
                Outcome::err(error_response(id, INVALID_PARAMS, &message), message)
            }
        };
        outcome.with_tool(name, logged_args)
    }

    fn call_tool(
        &mut self,
        name: &str,
        args: &Value,
        now_ms: i64,
        ctx: &RequestContext,
    ) -> Result<Value, ToolError> {
        let result = match name {
            "task_list" => self.task_list(),
            "task_status" => self.task_status(args),
            "task_create" => self.task_create(args, now_ms),
            "task_summary" => self.task_summary(args, now_ms),
            "task_delete" => self.task_delete(args),
            "task_start" => self.task_start(args),
            "preview_file" => self.preview_file(args, ctx),
            "file_open" => self.file_open(args, ctx),
            "calendar_today" => self.calendar_today(now_ms),
            "calendar_next" => self.calendar_next(now_ms),
            "calendar_set" => self.calendar_set(args, now_ms),
            _ => return Err(ToolError::Unknown),
        };
        result.map_err(ToolError::Failed)
    }

    /// Events starting within the local day of `now_ms` — the shape of the day.
    fn calendar_today(&self, now_ms: i64) -> Result<Value, String> {
        let (start, end) = Store::local_day_bounds(now_ms);
        let events = self.store.events_between(start, end).map_err(|e| e.to_string())?;
        Ok(json!({ "events": events, "now": now_ms }))
    }

    /// The meeting in progress, else the next to start; `minutesUntil` goes negative while live.
    fn calendar_next(&self, now_ms: i64) -> Result<Value, String> {
        match self.store.current_or_next_event(now_ms).map_err(|e| e.to_string())? {
            Some(event) => {
                // Floor, not truncate: `/` reports `0` for a live meeting's first minute, and the contract
                // promises a negative `minutesUntil` while one runs.
                let minutes_until = (event.start_ms() - now_ms).div_euclid(60_000);
                let live =
                    event.start_ms() <= now_ms && event.end_ms().is_some_and(|end| now_ms < end);
                Ok(json!({
                    "event": event,
                    "minutesUntil": minutes_until,
                    "live": live,
                    "now": now_ms,
                }))
            }
            None => Ok(json!({ "event": Value::Null, "now": now_ms })),
        }
    }

    /// Replace one calendar's events for one local day, touching no other calendar or day. The
    /// window comes from [`Store::local_day_bounds`], never the payload, so a client can't widen the
    /// delete; `source` must be a configured lane, or a hallucinated id mints an orphan nothing sweeps.
    fn calendar_set(&self, args: &Value, now_ms: i64) -> Result<Value, String> {
        let source = args
            .get("source")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|source| !source.is_empty())
            .ok_or_else(|| "missing required argument: source".to_string())?;
        let configured = self.calendar_source_ids();
        if !configured.iter().any(|id| id == source) {
            return Err(unknown_calendar_source_message(source, &configured));
        }
        let events_arg = args
            .get("events")
            .filter(|events| events.is_array())
            .ok_or_else(|| "missing required argument: events (an array)".to_string())?;
        let events: Vec<EventInput> = serde_json::from_value(events_arg.clone())
            .map_err(|e| format!("invalid events payload: {e}"))?;
        // `end < start` is schema-valid but reads inconsistently (`calendar_today` lists it,
        // `current_or_next_event` drops it) — a model's likely slip, so refuse rather than repair.
        if let Some(bad) = events.iter().find(|e| e.end.is_some_and(|end| end < e.start)) {
            return Err(format!(
                "event {} ends before it starts (start {}, end {}) — check the field order",
                bad.external_id,
                bad.start.to_rfc3339(),
                bad.end.map(|e| e.to_rfc3339()).unwrap_or_default(),
            ));
        }

        let reference_ms = match args.get("day").and_then(Value::as_str) {
            Some(day) => day_reference_ms(day)
                .ok_or_else(|| format!("invalid day: {day} (expected YYYY-MM-DD)"))?,
            None => now_ms,
        };
        let (day_start, day_end) = Store::local_day_bounds(reference_ms);

        // A day retention would reclaim at once: `written: N` with a one-tick shelf life.
        if day_end <= now_ms.saturating_sub(tt_store::EVENT_RETAIN_MS) {
            return Err(format!(
                "day {} is past the {}-day retention window — events that old are swept, so \
                 writing them would report success and then silently drop them",
                args.get("day").and_then(Value::as_str).unwrap_or("(derived)"),
                tt_store::EVENT_RETAIN_MS / (24 * 60 * 60 * 1000),
            ));
        }

        // A row outside the day is reachable by neither the lane's next delete nor retention, and
        // feeds `calendar_next` as a phantom meeting — so name the offender and refuse.
        if let Some(stray) =
            events.iter().find(|e| e.start_ms() < day_start || e.start_ms() >= day_end)
        {
            return Err(format!(
                "event {} starts at {}, outside the day being written [{}, {}) — push it with \
                 that day's `day` argument instead; an event outside the window would be stored \
                 where nothing can ever replace or sweep it",
                stray.external_id,
                stray.start.to_rfc3339(),
                local_iso(day_start),
                local_iso(day_end),
            ));
        }

        let written = self
            .store
            .replace_events_for_source(source, day_start, day_end, &events, now_ms)
            .map_err(|e| e.to_string())?;
        tracing::info!(
            %source,
            written,
            day_start = %local_iso(day_start),
            day_end = %local_iso(day_end),
            "calendar.set"
        );
        Ok(json!({
            "source": source,
            "written": written,
            "dayStart": local_iso(day_start),
            "dayEnd": local_iso(day_end),
        }))
    }

    /// Open board tasks in board order, with their issue/PR links and repo/worktree binding.
    fn task_list(&self) -> Result<Value, String> {
        let tasks = self.store.open_tasks().map_err(|e| e.to_string())?;
        Ok(json!({ "tasks": tasks }))
    }

    /// One task by id, done tasks included.
    fn task_status(&self, args: &Value) -> Result<Value, String> {
        let id = args
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| "missing required argument: id".to_string())?;
        // Only a genuinely absent row is "no such task": a busy-timeout read as a vanished task
        // makes a session go create a duplicate.
        let task = self.store.task_by_id(id).map_err(|error| match error {
            tt_store::Error::TaskNotFound(id) => format!("no task with id {id}"),
            other => format!("could not read task {id}: {other}"),
        })?;
        Ok(json!({ "task": task }))
    }

    /// Record what an agent reported when it finished, on the task's own row — the worktree and its
    /// scrollback die when the user confirms the task. Not folded into `notes`: [`task_prompt`] feeds
    /// notes into a `task_start` prompt, so a summary there would return as instructions.
    fn task_summary(&self, args: &Value, now_ms: i64) -> Result<Value, String> {
        let id = args
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| "missing required argument: id".to_string())?;
        let summary = args
            .get("summary")
            .and_then(Value::as_str)
            .ok_or_else(|| "missing required argument: summary".to_string())?;
        // As in `task_status`: a busy db must not read as a vanished row.
        let task =
            self.store.set_task_summary(id, summary, now_ms).map_err(|error| match error {
                tt_store::Error::TaskNotFound(id) => format!("no task with id {id}"),
                other => format!("could not record the summary for task {id}: {other}"),
            })?;
        Ok(json!({ "task": task }))
    }

    /// The same store path as the Agentboard `+` flow, so the task lands in that repo's swimlane
    /// at once (no worktree yet). `repo` is a GitHub `owner/repo` slug.
    fn task_create(&self, args: &Value, now_ms: i64) -> Result<Value, String> {
        let title = args
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .ok_or_else(|| "missing required argument: title".to_string())?;
        let repo_arg = args
            .get("repo")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|repo| !repo.is_empty())
            .ok_or_else(|| "missing required argument: repo".to_string())?;
        let status = args.get("status").and_then(Value::as_str).unwrap_or("backlog");
        let notes = args.get("notes").and_then(Value::as_str);
        let goal = args.get("goal").and_then(Value::as_str);

        // Case-insensitive, stamped with the tracked repo's own spelling: `christowles/x` must not
        // mint a second identity beside `ChrisTowles/x` and split one repo across two lanes.
        let (repo_root, repo) = self
            .store
            .tracked_repo_for_owner_repo(repo_arg)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| {
                let slugs = self.store.repo_slugs().unwrap_or_default();
                unknown_repo_message(repo_arg, &slugs)
            })?;

        let task =
            self.store.add_task(title, status, notes, goal, now_ms).map_err(|e| e.to_string())?;
        self.store
            .set_task_worktree(task.id, &repo_root, Some(&repo), None, None)
            .map_err(|e| e.to_string())?;
        let task = self.store.task_by_id(task.id).map_err(|e| e.to_string())?;
        tracing::info!(task_id = task.id, %repo, %status, "task.created");
        Ok(json!({ "task": task }))
    }

    /// Mint the worktree, launch an agent on the goal. Each guard exists because its failure is
    /// silent or destructive: a second worktree abandons the running one; a closed task resurrects.
    fn task_start(&mut self, args: &Value) -> Result<Value, String> {
        let id = args
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| "missing required argument: id".to_string())?;
        let branch_arg =
            args.get("branch").and_then(Value::as_str).map(str::trim).filter(|b| !b.is_empty());
        let base = args
            .get("base")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|b| !b.is_empty())
            .map(str::to_string);

        // Availability before diagnosis: don't make a caller fix its arguments for a tool that can't run.
        if self.task_host.is_none() {
            return Err("task_start is unavailable: no task host is attached".to_string());
        }

        // `task_by_id` already distinguishes "no such row" from "couldn't answer".
        let task = self.store.task_by_id(id).map_err(|e| e.to_string())?;

        if task.closed {
            return Err(format!(
                "task {id} ({:?}) is closed — reopen it on the Board before starting it",
                task.text
            ));
        }
        let worktree = task.worktree.as_ref();
        if let Some(dir) = worktree.and_then(|w| w.dir.as_deref()) {
            return Err(format!(
                "task {id} ({:?}) already has a worktree at {dir} — starting it again would \
                 abandon that one",
                task.text
            ));
        }
        let repo_root = worktree
            .map(|w| w.repo_root.clone())
            .filter(|root| !root.trim().is_empty())
            .ok_or_else(|| {
                format!(
                    "task {id} ({:?}) isn't bound to a repo, so there's nothing to branch from",
                    task.text
                )
            })?;

        // A task is named after its branch: slug the title, as `tt task new` does.
        let branch = match branch_arg {
            Some(b) => b.to_string(),
            None => {
                let slug = tt_git::branch_name::slug(&task.text);
                if slug.is_empty() {
                    return Err(format!(
                        "couldn't derive a branch name from {:?} — pass `branch` explicitly",
                        task.text
                    ));
                }
                slug
            }
        };

        // Goal plus notes — the handoff context — with the title as the last resort.
        let prompt = task_start_prompt(&task);

        let host =
            self.task_host.as_ref().expect("checked above, before any of the row guards ran");
        host.start_task(TaskStartRequest {
            id,
            text: task.text.clone(),
            repo_root,
            branch: branch.clone(),
            base,
            prompt,
        })?;

        Ok(json!({
            "status": "starting",
            "id": id,
            "text": task.text,
            "branch": branch,
        }))
    }

    /// Put a file on screen in the Preview pane — see [`PreviewHost`]. Everything checkable is
    /// checked here, because every failure of this tool is a silent empty pane.
    fn preview_file(&mut self, args: &Value, ctx: &RequestContext) -> Result<Value, String> {
        let raw = args
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| "missing required argument: path".to_string())?;

        // Availability before diagnosis, as in `task_start`.
        if self.preview_host.is_none() {
            return Err("preview_file is unavailable: no preview host is attached".to_string());
        }
        let path = validate_preview_path(raw)?;
        let title = preview_title(&path, args.get("title").and_then(Value::as_str));

        // `"routed": "path"` tells an agent its request carried no session and the pane may open
        // elsewhere. The session comes off the transport, never the arguments.
        let routed = if ctx.session.is_some() { "session" } else { "path" };
        let host =
            self.preview_host.as_ref().expect("checked above, before the path was validated");
        host.show(PreviewFile {
            path: path.clone(),
            title: title.clone(),
            session: ctx.session.clone(),
        })?;

        Ok(json!({ "status": "showing", "path": path, "title": title, "routed": routed }))
    }

    /// Reveal a file or folder in the caller's own Files pane — see [`EditorHost`]. Validated
    /// here for `preview_file`'s reason: a missing path would be a pane that never appears.
    fn file_open(&mut self, args: &Value, ctx: &RequestContext) -> Result<Value, String> {
        let raw = args
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| "missing required argument: path".to_string())?;

        // Availability before diagnosis, same as `task_start`.
        if self.editor_host.is_none() {
            return Err("file_open is unavailable: no editor host is attached".to_string());
        }
        let (path, is_dir) = validate_open_path(raw)?;
        let line = args
            .get("line")
            .and_then(Value::as_u64)
            .filter(|&n| n > 0)
            .map(|n| n.min(u64::from(u32::MAX)) as u32);

        let routed = if ctx.session.is_some() { "session" } else { "path" };
        let host = self.editor_host.as_ref().expect("checked above, before the path was validated");
        host.open_file(FileToOpen {
            path: path.clone(),
            is_dir,
            line,
            session: ctx.session.clone(),
        })?;

        Ok(json!({ "status": "opening", "path": path, "routed": routed }))
    }

    fn task_delete(&mut self, args: &Value) -> Result<Value, String> {
        let id = args
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| "missing required argument: id".to_string())?;
        let force = args.get("force").and_then(Value::as_bool).unwrap_or(false);
        let outcome = match args.get("outcome").and_then(Value::as_str) {
            None => None,
            Some(raw) => Some(
                tt_store::TaskOutcome::parse(raw)
                    .ok_or_else(|| format!("unknown outcome {raw:?} (done|abandoned)"))?,
            ),
        };
        let host = self
            .task_host
            .as_ref()
            .ok_or_else(|| "task_delete is unavailable: no task host is attached".to_string())?;

        // The host resolves the row to delete it anyway, so it names the task and diagnoses unknown ids.
        match host.delete_task(id, force, outcome)? {
            TaskDeletion::Deleted { name, messages } => {
                Ok(json!({ "status": "deleted", "id": id, "text": name, "messages": messages }))
            }
            TaskDeletion::Refused { name, blockers, messages } => Ok(json!({
                "status": "refused",
                "id": id,
                "text": name,
                "blockers": blockers,
                "messages": messages,
            })),
        }
    }
}

// JSON-RPC / MCP response builders

use tt_config::now_ms;

/// The one thing the tool list can't say: where a pane lands. Guidance, not a procedure.
const INSTRUCTIONS: &str = "Sessions started in the app's terminals are routed to their own \
    task: preview_file and file_open open their panes beside the calling terminal, so pass any \
    absolute path — where the file lives does not decide where it shows. The board and calendar \
    tools read and write this app instance's own store.";

/// What `server/discover` answers. The cache hints say "ask again": an instance restarted on
/// the same port may be a different build with different tools.
fn discover_result() -> Value {
    json!({
        "supportedVersions": [PROTOCOL_VERSION],
        "capabilities": { "tools": {} },
        "instructions": INSTRUCTIONS,
        "ttlMs": 0,
        "cacheScope": "public",
    })
}

fn tools_list_result() -> Value {
    json!({ "tools": tool_definitions(), "ttlMs": 0, "cacheScope": "public" })
}

fn request_meta(request: &Value) -> Option<&Value> {
    request.get("params")?.get("_meta")
}

/// A request turned away before its method was looked at, as the error it becomes.
struct Rejection {
    code: i64,
    message: String,
    data: Option<Value>,
}

impl Rejection {
    fn header(message: String) -> Rejection {
        Rejection { code: HEADER_MISMATCH, message, data: None }
    }

    /// A request missing a required `_meta` field is malformed: `-32602`, and 400 over HTTP.
    fn missing_meta(key: &str) -> Rejection {
        let message = required(&format!("params._meta.{key}"));
        Rejection { code: INVALID_PARAMS, message, data: None }
    }

    fn into_outcome(self, id: Value) -> Outcome {
        let mut error = json!({ "code": self.code, "message": self.message });
        if let Some(data) = self.data {
            error["data"] = data;
        }
        let response = json!({ "jsonrpc": "2.0", "id": id, "error": error }).to_string();
        Outcome::refused(response, self.code, self.message)
    }
}

/// Every request's checks before dispatch: the HTTP binding's mirrored headers agree with the
/// body, and the body names the one version served. The "required" refusals spell the version
/// out because a legacy client opening with `initialize` can show nothing else.
fn admit(request: &Value, method: &str, ctx: &RequestContext) -> Result<(), Rejection> {
    let version =
        request_meta(request).and_then(|m| m.get(META_PROTOCOL_VERSION)).and_then(Value::as_str);
    if let Some(headers) = &ctx.headers {
        if headers.protocol_version.is_none() {
            return Err(Rejection::header(required(&format!("{PROTOCOL_VERSION_HEADER} header"))));
        }
        mirrored(PROTOCOL_VERSION_HEADER, headers.protocol_version.as_deref(), version)?;
        mirrored(METHOD_HEADER, headers.method.as_deref(), Some(method))?;
        if method == "tools/call" {
            let name = request.pointer("/params/name").and_then(Value::as_str);
            let sent = headers.name.as_deref().map(decode_sentinel);
            mirrored(NAME_HEADER, sent.as_deref(), name)?;
        }
    }
    match version {
        None => return Err(Rejection::missing_meta(META_PROTOCOL_VERSION)),
        Some(requested) if requested != PROTOCOL_VERSION => {
            return Err(Rejection {
                code: UNSUPPORTED_PROTOCOL_VERSION,
                message: "Unsupported protocol version".to_string(),
                data: Some(json!({ "supported": [PROTOCOL_VERSION], "requested": requested })),
            });
        }
        Some(_) => {}
    }
    // Required on every request. Only presence is checked: a `MissingRequiredClientCapability`
    // answers a request that needs one the client withheld, and nothing here needs any.
    let capabilities = request_meta(request).and_then(|m| m.get(META_CLIENT_CAPABILITIES));
    if !capabilities.is_some_and(Value::is_object) {
        return Err(Rejection::missing_meta(META_CLIENT_CAPABILITIES));
    }
    Ok(())
}

fn required(what: &str) -> String {
    format!(
        "{what} is required: this server speaks MCP {PROTOCOL_VERSION} only, which has no \
         initialize handshake"
    )
}

/// Equal to the body field it copies, and absent when there is nothing to copy.
fn mirrored(header: &str, sent: Option<&str>, body: Option<&str>) -> Result<(), Rejection> {
    match (sent, body) {
        (None, None) => Ok(()),
        (Some(sent), Some(body)) if sent == body => Ok(()),
        (None, Some(_)) => Err(Rejection::header(format!("missing {header} header"))),
        (Some(sent), None) => {
            Err(Rejection::header(format!("{header} header {sent:?} names nothing in the body")))
        }
        (Some(sent), Some(body)) => Err(Rejection::header(format!(
            "{header} header {sent:?} does not match the body's {body:?}"
        ))),
    }
}

/// `=?base64?…?=` carries a header-unsafe name; decoded before comparing, as the spec asks.
fn decode_sentinel(value: &str) -> Cow<'_, str> {
    use base64::Engine;
    value
        .strip_prefix("=?base64?")
        .and_then(|rest| rest.strip_suffix("?="))
        .and_then(|encoded| base64::engine::general_purpose::STANDARD.decode(encoded).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .map_or(Cow::Borrowed(value), Cow::Owned)
}

/// `name version` from the request's own `clientInfo`; per request, since nothing persists.
fn client_label(request: &Value) -> Option<String> {
    let info = request_meta(request)?.get(META_CLIENT_INFO)?;
    let name = info.get("name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty())?;
    match info.get("version").and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()) {
        Some(version) => Some(format!("{name} {version}")),
        None => Some(name.to_string()),
    }
}

/// The args for the call log, cut at [`CALL_LOG_ARGS_MAX`] chars on a char boundary.
fn compact_args(args: &Value) -> String {
    let rendered = args.to_string();
    if rendered.chars().count() <= CALL_LOG_ARGS_MAX {
        return rendered;
    }
    let mut truncated: String = rendered.chars().take(CALL_LOG_ARGS_MAX).collect();
    truncated.push('…');
    truncated
}

fn error_response(id: Value, code: i64, message: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string()
}

impl Dispatcher {
    /// Every result carries `resultType`, required since 2026-07-28, and names this server.
    fn result_response(&self, id: Value, mut result: Value) -> String {
        if let Some(result) = result.as_object_mut() {
            result.insert("resultType".to_string(), json!("complete"));
            result.insert("_meta".to_string(), json!({ META_SERVER_INFO: self.server_info }));
        }
        json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
    }

    /// The value twice: as `structuredContent`, which a client validates against the tool's
    /// `outputSchema` and prefers for display, and as the text block the spec keeps for clients
    /// that read only that.
    fn tool_result_response(&self, id: Value, value: &Value) -> String {
        let text = serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string());
        self.result_response(
            id,
            json!({ "content": [{ "type": "text", "text": text }], "structuredContent": value }),
        )
    }

    fn tool_error_response(&self, id: Value, message: &str) -> String {
        self.result_response(
            id,
            json!({ "content": [{ "type": "text", "text": message }], "isError": true }),
        )
    }
}

/// Epoch ms as local RFC 3339, for the day-window bounds in refusals: a caller reading
/// `1784707200000` cannot tell which day it was handed.
fn local_iso(ms: i64) -> String {
    Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| ms.to_string())
}

/// The reference instant for [`Store::local_day_bounds`] from a `YYYY-MM-DD`, or `None`.
fn day_reference_ms(day: &str) -> Option<i64> {
    let date = NaiveDate::parse_from_str(day.trim(), "%Y-%m-%d").ok()?;
    // Noon, not midnight: this is only a reference instant, and midnight is the one time that can
    // fail to exist — `.single()` returned `None` on DST dates in zones that switch at midnight
    // (Havana, Santiago, São Paulo), so a valid day's calendar could never be pushed.
    let noon = date.and_hms_opt(12, 0, 0)?;
    Some(Local.from_local_datetime(&noon).earliest()?.timestamp_millis())
}

/// Names the rejected id and lists the configured ones. An empty set is called out separately:
/// "no calendars configured" is a settings problem, not a bad argument.
fn unknown_calendar_source_message(source: &str, configured: &[String]) -> String {
    if configured.is_empty() {
        return format!(
            "unknown calendar source: {source} — no calendars are configured. Add one under \
             Settings → Collectors → Calendar before pushing events."
        );
    }
    format!(
        "unknown calendar source: {source} — configured calendars are: {}. Writing to an \
         unconfigured lane would strand rows nothing ever sweeps.",
        configured.join(", ")
    )
}

/// `goal`, then `notes` under a header; `text` last. The Board's own "Start task" passed the
/// title alone, so an agent started on a task with a written goal had seen neither.
fn task_start_prompt(task: &tt_store::TaskItem) -> String {
    let goal = task.goal.as_deref().map(str::trim).filter(|g| !g.is_empty());
    let notes = task.notes.as_deref().map(str::trim).filter(|n| !n.is_empty());
    let head = goal.unwrap_or(task.text.trim());
    match notes {
        Some(notes) => format!("{head}\n\n## Notes\n\n{notes}"),
        None => head.to_string(),
    }
}

/// Names the argument and lists the tracked `owner/repo` slugs, so a caller can self-correct.
fn unknown_repo_message(repo: &str, slugs: &[String]) -> String {
    if slugs.is_empty() {
        return format!(
            "unknown repo: {repo} — no repos are tracked yet (add one on the app's Agentboard)"
        );
    }
    format!("unknown repo: {repo} — tracked repos: {}", slugs.join(", "))
}

/// The MCP contract's single source of truth, also behind the app's `mcp_tool_docs` command so
/// the MCP screen's documentation cannot drift from what the server exposes.
pub fn tool_definitions() -> Value {
    let no_args = || json!({ "type": "object", "properties": {}, "required": [] });
    let mut tools = json!([
        {
            "name": "task_list",
            "description": "Open (not-done) board tasks in board order, each with its issue/PR links and repo/worktree binding.",
            "inputSchema": no_args(),
        },
        {
            "name": "task_status",
            "description": "One board task by id — the full row (status, links, repo/worktree binding), including done tasks.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer", "description": "The task's id (from task_list or task_create)." },
                },
                "required": ["id"],
            },
        },
        {
            "name": "task_create",
            "description": "Create a board task in a tracked repo's swimlane. Writes to the board.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "repo": { "type": "string", "description": "The tracked repo's GitHub `owner/repo` slug." },
                    "title": { "type": "string", "description": "The task's title." },
                    "goal": { "type": "string", "description": "Optional objective the task is meant to accomplish, shown on the board card under the title." },
                    "notes": { "type": "string", "description": "Optional free-form context." },
                    "status": { "type": "string", "enum": ["backlog", "doing", "done"], "description": "Column to land in (default backlog)." },
                },
                "required": ["repo", "title"],
            },
        },
        {
            "name": "task_summary",
            "description": "Record what you did on a task, on the task's own card — the last thing to do when the work is finished. Write the wrap-up you would otherwise print into the terminal: what landed (PR number and merge commit), what CI said, decisions worth knowing, and anything still open. The worktree and its terminal scrollback are deleted once the user confirms the task is done; the card is what survives, so this is the record they read afterwards. Replaces any previous summary for the task. Does not close the task or touch its worktree — the user confirms it is done themselves.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer", "description": "The task's id (from task_list or task_status)." },
                    "summary": { "type": "string", "description": "The wrap-up, as plain text or markdown. A few short lines, not a transcript. Empty clears it." },
                },
                "required": ["id", "summary"],
            },
        },
        {
            "name": "task_delete",
            "description": "Close a board task and delete everything bound to it — its terminal panes and its git worktree on disk. The board row itself survives, closed with an outcome (done/abandoned) as the record of the work. Guarded: if the worktree has uncommitted changes, commits that reached no branch or remote, or a foreign process on its claimed ports, nothing is deleted and the reasons come back as `status: \"refused\"`. Report those to the user and let them decide; only pass force after they have said so explicitly, since it destroys that work permanently.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer", "description": "The task's id (from task_list or task_status)." },
                    "outcome": { "type": "string", "enum": ["done", "abandoned"], "description": "How the task ended, recorded on its closed row. Omitted: inferred from the task's own evidence — done if a linked PR merged, else abandoned." },
                    "force": { "type": "boolean", "description": "Skip the guards and delete the worktree anyway, discarding uncommitted changes and unreachable commits for good. Default false." },
                },
                "required": ["id"],
            },
        },
        {
            "name": "task_start",
            "description": "Start a board task that has no worktree yet: mint its git worktree on a fresh branch and launch a Claude session in it, working on the task's goal and notes. This is how a task goes from a card on the board to actual work in progress. Returns `status: \"starting\"` — the worktree and agent come up asynchronously in the app, so confirm with task_list rather than assuming. Refuses a task that already has a worktree (starting again would abandon the running one) or one that is closed.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer", "description": "The task's id (from task_list or task_status)." },
                    "branch": { "type": "string", "description": "Branch to create for the task. Omitted: derived by slugging the task's title, the same way `tt task new` does." },
                    "base": { "type": "string", "description": "Ref to branch from. Omitted: the repo's default branch." },
                },
                "required": ["id"],
            },
        },
        {
            "name": "preview_file",
            "description": "Show a file on screen in the app's Preview pane, beside the terminal you are running in — the way to hand back something worth *looking at* rather than reading as terminal output. Works for any file, artifacts included: a Markdown file renders as formatted prose, a self-contained HTML artifact renders as the page it is, and anything else (a log, a diff, JSON, source) renders as text. Good uses: a plan or design laid out for a decision, a table of what a sweep found, a before/after or diagram, a summary of a long investigation. Write the file first — anywhere you like, including a scratch directory outside the repo — then call this with its absolute path. The pane opens in *your* terminal's task: the app knows which session you are calling from, so where the file lives has no bearing on where it appears. The pane hot-reloads: it watches the file and repaints whenever you rewrite it, so you can keep editing without calling this again. An HTML artifact renders in an isolated frame with no network, so inline all CSS/JS and embed images as data: URIs — a CDN link or an external stylesheet simply won't load. Returns `status: \"showing\"`; the pane opens asynchronously, so say what you put there rather than assuming it was read.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the file to show — Markdown, HTML, or any text file. Relative paths are refused — this server is shared by every session on the machine and has no working directory of its own. This names the file to render, not the task to render it in." },
                    "title": { "type": "string", "description": "Short label for the pane header, e.g. \"Migration plan\". Defaults to the file name." },
                },
                "required": ["path"],
            },
        },
        {
            "name": "file_open",
            "description": "Open a file (or folder) that already exists on disk in the app's Files pane, beside the terminal you are running in — so the human can read it without leaving the app or scrolling your output. Use it to put the thing you are talking about on screen: the file you just changed, the config you want a decision about, the test that fails. To *render* a file instead of revealing it in the tree — Markdown as prose, an HTML page you wrote as the page it is — use preview_file. The pane opens in your terminal's task; the path names the file to reveal, not the task to reveal it in, and it must be inside a folder the app tracks. Returns `status: \"opening\"` — the pane opens asynchronously, so say what you put there rather than assuming it was read.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Absolute path to the file or directory to reveal. Relative paths are refused — this server is shared by every session on the machine and has no working directory of its own." },
                    "line": { "type": "integer", "description": "1-based line to scroll to and highlight. Ignored for a directory." },
                },
                "required": ["path"],
            },
        },
        {
            "name": "calendar_today",
            "description": "The shape of today: every meeting starting in today's local calendar day, in order. Use it to see where the uninterrupted stretches are before committing to deep work.",
            "inputSchema": no_args(),
        },
        {
            "name": "calendar_next",
            "description": "How much focus time is left: the meeting in progress now, or the next one to start, with `minutesUntil` (negative while a meeting is live) and a `live` flag. The one calendar read that matters mid-task — nothing scheduled means keep working.",
            "inputSchema": no_args(),
        },
        {
            "name": "calendar_set",
            "description": "Push one calendar's meetings for one local day into the local cache, replacing whatever that calendar previously had for that day. This is how the calendar gets filled — a scheduled pull writes here; nothing else reads your real calendar. Other calendars and other days are left untouched.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "source": { "type": "string", "description": "Which configured calendar this pull represents (e.g. \"google\", \"outlook\"). Only this calendar's rows for the day are replaced." },
                    "day": { "type": "string", "description": "Local calendar day being pushed, YYYY-MM-DD. Defaults to today." },
                    "events": {
                        "type": "array",
                        "description": "The meetings for that day. An empty array clears the day for this calendar.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "externalId": { "type": "string", "description": "The calendar provider's stable id for the event." },
                                "title": { "type": "string", "description": "Meeting title." },
                                "start": { "type": "string", "description": "Start time, RFC 3339 with the calendar's UTC offset, e.g. \"2026-07-20T15:00:00+01:00\" (or \"...Z\"). Keep the offset the calendar reports — it records that the meeting was booked as 3pm there, which a UTC-only time cannot." },
                                "end": { "type": "string", "description": "End time, same format. Omit for a point-in-time entry." },
                                "attendees": { "type": "array", "items": { "type": "string" }, "description": "Attendee names or addresses." },
                                "location": { "type": "string", "description": "Room or place, if any." },
                                "joinUrl": { "type": "string", "description": "Video-call link, if any." },
                            },
                            "required": ["externalId", "title", "start"],
                        },
                    },
                },
                "required": ["source", "events"],
            },
        },
    ]);

    if let Some(entries) = tools.as_array_mut() {
        for entry in entries {
            let name = entry["name"].as_str().unwrap_or_default().to_string();
            let (_, title, effect) = TOOL_HINTS
                .iter()
                .find(|(hinted, ..)| *hinted == name)
                .unwrap_or_else(|| panic!("{name} has no TOOL_HINTS entry"));
            entry["title"] = json!(title);
            entry["annotations"] = effect.annotations(title);
            entry["outputSchema"] =
                output::schema_for(&name).unwrap_or_else(|| panic!("{name} has no output schema"));
        }
    }
    tools
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    const NOW: i64 = 1_700_000_000_000; // fixed epoch ms for deterministic tests
    const TEST_VERSION: &str = "0.0.0-test";

    /// The tracked repo every test dispatcher knows, seeded as the Agentboard poll loop would.
    const REPO_DIR: &str = "/home/u/code/demo";
    const REPO_SLUG: &str = "o/demo";

    fn seeded_store() -> Store {
        let store = Store::open_in_memory().unwrap();
        store.add_task("open task", "backlog", None, None, NOW).unwrap();
        store
    }

    /// A dispatcher over a store with one reconciled tracked repo — never the real `repos.json`.
    fn dispatcher() -> Dispatcher {
        let store = seeded_store();
        store.reconcile_repos(&[(REPO_DIR.to_string(), REPO_SLUG.to_string())], NOW).unwrap();
        Dispatcher::new(store, TEST_VERSION)
            .with_calendar_sources(vec!["google".to_string(), "outlook".to_string()])
    }

    /// Call a tool and return its result, checked against the contract on the way out.
    fn call_tool(dispatcher: &mut Dispatcher, name: &str, args: Value) -> Value {
        let response = call_tool_raw(dispatcher, name, args);
        conformant_result(name, &response)
    }

    /// The `structuredContent` of a successful result, after every check a client may make:
    /// it equals the text block, and it validates against the tool's own `outputSchema`.
    fn conformant_result(name: &str, response: &Value) -> Value {
        let result = &response["result"];
        assert_eq!(result["isError"], Value::Null, "unexpected tool error: {response}");
        let text = result["content"][0]["text"].as_str().expect("a text block");
        let value = result["structuredContent"].clone();
        assert_eq!(serde_json::from_str::<Value>(text).unwrap(), value, "text ≠ structured");
        let schema = output::schema_for(name).expect("every tool declares an output schema");
        let validator = jsonschema::validator_for(&schema).expect("a valid schema");
        let errors: Vec<String> = validator.iter_errors(&value).map(|e| e.to_string()).collect();
        assert!(errors.is_empty(), "{name} result violates its outputSchema: {errors:?}\n{value}");
        value
    }

    /// Call a tool expecting an `isError` result; returns the error text.
    fn call_tool_err(dispatcher: &mut Dispatcher, name: &str, args: Value) -> String {
        let response = call_tool_raw(dispatcher, name, args);
        assert_eq!(response["result"]["isError"], true, "expected a tool error: {response}");
        response["result"]["content"][0]["text"].as_str().unwrap().to_string()
    }

    /// [`call_tool`] from a caller the transport identified.
    fn call_tool_as(
        dispatcher: &mut Dispatcher,
        name: &str,
        args: Value,
        ctx: &RequestContext,
    ) -> Value {
        let request = tool_call_request(name, args);
        let response = dispatcher
            .dispatch_at(&request, NOW, ctx)
            .response
            .expect("tool call returns a response");
        let response: Value = serde_json::from_str(&response).unwrap();
        conformant_result(name, &response)
    }

    fn call_tool_raw(dispatcher: &mut Dispatcher, name: &str, args: Value) -> Value {
        let request = tool_call_request(name, args);
        let response = dispatcher.handle_at(&request, NOW).expect("tool call returns a response");
        serde_json::from_str(&response).unwrap()
    }

    fn tool_call_request(name: &str, args: Value) -> String {
        request(1, "tools/call", json!({ "name": name, "arguments": args }))
    }

    /// A request in the one shape the server accepts: 2026-07-28 `_meta` on it.
    fn request(id: i64, method: &str, mut params: Value) -> String {
        params["_meta"] = json!({
            META_PROTOCOL_VERSION: PROTOCOL_VERSION,
            META_CLIENT_INFO: { "name": "claude-code", "version": "2.1" },
            META_CLIENT_CAPABILITIES: {},
        });
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string()
    }

    fn parsed(dispatcher: &mut Dispatcher, request: &str) -> Value {
        serde_json::from_str(&dispatcher.handle_at(request, NOW).unwrap()).unwrap()
    }

    #[test]
    fn server_discover_names_the_one_version_and_the_tools_capability() {
        let mut dispatcher = dispatcher();
        let response = parsed(&mut dispatcher, &request(1, "server/discover", json!({})));
        let result = &response["result"];
        assert_eq!(result["supportedVersions"], json!([PROTOCOL_VERSION]));
        assert!(result["capabilities"]["tools"].is_object());
        assert_eq!(result["resultType"], "complete");
        assert_eq!(result["_meta"][META_SERVER_INFO]["name"], "towles-tool");
        assert_eq!(result["_meta"][META_SERVER_INFO]["version"], TEST_VERSION);
        assert!(result["instructions"].as_str().is_some_and(|i| i.contains("preview_file")));
        assert_eq!(result["ttlMs"], 0);
    }

    /// Both required `_meta` fields are checked, and a missing one is the 400 the spec wants.
    #[test]
    fn a_request_without_client_capabilities_is_malformed() {
        let mut dispatcher = dispatcher();
        let mut value: Value = serde_json::from_str(&request(1, "tools/list", json!({}))).unwrap();
        value["params"]["_meta"].as_object_mut().unwrap().remove(META_CLIENT_CAPABILITIES);
        let handled = dispatcher.dispatch_at(&value.to_string(), NOW, &RequestContext::none());
        let response: Value = serde_json::from_str(&handled.response.unwrap()).unwrap();
        assert_eq!(response["error"]["code"], INVALID_PARAMS);
        assert_eq!(handled.error_code, Some(INVALID_PARAMS));
        let message = response["error"]["message"].as_str().unwrap();
        assert!(message.contains(META_CLIENT_CAPABILITIES), "{message}");
    }

    /// A legacy client's `initialize` gets the version named — all it can show.
    #[test]
    fn a_legacy_initialize_is_refused_naming_the_version() {
        let mut dispatcher = dispatcher();
        let legacy = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": { "protocolVersion": "2025-06-18", "clientInfo": { "name": "old" } },
        })
        .to_string();

        // Over HTTP the missing header is what's refused.
        let ctx = RequestContext::none().with_headers(MirroredHeaders::default());
        let handled = dispatcher.dispatch_at(&legacy, NOW, &ctx);
        let response: Value = serde_json::from_str(&handled.response.unwrap()).unwrap();
        assert_eq!(response["error"]["code"], HEADER_MISMATCH);
        assert_eq!(handled.error_code, Some(HEADER_MISMATCH));
        let message = response["error"]["message"].as_str().unwrap();
        assert!(message.contains(PROTOCOL_VERSION) && message.contains("initialize"), "{message}");

        // With no header layer, the body's missing version is.
        let response = parsed(&mut dispatcher, &legacy);
        assert_eq!(response["error"]["code"], INVALID_PARAMS);
        assert!(response["error"]["message"].as_str().unwrap().contains(PROTOCOL_VERSION));
    }

    #[test]
    fn an_unsupported_version_lists_the_supported_one() {
        let mut dispatcher = dispatcher();
        let mut value: Value = serde_json::from_str(&request(1, "tools/list", json!({}))).unwrap();
        value["params"]["_meta"][META_PROTOCOL_VERSION] = json!("2025-11-25");
        let response = parsed(&mut dispatcher, &value.to_string());
        assert_eq!(response["error"]["code"], UNSUPPORTED_PROTOCOL_VERSION);
        assert_eq!(response["error"]["data"]["supported"], json!([PROTOCOL_VERSION]));
        assert_eq!(response["error"]["data"]["requested"], "2025-11-25");
    }

    /// The HTTP binding mirrors body fields into headers; the two must agree.
    #[test]
    fn mirrored_headers_must_match_the_body() {
        let mut dispatcher = dispatcher();
        let call = tool_call_request("task_list", json!({}));
        let headers = |method: &str, name: Option<&str>| {
            RequestContext::none().with_headers(MirroredHeaders {
                protocol_version: Some(PROTOCOL_VERSION.to_string()),
                method: Some(method.to_string()),
                name: name.map(str::to_string),
            })
        };
        let codes = |dispatcher: &mut Dispatcher, ctx: &RequestContext| {
            let handled = dispatcher.dispatch_at(&call, NOW, ctx);
            let response: Value = serde_json::from_str(&handled.response.unwrap()).unwrap();
            (handled.error_code, response["error"]["code"].as_i64())
        };

        assert_eq!(codes(&mut dispatcher, &headers("tools/call", Some("task_list"))), (None, None));
        assert_eq!(
            codes(&mut dispatcher, &headers("tools/call", Some("=?base64?dGFza19saXN0?="))),
            (None, None),
            "an encoded name is decoded before the comparison"
        );
        for wrong in [
            headers("tools/list", Some("task_list")),
            headers("tools/call", Some("task_status")),
            headers("tools/call", None),
        ] {
            assert_eq!(
                codes(&mut dispatcher, &wrong),
                (Some(HEADER_MISMATCH), Some(HEADER_MISMATCH)),
                "{wrong:?}"
            );
        }
    }

    #[test]
    fn notifications_get_no_response() {
        let mut dispatcher = dispatcher();
        let initialized =
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string();
        assert!(dispatcher.handle_at(&initialized, NOW).is_none());
        let other = json!({ "jsonrpc": "2.0", "method": "some/notification" }).to_string();
        assert!(dispatcher.handle_at(&other, NOW).is_none());
    }

    #[test]
    fn tools_list_is_exactly_the_task_pane_and_calendar_families() {
        let mut dispatcher = dispatcher();
        let response = parsed(&mut dispatcher, &request(1, "tools/list", json!({})));
        let names: Vec<&str> = response["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            vec![
                "task_list",
                "task_status",
                "task_create",
                "task_summary",
                "task_delete",
                "task_start",
                "preview_file",
                "file_open",
                "calendar_today",
                "calendar_next",
                "calendar_set",
            ]
        );
    }

    // preview_file

    /// Every `(path, title, session)` a fake preview host was handed.
    type Shown = std::sync::Arc<std::sync::Mutex<Vec<(String, String, Option<String>)>>>;

    fn with_preview_host() -> (Dispatcher, Shown) {
        struct FakePreviewHost {
            shown: Shown,
        }
        impl PreviewHost for FakePreviewHost {
            fn show(&self, artifact: PreviewFile) -> Result<(), String> {
                self.shown.lock().unwrap().push((artifact.path, artifact.title, artifact.session));
                Ok(())
            }
        }
        let shown: Shown = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let host = FakePreviewHost { shown: std::sync::Arc::clone(&shown) };
        (dispatcher().with_preview_host(Box::new(host)), shown)
    }

    /// Canonical, since a macOS temp dir sits behind a symlink (`/var` → `/private/var`).
    fn artifact_file(dir: &tempfile::TempDir, name: &str, body: &str) -> String {
        let path = dir.path().join(name);
        std::fs::write(&path, body).unwrap();
        std::fs::canonicalize(&path).unwrap().to_string_lossy().into_owned()
    }

    #[test]
    fn preview_file_hands_the_artifact_to_the_host() {
        let (mut dispatcher, shown) = with_preview_host();
        let dir = tempfile::tempdir().unwrap();
        let path = artifact_file(&dir, "plan.html", "<h1>plan</h1>");

        let result = call_tool(
            &mut dispatcher,
            "preview_file",
            json!({ "path": path, "title": "The plan" }),
        );

        assert_eq!(result["status"], "showing");
        assert_eq!(result["title"], "The plan");
        assert_eq!(&*shown.lock().unwrap(), &[(path, "The plan".to_string(), None)]);
    }

    #[test]
    fn preview_file_routes_by_the_callers_session() {
        let (mut dispatcher, shown) = with_preview_host();
        let dir = tempfile::tempdir().unwrap();
        let path = artifact_file(&dir, "plan.html", "<h1>plan</h1>");

        let result = call_tool_as(
            &mut dispatcher,
            "preview_file",
            json!({ "path": path }),
            &RequestContext::for_session(Some("s64abebd44298447d")),
        );

        assert_eq!(result["routed"], "session");
        assert_eq!(shown.lock().unwrap()[0].2.as_deref(), Some("s64abebd44298447d"));
    }

    /// `${TT_SESSION_ID:-}` expands empty outside an app terminal: "didn't say", not a bad id.
    #[test]
    fn preview_file_treats_a_blank_session_as_absent() {
        let (mut dispatcher, shown) = with_preview_host();
        let dir = tempfile::tempdir().unwrap();
        let path = artifact_file(&dir, "plan.html", "<h1>plan</h1>");

        let result = call_tool_as(
            &mut dispatcher,
            "preview_file",
            json!({ "path": path }),
            &RequestContext::for_session(Some("   ")),
        );

        assert_eq!(result["routed"], "path");
        assert_eq!(shown.lock().unwrap()[0].2, None);
    }

    /// One dispatcher serves every session; identity must not leak between callers.
    #[test]
    fn a_session_never_leaks_into_the_next_request() {
        let (mut dispatcher, shown) = with_preview_host();
        let dir = tempfile::tempdir().unwrap();
        let path = artifact_file(&dir, "plan.html", "<h1>plan</h1>");

        call_tool_as(
            &mut dispatcher,
            "preview_file",
            json!({ "path": path }),
            &RequestContext::for_session(Some("s-first")),
        );
        call_tool(&mut dispatcher, "preview_file", json!({ "path": path }));

        let shown = shown.lock().unwrap();
        assert_eq!(shown[0].2.as_deref(), Some("s-first"));
        assert_eq!(shown[1].2, None, "the second caller named no session");
    }

    #[test]
    fn preview_file_falls_back_to_the_file_name_as_the_title() {
        let (mut dispatcher, shown) = with_preview_host();
        let dir = tempfile::tempdir().unwrap();
        let path = artifact_file(&dir, "findings.html", "<p>hi</p>");

        let result = call_tool(&mut dispatcher, "preview_file", json!({ "path": path }));

        assert_eq!(result["title"], "findings.html");
        assert_eq!(shown.lock().unwrap()[0].1, "findings.html");
    }

    #[test]
    fn preview_file_without_a_host_refuses() {
        let mut dispatcher = dispatcher();
        let message = call_tool_err(&mut dispatcher, "preview_file", json!({ "path": "/nope" }));
        assert!(message.contains("no preview host"), "{message}");
    }

    /// Each would otherwise be a blank pane and a cheerful success.
    #[test]
    fn preview_file_refuses_a_path_it_cannot_render() {
        let dir = tempfile::tempdir().unwrap();
        let html = artifact_file(&dir, "ok.html", "<p>ok</p>");
        let relative = "docs/plan.html";
        let missing = dir.path().join("gone.html").to_string_lossy().into_owned();
        let directory = dir.path().to_string_lossy().into_owned();

        for (path, expected) in [
            (relative, "must be absolute"),
            (missing.as_str(), "can't read"),
            (directory.as_str(), "is not a file"),
        ] {
            let (mut dispatcher, shown) = with_preview_host();
            let message = call_tool_err(&mut dispatcher, "preview_file", json!({ "path": path }));
            assert!(message.contains(expected), "for {path}: {message}");
            assert!(shown.lock().unwrap().is_empty(), "nothing should reach the host for {path}");
        }

        // …and the control: the valid one goes through.
        let (mut dispatcher, _) = with_preview_host();
        call_tool(&mut dispatcher, "preview_file", json!({ "path": html }));
    }

    #[test]
    fn preview_file_accepts_markdown_and_plain_text() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["notes.md", "run.log", "Makefile"] {
            let (mut dispatcher, shown) = with_preview_host();
            let path = artifact_file(&dir, name, "hello");
            let result = call_tool(&mut dispatcher, "preview_file", json!({ "path": path }));
            assert_eq!(result["status"], "showing", "for {name}");
            assert_eq!(shown.lock().unwrap().len(), 1, "for {name}");
        }
    }

    #[test]
    fn preview_file_refuses_an_oversized_file() {
        let (mut dispatcher, _) = with_preview_host();
        let dir = tempfile::tempdir().unwrap();
        let path = artifact_file(&dir, "huge.html", &"x".repeat(PREVIEW_MAX_BYTES as usize + 1));

        let message = call_tool_err(&mut dispatcher, "preview_file", json!({ "path": path }));
        assert!(message.contains("keep it under"), "{message}");
    }

    #[test]
    fn preview_file_is_not_a_writing_tool() {
        assert!(!tool_writes("preview_file"));
    }

    // file_open

    /// Every `(path, is_dir, line, session)` a fake editor host was handed.
    type Opened =
        std::sync::Arc<std::sync::Mutex<Vec<(String, bool, Option<u32>, Option<String>)>>>;

    fn with_editor_host() -> (Dispatcher, Opened) {
        struct FakeEditorHost {
            opened: Opened,
        }
        impl EditorHost for FakeEditorHost {
            fn open_file(&self, req: FileToOpen) -> Result<(), String> {
                self.opened.lock().unwrap().push((req.path, req.is_dir, req.line, req.session));
                Ok(())
            }
        }
        let opened: Opened = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let host = FakeEditorHost { opened: std::sync::Arc::clone(&opened) };
        (dispatcher().with_editor_host(Box::new(host)), opened)
    }

    #[test]
    fn file_open_hands_the_file_to_the_host() {
        let (mut dispatcher, opened) = with_editor_host();
        let dir = tempfile::tempdir().unwrap();
        let path = artifact_file(&dir, "main.rs", "fn main() {}");

        let result = call_tool(&mut dispatcher, "file_open", json!({ "path": path, "line": 42 }));

        assert_eq!(result["status"], "opening");
        assert_eq!(result["routed"], "path");
        assert_eq!(&*opened.lock().unwrap(), &[(path, false, Some(42), None)]);
    }

    #[test]
    fn file_open_routes_by_the_callers_session() {
        let (mut dispatcher, opened) = with_editor_host();
        let dir = tempfile::tempdir().unwrap();
        let path = artifact_file(&dir, "main.rs", "fn main() {}");

        let result = call_tool_as(
            &mut dispatcher,
            "file_open",
            json!({ "path": path }),
            &RequestContext::for_session(Some("s64abebd44298447d")),
        );

        assert_eq!(result["routed"], "session");
        assert_eq!(
            opened.lock().unwrap()[0].3.as_deref(),
            Some("s64abebd44298447d"),
            "the session travels with the request, not in the arguments"
        );
    }

    #[test]
    fn file_open_marks_a_directory_as_one() {
        let (mut dispatcher, opened) = with_editor_host();
        let dir = tempfile::tempdir().unwrap();
        let path = std::fs::canonicalize(dir.path()).unwrap().to_string_lossy().into_owned();

        call_tool(&mut dispatcher, "file_open", json!({ "path": path }));

        assert!(
            opened.lock().unwrap()[0].1,
            "a directory opens the pane, it doesn't select a file"
        );
    }

    #[test]
    fn file_open_refuses_a_relative_or_missing_path() {
        let (mut dispatcher, _) = with_editor_host();
        let message = call_tool_err(&mut dispatcher, "file_open", json!({ "path": "src/main.rs" }));
        assert!(message.contains("must be absolute"), "{message}");

        let message =
            call_tool_err(&mut dispatcher, "file_open", json!({ "path": "/nope/gone.rs" }));
        assert!(message.contains("can't open"), "{message}");
    }

    #[test]
    fn file_open_without_a_host_refuses() {
        let mut dispatcher = dispatcher();
        let message = call_tool_err(&mut dispatcher, "file_open", json!({ "path": "/nope" }));
        assert!(message.contains("no editor host"), "{message}");
    }

    #[test]
    fn file_open_is_not_a_writing_tool() {
        assert!(!tool_writes("file_open"));
    }

    /// Epoch ms as the local RFC 3339 the tool speaks.
    fn iso(ms: i64) -> String {
        Local.timestamp_millis_opt(ms).single().unwrap().to_rfc3339()
    }

    /// A `calendar_set` event payload, in the tool's wire shape.
    fn event_json(external_id: &str, start_ts: i64, end_ts: i64) -> Value {
        json!({
            "externalId": external_id,
            "title": external_id,
            "start": iso(start_ts),
            "end": iso(end_ts),
        })
    }

    /// `calendar_set` one source's day, returning the tool result.
    fn set_calendar(dispatcher: &mut Dispatcher, source: &str, events: Value) -> Value {
        call_tool(dispatcher, "calendar_set", json!({ "source": source, "events": events }))
    }

    #[test]
    fn calendar_today_returns_only_the_local_day() {
        let (day_start, day_end) = Store::local_day_bounds(NOW);
        let mut dispatcher = dispatcher();
        // Neighbouring days are pushed as their own days — a day's push refuses events outside it.
        let day_of = |ms: i64| {
            Local.timestamp_millis_opt(ms).single().unwrap().format("%Y-%m-%d").to_string()
        };
        for (day_ms, event) in [
            (day_start - 3_600_000, event_json("yesterday", day_start - 3_600_000, day_start - 1)),
            (NOW, event_json("standup", day_start + 3_600_000, day_start + 5_400_000)),
            (day_end + 3_600_000, event_json("tomorrow", day_end + 3_600_000, day_end + 5_400_000)),
        ] {
            call_tool(
                &mut dispatcher,
                "calendar_set",
                json!({ "source": "google", "day": day_of(day_ms), "events": [event] }),
            );
        }

        let result = call_tool(&mut dispatcher, "calendar_today", json!({}));
        assert_eq!(result["now"], NOW);
        let ids: Vec<&str> = result["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|event| event["externalId"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["standup"], "only today's event is in the window");
    }

    /// Reachable by neither the lane's next delete nor retention: a phantom meeting forever.
    #[test]
    fn calendar_set_refuses_an_event_outside_the_day_being_written() {
        let (_, day_end) = Store::local_day_bounds(NOW);
        let mut dispatcher = dispatcher();
        let message = call_tool_err(
            &mut dispatcher,
            "calendar_set",
            json!({
                "source": "google",
                "events": [event_json("next-week", day_end + 6 * 86_400_000, day_end + 6 * 86_400_000 + 1_800_000)],
            }),
        );
        assert!(message.contains("next-week"), "names the offending event: {message}");
        assert!(message.contains("outside the day"), "says why: {message}");
    }

    /// `end < start` shows in `calendar_today` but never in `calendar_next`.
    #[test]
    fn calendar_set_refuses_an_event_that_ends_before_it_starts() {
        let mut dispatcher = dispatcher();
        let message = call_tool_err(
            &mut dispatcher,
            "calendar_set",
            json!({
                "source": "google",
                "events": [event_json("backwards", NOW + 3_600_000, NOW - 3_600_000)],
            }),
        );
        assert!(message.contains("backwards"), "names the offending event: {message}");
        assert!(message.contains("ends before it starts"), "says why: {message}");
    }

    /// Truncating division would report `0` for a live meeting's first 59 seconds.
    #[test]
    fn calendar_next_minutes_until_is_negative_from_the_first_second() {
        let mut dispatcher = dispatcher();
        set_calendar(
            &mut dispatcher,
            "google",
            json!([event_json("live", NOW - 30_000, NOW + 1_800_000)]),
        );
        let result = call_tool(&mut dispatcher, "calendar_next", json!({}));
        assert_eq!(result["live"], true);
        assert_eq!(result["minutesUntil"], -1, "30s in is already negative, not 0");
    }

    #[test]
    fn calendar_next_flags_a_meeting_in_progress() {
        let mut dispatcher = dispatcher();
        // Started 10 minutes ago, runs for another 20.
        set_calendar(
            &mut dispatcher,
            "google",
            json!([event_json("in-progress", NOW - 600_000, NOW + 1_200_000)]),
        );

        let result = call_tool(&mut dispatcher, "calendar_next", json!({}));
        assert_eq!(result["event"]["externalId"], "in-progress");
        assert_eq!(result["live"], true);
        assert_eq!(result["minutesUntil"], -10, "minutes go negative while live");
        assert_eq!(result["now"], NOW);
    }

    #[test]
    fn calendar_next_counts_down_to_the_next_meeting() {
        let mut dispatcher = dispatcher();
        set_calendar(
            &mut dispatcher,
            "google",
            json!([event_json("upcoming", NOW + 1_800_000, NOW + 3_600_000)]),
        );

        let result = call_tool(&mut dispatcher, "calendar_next", json!({}));
        assert_eq!(result["event"]["externalId"], "upcoming");
        assert_eq!(result["live"], false);
        assert_eq!(result["minutesUntil"], 30);
    }

    #[test]
    fn calendar_next_on_an_empty_calendar_is_null() {
        let mut dispatcher = dispatcher();
        let result = call_tool(&mut dispatcher, "calendar_next", json!({}));
        assert_eq!(result["event"], Value::Null);
    }

    #[test]
    fn calendar_set_replaces_one_source_and_leaves_the_others() {
        let (day_start, _) = Store::local_day_bounds(NOW);
        let mut dispatcher = dispatcher();
        set_calendar(
            &mut dispatcher,
            "outlook",
            json!([event_json(
                "work-sync",
                day_start + 3_600_000,
                day_start + 5_400_000
            )]),
        );
        set_calendar(
            &mut dispatcher,
            "google",
            json!([event_json(
                "dentist",
                day_start + 7_200_000,
                day_start + 9_000_000
            )]),
        );

        // Re-pushing google replaces only google's rows for the day.
        let result = set_calendar(
            &mut dispatcher,
            "google",
            json!([event_json(
                "school-run",
                day_start + 10_800_000,
                day_start + 12_600_000
            )]),
        );
        assert_eq!(result["source"], "google");
        assert_eq!(result["written"], 1);
        assert_eq!(result["dayStart"], iso(day_start));

        let today = call_tool(&mut dispatcher, "calendar_today", json!({}));
        let ids: Vec<&str> = today["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|event| event["externalId"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["work-sync", "school-run"], "outlook's row survived");
    }

    #[test]
    fn calendar_set_accepts_an_explicit_day() {
        let mut dispatcher = dispatcher();
        let day = Local.timestamp_millis_opt(NOW).single().unwrap().date_naive();
        let tomorrow = (day + Duration::days(1)).format("%Y-%m-%d").to_string();
        let tomorrow_start = Store::local_day_bounds(day_reference_ms(&tomorrow).unwrap()).0;

        let result = call_tool(
            &mut dispatcher,
            "calendar_set",
            json!({
                "source": "google",
                "day": tomorrow,
                "events": [event_json("offsite", tomorrow_start + 3_600_000, tomorrow_start + 7_200_000)],
            }),
        );
        assert_eq!(result["dayStart"], iso(tomorrow_start));

        // It is tomorrow's, so today's read does not see it.
        let today = call_tool(&mut dispatcher, "calendar_today", json!({}));
        assert!(today["events"].as_array().unwrap().is_empty(), "{today}");
    }

    #[test]
    fn calendar_set_clears_a_day_with_an_empty_array() {
        let (day_start, _) = Store::local_day_bounds(NOW);
        let mut dispatcher = dispatcher();
        set_calendar(
            &mut dispatcher,
            "google",
            json!([event_json(
                "cancelled",
                day_start + 3_600_000,
                day_start + 5_400_000
            )]),
        );
        let result = set_calendar(&mut dispatcher, "google", json!([]));
        assert_eq!(result["written"], 0);
        let today = call_tool(&mut dispatcher, "calendar_today", json!({}));
        assert!(today["events"].as_array().unwrap().is_empty(), "{today}");
    }

    #[test]
    fn calendar_set_validates_its_arguments() {
        let mut dispatcher = dispatcher();
        let message = call_tool_err(&mut dispatcher, "calendar_set", json!({ "events": [] }));
        assert!(message.contains("source"), "{message}");
        let message = call_tool_err(&mut dispatcher, "calendar_set", json!({ "source": "google" }));
        assert!(message.contains("events"), "{message}");
        let message = call_tool_err(
            &mut dispatcher,
            "calendar_set",
            json!({ "source": "google", "events": [{ "title": "no id" }] }),
        );
        assert!(message.contains("invalid events payload"), "{message}");
        let message = call_tool_err(
            &mut dispatcher,
            "calendar_set",
            json!({ "source": "google", "day": "not-a-date", "events": [] }),
        );
        assert!(message.contains("invalid day"), "{message}");
    }

    #[test]
    fn calendar_set_ignores_a_source_field_smuggled_into_an_event() {
        // `source` is caller-assigned: an event's own `source` must not write into another lane.
        let (day_start, _) = Store::local_day_bounds(NOW);
        let mut dispatcher = dispatcher();
        set_calendar(
            &mut dispatcher,
            "outlook",
            json!([event_json(
                "work-sync",
                day_start + 3_600_000,
                day_start + 5_400_000
            )]),
        );
        call_tool(
            &mut dispatcher,
            "calendar_set",
            json!({
                "source": "google",
                "events": [{
                    "source": "outlook",
                    "externalId": "work-sync",
                    "title": "hijacked",
                    "start": iso(day_start + 3_600_000),
                }],
            }),
        );

        let today = call_tool(&mut dispatcher, "calendar_today", json!({}));
        let events = today["events"].as_array().unwrap();
        assert_eq!(events.len(), 2, "the outlook row was not overwritten: {today}");
        let outlook = events.iter().find(|e| e["source"] == "outlook").unwrap();
        assert_eq!(outlook["title"], "work-sync");
    }

    #[test]
    fn task_list_returns_seeded_task() {
        let mut dispatcher = dispatcher();
        let result = call_tool(&mut dispatcher, "task_list", json!({}));
        let tasks = result["tasks"].as_array().unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0]["text"], "open task");
    }

    #[test]
    fn task_status_returns_one_task_including_done() {
        let store = seeded_store();
        let done = store.add_task("shipped", "done", None, None, NOW).unwrap();
        let mut dispatcher = Dispatcher::new(store, TEST_VERSION);
        let result = call_tool(&mut dispatcher, "task_status", json!({ "id": done.id }));
        assert_eq!(result["task"]["text"], "shipped");
        assert_eq!(result["task"]["status"], "done");
    }

    #[test]
    fn task_status_requires_a_known_id() {
        let mut dispatcher = dispatcher();
        let message = call_tool_err(&mut dispatcher, "task_status", json!({}));
        assert!(message.contains("id"), "error should name the missing arg: {message}");
        let message = call_tool_err(&mut dispatcher, "task_status", json!({ "id": 9999 }));
        assert!(message.contains("9999"), "error should name the unknown id: {message}");
    }

    #[test]
    fn task_summary_records_the_report_on_the_card() {
        let store = seeded_store();
        let task =
            store.add_task("switch the files pane", "doing", Some("mine"), None, NOW).unwrap();
        let mut dispatcher = Dispatcher::new(store, TEST_VERSION);
        let result = call_tool(
            &mut dispatcher,
            "task_summary",
            json!({ "id": task.id, "summary": "PR #510 merged as 9a550d9. CI green." }),
        );
        assert_eq!(result["task"]["summary"], "PR #510 merged as 9a550d9. CI green.");
        assert_eq!(result["task"]["summaryAt"], NOW);
        // It records, it does not close — status and worktree binding stay the user's.
        assert_eq!(result["task"]["status"], "doing");
        assert_eq!(result["task"]["closed"], false);
        // The user's notes stay theirs: a summary there would return as instructions.
        assert_eq!(result["task"]["notes"], "mine");
        let read = call_tool(&mut dispatcher, "task_status", json!({ "id": task.id }));
        assert_eq!(read["task"]["summary"], "PR #510 merged as 9a550d9. CI green.");
    }

    #[test]
    fn task_summary_requires_both_args_and_a_known_id() {
        let store = seeded_store();
        let task = store.add_task("x", "doing", None, None, NOW).unwrap();
        let mut dispatcher = Dispatcher::new(store, TEST_VERSION);
        let message = call_tool_err(&mut dispatcher, "task_summary", json!({ "summary": "done" }));
        assert!(message.contains("id"), "error should name the missing arg: {message}");
        let message = call_tool_err(&mut dispatcher, "task_summary", json!({ "id": task.id }));
        assert!(message.contains("summary"), "error should name the missing arg: {message}");
        let message = call_tool_err(
            &mut dispatcher,
            "task_summary",
            json!({ "id": 9999, "summary": "done" }),
        );
        assert!(message.contains("9999"), "error should name the unknown id: {message}");
    }

    #[test]
    fn task_create_lands_in_the_repo_swimlane() {
        let mut dispatcher = dispatcher();
        let result = call_tool(
            &mut dispatcher,
            "task_create",
            json!({ "repo": REPO_SLUG, "title": "port the CLI", "notes": "start with doctor" }),
        );
        assert_eq!(result["task"]["text"], "port the CLI");
        assert_eq!(result["task"]["status"], "backlog");
        assert_eq!(result["task"]["notes"], "start with doctor");
        assert_eq!(result["task"]["createdAt"], NOW);
        // The repo binding is what puts the task in a Board swimlane.
        assert_eq!(result["task"]["worktree"]["repoRoot"], REPO_DIR);
        assert_eq!(result["task"]["worktree"]["repo"], REPO_SLUG);

        let open = call_tool(&mut dispatcher, "task_list", json!({}));
        let texts: Vec<&str> =
            open["tasks"].as_array().unwrap().iter().map(|t| t["text"].as_str().unwrap()).collect();
        assert!(texts.contains(&"port the CLI"), "created task missing: {texts:?}");
    }

    /// Wrong-cased slugs must land in the one real swimlane: an exact match against a case-folded
    /// cache rejected `gh`'s own casing and stamped the accepted one verbatim, splitting the lane.
    #[test]
    fn task_create_normalizes_the_repo_slug_casing() {
        let mut dispatcher = dispatcher();
        let result = call_tool(
            &mut dispatcher,
            "task_create",
            json!({ "repo": REPO_SLUG.to_uppercase(), "title": "shouty repo arg" }),
        );
        // Stamped with the tracked repo's spelling, not the caller's.
        assert_eq!(result["task"]["worktree"]["repo"], REPO_SLUG);
        assert_eq!(result["task"]["worktree"]["repoRoot"], REPO_DIR);
    }

    #[test]
    fn task_create_accepts_a_status() {
        let mut dispatcher = dispatcher();
        let result = call_tool(
            &mut dispatcher,
            "task_create",
            json!({ "repo": REPO_SLUG, "title": "already underway", "status": "doing" }),
        );
        assert_eq!(result["task"]["status"], "doing");
        assert_eq!(result["task"]["worktree"]["repoRoot"], REPO_DIR);
    }

    /// Each `(id, force, outcome)` a fake host was called with; the real host tears down worktrees,
    /// which has no place in a unit test of the tool's shape.
    type HostCalls =
        std::sync::Arc<std::sync::Mutex<Vec<(i64, bool, Option<tt_store::TaskOutcome>)>>>;

    /// Each start request the host was handed — only the fields a test asserts on.
    type StartCalls =
        std::sync::Arc<std::sync::Mutex<Vec<(i64, String, String, Option<String>, String)>>>;

    struct FakeHost {
        answer: std::sync::Mutex<Option<Result<TaskDeletion, String>>>,
        calls: HostCalls,
        starts: StartCalls,
    }

    impl TaskHost for FakeHost {
        fn delete_task(
            &self,
            id: i64,
            force: bool,
            outcome: Option<tt_store::TaskOutcome>,
        ) -> Result<TaskDeletion, String> {
            self.calls.lock().unwrap().push((id, force, outcome));
            self.answer.lock().unwrap().take().expect("one delete per test")
        }

        fn start_task(&self, req: TaskStartRequest) -> Result<(), String> {
            self.starts.lock().unwrap().push((
                req.id,
                req.repo_root,
                req.branch,
                req.base,
                req.prompt,
            ));
            Ok(())
        }
    }

    fn with_host(answer: Result<TaskDeletion, String>) -> (Dispatcher, HostCalls) {
        let (dispatcher, calls, _) = with_host_recording(answer);
        (dispatcher, calls)
    }

    fn with_host_recording(
        answer: Result<TaskDeletion, String>,
    ) -> (Dispatcher, HostCalls, StartCalls) {
        let calls: HostCalls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let starts: StartCalls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let host = FakeHost {
            answer: std::sync::Mutex::new(Some(answer)),
            calls: std::sync::Arc::clone(&calls),
            starts: std::sync::Arc::clone(&starts),
        };
        (dispatcher().with_task_host(Box::new(host)), calls, starts)
    }

    fn deleted(name: &str, messages: Vec<String>) -> Result<TaskDeletion, String> {
        Ok(TaskDeletion::Deleted { name: name.to_string(), messages })
    }

    // task_start

    /// As with `task_delete`: without a host, refuse rather than half-do the job.
    #[test]
    fn task_start_without_a_host_refuses() {
        let mut dispatcher = dispatcher();
        let message = call_tool_err(&mut dispatcher, "task_start", json!({ "id": 1 }));
        assert!(message.contains("no task host"), "{message}");
    }

    /// Everything comes from the row, so the host reads nothing.
    #[test]
    fn task_start_resolves_branch_repo_and_prompt_from_the_row() {
        let (mut dispatcher, _, starts) = with_host_recording(deleted("unused", vec![]));
        let created = call_tool(
            &mut dispatcher,
            "task_create",
            json!({
                "repo": REPO_SLUG,
                "title": "Collapse git_info's eight spawns",
                "goal": "Cut the per-folder git subprocess count from ~8 to 1.",
                "notes": "Work in git_info.rs only.",
            }),
        );
        let id = created["task"]["id"].as_i64().unwrap();

        let result = call_tool(&mut dispatcher, "task_start", json!({ "id": id }));
        assert_eq!(result["status"], "starting");
        assert_eq!(result["id"], id);
        assert_eq!(result["branch"], "collapse-git_info-s-eight-spawns");

        let starts = starts.lock().unwrap();
        assert_eq!(starts.len(), 1);
        let (got_id, repo_root, branch, base, prompt) = &starts[0];
        assert_eq!(*got_id, id);
        assert_eq!(repo_root, REPO_DIR);
        assert_eq!(branch, "collapse-git_info-s-eight-spawns");
        assert_eq!(*base, None);
        // Goal leads, notes follow — the title is not the instruction.
        assert!(prompt.starts_with("Cut the per-folder git subprocess count"), "{prompt}");
        assert!(prompt.contains("Work in git_info.rs only."), "{prompt}");
    }

    #[test]
    fn task_start_passes_an_explicit_branch_and_base_through() {
        let (mut dispatcher, _, starts) = with_host_recording(deleted("unused", vec![]));
        let created =
            call_tool(&mut dispatcher, "task_create", json!({ "repo": REPO_SLUG, "title": "x" }));
        let id = created["task"]["id"].as_i64().unwrap();

        call_tool(
            &mut dispatcher,
            "task_start",
            json!({ "id": id, "branch": "fix/thing", "base": "develop" }),
        );

        let starts = starts.lock().unwrap();
        let (_, _, branch, base, _) = &starts[0];
        assert_eq!(branch, "fix/thing");
        assert_eq!(base.as_deref(), Some("develop"));
    }

    /// A second worktree would orphan the running one.
    #[test]
    fn task_start_refuses_a_task_that_already_has_a_worktree() {
        let (mut dispatcher, _, starts) = with_host_recording(deleted("unused", vec![]));
        let created =
            call_tool(&mut dispatcher, "task_create", json!({ "repo": REPO_SLUG, "title": "x" }));
        let id = created["task"]["id"].as_i64().unwrap();
        dispatcher
            .store
            .set_task_worktree(id, REPO_DIR, None, Some("feat/x"), Some("/w/feat-x"))
            .unwrap();

        let message = call_tool_err(&mut dispatcher, "task_start", json!({ "id": id }));
        assert!(message.contains("already has a worktree"), "{message}");
        assert!(starts.lock().unwrap().is_empty(), "host must not be called");
    }

    #[test]
    fn task_start_refuses_a_closed_task() {
        let (mut dispatcher, _, starts) = with_host_recording(deleted("unused", vec![]));
        let created =
            call_tool(&mut dispatcher, "task_create", json!({ "repo": REPO_SLUG, "title": "x" }));
        let id = created["task"]["id"].as_i64().unwrap();
        dispatcher.store.close_task(id, tt_store::TaskOutcome::Done, NOW).unwrap();

        let message = call_tool_err(&mut dispatcher, "task_start", json!({ "id": id }));
        assert!(message.contains("closed"), "{message}");
        assert!(starts.lock().unwrap().is_empty(), "host must not be called");
    }

    #[test]
    fn task_start_refuses_a_task_with_no_repo_binding() {
        let (mut dispatcher, _, starts) = with_host_recording(deleted("unused", vec![]));
        let message = call_tool_err(&mut dispatcher, "task_start", json!({ "id": 1 }));
        assert!(message.contains("isn't bound to a repo"), "{message}");
        assert!(starts.lock().unwrap().is_empty(), "host must not be called");
    }

    #[test]
    fn task_start_reports_an_unknown_id() {
        let (mut dispatcher, _, _) = with_host_recording(deleted("unused", vec![]));
        let message = call_tool_err(&mut dispatcher, "task_start", json!({ "id": 9999 }));
        assert!(message.to_lowercase().contains("task"), "{message}");
    }

    #[test]
    fn start_prompt_prefers_goal_then_falls_back_to_the_title() {
        // A real row, so the fixture can't drift from what the store hands the dispatcher.
        let store = Store::open_in_memory().unwrap();
        let mut task = store.add_task("Card title", "backlog", None, None, NOW).unwrap();

        // Nothing but a title: it's all the agent can be told.
        assert_eq!(task_start_prompt(&task), "Card title");

        task.goal = Some("  Do the thing.  ".into());
        assert_eq!(task_start_prompt(&task), "Do the thing.");

        task.notes = Some("Context here.".into());
        assert_eq!(task_start_prompt(&task), "Do the thing.\n\n## Notes\n\nContext here.");

        // Blank strings are absent, not content.
        task.goal = Some("   ".into());
        assert_eq!(task_start_prompt(&task), "Card title\n\n## Notes\n\nContext here.");
    }

    /// Without a host, refuse — deleting only the row would strand the worktree on disk.
    #[test]
    fn task_delete_without_a_host_refuses() {
        let mut dispatcher = dispatcher();
        let message = call_tool_err(&mut dispatcher, "task_delete", json!({ "id": 1 }));
        assert!(message.contains("no task host"), "{message}");
        // And the row it declined to delete is still there.
        let open = call_tool(&mut dispatcher, "task_list", json!({}));
        assert_eq!(open["tasks"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn task_delete_passes_the_id_force_and_outcome_through_and_names_what_it_deleted() {
        let (mut dispatcher, calls) =
            with_host(deleted("open task", vec!["removed the worktree".into()]));
        let result = call_tool(
            &mut dispatcher,
            "task_delete",
            json!({ "id": 1, "force": true, "outcome": "abandoned" }),
        );
        assert_eq!(result["status"], "deleted");
        assert_eq!(result["id"], 1);
        // The name comes from the host, which resolved the row anyway.
        assert_eq!(result["text"], "open task");
        assert_eq!(result["messages"][0], "removed the worktree");
        assert_eq!(*calls.lock().unwrap(), vec![(1, true, Some(tt_store::TaskOutcome::Abandoned))]);
    }

    /// A bad outcome is rejected before the host acts; an omitted one reaches it as `None`.
    #[test]
    fn task_delete_validates_the_outcome_and_defaults_it_to_inference() {
        let (mut dispatcher, calls) = with_host(deleted("open task", vec![]));
        let message = call_tool_err(
            &mut dispatcher,
            "task_delete",
            json!({ "id": 1, "outcome": "exploded" }),
        );
        assert!(message.contains("unknown outcome"), "{message}");
        assert!(calls.lock().unwrap().is_empty(), "rejected before the host ran");

        let result = call_tool(&mut dispatcher, "task_delete", json!({ "id": 1 }));
        assert_eq!(result["status"], "deleted");
        assert_eq!(*calls.lock().unwrap(), vec![(1, false, None)]);
    }

    /// A guarded refusal is a result, not an error — an error would invite a retry with force.
    #[test]
    fn task_delete_reports_a_refusal_as_a_normal_result() {
        let (mut dispatcher, calls) = with_host(Ok(TaskDeletion::Refused {
            name: "open task".to_string(),
            blockers: vec![json!({
                "kind": "dirtyTree",
                "message": "2 uncommitted files",
                "remedy": "commit or stash them",
                "losesWork": true,
            })],
            messages: vec![],
        }));
        let result = call_tool(&mut dispatcher, "task_delete", json!({ "id": 1 }));
        assert_eq!(result["status"], "refused");
        assert_eq!(result["blockers"][0]["kind"], "dirtyTree");
        assert_eq!(result["blockers"][0]["losesWork"], true);
        // Force defaults off — a refusal must be reachable without asking for one.
        assert_eq!(*calls.lock().unwrap(), vec![(1, false, None)]);
    }

    #[test]
    fn task_delete_requires_an_id() {
        let (mut dispatcher, calls) = with_host(deleted("open task", vec![]));
        let message = call_tool_err(&mut dispatcher, "task_delete", json!({}));
        assert!(message.contains("missing required argument: id"), "{message}");
        // Rejected before the host could touch anything.
        assert!(calls.lock().unwrap().is_empty());
    }

    /// An unknown id is the host's answer: it resolves the row anyway.
    #[test]
    fn task_delete_surfaces_the_hosts_unknown_id_error() {
        let (mut dispatcher, calls) = with_host(Err("no board task #9999".to_string()));
        let message = call_tool_err(&mut dispatcher, "task_delete", json!({ "id": 9999 }));
        assert!(message.contains("no board task #9999"), "{message}");
        assert_eq!(*calls.lock().unwrap(), vec![(9999, false, None)]);
    }

    #[test]
    fn task_create_rejects_an_untracked_repo() {
        let mut dispatcher = dispatcher();
        let message = call_tool_err(
            &mut dispatcher,
            "task_create",
            json!({ "repo": "nope/nope", "title": "x" }),
        );
        assert!(message.contains("unknown repo: nope/nope"), "{message}");
        assert!(message.contains(REPO_SLUG), "error should list tracked repos: {message}");

        let mut empty = Dispatcher::new(seeded_store(), TEST_VERSION);
        let message =
            call_tool_err(&mut empty, "task_create", json!({ "repo": REPO_SLUG, "title": "x" }));
        assert!(message.contains("no repos are tracked"), "{message}");
    }

    #[test]
    fn task_create_requires_title_and_repo() {
        let mut dispatcher = dispatcher();
        let message = call_tool_err(&mut dispatcher, "task_create", json!({ "repo": REPO_SLUG }));
        assert!(message.contains("title"), "error should name the missing arg: {message}");
        let message = call_tool_err(
            &mut dispatcher,
            "task_create",
            json!({ "repo": REPO_SLUG, "title": " " }),
        );
        assert!(message.contains("title"), "blank title should be rejected: {message}");
        let message = call_tool_err(&mut dispatcher, "task_create", json!({ "title": "x" }));
        assert!(message.contains("repo"), "error should name the missing arg: {message}");
    }

    #[test]
    fn task_create_rejects_a_bogus_status() {
        let mut dispatcher = dispatcher();
        let message = call_tool_err(
            &mut dispatcher,
            "task_create",
            json!({ "repo": REPO_SLUG, "title": "x", "status": "bogus" }),
        );
        assert!(message.contains("bogus"), "{message}");
        // Nothing was created.
        let open = call_tool(&mut dispatcher, "task_list", json!({}));
        assert_eq!(open["tasks"].as_array().unwrap().len(), 1, "only the seeded task remains");
    }

    /// The lane check stops a typo minting a calendar nothing writes again — the orphan-lane failure
    /// the v9 migration destroyed data to avoid, so it must hold at runtime too.
    #[test]
    fn calendar_set_refuses_an_unconfigured_source() {
        let mut dispatcher = dispatcher();
        let message = call_tool_err(
            &mut dispatcher,
            "calendar_set",
            json!({ "source": "gcal", "events": [] }),
        );
        assert!(message.contains("unknown calendar source: gcal"), "{message}");
        assert!(message.contains("google"), "refusal lists configured lanes: {message}");
    }

    /// Fails closed: nothing configured means every push is refused.
    #[test]
    fn calendar_set_refuses_everything_when_no_calendars_are_configured() {
        let mut dispatcher =
            Dispatcher::new(seeded_store(), TEST_VERSION).with_calendar_sources(vec![]);
        let message = call_tool_err(
            &mut dispatcher,
            "calendar_set",
            json!({ "source": "google", "events": [] }),
        );
        assert!(message.contains("no calendars are configured"), "{message}");
    }

    /// A configured lane still works, including the empty-array clear.
    #[test]
    fn calendar_set_accepts_a_configured_source() {
        let mut dispatcher = dispatcher();
        let result =
            call_tool(&mut dispatcher, "calendar_set", json!({ "source": "google", "events": [] }));
        assert_eq!(result["source"], "google");
        assert_eq!(result["written"], 0);
    }

    /// Writes are flagged in the contract, not inferred from a description: the UI's write warning
    /// is the only signal a human gets before a mutation, so it must not hinge on an adjective.
    #[test]
    fn every_tool_states_all_four_hints_and_no_writer_claims_read_only() {
        let tools = tool_definitions();
        let tools = tools.as_array().unwrap();
        let hint = |name: &str, key: &str| {
            tools.iter().find(|t| t["name"] == name).and_then(|t| t["annotations"][key].as_bool())
        };
        assert_eq!(hint("task_delete", "destructiveHint"), Some(true));
        assert_eq!(hint("task_create", "destructiveHint"), Some(false));
        assert_eq!(hint("task_summary", "idempotentHint"), Some(true));
        assert_eq!(hint("calendar_set", "idempotentHint"), Some(true));
        // Mints a worktree and launches an agent: not read-only, whatever the transport repaints.
        assert_eq!(hint("task_start", "readOnlyHint"), Some(false));
        assert_eq!(hint("preview_file", "readOnlyHint"), Some(true));

        for tool in tools {
            let name = tool["name"].as_str().unwrap();
            let hints = &tool["annotations"];
            for key in [
                "readOnlyHint",
                "destructiveHint",
                "idempotentHint",
                "openWorldHint",
            ] {
                assert!(hints[key].is_boolean(), "{name} omits {key}");
            }
            assert_eq!(hints["openWorldHint"], false, "{name} never leaves the machine");
            assert_eq!(hints["title"], tool["title"], "{name}: one title, stated twice");
            if tool_writes(name) {
                assert_eq!(hints["readOnlyHint"], false, "{name} writes the store");
            }
        }
        assert_eq!(TOOL_HINTS.len(), tools.len(), "a hint for a tool that no longer exists");
    }

    /// Inlined and dialect-free, so a client's 2020-12 validator reads it without a resolver.
    #[test]
    fn every_tool_declares_a_valid_output_schema() {
        for tool in tool_definitions().as_array().unwrap() {
            let name = tool["name"].as_str().unwrap();
            let schema = &tool["outputSchema"];
            assert_eq!(schema["type"], "object", "{name}");
            assert!(!schema.to_string().contains("$ref"), "{name} leaves a $ref to resolve");
            assert!(schema.get("$schema").is_none(), "{name} names a dialect");
            jsonschema::validator_for(schema).unwrap_or_else(|e| panic!("{name}: {e}"));
            for format in formats(schema) {
                assert!(["int64", "date-time"].contains(&format.as_str()), "{name}: {format}");
            }
        }
    }

    /// Every `format` a schema carries — Claude Code's validator warns aloud on one it
    /// doesn't know (`uint64`), on every `tools/list`.
    fn formats(schema: &Value) -> Vec<String> {
        match schema {
            Value::Object(map) => map
                .iter()
                .flat_map(|(key, value)| match (key.as_str(), value.as_str()) {
                    ("format", Some(format)) => vec![format.to_string()],
                    _ => formats(value),
                })
                .collect(),
            Value::Array(items) => items.iter().flat_map(formats).collect(),
            _ => Vec::new(),
        }
    }

    #[test]
    fn removed_tools_are_unknown() {
        // Removed in the 2026-07 tool-surface review; a straggler gets the spec's protocol
        // error, not an `isError` result — and not a refusal at the door, so still a 200.
        let mut dispatcher = dispatcher();
        for tool in [
            "todo_create",
            "journal_append",
            "collect_refresh",
            "agent_sessions",
            "tasks_open",
            "issues_open",
            "prs_status",
            "dm_status",
            "day_brief",
            "needs_you",
            "snapshot",
            "collect_status",
        ] {
            let request = tool_call_request(tool, json!({}));
            let handled = dispatcher.dispatch_at(&request, NOW, &RequestContext::none());
            let response: Value = serde_json::from_str(&handled.response.unwrap()).unwrap();
            assert_eq!(response["error"]["code"], INVALID_PARAMS, "{tool}: {response}");
            assert!(response["error"]["message"].as_str().unwrap().contains(tool));
            assert_eq!(handled.error_code, None, "{tool}");
        }
    }

    #[test]
    fn unknown_method_returns_method_not_found() {
        let mut dispatcher = dispatcher();
        // `ping` and `initialize` went with the handshake; nothing special about them.
        for method in ["no/such", "ping", "initialize"] {
            let response = parsed(&mut dispatcher, &request(3, method, json!({})));
            assert_eq!(response["id"], 3);
            assert_eq!(response["error"]["code"], METHOD_NOT_FOUND, "{method}");
        }
    }

    #[test]
    fn broken_json_returns_parse_error_with_null_id() {
        let mut dispatcher = dispatcher();
        let response: Value =
            serde_json::from_str(&dispatcher.handle_at("{ not json", NOW).unwrap()).unwrap();
        assert_eq!(response["id"], Value::Null);
        assert_eq!(response["error"]["code"], -32700);
    }

    #[test]
    fn batch_array_returns_invalid_request() {
        // Batching is gone since 2025-06-18: one Invalid Request, not a silent drop.
        let mut dispatcher = dispatcher();
        let batch = r#"[{"jsonrpc":"2.0","id":1,"method":"ping"}]"#;
        let response: Value =
            serde_json::from_str(&dispatcher.handle_at(batch, NOW).unwrap()).unwrap();
        assert_eq!(response["id"], Value::Null);
        assert_eq!(response["error"]["code"], -32600);
    }

    #[test]
    fn request_with_id_but_no_method_is_invalid_request() {
        let mut dispatcher = dispatcher();
        let request = json!({ "jsonrpc": "2.0", "id": 5 }).to_string();
        let response: Value =
            serde_json::from_str(&dispatcher.handle_at(&request, NOW).unwrap()).unwrap();
        assert_eq!(response["id"], 5);
        assert_eq!(response["error"]["code"], -32600);
    }

    /// Drive a raw request line through the dispatcher, discarding its response.
    fn drive(dispatcher: &mut Dispatcher, request: impl ToString) {
        dispatcher.handle_at(&request.to_string(), NOW);
    }

    #[test]
    fn dispatch_records_each_requests_own_client() {
        let mut dispatcher = dispatcher();

        drive(&mut dispatcher, tool_call_request("task_list", json!({ "why": "ship it" })));
        drive(&mut dispatcher, tool_call_request("does_not_exist", json!({})));
        // A caller that sent no `clientInfo` is recorded as nobody, not as the last one.
        let mut anonymous: Value =
            serde_json::from_str(&request(3, "server/discover", json!({}))).unwrap();
        anonymous["params"]["_meta"].as_object_mut().unwrap().remove(META_CLIENT_INFO);
        drive(&mut dispatcher, anonymous);

        let calls = dispatcher.store.mcp_calls(10).unwrap();
        assert_eq!(calls.len(), 3, "one row per handled request: {calls:?}");

        // Newest first: the anonymous discover.
        assert_eq!(calls[0].method, "server/discover");
        assert!(calls[0].ok);
        assert_eq!(calls[0].client, None);

        // The failing unknown-tool call.
        assert_eq!(calls[1].method, "tools/call");
        assert_eq!(calls[1].tool.as_deref(), Some("does_not_exist"));
        assert!(!calls[1].ok);
        assert!(calls[1].error.is_some(), "failed call records an error");
        assert!(calls[1].duration_ms.is_some());
        assert_eq!(calls[1].client.as_deref(), Some("claude-code 2.1"));

        // The successful task_list call, with its compacted args and ts.
        assert_eq!(calls[2].tool.as_deref(), Some("task_list"));
        assert!(calls[2].ok);
        assert_eq!(calls[2].error, None);
        assert_eq!(calls[2].ts, NOW);
        assert!(
            calls[2].args.as_deref().is_some_and(|a| a.contains("ship it")),
            "args should carry the payload: {:?}",
            calls[2].args
        );
        assert_eq!(calls[2].client.as_deref(), Some("claude-code 2.1"));
    }

    #[test]
    fn dispatch_records_unknown_method_as_error() {
        let mut dispatcher = dispatcher();
        drive(&mut dispatcher, request(1, "bogus/method", json!({})));
        let calls = dispatcher.store.mcp_calls(10).unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].method, "bogus/method");
        assert!(!calls[0].ok);
        assert_eq!(calls[0].error.as_deref(), Some("Method not found"));
    }

    #[test]
    fn notifications_are_not_recorded() {
        let mut dispatcher = dispatcher();
        // A notification (no id) gets no response and no call-log row.
        drive(&mut dispatcher, json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
        assert!(dispatcher.store.mcp_calls(10).unwrap().is_empty());
    }

    #[test]
    fn compact_args_truncates_on_char_boundary() {
        let short = json!({ "title": "x" });
        assert_eq!(compact_args(&short), r#"{"title":"x"}"#);

        let big = json!({ "notes": "é".repeat(CALL_LOG_ARGS_MAX) });
        let out = compact_args(&big);
        assert!(out.ends_with('…'), "oversized args end with an ellipsis: {out}");
        assert_eq!(out.chars().count(), CALL_LOG_ARGS_MAX + 1);
    }
}
