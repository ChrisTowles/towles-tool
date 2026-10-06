//! What fails for *one checkout* while every machine-wide tool is fine: the MCP
//! server its app instance serves, the code-server behind its Files pane and the
//! Chrome behind its browser pane. The doctor runs inside the app, so the MCP
//! probe is one loopback `server/discover` — the same request a session's
//! `.mcp.json` ends up making — against the port this instance actually bound,
//! with the checkout's rendered `.env` claim as a second signal when they differ.
//!
//! The socket call is one thin function; everything that decides what to report
//! takes plain values, so the classifiers are tested without a server.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

/// One row of the Doctor screen's "This checkout" card: `ok` with a `warning` is
/// amber, `ok` without one green, neither red. `hint` is the fix.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutCheck {
    pub name: String,
    pub value: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

const MCP_ROW: &str = "MCP server";
const MCP_CLAIM_ROW: &str = "MCP port claim";
const CODE_SERVER_ROW: &str = "code-server";
const CHROME_ROW: &str = "Chrome";

/// Loopback: a healthy app answers in milliseconds, and a wedged one must not
/// hold the whole report.
const MCP_PROBE_TIMEOUT: Duration = Duration::from_secs(1);

pub fn check_checkout(bound_mcp_port: Option<u16>) -> Vec<CheckoutCheck> {
    let mut rows = check_mcp_server(bound_mcp_port);
    rows.push(check_code_server());
    rows.push(check_chrome());
    rows
}

#[derive(Debug, PartialEq, Eq)]
enum McpPortSource {
    /// A packaged app runs from no checkout, so there is no `.env` to render.
    NoCheckout,
    NoDotenv,
    /// An `.env` with no usable `TT_MCP_PORT` — an unrendered `${tt:port …}` token
    /// is the common shape.
    Unclaimed,
    Claimed(u16),
}

fn mcp_port_source(dotenv: Option<&str>) -> McpPortSource {
    match dotenv {
        None => McpPortSource::NoDotenv,
        Some(text) => tt_mcp::port::claim_in_dotenv(text)
            .map_or(McpPortSource::Unclaimed, McpPortSource::Claimed),
    }
}

/// A `server/discover` exchange flattened to what the classifier needs.
#[derive(Debug)]
enum Probe {
    Answered { status: u16, body: String },
    Unreachable,
}

/// `bound` is the port this instance serves on, `None` when it lost the bind — the
/// app passes it, since only the app knows.
fn check_mcp_server(bound: Option<u16>) -> Vec<CheckoutCheck> {
    let root = std::env::current_dir().ok().and_then(|dir| tt_config::checkout_root_from_dir(&dir));
    let (source, env_hint) = match &root {
        Some(root) => {
            let dotenv = std::fs::read_to_string(root.join(".env")).ok();
            (mcp_port_source(dotenv.as_deref()), render_env_hint(root))
        }
        None => (McpPortSource::NoCheckout, String::new()),
    };
    let probe = bound.map(probe_mcp);
    mcp_rows(bound, probe.as_ref(), source, &env_hint)
}

fn mcp_rows(
    bound: Option<u16>,
    probe: Option<&Probe>,
    source: McpPortSource,
    env_hint: &str,
) -> Vec<CheckoutCheck> {
    let mut rows = vec![match (bound, probe) {
        (Some(port), Some(probe)) => classify_mcp_probe(port, probe),
        _ => mcp_not_serving(),
    }];
    match source {
        McpPortSource::Claimed(claim) => {
            if let Some(port) = bound.filter(|&port| port != claim) {
                rows.push(mcp_claim_mismatch(port, claim));
            }
        }
        McpPortSource::NoCheckout => {}
        source => rows.push(mcp_unclaimed(source, env_hint)),
    }
    rows
}

fn mcp_not_serving() -> CheckoutCheck {
    CheckoutCheck {
        name: MCP_ROW.to_string(),
        value: "this instance isn't serving".to_string(),
        ok: false,
        warning: None,
        hint: Some(
            "the bind failed — the MCP screen says why (another instance may hold the port); \
             restart with `bun start`"
                .to_string(),
        ),
    }
}

