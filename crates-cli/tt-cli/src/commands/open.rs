//! `tt open <PATH>` — put a file or folder on screen in the app's Files pane,
//! in the task the caller is sitting in.
//!
//! A client, not an editor launcher: it POSTs the `file_open` MCP tool call to
//! the app instance serving this checkout, with the same `X-TT-Session` routing
//! an agent's own `file_open` uses (`tt-mcp`'s `EditorHost`, `tt-app`'s
//! `mcp_http`). The root CLAUDE.md has the why; two things it doesn't say:
//!
//! - **`TT_SESSION_ID` is what routes.** Every shell the app spawns has it, so
//!   `tt open` in a task's terminal opens in that task. Run from a plain
//!   terminal there is nothing to route on and the app falls back to matching
//!   the path against its folders — usually right for a file, which is why the
//!   fallback is acceptable here and not in `preview_show`.
//! - **A path under no git repository is refused here, not in the app.** The
//!   Files pane browses a checkout, so a path outside every one has no pane to
//!   appear in; failing at the CLI names the problem instead of surfacing as a
//!   toast in a window that may not be on screen.

use crate::ui;
use std::path::Path;
use std::time::Duration;

/// How long to wait on the app. Generous for loopback because the dispatcher
/// holds one mutex across a call, so a `file_open` can queue behind another
/// tool's work — but bounded, since a wedged app must not hang a CLI.
const CALL_TIMEOUT: Duration = Duration::from_secs(10);

pub fn run(path: &Path, line: Option<u32>) -> i32 {
    let target = match std::fs::canonicalize(path) {
        Ok(p) => p,
        Err(e) => {
            ui::error(&format!("Cannot open '{}': {e}", path.display()));
            return 1;
        }
    };

    // The pane can only browse a checkout, so a path in none of them can't be
    // shown. Checked before dialing the app: this is the caller's mistake, and it
    // is answerable without one.
    if tt_git::repo::discover_root(&target).is_none() {
        ui::error(&format!(
            "{} is not inside a git repository — the app's file pane browses a checkout, so \
             there's nowhere to open it",
            target.display()
        ));
        return 1;
    }

    let port = tt_mcp::port::for_this_checkout();
    let session = std::env::var("TT_SESSION_ID").ok().filter(|s| !s.trim().is_empty());
    match call_file_open(port, &target.to_string_lossy(), line, session.as_deref()) {
        Ok(()) => {
            ui::success(&format!("Opening {} in the app", target.display()));
            0
        }
        Err(e) => {
            ui::error(&e);
            1
        }
    }
}

/// POST one `tools/call` for `file_open` and flatten the answer to `Ok`/message.
///
/// Hand-rolled rather than an MCP client: the dispatcher answers a `tools/call`
/// with no `initialize` handshake, and the transport's admission rules (no
/// `Origin`, JSON `Content-Type`) hold by construction here.
fn call_file_open(
    port: u16,
    path: &str,
    line: Option<u32>,
    session: Option<&str>,
) -> Result<(), String> {
    let mut arguments = serde_json::json!({ "path": path });
    if let Some(line) = line {
        arguments["line"] = serde_json::json!(line);
    }
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": { "name": "file_open", "arguments": arguments },
    });

    let agent = ureq::AgentBuilder::new().timeout(CALL_TIMEOUT).build();
    let mut request =
        agent.post(&format!("http://127.0.0.1:{port}/mcp")).set("Content-Type", "application/json");
    if let Some(session) = session {
        request = request.set("X-TT-Session", session);
    }

    let response = match request.send_json(body) {
        Ok(response) => response,
        Err(ureq::Error::Status(status, _)) => {
            return Err(format!("the app refused the request (HTTP {status}) on port {port}"));
        }
        Err(ureq::Error::Transport(e)) => {
            return Err(format!(
                "no towles-tool app is serving on 127.0.0.1:{port} — open the app for this \
                 checkout ({e})"
            ));
        }
    };
    let answer: serde_json::Value =
        response.into_json().map_err(|e| format!("unreadable answer from the app: {e}"))?;

    // Two failure shapes: a JSON-RPC error (bad request) and an `isError` tool
    // result (the tool ran and refused — a path the app can't show). Both are
    // the user's answer, so neither may pass as success.
    if let Some(message) = answer.pointer("/error/message").and_then(|m| m.as_str()) {
        return Err(message.to_string());
    }
    if answer.pointer("/result/isError").and_then(serde_json::Value::as_bool) == Some(true) {
        let detail = answer
            .pointer("/result/content/0/text")
            .and_then(|t| t.as_str())
            .unwrap_or("the app refused to open it");
        return Err(detail.to_string());
    }
    Ok(())
}

/// Split a `<path>:<line>` operand, the spelling every compiler, grep and stack
/// trace prints. A trailing `:<n>` counts only when the rest of the operand
/// actually exists on disk — a file whose name genuinely ends in `:12` (legal on
/// Linux) then still opens, and `--line` stays available either way.
pub fn split_line_suffix(operand: &str) -> (&str, Option<u32>) {
    let Some((head, tail)) = operand.rsplit_once(':') else {
        return (operand, None);
    };
    let Ok(line) = tail.parse::<u32>() else {
        return (operand, None);
    };
    if line == 0 || Path::new(operand).exists() || !Path::new(head).exists() {
        return (operand, None);
    }
    (head, Some(line))
}

#[cfg(test)]
mod tests {
    use super::split_line_suffix;

    #[test]
    fn a_plain_path_has_no_line() {
        assert_eq!(split_line_suffix("src/main.rs"), ("src/main.rs", None));
    }

    #[test]
    fn a_line_suffix_is_split_off_when_the_file_exists() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("main.rs");
        std::fs::write(&file, "fn main() {}").unwrap();
        let operand = format!("{}:42", file.display());
        assert_eq!(split_line_suffix(&operand), (file.to_str().unwrap(), Some(42)));
    }

    /// Nothing to split when the head isn't a real path — the whole operand is
    /// the path, and canonicalize gets to produce the error message.
    #[test]
    fn a_colon_in_a_name_is_not_a_line() {
        assert_eq!(split_line_suffix("/nope/gone.rs:42"), ("/nope/gone.rs:42", None));
    }

    /// A file that really is named `notes:12` wins over the line reading.
    #[test]
    fn an_existing_path_ending_in_a_number_stays_whole() {
        let dir = tempfile::tempdir().unwrap();
        let odd = dir.path().join("notes:12");
        std::fs::write(&odd, "hi").unwrap();
        std::fs::write(dir.path().join("notes"), "hi").unwrap();
        let operand = odd.to_string_lossy().into_owned();
        assert_eq!(split_line_suffix(&operand), (operand.as_str(), None));
    }
}
