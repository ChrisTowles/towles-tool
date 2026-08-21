//! code-server as a supervised child process for the editor pane: find the
//! binary, launch one HTTP server on an OS-assigned port, hand back the URL a
//! webview iframe loads. Tauri-free per the workspace rule.
//!
//! **Spike** (docs/CODE-SERVER-SPIKE.md) — evaluating a real VS Code server as
//! a swap-in for the in-webview Monaco editor, not yet a shipped surface.
//!
//! One process serves every folder: a workbench is just `/?folder=<dir>`, so N
//! panes across N checkouts are N iframes against one server, and the process
//! exits when the host drops. The port is never chosen here — `--bind-addr
//! 127.0.0.1:0` lets the OS assign one and code-server logs it, which is both
//! race-free and the repo's rule about concurrent worktree tasks.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const STARTUP_DEADLINE: Duration = Duration::from_secs(30);
const STDERR_TAIL_LINES: usize = 30;

/// Binary override for tests and settings; checked before PATH and the
/// standard install prefixes.
pub const BIN_ENV: &str = "TT_CODE_SERVER_BIN";

#[derive(Debug, thiserror::Error)]
pub enum CodeServerError {
    #[error("no code-server binary found (install it, or set {BIN_ENV})")]
    NoBinary,
    #[error("code-server exited during startup: {0}")]
    StartupExit(String),
    #[error("code-server never reported a listening port: {0}")]
    Startup(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

pub fn find_code_server(override_path: Option<&Path>) -> Option<PathBuf> {
    if let Some(p) = override_path.filter(|p| p.is_file()) {
        return Some(p.to_path_buf());
    }
    if let Some(p) = std::env::var_os(BIN_ENV).map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(p);
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join("code-server");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    // The install script's own prefixes, which put the launcher outside PATH.
    let home = dirs_home()?;
    let prefixes = [
        home.join(".local/lib/code-server/bin/code-server"),
        PathBuf::from("/usr/lib/code-server/bin/code-server"),
        PathBuf::from("/opt/code-server/bin/code-server"),
    ];
    prefixes.into_iter().find(|p| p.is_file())
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

#[derive(Debug, Clone)]
pub struct CodeServerConfig {
    pub binary: PathBuf,
    /// Instance-scoped: two checkouts running concurrently would otherwise
    /// contend on the same `code-server-ipc.sock`.
    pub user_data_dir: PathBuf,
    /// Shared: an installed extension is a machine fact, and the directory is
    /// large enough that per-instance copies are a real disk cost.
    pub extensions_dir: PathBuf,
    /// Ours, so the user's `~/.config/code-server/config.yaml` — which can pin
    /// a bind address or re-enable password auth — never reaches this process.
    pub config_file: PathBuf,
}

/// Auth is off because the socket is loopback-only and the *pane* has no way to
/// carry a password; that is exactly the posture already argued for the MCP
/// server (docs/MCP.md), and the same caveat applies — any local process can
/// reach it.
pub fn build_args(cfg: &CodeServerConfig) -> Vec<String> {
    vec![
        "--auth".into(),
        "none".into(),
        "--bind-addr".into(),
        "127.0.0.1:0".into(),
        format!("--user-data-dir={}", cfg.user_data_dir.display()),
        format!("--extensions-dir={}", cfg.extensions_dir.display()),
        format!("--config={}", cfg.config_file.display()),
        "--disable-telemetry".into(),
        "--disable-update-check".into(),
        "--disable-workspace-trust".into(),
        "--disable-getting-started-override".into(),
        "--ignore-last-opened".into(),
    ]
}

/// The workbench URL for one folder. A pane is this URL in an iframe.
pub fn folder_url(port: u16, folder: &Path) -> String {
    format!("http://127.0.0.1:{port}/?folder={}", encode_query(&folder.to_string_lossy()))
}

fn encode_query(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for byte in raw.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

pub struct CodeServerChild {
    child: Child,
    pub port: u16,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
}

impl CodeServerChild {
    /// Launch and block until the listening port is parsed off stdout. The
    /// config file is created empty if absent — code-server errors on a
    /// missing `--config` path rather than defaulting.
    pub fn launch(cfg: &CodeServerConfig) -> Result<Self, CodeServerError> {
        std::fs::create_dir_all(&cfg.user_data_dir)?;
        std::fs::create_dir_all(&cfg.extensions_dir)?;
        if let Some(parent) = cfg.config_file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if !cfg.config_file.exists() {
            std::fs::write(&cfg.config_file, "auth: none\n")?;
        }

        let args = build_args(cfg);
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let bin = cfg.binary.to_string_lossy();
        tt_exec::record_detached_spawn(&bin, &arg_refs, "code-server");

        let mut cmd = Command::new(&cfg.binary);
        cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        for (key, _) in std::env::vars_os() {
            if tt_exec::is_app_instance_env(&key.to_string_lossy()) {
                cmd.env_remove(&key);
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
            // Drop can't run when the app is SIGKILLed, and a stray workbench
            // is ~1 GB of node. PDEATHSIG reaps the root; its extension host
            // follows once that connection drops. Linux-only — macOS has no
            // equivalent, so a killed app there still leaks one tree.
            // SAFETY: pre_exec runs in the forked child before exec; prctl is
            // async-signal-safe and touches only this process.
            #[cfg(target_os = "linux")]
            unsafe {
                cmd.pre_exec(|| {
                    libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
                    Ok(())
                });
            }
        }

        let mut child = cmd.spawn()?;
        let stderr_tail = Arc::new(Mutex::new(VecDeque::new()));
        if let Some(stderr) = child.stderr.take() {
            let tail = Arc::clone(&stderr_tail);
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    push_tail(&tail, line);
                }
            });
        }

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| CodeServerError::Startup("child stdout was not piped".to_string()))?;
        let (tx, rx) = std::sync::mpsc::channel();
        let tail = Arc::clone(&stderr_tail);
        std::thread::spawn(move || {
            let mut sent = false;
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if !sent && let Some(port) = parse_listening_port(&line) {
                    sent = tx.send(port).is_ok();
                }
                push_tail(&tail, line);
            }
        });

        let deadline = Instant::now() + STARTUP_DEADLINE;
        loop {
            if let Ok(port) = rx.try_recv() {
                return Ok(Self { child, port, stderr_tail });
            }
            if let Ok(Some(status)) = child.try_wait() {
                let tail = tail_string(&stderr_tail);
                return Err(CodeServerError::StartupExit(format!("{status}; output: {tail}")));
            }
            if Instant::now() > deadline {
                kill_group(&mut child);
                return Err(CodeServerError::Startup(format!(
                    "nothing within {STARTUP_DEADLINE:?}; output: {}",
                    tail_string(&stderr_tail)
                )));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    pub fn output_tail(&self) -> String {
        tail_string(&self.stderr_tail)
    }

    pub fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// TERM the group (the launcher is a shell script wrapping node), then KILL.
    pub fn shutdown(&mut self) {
        if !self.is_running() {
            let _ = self.child.wait();
            return;
        }
        signal_group(&self.child, libc::SIGTERM);
        use wait_timeout::ChildExt;
        if self.child.wait_timeout(Duration::from_secs(5)).ok().flatten().is_none() {
            kill_group(&mut self.child);
        }
    }
}

impl Drop for CodeServerChild {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn push_tail(tail: &Arc<Mutex<VecDeque<String>>>, line: String) {
    let Ok(mut tail) = tail.lock() else { return };
    if tail.len() >= STDERR_TAIL_LINES {
        tail.pop_front();
    }
    tail.push_back(line);
}

fn signal_group(child: &Child, signal: i32) {
    #[cfg(unix)]
    {
        // SAFETY: killpg on the pgid created by process_group(0) at spawn;
        // affects only our own child's group.
        unsafe {
            libc::killpg(child.id() as i32, signal);
        }
    }
    #[cfg(not(unix))]
    let _ = (child, signal);
}

fn kill_group(child: &mut Child) {
    signal_group(child, libc::SIGKILL);
    let _ = child.kill();
    let _ = child.wait();
}

fn tail_string(tail: &Arc<Mutex<VecDeque<String>>>) -> String {
    tail.lock().map(|t| t.iter().cloned().collect::<Vec<_>>().join("\n")).unwrap_or_default()
}

/// `[…] info  HTTP server listening on http://127.0.0.1:41207/` — the only
/// place the OS-assigned port is reported.
pub fn parse_listening_port(line: &str) -> Option<u16> {
    let rest = line.split("HTTP server listening on http://").nth(1)?;
    let authority = rest.split('/').next()?;
    authority.rsplit(':').next()?.trim().parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_listening_port() {
        let line =
            "[2026-08-21T02:32:15.859Z] info  HTTP server listening on http://127.0.0.1:52987/";
        assert_eq!(parse_listening_port(line), Some(52987));
    }

    #[test]
    fn ignores_other_log_lines() {
        assert_eq!(parse_listening_port("info  Authentication is disabled"), None);
        assert_eq!(
            parse_listening_port("info  Session server listening on /tmp/code-server-ipc.sock"),
            None
        );
    }

    #[test]
    fn folder_url_percent_encodes_the_path() {
        let url = folder_url(4200, Path::new("/home/me/code/my repo"));
        assert_eq!(url, "http://127.0.0.1:4200/?folder=/home/me/code/my%20repo");
    }

    #[test]
    fn args_never_pin_a_port_or_read_the_user_config() {
        let cfg = CodeServerConfig {
            binary: PathBuf::from("/usr/bin/code-server"),
            user_data_dir: PathBuf::from("/tmp/ud"),
            extensions_dir: PathBuf::from("/tmp/ext"),
            config_file: PathBuf::from("/tmp/cfg.yaml"),
        };
        let args = build_args(&cfg);
        assert!(args.contains(&"127.0.0.1:0".to_string()));
        assert!(args.iter().any(|a| a == "--config=/tmp/cfg.yaml"));
    }
}
