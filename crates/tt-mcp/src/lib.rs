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
use std::path::Path;
use std::time::Instant;

use chrono::{Local, NaiveDate, TimeZone};

mod inbox;
mod output;
pub mod port;
mod suggest;

pub use inbox::InboxHost;
pub use suggest::{SuggestAnswer, SuggestHost, SuggestRequest};

use serde_json::{Value, json};
use tt_store::{EventInput, McpCallInput, Store};

/// The one revision served, shared with the CLI so both ends of `tt open` move together.
pub const PROTOCOL_VERSION: &str = "2026-07-28";
/// `params._meta` keys — the version a request must carry, its `clientInfo`, and ours on results.
pub const META_PROTOCOL_VERSION: &str = "io.modelcontextprotocol/protocolVersion";
pub const META_CLIENT_INFO: &str = "io.modelcontextprotocol/clientInfo";
pub const META_CLIENT_CAPABILITIES: &str = "io.modelcontextprotocol/clientCapabilities";
pub const META_SERVER_INFO: &str = "io.modelcontextprotocol/serverInfo";
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

/// The app-side half of `needs_you`: which sessions wait on the user is the agentboard's
/// PTY-stamped state, invisible from this Tauri-free crate.
pub trait AttentionHost: Send {
    fn needs_you(&self) -> Vec<WaitingSession>;

    /// Chime until the user answers — a hand-off: returns once the chime starts.
    fn summon(&self, request: SummonRequest) -> Result<(), String>;
}

/// A validated `summon` — see [`AttentionHost::summon`].
pub struct SummonRequest {
    /// Shown to the user, never logged.
    pub reason: String,
    /// The caller's PTY; `None` is answered by input to any terminal.
    pub session: Option<String>,
    pub max_minutes: u32,
}

/// `summon`'s chime cap when the caller names none, and its clamp.
const SUMMON_DEFAULT_MINUTES: u32 = 15;
const SUMMON_MAX_MINUTES: u32 = 60;
const SUMMON_REASON_MAX_CHARS: usize = 200;

/// One session the rail badges as needing the user.
pub struct WaitingSession {
    /// The rail's session id — the `TT_SESSION_ID` its terminal carries.
    pub session: String,
    pub name: String,
    pub repo: String,
    /// The checkout or worktree directory the session runs in.
    pub dir: String,
    /// `waitingForInput`, `errored` or `finished`.
    pub reason: String,
    pub since_ms: i64,
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
    /// Injected by the transport; `None` in tests, where `needs_you` refuses.
    attention_host: Option<Box<dyn AttentionHost>>,
    /// Injected by the transport; `None` in tests, where notes are still leased and acked.
    inbox_host: Option<Box<dyn InboxHost>>,
    /// Injected by the transport; `None` in tests, where `next_prompt` refuses.
    suggest_host: Option<Box<dyn SuggestHost>>,
    /// Test hook: fixed lane ids, keeping `calendar_set` off the real settings file.
    calendar_sources: Option<Vec<String>>,
    /// Test hook: keeps `next_prompt` off the real settings file.
    next_prompt_settings: Option<tt_config::NextPromptSettings>,
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
const WRITING_TOOLS: &[&str] = &[
    "task_create",
    "task_summary",
    "task_sync",
    "task_delete",
    "task_done",
    "calendar_set",
];

pub fn tool_writes(name: &str) -> bool {
    WRITING_TOOLS.contains(&name)
}

/// Writing tools that repaint the UI themselves, so the transport must not. `task_delete` runs
/// the app's own delete path, which emits a snapshot as the row goes; a second rebuild would
/// take the `StoreState` mutex even for a refused delete. Still a [`WRITING_TOOLS`] entry.
const SELF_REFRESHING_TOOLS: &[&str] = &["task_delete", "task_done"];

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
    ("task_sync", "Sync task branch", Effect::Replace),
    ("task_delete", "Delete task", Effect::Destroy),
    ("task_done", "Finish task", Effect::Destroy),
    ("task_start", "Start task", Effect::Write),
    ("preview_file", "Preview file", Effect::Read),
    ("file_open", "Open file", Effect::Read),
    ("needs_you", "Sessions needing you", Effect::Read),
    ("summon", "Summon the user", Effect::Write),
    ("calendar_today", "Today's meetings", Effect::Read),
    ("calendar_next", "Next meeting", Effect::Read),
    ("calendar_set", "Set a calendar day", Effect::Replace),
    ("inbox_take", "Take notes for this session", Effect::Write),
    ("inbox_ack", "Acknowledge delivered notes", Effect::Replace),
    ("next_prompt", "Suggest the next prompt", Effect::Read),
    ("next_prompt_taken", "Record a taken suggestion", Effect::Write),
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
    /// An `inbox_take` that found nothing: the mod polls every few seconds, so logging each
    /// empty poll would fill the call log with nothing.
    quiet: bool,
}

