//! Claude Code IDE-protocol core: the towles-tool app poses as an "IDE" that
//! Claude Code CLI sessions connect to, so a session knows which checkout it is
//! in and can pull that folder's diagnostics (see `docs/CLAUDE-CODE-IDE.md`).
//!
//! The protocol is MCP (JSON-RPC 2.0) over a WebSocket the IDE hosts,
//! advertised by a `~/.claude/ide/<port>.lock` file. This crate is the
//! transport-free half: lockfile schema + lifecycle, the request dispatcher
//! ([`handle_message`]), and the notification frame the IDE pushes
//! ([`diagnostics::diagnostics_changed_frame`]). Sockets, tokens and clocks
//! live in the app shell, which passes state in per call.

use std::path::PathBuf;

use serde_json::{Value, json};

pub mod diagnostics;
pub mod lockfile;

pub use lockfile::Lockfile;

/// Protocol version echoed back when the client doesn't send one (matches
/// tt-mcp's default).
const DEFAULT_PROTOCOL_VERSION: &str = "2025-06-18";

/// Per-message snapshot of the server's world, passed in by the transport:
/// the dispatcher itself is stateless so tests can drive it directly.
#[derive(Debug, Clone)]
pub struct ServerContext {
    /// Shown to the CLI as the server name (e.g. "Towles Tool").
    pub ide_name: String,
    /// The single workspace folder this server roots (the terminal's cwd).
    pub workspace_folder: PathBuf,
    /// Current compiler diagnostics for this folder, already in the
    /// `getDiagnostics` wire shape (`[{uri, diagnostics: [...]}]`, see
    /// [`diagnostics::to_wire`]). Empty array when no check has run.
    pub diagnostics: Value,
}

/// Handle one incoming JSON-RPC message from the CLI. Returns the response to
/// send back, or `None` for notifications (which get no response).
pub fn handle_message(message: &str, ctx: &ServerContext) -> Option<String> {
    let value: Value = match serde_json::from_str(message) {
        Ok(value) => value,
        Err(_) => return Some(error_response(Value::Null, -32700, "Parse error")),
    };
    if value.is_array() {
        return Some(error_response(Value::Null, -32600, "Invalid Request"));
    }

    // Requests carry an `id`; notifications (`notifications/initialized`, …)
    // do not and receive no response.
    let id = match value.get("id") {
        Some(id) if !id.is_null() => id.clone(),
        _ => return None,
    };
    let method = match value.get("method").and_then(Value::as_str) {
        Some(method) => method,
        None => return Some(error_response(id, -32600, "Invalid Request")),
    };

    let response = match method {
        "initialize" => success_response(id, initialize_result(&value, ctx)),
        "ping" => success_response(id, json!({})),
        "tools/list" => success_response(id, json!({ "tools": tool_definitions() })),
        "tools/call" => tools_call(id, &value, ctx),
        _ => error_response(id, -32601, "Method not found"),
    };
    Some(response)
}

fn initialize_result(request: &Value, ctx: &ServerContext) -> Value {
    let requested = request
        .pointer("/params/protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_PROTOCOL_VERSION);
    json!({
        "protocolVersion": requested,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": ctx.ide_name, "version": env!("CARGO_PKG_VERSION") },
    })
}

fn tools_call(id: Value, request: &Value, ctx: &ServerContext) -> String {
    let params = request.get("params");
    let Some(name) = params.and_then(|p| p.get("name")).and_then(Value::as_str) else {
        return tool_error_response(id, "tools/call is missing the tool name");
    };
    let args = params.and_then(|p| p.get("arguments")).cloned().unwrap_or_else(|| json!({}));
    let result = match name {
        "getWorkspaceFolders" => workspace_folders(ctx),
        "getDiagnostics" => diagnostics_for(ctx, &args),
        // openFile has app-side effects; the shell intercepts it before this
        // dispatcher (see the app's ide.rs). Reaching here is a wiring bug.
        _ => return tool_error_response(id, &format!("Unknown tool: {name}")),
    };
    tool_result_response(id, &result)
}

fn workspace_folders(ctx: &ServerContext) -> Value {
    let path = ctx.workspace_folder.to_string_lossy();
    let name = ctx
        .workspace_folder
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone().into_owned());
    json!({
        "success": true,
        "folders": [{ "name": name, "uri": format!("file://{path}"), "path": path }],
    })
}

/// `getDiagnostics`: the folder's cached compiler diagnostics, optionally
/// narrowed to one file when the CLI passes `uri`.
fn diagnostics_for(ctx: &ServerContext, args: &Value) -> Value {
    let all = ctx.diagnostics.as_array().cloned().unwrap_or_default();
    match args.get("uri").and_then(Value::as_str) {
        Some(uri) => Value::Array(
            all.into_iter()
                .filter(|entry| entry.get("uri").and_then(Value::as_str) == Some(uri))
                .collect(),
        ),
        None => Value::Array(all),
    }
}