fn mcp_claim_mismatch(bound: u16, claim: u16) -> CheckoutCheck {
    CheckoutCheck {
        name: MCP_CLAIM_ROW.to_string(),
        value: format!("bound {bound} · claims {claim}"),
        ok: false,
        warning: Some("the bound port is not this checkout's claim".to_string()),
        hint: Some(format!(
            "bound {bound} from the environment; this checkout claims {claim} — `tt task ports` \
             lists every claim"
        )),
    }
}

/// `tt task env <name>` for this checkout — a task's dir name, or `primary` for the
/// main checkout, which is how the CLI spells it.
fn render_env_hint(root: &Path) -> String {
    let name = match tt_tasks::layout::main_checkout_for(root) {
        Some(_) => tt_tasks::layout::task_name_from_dir(root),
        None => "primary".to_string(),
    };
    format!("tt task env {name}")
}

fn mcp_unclaimed(source: McpPortSource, hint: &str) -> CheckoutCheck {
    let value = match source {
        McpPortSource::NoDotenv => "no rendered .env",
        _ => "no TT_MCP_PORT in .env",
    };
    CheckoutCheck {
        name: MCP_CLAIM_ROW.to_string(),
        value: value.to_string(),
        ok: false,
        warning: Some(
            "the app falls back to the shared settings port, which another checkout's \
             instance may already hold"
                .to_string(),
        ),
        hint: Some(format!("render this checkout's port claims: `{hint}`")),
    }
}

/// The request docs/WORKTREE-TASKS.md shows under "the MCP tools aren't there",
/// with the headers the transport mirrors against the body. No `Origin`: ureq
/// sends none, which is what admits the request.
fn probe_mcp(port: u16) -> Probe {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "server/discover",
        "params": {
            "_meta": {
                tt_mcp::META_PROTOCOL_VERSION: tt_mcp::PROTOCOL_VERSION,
                tt_mcp::META_CLIENT_INFO: {
                    "name": "tt-doctor",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                tt_mcp::META_CLIENT_CAPABILITIES: {},
            },
        },
    });
    let agent = ureq::AgentBuilder::new().timeout(MCP_PROBE_TIMEOUT).build();
    let request = agent
        .post(&format!("http://127.0.0.1:{port}/mcp"))
        .set("Content-Type", "application/json")
        .set(tt_mcp::PROTOCOL_VERSION_HEADER, tt_mcp::PROTOCOL_VERSION)
        .set(tt_mcp::METHOD_HEADER, "server/discover");
    match request.send_json(body) {
        Ok(response) => Probe::Answered {
            status: response.status(),
            body: response.into_string().unwrap_or_default(),
        },
        Err(ureq::Error::Status(status, response)) => {
            Probe::Answered { status, body: response.into_string().unwrap_or_default() }
        }
        Err(ureq::Error::Transport(_)) => Probe::Unreachable,
    }
}

fn classify_mcp_probe(port: u16, probe: &Probe) -> CheckoutCheck {
    let row = |value: String, ok: bool, hint: Option<&str>| CheckoutCheck {
        name: MCP_ROW.to_string(),
        value,
        ok,
        warning: None,
        hint: hint.map(str::to_string),
    };
    let foreign = "something else answers on the port this instance bound — `tt task ports` \
                   lists every claim";
    match probe {
        Probe::Unreachable => row(
            format!("nobody serving on {port}"),
            false,
            Some(&format!(
                "this instance bound {port} but doesn't answer — restart it with `bun start`"
            )),
        ),
        Probe::Answered { status: 200, body } => match discover_server(body) {
            Some(server) => row(format!("serving on {port} · {server}"), true, None),
            None => {
                row(format!("port {port} answered, but not as an MCP server"), false, Some(foreign))
            }
        },
        Probe::Answered { status, .. } => {
            row(format!("port {port} answered HTTP {status}"), false, Some(foreign))
        }
    }
}

