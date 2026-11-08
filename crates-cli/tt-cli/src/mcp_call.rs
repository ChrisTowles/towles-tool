//! One `tools/call` against the app's MCP endpoint — the CLI is only ever its client.
//! Hand-rolled rather than an MCP client: 2026-07-28 has no handshake, so one request
//! carrying its `_meta` and mirrored headers is the whole exchange.

use serde_json::Value;
use std::time::Duration;

pub enum CallError {
    /// Nothing answered on the port: no app is running for this checkout.
    NoApp(String),
    /// The app answered and said no; the message is the user's to read.
    Failed(String),
}

/// POST `name(arguments)` to the app on `port` and return the tool's structured result.
/// `session` is the caller's `TT_SESSION_ID`, which routes pane-opening tools.
pub fn call_tool(
    port: u16,
    name: &str,
    arguments: Value,
    session: Option<&str>,
    timeout: Duration,
) -> Result<Value, CallError> {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": name,
            "arguments": arguments,
            "_meta": {
                tt_mcp::META_PROTOCOL_VERSION: tt_mcp::PROTOCOL_VERSION,
                tt_mcp::META_CLIENT_INFO: { "name": "tt", "version": env!("CARGO_PKG_VERSION") },
                tt_mcp::META_CLIENT_CAPABILITIES: {},
            },
        },
    });

    let agent = ureq::AgentBuilder::new().timeout(timeout).build();
    let mut request = agent
        .post(&format!("http://127.0.0.1:{port}/mcp"))
        .set("Content-Type", "application/json")
        .set("Accept", "application/json, text/event-stream")
        .set(tt_mcp::PROTOCOL_VERSION_HEADER, tt_mcp::PROTOCOL_VERSION)
        .set(tt_mcp::METHOD_HEADER, "tools/call")
        .set(tt_mcp::NAME_HEADER, name);
    if let Some(session) = session {
        request = request.set("X-TT-Session", session);
    }

    let response = match request.send_json(body) {
        Ok(response) => response,
        Err(ureq::Error::Status(status, _)) => {
            return Err(CallError::Failed(format!(
                "the app refused the request (HTTP {status}) on port {port}"
            )));
        }
        Err(ureq::Error::Transport(e)) => {
            return Err(CallError::NoApp(format!(
                "no towles-tool app is serving on 127.0.0.1:{port} — open the app for this \
                 checkout ({e})"
            )));
        }
    };
    let answer: Value = response
        .into_json()
        .map_err(|e| CallError::Failed(format!("unreadable answer from the app: {e}")))?;

    if let Some(message) = answer.pointer("/error/message").and_then(Value::as_str) {
        return Err(CallError::Failed(message.to_string()));
    }
    if answer.pointer("/result/isError").and_then(Value::as_bool) == Some(true) {
        let detail = answer
            .pointer("/result/content/0/text")
            .and_then(Value::as_str)
            .unwrap_or("the app refused the call");
        return Err(CallError::Failed(detail.to_string()));
    }
    Ok(answer.pointer("/result/structuredContent").cloned().unwrap_or(Value::Null))
}
