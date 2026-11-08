//! `tt open <PATH>` — put a file or folder on screen in the app's Files pane,
//! in the task the caller is sitting in.
//! - **`TT_SESSION_ID` is what routes.** Every shell the app spawns has it, so
//!   `tt open` in a task's terminal opens in that task. Run from a plain
//!   terminal there is nothing to route on and the app falls back to matching
//!   the path against its folders — usually right for a file, which is why the
//!   fallback is acceptable here and not in `preview_show`.
//! - **A path under no git repository is refused here, not in the app.** The
//!   Files pane browses a checkout, so a path outside every one has no pane to
//!   appear in; failing at the CLI names the problem instead of surfacing as a
//!   toast in a window that may not be on screen.

use crate::mcp_call::{self, CallError};
use crate::ui;
use std::path::Path;
use std::time::Duration;

const CALL_TIMEOUT: Duration = Duration::from_secs(10);

pub fn run(path: &Path, line: Option<u32>) -> i32 {
    let target = match std::fs::canonicalize(path) {
        Ok(p) => p,
        Err(e) => {
            ui::error(&format!("Cannot open '{}': {e}", path.display()));
            return 1;
        }
    };

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
    match mcp_call::call_tool(port, "file_open", arguments, session, CALL_TIMEOUT) {
        Ok(_) => Ok(()),
        Err(CallError::NoApp(e) | CallError::Failed(e)) => Err(e),
    }
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

    #[test]
    fn a_colon_in_a_name_is_not_a_line() {
        assert_eq!(split_line_suffix("/nope/gone.rs:42"), ("/nope/gone.rs:42", None));
    }

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