/// Tool definitions advertised in `tools/list`. Only what the app actually
/// implements — the CLI never calls tools that aren't listed, and degrades
/// gracefully without them: no `openDiff` means it reviews edits in the
/// terminal, and no selection tools mean no editor-selection context.
fn tool_definitions() -> Value {
    let empty_object = json!({ "type": "object", "properties": {}, "additionalProperties": false });
    json!([
        {
            "name": "getWorkspaceFolders",
            "description": "Get all workspace folders currently open in the IDE",
            "inputSchema": empty_object,
        },
        {
            "name": "getDiagnostics",
            "description": "Get language diagnostics from the IDE",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "uri": { "type": "string", "description": "Optional file URI to get diagnostics for. If not provided, gets diagnostics for all files." }
                },
                "additionalProperties": false,
            },
        },
        {
            "name": "openFile",
            "description": "Open a file in the IDE and optionally select a range of text",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "filePath": { "type": "string", "description": "Path to the file to open" },
                    "preview": { "type": "boolean" },
                    "startText": { "type": "string", "description": "Text pattern where the selection starts" },
                    "endText": { "type": "string", "description": "Text pattern where the selection ends" },
                    "selectToEndOfLine": { "type": "boolean" },
                    "makeFrontmost": { "type": "boolean" }
                },
                "required": ["filePath"],
                "additionalProperties": false,
            },
        },
    ])
}

// JSON-RPC response builders (same shapes as tt-mcp's).

fn success_response(id: Value, result: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

fn error_response(id: Value, code: i64, message: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string()
}

/// MCP tool result: the payload rides as a JSON string inside a text content
/// block (how the VS Code extension answers every tool). Public so the app
/// shell can answer the tools it intercepts (openFile) in the same shape.
pub fn tool_result_response(id: Value, result: &Value) -> String {
    let text = result.to_string();
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": { "content": [{ "type": "text", "text": text }] },
    })
    .to_string()
}

fn tool_error_response(id: Value, message: &str) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": { "content": [{ "type": "text", "text": message }], "isError": true },
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> ServerContext {
        ServerContext {
            ide_name: "Towles Tool".to_string(),
            workspace_folder: PathBuf::from("/repo/slot-a"),
            diagnostics: json!([]),
        }
    }

    fn call(ctx: &ServerContext, tool: &str) -> Value {
        let request = json!({
            "jsonrpc": "2.0", "id": 7, "method": "tools/call",
            "params": { "name": tool, "arguments": {} },
        })
        .to_string();
        let response: Value =
            serde_json::from_str(&handle_message(&request, ctx).expect("response")).unwrap();
        let text = response["result"]["content"][0]["text"].as_str().expect("text content");
        serde_json::from_str(text).expect("tool payload is JSON")
    }

    #[test]
    fn initialize_echoes_protocol_version_and_names_the_ide() {
        let request = json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2024-11-05" },
        })
        .to_string();
        let response: Value =
            serde_json::from_str(&handle_message(&request, &ctx()).unwrap()).unwrap();
        assert_eq!(response["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(response["result"]["serverInfo"]["name"], "Towles Tool");
    }

    #[test]
    fn notifications_get_no_response() {
        let note = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string();
        assert_eq!(handle_message(&note, &ctx()), None);
    }

    #[test]
    fn unknown_method_is_a_json_rpc_error() {
        let request = json!({ "jsonrpc": "2.0", "id": 2, "method": "resources/list" }).to_string();
        let response: Value =
            serde_json::from_str(&handle_message(&request, &ctx()).unwrap()).unwrap();
        assert_eq!(response["error"]["code"], -32601);
    }

    #[test]
    fn tools_list_advertises_only_the_implemented_set() {
        let request = json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" }).to_string();
        let response: Value =
            serde_json::from_str(&handle_message(&request, &ctx()).unwrap()).unwrap();
        let names: Vec<&str> = response["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["getWorkspaceFolders", "getDiagnostics", "openFile"]);
    }

    #[test]
    fn workspace_folders_reports_the_single_root() {
        let folders = call(&ctx(), "getWorkspaceFolders");
        assert_eq!(folders["folders"][0]["name"], "slot-a");
        assert_eq!(folders["folders"][0]["path"], "/repo/slot-a");
        assert_eq!(folders["folders"][0]["uri"], "file:///repo/slot-a");
    }

    #[test]
    fn diagnostics_answer_the_empty_set() {
        let diags = call(&ctx(), "getDiagnostics");
        assert_eq!(diags, json!([]));
    }

    #[test]
    fn diagnostics_filter_by_uri_when_requested() {
        let mut ctx = ctx();
        ctx.diagnostics = json!([
            { "uri": "file:///repo/slot-a/src/a.rs", "diagnostics": [{ "message": "boom" }] },
            { "uri": "file:///repo/slot-a/src/b.rs", "diagnostics": [] },
        ]);

        let all = call(&ctx, "getDiagnostics");
        assert_eq!(all.as_array().unwrap().len(), 2);

        let request = json!({
            "jsonrpc": "2.0", "id": 9, "method": "tools/call",
            "params": { "name": "getDiagnostics",
                        "arguments": { "uri": "file:///repo/slot-a/src/a.rs" } },
        })
        .to_string();
        let response: Value =
            serde_json::from_str(&handle_message(&request, &ctx).unwrap()).unwrap();
        let text = response["result"]["content"][0]["text"].as_str().unwrap();
        let filtered: Value = serde_json::from_str(text).unwrap();
        assert_eq!(filtered.as_array().unwrap().len(), 1);
        assert_eq!(filtered[0]["uri"], "file:///repo/slot-a/src/a.rs");
    }

    #[test]
    fn malformed_json_and_batches_are_rejected() {
        let parse: Value = serde_json::from_str(&handle_message("{nope", &ctx()).unwrap()).unwrap();
        assert_eq!(parse["error"]["code"], -32700);
        let batch: Value = serde_json::from_str(&handle_message("[]", &ctx()).unwrap()).unwrap();
        assert_eq!(batch["error"]["code"], -32600);
    }
}
