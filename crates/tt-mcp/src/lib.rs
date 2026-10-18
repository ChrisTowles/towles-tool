//! A Model Context Protocol (MCP) server for towles-tool — **the transport-free
//! half**. [`Dispatcher::dispatch_at`] takes one JSON-RPC request string and returns
//! one response string, knowing nothing about sockets, HTTP, ports or the wall clock.
//!
//! Speaks **MCP 2026-07-28 only** — no `initialize` handshake, no session: every request
//! carries its version and the caller's identity in `params._meta`, `server/discover`
//! says so up front, and a client opening with `initialize` is refused by an error
//! naming the version, all the spec asks of a modern-only server.
//!
//! No capability gate on writes: they are local and reversible. The transport's
//! admission checks guard against a web page POSTing to `127.0.0.1`.

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::time::Instant;

use chrono::{Local, NaiveDate, TimeZone};

mod calendar_tools;
mod clip_gate;
mod hosts;
mod inbox;
mod output;
mod pane_tools;
pub mod port;
mod protocol;
mod suggest;
mod task_tools;
mod tool_defs;

pub use hosts::*;
use protocol::*;
pub use task_tools::task_start_request;
pub use tool_defs::tool_definitions;

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
    /// Test hook: keeps `clip_suggest` off the real settings file.
    clip_settings: Option<tt_config::ClipSuggestSettings>,
    /// In memory only: a restart gives every session a fresh three offers.
    clip_backoff: clip_gate::Backoff,
}

/// What the transport knows that the body cannot say: the caller's app terminal (`X-TT-Session`).
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

/// The tools whose success means the transport must repaint — not [`Effect`]'s `readOnlyHint`.
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

/// Writing tools that repaint the UI themselves, so the transport must not.
const SELF_REFRESHING_TOOLS: &[&str] = &["task_delete", "task_done"];

/// What a tool does to the world, as the four `annotations` hints. Every tool states all
/// four, since an omitted hint reads as the risky answer.
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
    ("task_diff", "Sibling task changes", Effect::Read),
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
    ("clip_suggest", "Suggest what to copy", Effect::Read),
    ("clip_copied", "Record a copied offer", Effect::Write),
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
    /// An `inbox_take` that found nothing, kept out of the call log.
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
            clip_settings: None,
            clip_backoff: clip_gate::Backoff::default(),
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

    /// Test hook — see [`Dispatcher::clip_settings`].
    #[cfg(test)]
    fn with_clip_settings(mut self, settings: tt_config::ClipSuggestSettings) -> Dispatcher {
        self.clip_settings = Some(settings);
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

    /// A tool that refused answers `isError`; an unknown tool is a protocol error (`-32602`).
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
            "task_diff" => self.task_diff(args),
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
            "clip_suggest" => self.clip_suggest(args, now_ms, ctx),
            "clip_copied" => self.clip_copied(args, ctx),
            _ => return Err(ToolError::Unknown),
        };
        result.map_err(ToolError::Failed)
    }
}

use tt_config::now_ms;

#[cfg(test)]
mod tests;