impl Outcome {
    fn ok(response: String) -> Outcome {
        Outcome { response, tool: None, args: None, error: None, code: None, quiet: false }
    }

    fn err(response: String, error: String) -> Outcome {
        Outcome { response, tool: None, args: None, error: Some(error), code: None, quiet: false }
    }

    fn refused(response: String, code: i64, error: String) -> Outcome {
        Outcome {
            response,
            tool: None,
            args: None,
            error: Some(error),
            code: Some(code),
            quiet: false,
        }
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
            attention_host: None,
            inbox_host: None,
            suggest_host: None,
            calendar_sources: None,
            next_prompt_settings: None,
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

    /// Injected by the serving transport — see [`AttentionHost`].
    pub fn with_attention_host(mut self, host: Box<dyn AttentionHost>) -> Dispatcher {
        self.attention_host = Some(host);
        self
    }

    /// Injected by the serving transport — see [`InboxHost`].
    pub fn with_inbox_host(mut self, host: Box<dyn InboxHost>) -> Dispatcher {
        self.inbox_host = Some(host);
        self
    }

    /// Injected by the serving transport — see [`SuggestHost`].
    pub fn with_suggest_host(mut self, host: Box<dyn SuggestHost>) -> Dispatcher {
        self.suggest_host = Some(host);
        self
    }

    /// Test hook — see [`Dispatcher::next_prompt_settings`].
    #[cfg(test)]
    fn with_next_prompt_settings(mut self, settings: tt_config::NextPromptSettings) -> Dispatcher {
        self.next_prompt_settings = Some(settings);
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

        if outcome.quiet {
            return Handled { response: Some(outcome.response), wrote: false, error_code: None };
        }
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
            Ok(value) => {
                let mut ok = Outcome::ok(self.tool_result_response(id, &value));
                ok.quiet = name == "inbox_take" && inbox::is_empty_take(&value);
                ok
            }
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
            "task_sync" => self.task_sync(args),
            "task_delete" => self.task_delete(args),
            "task_done" => self.task_done(args, now_ms),
            "task_start" => self.task_start(args),
            "preview_file" => self.preview_file(args, ctx),
            "file_open" => self.file_open(args, ctx),
            "needs_you" => self.needs_you(ctx),
            "summon" => self.summon(args, ctx),
            "calendar_today" => self.calendar_today(now_ms),
            "calendar_next" => self.calendar_next(now_ms),
            "calendar_set" => self.calendar_set(args, now_ms),
            "inbox_take" => self.inbox_take(now_ms, ctx),
            "inbox_ack" => self.inbox_ack(args, now_ms, ctx),
            "next_prompt" => self.next_prompt(args, now_ms, ctx),
            "next_prompt_taken" => self.next_prompt_taken(args),
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

    /// Re-read the branch the task's worktree is on and record it — the fix after a
    /// `git switch -c` inside the task. Refusals are errors: none has a force to retry with.
    fn task_sync(&self, args: &Value) -> Result<Value, String> {
        let id = args
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| "missing required argument: id".to_string())?;
        let resync =
            tt_tasks::ops::sync_task_branch(&self.store, id, "mcp").map_err(|e| {
                match (&e, e.remedy()) {
                    (tt_tasks::ops::SyncError::Store(tt_store::Error::TaskNotFound(id)), _) => {
                        format!("no task with id {id}")
                    }
                    (_, Some(remedy)) => format!("{e} — {remedy}"),
                    (_, None) => e.to_string(),
                }
            })?;
        let task = self.store.task_by_id(id).map_err(|e| e.to_string())?;
        let mut result = json!(resync);
        result["task"] = json!(task);
        Ok(result)
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
        let text_arg = |key: &str| {
            args.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty())
        };
        let status = args.get("status").and_then(Value::as_str).unwrap_or("backlog");
        let notes = args.get("notes").and_then(Value::as_str);
        let goal = args.get("goal").and_then(Value::as_str);
        let origin = match text_arg("origin") {
            None => "agent",
            Some("park") => "park",
            Some(other) => return Err(format!("unknown origin: {other} (only \"park\")")),
        };

        // Case-insensitive, stamped with the tracked repo's own spelling: `christowles/x` must not
        // mint a second identity beside `ChrisTowles/x` and split one repo across two lanes.
        let (repo_root, repo) = match (text_arg("repo"), text_arg("dir")) {
            (Some(repo_arg), _) => self
                .store
                .tracked_repo_for_owner_repo(repo_arg)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| {
                    let slugs = self.store.repo_slugs().unwrap_or_default();
                    unknown_repo_message(repo_arg, &slugs)
                })?,
            (None, Some(dir)) => self
                .store
                .tracked_repo_for_dir(dir)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("{dir} is in no tracked repo"))?,
            (None, None) => return Err("missing required argument: repo (or dir)".to_string()),
        };

        let task =
            self.store.add_task(title, status, notes, goal, now_ms).map_err(|e| e.to_string())?;
        self.store
            .set_task_worktree(task.id, &repo_root, Some(&repo), None, None)
            .map_err(|e| e.to_string())?;
        let task = self.store.task_by_id(task.id).map_err(|e| e.to_string())?;
        tracing::info!(task_id = task.id, %repo, %status, origin, "task.created");
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

        let req = task_start_request(&task, branch_arg, base)?;
        let branch = req.branch.clone();
        let host =
            self.task_host.as_ref().expect("checked above, before any of the row guards ran");
        host.start_task(req)?;

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

    /// The other sessions waiting on the user, oldest wait first. The caller's own terminal is left
    /// out: it is the one the user is already looking at.
    fn needs_you(&self, ctx: &RequestContext) -> Result<Value, String> {
        let host = self
            .attention_host
            .as_ref()
            .ok_or_else(|| "needs_you is unavailable: no attention host is attached".to_string())?;
        let mut waiting: Vec<WaitingSession> = host
            .needs_you()
            .into_iter()
            .filter(|s| ctx.session.as_deref() != Some(s.session.as_str()))
            .collect();
        waiting.sort_by_key(|s| s.since_ms);
        let sessions: Vec<Value> = waiting
            .into_iter()
            .map(|s| {
                json!({
                    "session": s.session,
                    "name": s.name,
                    "repo": s.repo,
                    "dir": s.dir,
                    "reason": s.reason,
                    "sinceMs": s.since_ms,
                })
            })
            .collect();
        Ok(json!({ "sessions": sessions }))
    }

    /// Chime until the user answers the caller's terminal — see [`AttentionHost::summon`].
    fn summon(&self, args: &Value, ctx: &RequestContext) -> Result<Value, String> {
        let reason = args
            .get("reason")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .ok_or_else(|| "missing required argument: reason".to_string())?;
        let host = self
            .attention_host
            .as_ref()
            .ok_or_else(|| "summon is unavailable: no attention host is attached".to_string())?;
        let max_minutes = match args.get("max_minutes") {
            None | Some(Value::Null) => SUMMON_DEFAULT_MINUTES,
            Some(v) => v
                .as_u64()
                .ok_or_else(|| "max_minutes must be a positive integer".to_string())?
                .clamp(1, u64::from(SUMMON_MAX_MINUTES)) as u32,
        };
        host.summon(SummonRequest {
            reason: reason.chars().take(SUMMON_REASON_MAX_CHARS).collect(),
            session: ctx.session.clone(),
            max_minutes,
        })?;
        Ok(json!({ "status": "summoning", "session": ctx.session, "maxMinutes": max_minutes }))
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

    /// `/done` as one call, so finishing a task is code rather than an agent's reading of a
    /// procedure: the task comes from the caller's checkout (closed rows included — a merge
    /// closes the card while the worktree lives on), the gate reads git and `gh` live, and
    /// the summary lands before the delete removes the caller's own pane.
    fn task_done(&mut self, args: &Value, now_ms: i64) -> Result<Value, String> {
        let dir = args
            .get("dir")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .ok_or_else(|| "missing required argument: dir".to_string())?;
        let summary = args
            .get("summary")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "missing required argument: summary".to_string())?;
        if self.task_host.is_none() {
            return Err("task_done is unavailable: no task host is attached".to_string());
        }
        let task = self.task_for_checkout(dir)?;
        let id = task.id;

        let worktree = task.worktree.as_ref().and_then(|w| w.dir.as_deref()).map(Path::new);
        let mut messages = Vec::new();
        if let Some(worktree) = worktree.filter(|w| w.is_dir()) {
            let branch = tt_tasks::ops::head_branch(worktree)
                .ok_or_else(|| format!("{} is on no branch", worktree.display()))?;
            let (blockers, notes) = tt_tasks::ops::finish_blockers(worktree, &branch);
            messages.extend(notes);
            if !blockers.is_empty() {
                return Ok(json!({
                    "status": "refused",
                    "id": id,
                    "text": task.text,
                    "blockers": blockers,
                    "messages": messages,
                }));
            }
            messages.extend(tt_tasks::ops::stop_own_listeners(worktree)?);
        }

        self.store.set_task_summary(id, summary, now_ms).map_err(|e| e.to_string())?;
        let host = self.task_host.as_ref().expect("checked above, before the task was resolved");
        let deletion = host.delete_task(id, false, Some(tt_store::TaskOutcome::Done))?;
        Ok(match deletion {
            TaskDeletion::Deleted { name, messages: more } => {
                messages.extend(more);
                json!({ "status": "deleted", "id": id, "text": name, "messages": messages })
            }
            TaskDeletion::Refused { name, blockers, messages: more } => {
                messages.extend(more);
                json!({
                    "status": "refused",
                    "id": id,
                    "text": name,
                    "blockers": blockers,
                    "messages": messages,
                })
            }
        })
    }

    /// The board task bound to the checkout containing `dir`. Walks up, since a session's cwd
    /// can sit below its worktree root; a main checkout matches nothing, which is the answer.
    fn task_for_checkout(&self, dir: &str) -> Result<tt_store::TaskItem, String> {
        let given = Path::new(dir);
        if !given.is_absolute() {
            return Err(format!("dir must be an absolute path, got {dir:?}"));
        }
        let canonical = std::fs::canonicalize(given).ok();
        for start in std::iter::once(given).chain(canonical.as_deref()) {
            for candidate in start.ancestors() {
                let key = candidate.to_string_lossy();
                if let Some(task) =
                    self.store.task_for_worktree_dir(&key).map_err(|e| e.to_string())?
                {
                    return Ok(task);
                }
            }
        }
        Err(format!(
            "no board task is bound to {dir} — this is a main checkout or a worktree the board \
             never tracked, so there is no task to finish here"
        ))
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
/// The guards and derivations `task_start` applies, shared with the app's queue
/// "Start" so both refuse and name branches identically.
pub fn task_start_request(
    task: &tt_store::TaskItem,
    branch_arg: Option<&str>,
    base: Option<String>,
) -> Result<TaskStartRequest, String> {
    let id = task.id;
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
    let prompt = task_start_prompt(task);

    Ok(TaskStartRequest { id, text: task.text.clone(), repo_root, branch, base, prompt })
}

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
                    "dir": { "type": "string", "description": "Instead of `repo`: an absolute directory inside a tracked checkout (a task worktree counts), resolving to that checkout's repo." },
                    "origin": { "type": "string", "enum": ["park"], "description": "Set only by the tt mod's /park command. Leave it out." },
                    "title": { "type": "string", "description": "The task's title." },
                    "goal": { "type": "string", "description": "Optional objective the task is meant to accomplish, shown on the board card under the title." },
                    "notes": { "type": "string", "description": "Optional free-form context." },
                    "status": { "type": "string", "enum": ["backlog", "doing", "done"], "description": "Column to land in (default backlog)." },
                },
                "required": ["title"],
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
            "name": "task_sync",
            "description": "Re-read the branch a task's worktree is actually on and record it on the task. Call it after you create or switch branches inside a task's worktree (e.g. `git switch -c`), so the board card, PR auto-linking and task_list follow the new branch. Idempotent: `changed: false` means the record already matched. The worktree directory keeps its name. Refuses, with the fix in the message, a detached HEAD, the task's base branch, a worktree that is gone, or a branch another open task already records.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer", "description": "The task's id (from task_list or task_status)." },
                },
                "required": ["id"],
            },
        },
        {
            "name": "task_delete",
            "description": "Close a board task and delete everything bound to it — its terminal panes and its git worktree on disk. The board row itself survives, closed with an outcome (done/abandoned) as the record of the work. Guarded: if the worktree has uncommitted changes, commits that reached no branch or remote, or a foreign process on its claimed ports, nothing is deleted and the reasons come back as `status: \"refused\"`. Report those to the user and let them decide; only pass force after they have said so explicitly, since it destroys that work permanently.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer", "description": "The task's id (from task_list or task_status)." },
                    "outcome": { "type": "string", "enum": ["done", "abandoned"], "description": "How the task ended, recorded on its closed row. Omitted: inferred from the task's own evidence — done if its branch landed or a linked PR merged, else abandoned." },
                    "force": { "type": "boolean", "description": "Skip the guards and delete the worktree anyway, discarding uncommitted changes and unreachable commits for good. Default false." },
                },
                "required": ["id"],
            },
        },
        {
            "name": "task_done",
            "description": "Finish the task whose worktree you are in, as one call: the user has confirmed the work, so record your summary on its card and delete it as done — terminal panes and worktree — keeping the closed row. Finds the task from `dir`, closed cards included (a merged PR closes the card while the worktree lives on). Refuses with `status: \"refused\"` and typed `blockers`, deleting nothing, while a PR from the task's branch is still open, the worktree has uncommitted changes, or the branch has commits that reached the base through no PR. Stops the task's own dev server on its claimed ports first. It removes your own pane, so say everything before calling it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "dir": { "type": "string", "description": "Absolute path of your checkout — `git rev-parse --show-toplevel`." },
                    "summary": { "type": "string", "description": "What shipped, for the card that outlives the worktree: the PR number and merge commit, what CI said, anything still open. A few short lines." },
                },
                "required": ["dir", "summary"],
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
            "name": "needs_you",
            "description": "The other sessions in this app waiting on the human — a question asked, an error, or a finished turn they haven't looked at — oldest wait first. Your own terminal is left out. Each names its session, repo, directory and `reason` (`waitingForInput`, `errored`, `finished`). An empty list means nobody else is blocked on them.",
            "inputSchema": no_args(),
        },
        {
            "name": "summon",
            "description": "Get the human back when you need them to do something only they can: answer a question, approve a step, log in, plug something in. The app plays a chime every few seconds and shows one desktop notification with your `reason`, and keeps chiming until they type into *your* terminal — so end your turn with the question itself, since their answer is what stops it. Stops on its own after `max_minutes`, or if your terminal closes; calling again replaces your previous summon. Outside an app terminal (no session), input to any app terminal stops it. Don't use it for progress updates or anything that can wait — it is meant to interrupt. Returns `status: \"summoning\"` at once; it does not wait for them.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "reason": { "type": "string", "description": "What you need them to do, in one short line — shown in the notification. Truncated at 200 characters." },
                    "max_minutes": { "type": "integer", "description": "Stop chiming after this many minutes if they never answer. Default 15, clamped to 1–60." },
                },
                "required": ["reason"],
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
        {
            "name": "inbox_take",
            "description": "For the towles-tool Claude mod only; agents never call it. Leases the notes the user sent this session from the app, so the mod can hand them to the model. Answers `pollMs: 0` outside an app terminal.",
            "inputSchema": no_args(),
        },
        {
            "name": "inbox_ack",
            "description": "For the towles-tool Claude mod only; agents never call it. Marks leased notes delivered and how.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "ids": { "type": "array", "items": { "type": "integer" }, "description": "The delivered notes' ids, at most 50." },
                    "how": { "type": "string", "enum": ["midTurn", "prompt"], "description": "Read at the agent's next step, or submitted as a prompt." },
                },
                "required": ["ids", "how"],
            },
        },
        {
            "name": "next_prompt",
            "description": "For the towles-tool Claude mod only; agents never call it. Asks one context-free model question for what the user will type next, within their daily budget.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tools": { "type": "array", "items": { "type": "string" }, "description": "Tools the last turn used." },
                    "commands": { "type": "array", "items": { "type": "string" }, "description": "Bash commands the last turn ran." },
                    "answer": { "type": "string", "description": "The agent's last message." },
                    "taskId": { "type": "integer", "description": "The session's board task, for its goal." },
                },
                "required": ["tools", "commands", "answer"],
            },
        },
        {
            "name": "next_prompt_taken",
            "description": "For the towles-tool Claude mod only; agents never call it. Records that the user submitted the suggested prompt.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "edited": { "type": "boolean", "description": "Whether they changed it before sending." },
                },
                "required": ["edited"],
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
mod tests;
