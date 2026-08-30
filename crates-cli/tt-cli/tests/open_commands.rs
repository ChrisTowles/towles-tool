//! Black-box tests for `tt open` — the client half of the `file_open` MCP tool.
//!
//! The app is faked with a one-shot TCP listener on an ephemeral port, named to
//! the CLI through `TT_MCP_PORT` (the same override an app instance honors). That
//! makes the *request* assertable — the routing header and the tool call are the
//! whole contract between this command and the app — without a Tauri shell.

mod common;

use common::cli_cmd;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::Path;
use tempfile::TempDir;

/// A temp dir that is a real git repository, since `tt open` refuses a path
/// under no checkout before it dials anything.
fn repo() -> TempDir {
    let dir = TempDir::new().unwrap();
    let status = std::process::Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(dir.path())
        .status()
        .unwrap();
    assert!(status.success(), "git init should succeed");
    dir
}

/// One request served by a fake app, returned as `(headers, body)`. Answers a
/// successful `file_open` result so the CLI exits 0.
struct FakeApp {
    port: u16,
    handle: std::thread::JoinHandle<(String, String)>,
}

impl FakeApp {
    fn start() -> FakeApp {
        Self::start_answering(
            r#"{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{}"}]}}"#,
        )
    }

    /// A fake app whose single reply is `body` — for the refusal shapes.
    fn start_answering(body: &'static str) -> FakeApp {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut head = String::new();
            let mut len = 0usize;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap_or(0);
                }
                head.push_str(&line);
            }
            let mut payload = vec![0u8; len];
            reader.read_exact(&mut payload).unwrap();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
            stream.flush().unwrap();
            (head, String::from_utf8_lossy(&payload).into_owned())
        });
        FakeApp { port, handle }
    }

    fn request(self) -> (String, serde_json::Value) {
        let (head, body) = self.handle.join().unwrap();
        (head.to_ascii_lowercase(), serde_json::from_str(&body).unwrap())
    }
}

/// `tt open` pointed at `app`, with `TT_SESSION_ID` set unless `session` is None.
fn open_cmd(app: &FakeApp, path: &Path, session: Option<&str>) -> assert_cmd::Command {
    let mut cmd = cli_cmd(Path::new("/nonexistent-config"));
    cmd.env("TT_MCP_PORT", app.port.to_string());
    match session {
        Some(s) => cmd.env("TT_SESSION_ID", s),
        None => cmd.env_remove("TT_SESSION_ID"),
    };
    cmd.arg("open").arg(path);
    cmd
}

#[test]
fn calls_file_open_with_the_absolute_path() {
    let dir = repo();
    let file = dir.path().join("notes.txt");
    std::fs::write(&file, "hi").unwrap();
    let app = FakeApp::start();

    open_cmd(&app, &file, None).assert().success();

    let (head, body) = app.request();
    assert!(head.contains("content-type: application/json"), "{head}");
    assert!(!head.contains("origin:"), "an Origin header would be refused by the app: {head}");
    assert_eq!(body["method"], "tools/call");
    assert_eq!(body["params"]["name"], "file_open");
    // 2026-07-28: the version rides on the request, and the headers mirror the body.
    assert_eq!(body["params"]["_meta"]["io.modelcontextprotocol/protocolVersion"], "2026-07-28");
    assert!(head.contains("mcp-protocol-version: 2026-07-28"), "{head}");
    assert!(head.contains("mcp-method: tools/call"), "{head}");
    assert!(head.contains("mcp-name: file_open"), "{head}");
    assert_eq!(
        body["params"]["arguments"]["path"],
        std::fs::canonicalize(&file).unwrap().to_string_lossy().into_owned(),
        "the path is canonicalized — the app has no cwd to resolve against"
    );
}

/// The routing key: `TT_SESSION_ID` from the app's own terminal, forwarded as the
/// header the transport reads.
#[test]
fn forwards_the_callers_session_as_the_routing_header() {
    let dir = repo();
    let file = dir.path().join("notes.txt");
    std::fs::write(&file, "hi").unwrap();
    let app = FakeApp::start();

    open_cmd(&app, &file, Some("s64abebd44298447d")).assert().success();

    let (head, _) = app.request();
    assert!(head.contains("x-tt-session: s64abebd44298447d"), "{head}");
}

#[test]
fn a_line_suffix_becomes_the_line_argument() {
    let dir = repo();
    let file = dir.path().join("main.rs");
    std::fs::write(&file, "fn main() {}").unwrap();
    let app = FakeApp::start();

    let mut cmd = cli_cmd(Path::new("/nonexistent-config"));
    cmd.env("TT_MCP_PORT", app.port.to_string());
    cmd.env_remove("TT_SESSION_ID");
    cmd.arg("open").arg(format!("{}:42", file.display())).assert().success();

    let (_, body) = app.request();
    assert_eq!(body["params"]["arguments"]["line"], 42);
}

#[test]
fn a_folder_is_opened_too() {
    let dir = repo();
    let app = FakeApp::start();

    open_cmd(&app, dir.path(), None).assert().success();

    let (_, body) = app.request();
    assert_eq!(
        body["params"]["arguments"]["path"],
        std::fs::canonicalize(dir.path()).unwrap().to_string_lossy().into_owned()
    );
}

/// The tool ran and refused — that answer is the user's, so it must not pass as
/// success.
#[test]
fn a_refusal_from_the_app_fails_the_command() {
    let dir = repo();
    let file = dir.path().join("notes.txt");
    std::fs::write(&file, "hi").unwrap();
    let app = FakeApp::start_answering(
        r#"{"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"it isn't inside a tracked folder"}]}}"#,
    );

    open_cmd(&app, &file, None)
        .assert()
        .failure()
        .stderr(predicates::str::contains("it isn't inside a tracked folder"));
    let _ = app.request();
}

#[test]
fn no_app_serving_fails_with_the_port() {
    let dir = repo();
    let file = dir.path().join("notes.txt");
    std::fs::write(&file, "hi").unwrap();
    // A port nothing is listening on: bound and dropped, so it's free and known.
    let port = {
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        l.local_addr().unwrap().port()
    };

    cli_cmd(Path::new("/nonexistent-config"))
        .env("TT_MCP_PORT", port.to_string())
        .arg("open")
        .arg(&file)
        .assert()
        .failure()
        .stderr(predicates::str::contains(format!("127.0.0.1:{port}")));
}

/// Refused before any request: the files pane browses a checkout, so a path
/// outside every one has no pane to appear in.
#[test]
fn a_path_outside_any_repo_fails_locally() {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("notes.txt");
    std::fs::write(&file, "hi").unwrap();

    cli_cmd(Path::new("/nonexistent-config"))
        .arg("open")
        .arg(&file)
        .assert()
        .failure()
        .stderr(predicates::str::contains("not inside a git repository"));
}

#[test]
fn missing_path_fails() {
    let dir = repo();

    cli_cmd(Path::new("/nonexistent-config"))
        .arg("open")
        .arg(dir.path().join("nope.txt"))
        .assert()
        .failure()
        .stderr(predicates::str::contains("Cannot open"));
}
