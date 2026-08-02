//! Thin process-execution wrapper for the towles-tool CLI.
//!
//! Ports `src/lib/git/exec.ts` from the TypeScript CLI: [`run`] captures
//! stdout/stderr/exit-code without failing, and the [`run_with_timeout`]
//! family does the same with a cap on how long a child may hang.
//!
//! [`claude`] is the third tool-shaped helper: the one way this workspace asks
//! `claude -p` for a machine-readable answer, via the CLI's own structured-output
//! guarantee.

pub mod claude;

use std::process::Command;
use std::time::Duration;
use thiserror::Error;

/// Env-var name prefixes identifying the running app instance, which must not
/// leak into a process spawned inside it. A shell that starts a *nested* app
/// instance must re-derive its own port and session identity; inheriting the
/// parent's collides on its port and mis-attributes to its session (#39).
pub const APP_INSTANCE_ENV_PREFIXES: &[&str] = &["TT_", "TAURI_", "npm_"];

/// Env vars that stamp a process as living *inside* a Claude Code session. With
/// `CLAUDE_CODE_CHILD_SESSION=1` present, Claude Code treats the session as a
/// nested child and never writes its transcript to `~/.claude/projects/`, so it
/// is unrecoverable once the window dies. The app's terminals host top-level
/// user sessions, so the whole identity set is dropped.
pub const CLAUDE_SESSION_ENV_VARS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SSE_PORT",
    "AI_AGENT",
];

/// Whether `key` names an env var a spawned process must not inherit.
pub fn is_app_instance_env(key: &str) -> bool {
    APP_INSTANCE_ENV_PREFIXES.iter().any(|prefix| key.starts_with(prefix))
        || CLAUDE_SESSION_ENV_VARS.contains(&key)
}

/// Pure and order-preserving; the caller applies the result to the child.
/// Everything [`is_app_instance_env`] doesn't match survives.
pub fn scrub_app_instance_env<I, K, V>(env: I) -> Vec<(K, V)>
where
    I: IntoIterator<Item = (K, V)>,
    K: AsRef<str>,
{
    env.into_iter().filter(|(key, _)| !is_app_instance_env(key.as_ref())).collect()
}

#[derive(Debug, Error)]
pub enum Error {
    #[error("Failed to spawn `{cmd}`: {source}")]
    Spawn { cmd: String, source: std::io::Error },

    #[error("Command failed (exit {exit_code}): {cmd}\n{stderr}")]
    NonZeroExit {
        cmd: String,
        exit_code: i32,
        stderr: String,
    },