/// The server a 200 discover answer names, `None` when the body isn't a JSON-RPC
/// result at all. `serverInfo` is optional in the spec, so a result without one
/// still counts as serving.
fn discover_server(body: &str) -> Option<String> {
    let answer: Value = serde_json::from_str(body).ok()?;
    let result = answer.get("result")?.as_object()?;
    let info = result.get("_meta").and_then(|m| m.get(tt_mcp::META_SERVER_INFO));
    let name = info.and_then(|i| i.get("name")).and_then(Value::as_str);
    let version = info.and_then(|i| i.get("version")).and_then(Value::as_str);
    Some(match (name, version) {
        (Some(name), Some(version)) => format!("{name} {version}"),
        (Some(name), None) => name.to_string(),
        _ => "MCP server".to_string(),
    })
}

/// The same lookup the Files pane runs before deciding to install, so "present"
/// here is "the pane won't download".
fn check_code_server() -> CheckoutCheck {
    let root = tt_config::code_server_install_dir().ok();
    let binary = tt_codeserver::find_code_server(None, root.as_deref());
    let version = binary.as_deref().and_then(code_server_version);
    code_server_row(binary.as_deref(), version)
}

/// `code-server --version` prints `4.137.0 <sha> with Code 1.137.0`.
fn code_server_version(binary: &Path) -> Option<String> {
    let out = tt_exec::run(&binary.to_string_lossy(), &["--version"]).ok().filter(|o| o.ok())?;
    super::extract_version(&out.stdout)
}

fn code_server_row(binary: Option<&Path>, version: Option<String>) -> CheckoutCheck {
    match binary {
        Some(bin) => CheckoutCheck {
            name: CODE_SERVER_ROW.to_string(),
            value: version.unwrap_or_else(|| "found".to_string()),
            ok: true,
            warning: None,
            hint: Some(bin.display().to_string()),
        },
        None => CheckoutCheck {
            name: CODE_SERVER_ROW.to_string(),
            value: "not installed".to_string(),
            ok: false,
            warning: Some("the first Files pane downloads it".to_string()),
            hint: Some(format!(
                "the first Files pane downloads code-server {} (~230 MB); pre-warm with `cargo \
                 run -p tt-codeserver --example provision`",
                tt_codeserver::install::VERSION
            )),
        },
    }
}

fn check_chrome() -> CheckoutCheck {
    chrome_row(tt_browser::find_chrome(None).as_deref())
}

