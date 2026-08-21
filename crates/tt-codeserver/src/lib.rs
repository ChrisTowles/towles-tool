//! code-server as a supervised child process for the Files pane: find the
//! binary, launch one HTTP server on an OS-assigned port, hand back the URL a
//! webview iframe loads, and open files in a workbench already running.
//! Tauri-free per the workspace rule. Design and costs: docs/CODE-SERVER.md.
//!
//! One process serves every folder: a workbench is just `/?folder=<dir>`, so N
//! panes across N checkouts are N iframes against one server, and the process
//! exits when the host drops. The port is never chosen here — `--bind-addr
//! 127.0.0.1:0` lets the OS assign one and code-server logs it, which is both
//! race-free and the repo's rule about concurrent worktree tasks.

pub mod install;

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const STARTUP_DEADLINE: Duration = Duration::from_secs(30);
const STDERR_TAIL_LINES: usize = 30;
/// How long a reveal waits for a workbench to register itself — a pane created
/// moments ago is still booting one.
const REVEAL_DEADLINE: Duration = Duration::from_secs(20);
const SOCKET_TIMEOUT: Duration = Duration::from_secs(5);

/// Binary override for tests and settings; checked before PATH and the
/// standard install prefixes.
pub const BIN_ENV: &str = "TT_CODE_SERVER_BIN";