    #[error("Command timed out after {timeout:?}: {cmd}")]
    Timeout { cmd: String, timeout: Duration },

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Makes `git` fail fast instead of blocking on an interactive credential/SSH
/// prompt — which can pop a GUI dialog *behind* the app window, stalling the
/// caller for the full timeout instead of failing with a clear error.
pub const GIT_NON_INTERACTIVE_ENV: &[(&str, &str)] = &[
    ("GIT_TERMINAL_PROMPT", "0"),
    ("GIT_SSH_COMMAND", "ssh -o BatchMode=yes -o ConnectTimeout=10"),
];

/// Captured output of a finished process.
#[derive(Debug, Clone)]
pub struct Output {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

impl Output {
    pub fn ok(&self) -> bool {
        self.exit_code == 0
    }
}

fn display_cmd(cmd: &str, args: &[&str]) -> String {
    if args.is_empty() { cmd.to_string() } else { format!("{cmd} {}", args.join(" ")) }
}

/// Every process this crate spawns goes through here, which makes the event log
/// a complete record of what the tool shelled out to with no per-call-site
/// instrumentation. Only argv is recorded, never stdin or captured output:
/// stdin carries things like PR bodies, stdout is unbounded, and argv holds no
/// credentials — tokens travel via settings and env, not flags.
fn spawn_span(
    cmd: &str,
    args: &[&str],
    dir: Option<&std::path::Path>,
    timeout: Option<Duration>,
) -> tracing::Span {
    tracing::debug_span!(
        "process.spawn",
        "process.executable.name" = cmd,
        "process.command_args" = args.join(" "),
        "process.working_directory" = dir.map(|d| d.display().to_string()).unwrap_or_default(),
        timeout_ms = timeout.map(|t| t.as_millis() as u64),
        exit_code = tracing::field::Empty,
        outcome = tracing::field::Empty,
        stdin_bytes = tracing::field::Empty,
    )
}

/// Close out a span for a process that ran to completion.
fn record_exit(span: &tracing::Span, exit_code: i32) {
    span.record("exit_code", exit_code);
    span.record("outcome", if exit_code == 0 { "ok" } else { "non_zero_exit" });
}

/// The single home for the failure vocabulary, so adding an outcome or renaming
/// the field is one edit rather than one per spawn site.
fn spawn_error(span: &tracing::Span, outcome: &str, cmd: &str, source: std::io::Error) -> Error {
    span.record("outcome", outcome);
    Error::Spawn { cmd: cmd.to_string(), source }
}

/// Record a process this crate does *not* run to completion: a PTY shell, a
/// language server, a detached editor. No exit code to wait for, so a single
/// event rather than a span — but it still belongs in the event log, which is
/// what makes "what did the app launch?" answerable. `kind` names the shape.
pub fn record_detached_spawn(cmd: &str, args: &[&str], kind: &str) {
    tracing::debug!(
        "process.executable.name" = cmd,
        "process.command_args" = args.join(" "),
        outcome = "detached",
        launch_kind = kind,
        "spawned detached process"
    );
}

/// Run a command, capturing output. Does not fail on a non-zero exit code.
pub fn run(cmd: &str, args: &[&str]) -> Result<Output> {
    let span = spawn_span(cmd, args, None, None);
    let _entered = span.enter();

    let output = Command::new(cmd)
        .args(args)
        .output()
        .map_err(|source| spawn_error(&span, "spawn_failed", cmd, source))?;

    let exit_code = output.status.code().unwrap_or(-1);
    record_exit(&span, exit_code);
    Ok(Output {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code,
    })
}

/// On expiry the child is killed (and reaped) so a hung subprocess can't block
/// the caller forever. Does not fail on a non-zero exit. stdout/stderr drain on
/// dedicated threads, so a chatty child can't deadlock on a full pipe.
pub fn run_with_timeout(cmd: &str, args: &[&str], timeout: Duration) -> Result<Output> {
    run_with_timeout_in(cmd, args, None, &[], timeout)
}

/// [`run_with_timeout`], but with the child's working directory set to `dir`.
/// For tools like `gh` that resolve their target repo from the cwd.
pub fn run_in_dir_with_timeout(
    cmd: &str,
    args: &[&str],
    dir: &std::path::Path,
    timeout: Duration,
) -> Result<Output> {
    run_with_timeout_in(cmd, args, Some(dir), &[], timeout)
}

/// [`run_with_timeout`], with extra env vars set on the child (e.g.
/// [`GIT_NON_INTERACTIVE_ENV`]).
pub fn run_with_timeout_env(
    cmd: &str,
    args: &[&str],
    env: &[(&str, &str)],
    timeout: Duration,
) -> Result<Output> {
    run_with_timeout_in(cmd, args, None, env, timeout)
}

fn run_with_timeout_in(
    cmd: &str,
    args: &[&str],
    dir: Option<&std::path::Path>,
    env: &[(&str, &str)],
    timeout: Duration,
) -> Result<Output> {
    use std::io::Read;
    use std::process::Stdio;
    use wait_timeout::ChildExt;

    let span = spawn_span(cmd, args, dir, Some(timeout));
    let _entered = span.enter();

    let mut command = Command::new(cmd);
    command.args(args).envs(env.iter().copied()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(dir) = dir {
        command.current_dir(dir);
    }
    let mut child =
        command.spawn().map_err(|source| spawn_error(&span, "spawn_failed", cmd, source))?;

    fn drain(reader: Option<impl Read>) -> String {
        let mut buf = Vec::new();
        if let Some(mut reader) = reader {
            let _ = reader.read_to_end(&mut buf);
        }
        String::from_utf8_lossy(&buf).to_string()
    }

    let out = child.stdout.take();
    let err = child.stderr.take();
    let out_thread = std::thread::spawn(move || drain(out));
    let err_thread = std::thread::spawn(move || drain(err));

    let status = child
        .wait_timeout(timeout)
        .map_err(|source| spawn_error(&span, "wait_failed", cmd, source))?;

    let Some(status) = status else {
        // Kill and reap so we don't leave a zombie; the drain threads then
        // observe EOF on the closed pipes.
        let _ = child.kill();
        let _ = child.wait();
        span.record("outcome", "timed_out");
        return Err(Error::Timeout { cmd: display_cmd(cmd, args), timeout });
    };

    // `join` only errors if a drain thread panicked — treat that as empty
    // output rather than propagating the panic.
    let stdout = out_thread.join().unwrap_or_default();
    let stderr = err_thread.join().unwrap_or_default();

    let exit_code = status.code().unwrap_or(-1);
    record_exit(&span, exit_code);
    Ok(Output { stdout, stderr, exit_code })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_captures_stdout_and_exit_code() {
        let output = run("echo", &["hello"]).unwrap();
        assert_eq!(output.stdout.trim(), "hello");
        assert_eq!(output.exit_code, 0);
        assert!(output.ok());
    }

    #[test]
    fn run_reports_spawn_failure_for_missing_binary() {
        let err = run("definitely-not-a-real-binary-xyz", &[]).unwrap_err();
        assert!(matches!(err, Error::Spawn { .. }));
    }

    #[test]
    fn run_with_timeout_kills_a_slow_child() {
        let start = std::time::Instant::now();
        let err = run_with_timeout("sleep", &["5"], Duration::from_millis(200)).unwrap_err();
        assert!(matches!(err, Error::Timeout { .. }));
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn run_with_timeout_returns_output_when_fast() {
        let output = run_with_timeout("echo", &["hi"], Duration::from_secs(5)).unwrap();
        assert_eq!(output.stdout.trim(), "hi");
        assert_eq!(output.exit_code, 0);
        assert!(output.ok());
    }

    #[test]
    fn run_with_timeout_reports_spawn_failure_for_missing_binary() {
        let err = run_with_timeout("definitely-not-a-real-binary-xyz", &[], Duration::from_secs(5))
            .unwrap_err();
        assert!(matches!(err, Error::Spawn { .. }));
    }

    #[test]
    fn run_with_timeout_env_sets_env_vars() {
        let output = run_with_timeout_env(
            "sh",
            &["-c", "echo $FOO"],
            &[("FOO", "bar")],
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(output.stdout.trim(), "bar");
    }

    #[test]
    fn run_in_dir_with_timeout_sets_cwd() {
        let dir = std::env::temp_dir();
        let output = run_in_dir_with_timeout("pwd", &[], &dir, Duration::from_secs(5)).unwrap();
        // temp_dir is often a symlink, so canonicalize both sides.
        let reported = std::fs::canonicalize(output.stdout.trim()).unwrap();
        assert_eq!(reported, std::fs::canonicalize(&dir).unwrap());
    }

    #[test]
    fn app_instance_env_prefixes_are_stripped() {
        for key in [
            "TT_DEV_PORT",
            "TT_SESSION_ID",
            "TT_APP_INSTANCE",
            "TT_E2E_WEBDRIVER_PORT",
            "TAURI_CONFIG",
            "TAURI_ENV_TARGET_TRIPLE",
            "TAURI_ANDROID_HOME",
            "TAURI_WEBVIEW_AUTOMATION",
            "npm_config_registry",
            "npm_lifecycle_event",
            "npm_package_name",
        ] {
            assert!(is_app_instance_env(key), "{key} should be stripped");
        }
    }

    #[test]
    fn ordinary_env_survives() {
        for key in [
            "PATH",
            "HOME",
            "TERM",
            "SHELL",
            "USER",
            "LANG",
            "PWD",
            "MY_TT_VAR",                    // prefix not at the start
            "NOTAURI",                      // prefix not at the start
            "SNAP_npm_x",                   // prefix not at the start
            "TTY",                          // "TT" without the underscore
            "TAURITE",                      // "TAURI" without the underscore
            "CLAUDE_CODE_ENABLE_TELEMETRY", // user config, not session identity
            "CLAUDE_EFFORT",                // user config, not session identity
        ] {
            assert!(!is_app_instance_env(key), "{key} should survive");
        }
    }

    #[test]
    fn claude_session_identity_vars_are_scrubbed() {
        for key in CLAUDE_SESSION_ENV_VARS {
            assert!(is_app_instance_env(key), "{key} should be scrubbed");
        }
    }

    #[test]
    fn scrub_keeps_survivors_and_order_and_drops_instance_vars() {
        let env = vec![
            ("PATH", "/usr/bin"),
            ("TT_DEV_PORT", "1440"),
            ("HOME", "/home/me"),
            ("TAURI_CONFIG", "{}"),
            ("TT_SESSION_ID", "s281e9dda73868f6f"),
            ("TERM", "xterm-256color"),
            ("npm_config_registry", "https://reg"),
        ];
        let scrubbed = scrub_app_instance_env(env);
        assert_eq!(
            scrubbed,
            vec![
                ("PATH", "/usr/bin"),
                ("HOME", "/home/me"),
                ("TERM", "xterm-256color")
            ]
        );
    }

    #[test]
    fn scrub_accepts_owned_pairs() {
        let env = vec![
            ("TT_DEV_PORT".to_string(), "1440".to_string()),
            ("PATH".to_string(), "/usr/bin".to_string()),
        ];
        let scrubbed = scrub_app_instance_env(env);
        assert_eq!(scrubbed, vec![("PATH".to_string(), "/usr/bin".to_string())]);
    }

    /// Runs `body` under a local event-log subscriber, returning its
    /// `process.spawn` records. **Serialized across the whole binary**, which is
    /// load-bearing: `with_default` is thread-local but `tracing`'s
    /// callsite-interest cache is global, so a thread evaluating a callsite
    /// while another sits between `with_default` calls caches "never
    /// interested" and silently drops the other's span.
    fn spawn_records(body: impl FnOnce()) -> Vec<serde_json::Value> {
        use tracing_subscriber::prelude::*;

        static SUBSCRIBER: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _serialized = SUBSCRIBER.lock().unwrap_or_else(|e| e.into_inner());

        let dir = tempfile::tempdir().unwrap();
        let layer = tt_telemetry::EventLogLayer::new(
            tt_telemetry::EventLog::new(dir.path(), 7),
            serde_json::Map::new(),
        );
        tracing::subscriber::with_default(tracing_subscriber::registry().with(layer), body);

        let mut records = Vec::new();
        for entry in std::fs::read_dir(dir.path()).unwrap().flatten() {
            let text = std::fs::read_to_string(entry.path()).unwrap_or_default();
            for line in text.lines() {
                let record: serde_json::Value = serde_json::from_str(line).unwrap();
                if record["name"] == "process.spawn" {
                    records.push(record);
                }
            }
        }
        records
    }

    #[test]
    fn every_spawned_command_reaches_the_event_log() {
        let records = spawn_records(|| {
            run("echo", &["hello"]).unwrap();
        });

        assert_eq!(records.len(), 1, "one record per spawn");
        assert_eq!(records[0]["process.executable.name"], "echo");
        assert_eq!(records[0]["process.command_args"], "hello");
        assert_eq!(records[0]["exit_code"], 0);
        assert_eq!(records[0]["outcome"], "ok");
        assert!(records[0]["duration_ms"].is_u64());
    }

    #[test]
    fn the_log_records_a_non_zero_exit() {
        let records = spawn_records(|| {
            run("sh", &["-c", "exit 3"]).unwrap();
        });

        assert_eq!(records[0]["exit_code"], 3);
        assert_eq!(records[0]["outcome"], "non_zero_exit");
    }

    #[test]
    fn the_log_records_the_working_directory_for_dir_scoped_calls() {
        let dir = tempfile::tempdir().unwrap();
        let records = spawn_records(|| {
            run_in_dir_with_timeout("pwd", &[], dir.path(), Duration::from_secs(10)).unwrap();
        });

        // The cwd is what attributes a `gh` call to a specific checkout.
        assert_eq!(records[0]["process.working_directory"], dir.path().display().to_string());
        assert_eq!(records[0]["timeout_ms"], 10_000);
    }

    #[test]
    fn a_timeout_is_recorded_as_its_own_outcome() {
        let records = spawn_records(|| {
            let result = run_with_timeout("sleep", &["5"], Duration::from_millis(50));
            assert!(matches!(result, Err(Error::Timeout { .. })));
        });

        assert_eq!(records[0]["outcome"], "timed_out");
        assert!(records[0]["exit_code"].is_null(), "a killed process has no exit code");
    }

    #[test]
    fn a_failed_spawn_is_recorded_rather_than_going_dark() {
        let records = spawn_records(|| {
            let result = run("tt-no-such-binary-exists", &[]);
            assert!(matches!(result, Err(Error::Spawn { .. })));
        });

        assert_eq!(records[0]["outcome"], "spawn_failed");
    }
}
