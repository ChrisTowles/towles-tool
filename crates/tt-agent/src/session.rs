//! Owns one `claude` subprocess speaking `stream-json` over stdin/stdout.
//!
//! This is the same mechanism Anthropic's own GUIs use: the VS Code extension
//! and the desktop app both drive the CLI with
//! `--input-format stream-json --output-format stream-json --verbose` through
//! `@anthropic-ai/claude-agent-sdk`, then render the resulting message stream.
//! We skip the Node SDK because the wire format is JSONL over pipes and Rust
//! reads pipes perfectly well — the SDK's value is its TypeScript types, which
//! [`crate::protocol`] replaces with the five shapes we render.
//!
//! Threading mirrors `tt-app`'s terminal host: one reader thread per pipe, and
//! the session handle itself holds no lock across a subprocess call. Events
//! reach the caller through a callback rather than a channel so the app can
//! emit straight to the webview without a second drain loop.
//!
//! **`--print` is required.** Without it the CLI starts its interactive TUI
//! and ignores the stream-json flags entirely; the failure mode is a process
//! that appears healthy and emits nothing.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use crate::protocol::{AgentEvent, encode_user_message, parse_line};

#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("failed to start claude: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("agent session has already exited")]
    Exited,
    #[error("failed to send message to agent: {0}")]
    Write(#[source] std::io::Error),
}

/// How to start a session. Every field maps to a CLI flag; nothing here is
/// interpreted by us.
#[derive(Debug, Clone, Default)]
pub struct AgentOptions {
    pub cwd: PathBuf,
    pub model: Option<String>,
    /// `default` | `acceptEdits` | `bypassPermissions` | `plan`.
    pub permission_mode: Option<String>,
    /// A `session_id` from a previous [`AgentEvent::Init`].
    pub resume: Option<String>,
    pub allowed_tools: Vec<String>,
}

/// Build the argument list. Pure and separated from the spawn so the flag
/// contract — the part that silently breaks when the CLI changes — is
/// testable without running anything.
pub fn build_args(opts: &AgentOptions) -> Vec<String> {
    let mut args: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();

    if let Some(model) = &opts.model {
        args.push("--model".into());
        args.push(model.clone());
    }
    if let Some(mode) = &opts.permission_mode {
        args.push("--permission-mode".into());
        args.push(mode.clone());
    }
    if let Some(session) = &opts.resume {
        args.push("--resume".into());
        args.push(session.clone());
    }
    if !opts.allowed_tools.is_empty() {
        args.push("--allowedTools".into());
        args.extend(opts.allowed_tools.iter().cloned());
    }
    args
}

/// A running agent. Dropping the handle does not kill the process — call
/// [`AgentSession::kill`]; the app ties that to closing the pane.
pub struct AgentSession {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
}