fn chrome_row(binary: Option<&Path>) -> CheckoutCheck {
    match binary {
        Some(bin) => CheckoutCheck {
            name: CHROME_ROW.to_string(),
            value: bin.display().to_string(),
            ok: true,
            warning: None,
            hint: None,
        },
        None => CheckoutCheck {
            name: CHROME_ROW.to_string(),
            value: "not found".to_string(),
            ok: false,
            warning: Some("the browser pane has nothing to launch".to_string()),
            hint: Some(format!(
                "install Google Chrome or Chromium, or point {} at a binary",
                tt_browser::launch::BIN_ENV
            )),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn discover_body(server_info: Option<Value>) -> String {
        let mut result = serde_json::json!({
            "supportedVersions": [tt_mcp::PROTOCOL_VERSION],
            "capabilities": { "tools": {} },
            "resultType": "complete",
        });
        if let Some(info) = server_info {
            result["_meta"] = serde_json::json!({ tt_mcp::META_SERVER_INFO: info });
        }
        serde_json::json!({ "jsonrpc": "2.0", "id": 1, "result": result }).to_string()
    }

    #[test]
    fn port_source_tells_a_missing_env_from_an_unclaimed_one() {
        assert_eq!(mcp_port_source(None), McpPortSource::NoDotenv);
        assert_eq!(mcp_port_source(Some("TT_DEV_PORT=1424\n")), McpPortSource::Unclaimed);
        assert_eq!(mcp_port_source(Some("")), McpPortSource::Unclaimed);
    }

    #[test]
    fn port_source_reads_a_rendered_claim() {
        let text = "# rendered\nTT_DEV_PORT=1424\nTT_MCP_PORT=8791\n";
        assert_eq!(mcp_port_source(Some(text)), McpPortSource::Claimed(8791));
    }

    /// A value the claim scanner skips is not a port the app binds either.
    #[test]
    fn port_source_rejects_what_the_claim_scanner_rejects() {
        for bad in ["${tt:port 8787-8986}", "eight", "0", "70000", ""] {
            let text = format!("TT_MCP_PORT={bad}\n");
            assert_eq!(mcp_port_source(Some(&text)), McpPortSource::Unclaimed, "{bad:?}");
        }
    }

    #[test]
    fn a_discover_answer_is_serving_with_the_server_named() {
        let body = discover_body(Some(serde_json::json!({
            "name": "towles-tool",
            "version": "0.4.2",
        })));
        let row = classify_mcp_probe(8791, &Probe::Answered { status: 200, body });
        assert!(row.ok);
        assert!(row.warning.is_none() && row.hint.is_none());
        assert_eq!(row.value, "serving on 8791 · towles-tool 0.4.2");
    }

    #[test]
    fn a_discover_answer_without_server_info_still_counts_as_serving() {
        let row =
            classify_mcp_probe(8791, &Probe::Answered { status: 200, body: discover_body(None) });
        assert!(row.ok);
        assert_eq!(row.value, "serving on 8791 · MCP server");
    }

    #[test]
    fn a_200_that_is_not_a_json_rpc_result_is_a_foreign_listener() {
        let body = "<html>hello</html>".to_string();
        let row = classify_mcp_probe(8791, &Probe::Answered { status: 200, body });
        assert!(!row.ok);
        assert!(row.warning.is_none(), "a wrong listener renders red, not amber");
        assert!(row.value.contains("not as an MCP server"), "{}", row.value);
        assert!(row.hint.as_deref().unwrap_or_default().contains("tt task ports"));
    }

    #[test]
    fn a_non_200_names_the_status_and_points_at_the_claims() {
        let body = "not found".to_string();
        let row = classify_mcp_probe(8791, &Probe::Answered { status: 404, body });
        assert!(!row.ok);
        assert_eq!(row.value, "port 8791 answered HTTP 404");
        assert!(row.hint.as_deref().unwrap_or_default().contains("tt task ports"));
    }

    #[test]
    fn connection_refused_is_nobody_serving_with_the_start_hint() {
        let row = classify_mcp_probe(8791, &Probe::Unreachable);
        assert!(!row.ok);
        assert!(row.warning.is_none(), "a down app renders red");
        assert_eq!(row.value, "nobody serving on 8791");
        assert!(row.hint.as_deref().unwrap_or_default().contains("bun start"));
    }

    #[test]
    fn an_unclaimed_port_is_amber_with_the_render_hint() {
        let row = mcp_unclaimed(McpPortSource::NoDotenv, "tt task env primary");
        assert!(!row.ok && row.warning.is_some(), "amber: not ok, with a warning");
        assert_eq!(row.value, "no rendered .env");
        assert!(row.hint.as_deref().unwrap_or_default().contains("tt task env primary"));

        let row = mcp_unclaimed(McpPortSource::Unclaimed, "tt task env feat-x");
        assert_eq!(row.value, "no TT_MCP_PORT in .env");
        assert!(row.hint.as_deref().unwrap_or_default().contains("tt task env feat-x"));
    }

    #[test]
    fn render_env_hint_names_a_task_or_the_primary() {
        let task = PathBuf::from("/repo/.claude/worktrees/feat-doctor");
        assert_eq!(render_env_hint(&task), "tt task env feat-doctor");
        assert_eq!(render_env_hint(Path::new("/repo")), "tt task env primary");
    }

    fn serving_probe() -> Probe {
        let body =
            discover_body(Some(serde_json::json!({ "name": "towles-tool", "version": "1" })));
        Probe::Answered { status: 200, body }
    }

    #[test]
    fn a_bound_port_matching_the_claim_is_one_green_row() {
        let rows = mcp_rows(Some(8791), Some(&serving_probe()), McpPortSource::Claimed(8791), "h");
        assert_eq!(rows.len(), 1);
        assert!(rows[0].ok && rows[0].warning.is_none());
        assert_eq!(rows[0].value, "serving on 8791 · towles-tool 1");
    }

    /// The #687 drive scenario: the instance was up on an inherited 8787 while the
    /// checkout's `.env` claimed 8791 — serving, but not where sessions expect it.
    #[test]
    fn a_bound_port_differing_from_the_claim_adds_an_amber_mismatch_row() {
        let rows = mcp_rows(Some(8787), Some(&serving_probe()), McpPortSource::Claimed(8791), "h");
        assert_eq!(rows.len(), 2);
        assert!(rows[0].ok, "serving is still green");
        let mismatch = &rows[1];
        assert!(!mismatch.ok && mismatch.warning.is_some(), "amber");
        assert_eq!(mismatch.name, MCP_CLAIM_ROW);
        assert_eq!(mismatch.value, "bound 8787 · claims 8791");
        let hint = mismatch.hint.as_deref().unwrap_or_default();
        assert!(
            hint.contains("bound 8787 from the environment; this checkout claims 8791"),
            "{hint}"
        );
        assert!(hint.contains("tt task ports"), "{hint}");
    }

    #[test]
    fn no_bound_port_is_one_red_row_with_the_start_hint() {
        let rows = mcp_rows(None, None, McpPortSource::Claimed(8791), "h");
        assert_eq!(rows.len(), 1);
        assert!(!rows[0].ok && rows[0].warning.is_none(), "red");
        assert_eq!(rows[0].value, "this instance isn't serving");
        assert!(rows[0].hint.as_deref().unwrap_or_default().contains("bun start"));
    }

    #[test]
    fn no_claim_keeps_the_amber_render_row_beside_the_serving_one() {
        let rows = mcp_rows(
            Some(8787),
            Some(&serving_probe()),
            McpPortSource::Unclaimed,
            "tt task env primary",
        );
        assert_eq!(rows.len(), 2);
        assert!(rows[0].ok);
        assert_eq!(rows[1].name, MCP_CLAIM_ROW);
        assert_eq!(rows[1].value, "no TT_MCP_PORT in .env");
        assert!(rows[1].hint.as_deref().unwrap_or_default().contains("tt task env primary"));
    }

    #[test]
    fn outside_a_checkout_there_is_no_claim_row() {
        let rows = mcp_rows(Some(8787), Some(&serving_probe()), McpPortSource::NoCheckout, "");
        assert_eq!(rows.len(), 1);
        assert!(rows[0].ok);
    }

    #[test]
    fn code_server_version_is_the_first_token_of_its_banner() {
        let banner = "4.137.0 b11dabdaca0d3369986975be285db92c8795cea5 with Code 1.137.0\n";
        assert_eq!(super::super::extract_version(banner).as_deref(), Some("4.137.0"));
    }

    #[test]
    fn code_server_present_is_green_with_version_and_path() {
        let bin = PathBuf::from("/data/code-server-dist/4.137.0/bin/code-server");
        let row = code_server_row(Some(&bin), Some("4.137.0".to_string()));
        assert!(row.ok && row.warning.is_none());
        assert_eq!(row.value, "4.137.0");
        assert_eq!(row.hint.as_deref(), Some(bin.to_str().unwrap()));

        let unknown = code_server_row(Some(&bin), None);
        assert_eq!(unknown.value, "found");
    }

    #[test]
    fn code_server_missing_is_amber_with_the_provision_hint() {
        let row = code_server_row(None, None);
        assert!(!row.ok && row.warning.is_some());
        assert_eq!(row.value, "not installed");
        let hint = row.hint.unwrap_or_default();
        assert!(hint.contains(tt_codeserver::install::VERSION), "{hint}");
        assert!(hint.contains("--example provision"), "{hint}");
    }

    #[test]
    fn chrome_rows() {
        let bin = PathBuf::from("/usr/bin/google-chrome");
        let found = chrome_row(Some(&bin));
        assert!(found.ok && found.warning.is_none() && found.hint.is_none());
        assert_eq!(found.value, "/usr/bin/google-chrome");

        let missing = chrome_row(None);
        assert!(!missing.ok && missing.warning.is_some());
        assert_eq!(missing.value, "not found");
        assert!(missing.hint.as_deref().unwrap_or_default().contains("TT_BROWSER_BIN"));
    }

    #[test]
    fn rows_serialize_camel_case_and_omit_absent_fields() {
        let row = chrome_row(Some(Path::new("/usr/bin/chromium")));
        let json = serde_json::to_value(&row).unwrap();
        assert_eq!(json["name"], "Chrome");
        assert!(json.get("warning").is_none() && json.get("hint").is_none());
    }
}