#[derive(Debug, thiserror::Error)]
pub enum CodeServerError {
    #[error("code-server could not be provisioned: {0}")]
    Install(#[from] install::InstallError),
    #[error("code-server exited during startup: {0}")]
    StartupExit(String),
    #[error("code-server never reported a listening port: {0}")]
    Startup(String),
    #[error("no VS Code workbench has come up to open the file in")]
    NoWorkbench,
    #[error("the workbench refused the open: {0}")]
    Reveal(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// The code-server to run, or `None` when the machine has none yet — which is
/// [`install::ensure`]'s cue, not an error. `managed_root` is where a previous
/// install of the pinned version would have landed; it wins over PATH, so a
/// machine that provisioned one keeps running that one.
pub fn find_code_server(
    override_path: Option<&Path>,
    managed_root: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(p) = override_path.filter(|p| p.is_file()) {
        return Some(p.to_path_buf());
    }
    if let Some(p) = std::env::var_os(BIN_ENV).map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(p);
    }
    if let Some(p) = managed_root.and_then(install::installed_binary) {
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
    // Prefixes the installers use that PATH may not carry: the install script's
    // own, and Homebrew's — which a Finder-launched `.app` never inherits,
    // since macOS gives it the bare `/usr/bin:/bin:/usr/sbin:/sbin`.
    let home = dirs_home()?;
    let prefixes = [
        home.join(".local/lib/code-server/bin/code-server"),
        PathBuf::from("/usr/lib/code-server/bin/code-server"),
        PathBuf::from("/opt/code-server/bin/code-server"),
        PathBuf::from("/opt/homebrew/bin/code-server"),
        PathBuf::from("/usr/local/bin/code-server"),
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
    /// Where code-server registers its workbench windows (the socket `reveal`
    /// asks). Short by necessity: `sun_path` is 108 bytes on Linux, and the
    /// default under `user_data_dir` overflows it — silently, in code-server.
    pub session_socket: PathBuf,
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
        format!("--session-socket={}", cfg.session_socket.display()),
        "--disable-telemetry".into(),
        "--disable-update-check".into(),
        "--disable-workspace-trust".into(),
        "--disable-getting-started-override".into(),
        "--ignore-last-opened".into(),
    ]
}

/// The workbench URL for one folder — a pane is this URL in an iframe — with an
/// optional file for it to open as it boots. VS Code's web entry reads `payload`
/// off the URL: `openFile` names the file and `gotoLineMode` makes a trailing
/// `:line` select that line.
pub fn workbench_url(port: u16, folder: &Path, open: Option<(&Path, Option<u32>)>) -> String {
    let mut url =
        format!("http://127.0.0.1:{port}/?folder={}", encode_query(&folder.to_string_lossy()));
    if let Some((file, line)) = open {
        let payload = serde_json::json!([
            ["openFile", file_uri(port, file, line)],
            ["gotoLineMode", "true"]
        ]);
        url.push_str("&payload=");
        url.push_str(&encode_query(&payload.to_string()));
    }
    url
}

/// A file as the workbench names it: `vscode-remote://<authority>/<path>`, the
/// authority being the host the iframe loaded the workbench from. The line
/// rides the path in the `code --goto` spelling.
fn file_uri(port: u16, file: &Path, line: Option<u32>) -> String {
    let mut uri =
        format!("vscode-remote://127.0.0.1:{port}{}", encode_query(&file.to_string_lossy()));
    if let Some(line) = line {
        uri.push_str(&format!(":{line}"));
    }
    uri
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

/// Open `file` in the workbench already serving it — the route `code -r` takes.
/// code-server registers every workbench window on `session_socket`: `GET
/// /session?filePath=` answers with the VS Code IPC socket of the window whose
/// folder contains the file (else the most recent window, as `code -r`), and
/// that socket takes the `open` request the `code` CLI sends. HTTP/1.0 on both,
/// so a reply ends at EOF. Polls while the registry is empty: a pane created
/// moments ago is still booting its workbench.
pub fn reveal(
    session_socket: &Path,
    port: u16,
    file: &Path,
    line: Option<u32>,
) -> Result<(), CodeServerError> {
    let registry = session_socket;
    let query = format!("/session?filePath={}", encode_query(&file.to_string_lossy()));
    let request = format!("GET {query} HTTP/1.0\r\nHost: localhost\r\n\r\n");
    let deadline = Instant::now() + REVEAL_DEADLINE;
    let socket = loop {
        let reply = unix_http(registry, &request)?;
        if let Some(path) = registered_window(&reply.body) {
            break path;
        }
        if Instant::now() > deadline {
            return Err(CodeServerError::NoWorkbench);
        }
        std::thread::sleep(Duration::from_millis(250));
    };
    let body = serde_json::json!({
        "type": "open",
        "fileURIs": [file_uri(port, file, line)],
        "folderURIs": [],
        "forceReuseWindow": true,
        "gotoLineMode": true,
    })
    .to_string();
    let request = format!(
        "POST / HTTP/1.0\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    let reply = unix_http(&socket, &request)?;
    if reply.status != 200 {
        return Err(CodeServerError::Reveal(format!("{} {}", reply.status, reply.body.trim())));
    }
    Ok(())
}

struct HttpReply {
    status: u16,
    body: String,
}

fn unix_http(socket: &Path, request: &str) -> Result<HttpReply, CodeServerError> {
    let mut stream = UnixStream::connect(socket)?;
    stream.set_read_timeout(Some(SOCKET_TIMEOUT))?;
    stream.set_write_timeout(Some(SOCKET_TIMEOUT))?;
    stream.write_all(request.as_bytes())?;
    let mut raw = String::new();
    stream.read_to_string(&mut raw)?;
    parse_http_reply(&raw)
        .ok_or_else(|| CodeServerError::Reveal(format!("unparseable reply: {raw:?}")))
}

fn parse_http_reply(raw: &str) -> Option<HttpReply> {
    let (head, body) = raw.split_once("\r\n\r\n")?;
    let status = head.split_whitespace().nth(1)?.parse().ok()?;
    Some(HttpReply { status, body: body.to_string() })
}

/// `{"socketPath": "/tmp/vscode-ipc-….sock"}`, or `null` while no window is up.
fn registered_window(body: &str) -> Option<PathBuf> {
    let reply: serde_json::Value = serde_json::from_str(body).ok()?;
    reply.get("socketPath")?.as_str().map(PathBuf::from)
}

pub struct CodeServerChild {
    child: Child,
    pub port: u16,
    /// The registry `reveal` asks, as launched.
    pub session_socket: PathBuf,
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
        if let Some(parent) = cfg.session_socket.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // A stale socket file from a crashed predecessor with this pid.
        let _ = std::fs::remove_file(&cfg.session_socket);

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
                let session_socket = cfg.session_socket.clone();
                return Ok(Self { child, port, session_socket, stderr_tail });
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
    use std::os::unix::net::UnixListener;

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
    fn workbench_url_percent_encodes_the_folder() {
        let url = workbench_url(4200, Path::new("/home/me/code/my repo"), None);
        assert_eq!(url, "http://127.0.0.1:4200/?folder=/home/me/code/my%20repo");
    }

    #[test]
    fn workbench_url_carries_a_file_to_open_as_a_payload() {
        let url = workbench_url(
            4200,
            Path::new("/home/me/repo"),
            Some((Path::new("/home/me/repo/src/main.rs"), Some(42))),
        );
        let (base, payload) = url.split_once("&payload=").expect("a payload");
        assert_eq!(base, "http://127.0.0.1:4200/?folder=/home/me/repo");
        let decoded = percent_decode(payload);
        let parsed: serde_json::Value = serde_json::from_str(&decoded).unwrap();
        assert_eq!(parsed[0][0], "openFile");
        assert_eq!(parsed[0][1], "vscode-remote://127.0.0.1:4200/home/me/repo/src/main.rs:42");
        assert_eq!(parsed[1], serde_json::json!(["gotoLineMode", "true"]));
    }

    #[test]
    fn file_uri_keeps_the_line_outside_the_encoded_path() {
        assert_eq!(
            file_uri(4200, Path::new("/a b/c.rs"), Some(7)),
            "vscode-remote://127.0.0.1:4200/a%20b/c.rs:7"
        );
        assert_eq!(
            file_uri(4200, Path::new("/a/c.rs"), None),
            "vscode-remote://127.0.0.1:4200/a/c.rs"
        );
    }

    #[test]
    fn args_never_pin_a_port_or_read_the_user_config() {
        let cfg = CodeServerConfig {
            binary: PathBuf::from("/usr/bin/code-server"),
            user_data_dir: PathBuf::from("/tmp/ud"),
            extensions_dir: PathBuf::from("/tmp/ext"),
            config_file: PathBuf::from("/tmp/cfg.yaml"),
            session_socket: PathBuf::from("/tmp/cs.sock"),
        };
        let args = build_args(&cfg);
        assert!(args.contains(&"127.0.0.1:0".to_string()));
        assert!(args.iter().any(|a| a == "--config=/tmp/cfg.yaml"));
        assert!(args.iter().any(|a| a == "--session-socket=/tmp/cs.sock"));
    }

    #[test]
    fn registered_window_reads_the_registry_reply() {
        assert_eq!(
            registered_window(r#"{"socketPath":"/tmp/vscode-ipc-1.sock"}"#),
            Some(PathBuf::from("/tmp/vscode-ipc-1.sock"))
        );
        assert_eq!(registered_window(r#"{"socketPath":null}"#), None);
        assert_eq!(registered_window("{}"), None);
        assert_eq!(registered_window("not json"), None);
    }

    #[test]
    fn http_reply_splits_status_and_body() {
        let reply =
            parse_http_reply("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nhi").unwrap();
        assert_eq!((reply.status, reply.body.as_str()), (200, "hi"));
        assert!(parse_http_reply("garbage").is_none());
    }

    /// A fake registry and a fake workbench socket, so the whole exchange is
    /// pinned without a code-server: the registry names the window, the
    /// window gets the `open` the `code` CLI would have sent.
    #[test]
    fn reveal_asks_the_registry_then_opens_on_the_window_socket() {
        let dir = tempfile::tempdir().unwrap();
        let window_sock = dir.path().join("window.sock");
        let window = UnixListener::bind(&window_sock).unwrap();
        let registry_sock = dir.path().join("registry.sock");
        let registry = UnixListener::bind(&registry_sock).unwrap();

        let window_path = window_sock.to_string_lossy().into_owned();
        let registry_thread = std::thread::spawn(move || {
            let (mut conn, _) = registry.accept().unwrap();
            let request = read_request(&mut conn);
            let body = format!(r#"{{"socketPath":"{window_path}"}}"#);
            write!(conn, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}", body.len())
                .unwrap();
            request
        });
        let window_thread = std::thread::spawn(move || {
            let (mut conn, _) = window.accept().unwrap();
            let request = read_request(&mut conn);
            write!(conn, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n\"\"").unwrap();
            request
        });

        reveal(&registry_sock, 4200, Path::new("/home/me/repo/src/lib.rs"), Some(12)).unwrap();

        let asked = registry_thread.join().unwrap();
        assert!(
            asked.starts_with("GET /session?filePath=/home/me/repo/src/lib.rs HTTP/1.0"),
            "{asked}"
        );
        let opened = window_thread.join().unwrap();
        let body = opened.split("\r\n\r\n").nth(1).unwrap();
        let open: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(open["type"], "open");
        assert_eq!(
            open["fileURIs"][0],
            "vscode-remote://127.0.0.1:4200/home/me/repo/src/lib.rs:12"
        );
        assert_eq!(open["forceReuseWindow"], true);
        assert_eq!(open["gotoLineMode"], true);
    }

    fn read_request(conn: &mut UnixStream) -> String {
        let mut reader = BufReader::new(conn.try_clone().unwrap());
        let mut head = String::new();
        let mut content_length = 0usize;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if let Some(value) = line.strip_prefix("Content-Length:") {
                content_length = value.trim().parse().unwrap();
            }
            head.push_str(&line);
            if line == "\r\n" {
                break;
            }
        }
        let mut body = vec![0u8; content_length];
        reader.read_exact(&mut body).unwrap();
        head + &String::from_utf8(body).unwrap()
    }

    fn percent_decode(raw: &str) -> String {
        let bytes = raw.as_bytes();
        let mut out = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap();
                out.push(u8::from_str_radix(hex, 16).unwrap());
                i += 3;
            } else {
                out.push(bytes[i]);
                i += 1;
            }
        }
        String::from_utf8(out).unwrap()
    }
}