impl AgentSession {
    /// Start `claude` in `opts.cwd` and stream its events to `on_event`.
    ///
    /// `on_event` is called from reader threads, in wire order, and receives a
    /// final [`AgentEvent::Exited`] exactly once.
    pub fn spawn<F>(opts: &AgentOptions, on_event: F) -> Result<Self, AgentError>
    where
        F: Fn(AgentEvent) + Send + Sync + 'static,
    {
        let args = build_args(opts);
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        // The agent outlives this call and has no exit code to wait on here,
        // so it takes the detached-spawn path of the telemetry contract.
        tt_exec::record_detached_spawn("claude", &arg_refs, "agent");

        let mut child = Command::new("claude")
            .args(&args)
            .current_dir(cwd_or_home(&opts.cwd))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(AgentError::Spawn)?;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stdin = child.stdin.take();
        let child = Arc::new(Mutex::new(child));

        let on_event = Arc::new(on_event);

        if let Some(stdout) = stdout {
            let on_event = Arc::clone(&on_event);
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    for event in parse_line(&line) {
                        on_event(event);
                    }
                }
            });
        }

        // Drain stderr so a chatty diagnostic can never fill the pipe buffer
        // and wedge the agent. It is logged, not surfaced: stdout is the
        // protocol, stderr is debug output.
        if let Some(stderr) = stderr {
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    tracing::debug!(target: "tt_agent::stderr", "{line}");
                }
            });
        }

        // A waiter thread turns process exit into the feed's last event, so
        // the UI learns about a crash the same way it learns about output.
        {
            let child = Arc::clone(&child);
            let on_event = Arc::clone(&on_event);
            std::thread::spawn(move || {
                let code = loop {
                    // Never hold the lock across the sleep — `kill` and `send`
                    // both need it while the agent is running.
                    let status = child.lock().ok().and_then(|mut c| c.try_wait().ok().flatten());
                    if let Some(status) = status {
                        break status.code();
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                };
                on_event(AgentEvent::Exited { code });
            });
        }

        Ok(Self { child, stdin: Arc::new(Mutex::new(stdin)) })
    }

    /// Send a user turn. Returns [`AgentError::Exited`] once stdin is gone,
    /// so a write to a dead agent is a value the caller must handle rather
    /// than a silent no-op.
    pub fn send(&self, text: &str) -> Result<(), AgentError> {
        let mut guard = self.stdin.lock().map_err(|_| AgentError::Exited)?;
        let stdin = guard.as_mut().ok_or(AgentError::Exited)?;
        stdin
            .write_all(format!("{}\n", encode_user_message(text)).as_bytes())
            .and_then(|()| stdin.flush())
            .map_err(AgentError::Write)
    }

    /// Kill the agent. Idempotent — killing an already-dead process is fine,
    /// which matters because the pane close path cannot know whether the
    /// waiter thread got there first.
    pub fn kill(&self) {
        // Drop stdin first: the CLI exits cleanly on EOF, so this is the
        // graceful half and the kill below is the backstop.
        if let Ok(mut guard) = self.stdin.lock() {
            guard.take();
        }
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// An empty or missing cwd would make `claude` inherit the app's own working
/// directory, silently rooting the agent in the wrong repo.
fn cwd_or_home(cwd: &Path) -> PathBuf {
    if cwd.is_dir() {
        return cwd.to_path_buf();
    }
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn always_requests_bidirectional_stream_json() {
        let args = build_args(&AgentOptions::default());
        // Without --print the CLI launches its TUI and ignores these flags,
        // producing a live process that emits nothing.
        assert!(args.contains(&"-p".to_string()));
        let joined = args.join(" ");
        assert!(joined.contains("--input-format stream-json"));
        assert!(joined.contains("--output-format stream-json"));
        // --verbose is what makes stream-json emit per-message events rather
        // than only a final result.
        assert!(args.contains(&"--verbose".to_string()));
    }

    #[test]
    fn optional_flags_are_omitted_when_unset() {
        let args = build_args(&AgentOptions::default());
        for flag in ["--model", "--permission-mode", "--resume", "--allowedTools"] {
            assert!(!args.contains(&flag.to_string()), "{flag} should not appear unset");
        }
    }

    #[test]
    fn options_map_to_their_flags() {
        let args = build_args(&AgentOptions {
            cwd: PathBuf::from("/tmp"),
            model: Some("claude-haiku-4-5-20251001".into()),
            permission_mode: Some("acceptEdits".into()),
            resume: Some("sess-123".into()),
            allowed_tools: vec!["Read".into(), "Grep".into()],
        });
        let joined = args.join(" ");
        assert!(joined.contains("--model claude-haiku-4-5-20251001"));
        assert!(joined.contains("--permission-mode acceptEdits"));
        assert!(joined.contains("--resume sess-123"));
        assert!(joined.contains("--allowedTools Read Grep"));
    }

    #[test]
    fn a_missing_cwd_falls_back_rather_than_inheriting_ours() {
        let fallback = cwd_or_home(Path::new("/definitely/not/a/real/dir"));
        assert_ne!(fallback, PathBuf::from("/definitely/not/a/real/dir"));
        assert_eq!(cwd_or_home(Path::new("/tmp")), PathBuf::from("/tmp"));
    }
}
