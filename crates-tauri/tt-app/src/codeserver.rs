//! code-server host for the Files pane (docs/CODE-SERVER.md).
//!
//! One process per app instance, started lazily on the first pane and dropped
//! with the host; every folder is a URL against it, so opening a second
//! checkout costs an iframe, not a server. Launch blocks on the child's first
//! log line and a reveal polls a socket, so both run on blocking threads and
//! never on the GTK main thread.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Emitter, State};
use tt_codeserver::bridge;
use tt_codeserver::install::{self, Phase, Progress};
use tt_codeserver::{CodeServerChild, CodeServerConfig, find_code_server, workbench_url};

use crate::ide::MAIN_WINDOW_LABEL;

/// Progress while the app provisions code-server for itself. The pane renders
/// it in place of "Starting…", because the first one takes minutes.
pub const INSTALL_EVENT: &str = "code-server://install";

#[derive(Default)]
pub struct CodeServerHost {
    child: Arc<Mutex<Option<CodeServerChild>>>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeServerInfo {
    pub url: String,
    pub port: u16,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallEvent {
    phase: &'static str,
    done_bytes: u64,
    total_bytes: u64,
}

/// Where a `window.open` out of a pane lands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Popup {
    /// A webview beside the one that asked, sharing its session.
    Webview,
    Browser,
    Dropped,
}

/// Path segments an OAuth round-trip has and a page you were sent to read does
/// not. Both `authorize` and `auth`: providers split either way.
const AUTH_SEGMENTS: [&str; 10] = [
    "auth",
    "authorize",
    "authorization",
    "callback",
    "consent",
    "login",
    "oauth",
    "oauth2",
    "signin",
    "sso",
];

/// Sign-in is the one reason a popup must stay in the app: its round-trip ends
/// at `/callback.html` on the workbench's own origin and hands back through that
/// origin's `localStorage`. A marketplace listing or a README is a page to
/// *read*, and a chrome-less webview is the wrong window for it. Guessed from
/// the URL: wry hands the Linux handler `size: None` whatever the opener passed.
pub(crate) fn popup_route(url: &tauri::Url) -> Popup {
    // `window.open("about:blank")` then assign `location`, as MSAL does. Nobody
    // sends you to a blank page to read it.
    if url.scheme() == "about" {
        return Popup::Webview;
    }
    if !matches!(url.scheme(), "http" | "https") {
        return Popup::Dropped;
    }
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    let auth = url.path_segments().is_some_and(|mut s| {
        s.any(|seg| AUTH_SEGMENTS.contains(&seg.to_ascii_lowercase().as_str()))
    });
    if loopback || auth { Popup::Webview } else { Popup::Browser }
}

/// Only the host is logged: an authorize URL carries the flow's secrets.
pub(crate) fn on_new_window<R: tauri::Runtime>(url: tauri::Url) -> NewWindowResponse<R> {
    let route = popup_route(&url);
    tracing::info!(host = url.host_str().unwrap_or_default(), ?route, "webview.new_window");
    if route == Popup::Browser
        && let Err(e) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>)
    {
        tracing::warn!(error = %e, "webview.new_window.open-failed");
    }
    match route {
        Popup::Webview => NewWindowResponse::Allow,
        Popup::Browser | Popup::Dropped => NewWindowResponse::Deny,
    }
}

/// The code-server to launch: whatever the machine already has, else one this
/// app downloads and unpacks (docs/CODE-SERVER.md). Blocking, minutes long on
/// a first install — callers are already on a blocking thread.
fn binary(app: &AppHandle) -> Result<PathBuf, String> {
    let root = tt_config::code_server_install_dir().map_err(|e| e.to_string())?;
    if let Some(bin) = find_code_server(None, Some(&root)) {
        return Ok(bin);
    }
    // One event per whole percent: 235 MB in 1 MiB reads is ~230 emits either
    // way, and a progress bar can't show more than that.
    let mut last = u64::MAX;
    let bin = install::ensure(&root, &mut |p: Progress| {
        let percent = p.done_bytes * 100 / p.total_bytes.max(1);
        if percent == last && p.phase == Phase::Downloading {
            return;
        }
        last = percent;
        let _ = app.emit_to(
            MAIN_WINDOW_LABEL,
            INSTALL_EVENT,
            InstallEvent {
                phase: match p.phase {
                    Phase::Downloading => "downloading",
                    Phase::Verifying => "verifying",
                    Phase::Unpacking => "unpacking",
                },
                done_bytes: p.done_bytes,
                total_bytes: p.total_bytes,
            },
        );
    })
    .map_err(|e| e.to_string())?;
    tracing::info!(binary = %bin.display(), "code-server.install.done");
    Ok(bin)
}

fn config(binary: PathBuf) -> Result<CodeServerConfig, String> {
    let user_data_dir = tt_config::code_server_user_data_dir().map_err(|e| e.to_string())?;
    let root = tt_config::code_server_install_dir().map_err(|e| e.to_string())?;
    Ok(CodeServerConfig {
        builtin_extensions_dir: install::builtin_extensions_dir(&root, &binary),
        binary,
        config_file: user_data_dir.join("config.yaml"),
        user_data_dir,
        extensions_dir: tt_config::code_server_extensions_dir().map_err(|e| e.to_string())?,
        shared_user_dir: tt_config::code_server_shared_user_dir().map_err(|e| e.to_string())?,
        session_socket: tt_config::code_server_session_socket(),
        bridge_dir: tt_config::code_server_bridge_dir(),
    })
}

/// The port of the running server, starting one if there is none. A child that
/// died since the last call is replaced rather than reported.
fn running_port(app: &AppHandle, child: &Mutex<Option<CodeServerChild>>) -> Result<u16, String> {
    let mut guard = child.lock().map_err(|_| "code-server host poisoned".to_string())?;
    if !guard.as_mut().is_some_and(CodeServerChild::is_running) {
        let cfg = config(binary(app)?)?;
        *guard = Some(CodeServerChild::launch(&cfg).map_err(|e| e.to_string())?);
    }
    guard.as_ref().map(|c| c.port).ok_or_else(|| "code-server not running".to_string())
}

/// The workbench URL for `dir`, starting the server if this is the first pane.
/// A checkout-relative `path` rides the URL so the workbench opens it as it
/// boots — the only way to open a file in a workbench that doesn't exist yet.
#[tauri::command]
pub async fn code_server_open(
    app: AppHandle,
    state: State<'_, CodeServerHost>,
    dir: String,
    path: Option<String>,
    line: Option<u32>,
) -> Result<CodeServerInfo, String> {
    let folder = PathBuf::from(&dir);
    if !folder.is_dir() {
        return Err(format!("not a directory: {dir}"));
    }
    let child = Arc::clone(&state.child);
    let port = tauri::async_runtime::spawn_blocking(move || running_port(&app, &child))
        .await
        .map_err(|e| format!("code-server launch task failed: {e}"))??;
    let file = path.map(|p| folder.join(p));
    let open = file.as_deref().map(|f| (f, line));
    Ok(CodeServerInfo { url: workbench_url(port, &folder, open), port })
}

/// Open a checkout-relative `path` in the workbench already running for `dir`.
#[tauri::command]
pub async fn code_server_reveal(
    state: State<'_, CodeServerHost>,
    dir: String,
    path: String,
    line: Option<u32>,
) -> Result<(), String> {
    let (port, registry) = {
        let mut guard = state.child.lock().map_err(|_| "code-server host poisoned".to_string())?;
        let Some(child) = guard.as_mut() else {
            return Err("code-server is not running".to_string());
        };
        if !child.is_running() {
            return Err("code-server is not running".to_string());
        }
        (child.port, child.session_socket.clone())
    };
    let file = PathBuf::from(&dir).join(&path);
    tracing::debug!(dir = %dir, path = %path, line = line.unwrap_or(0), "code_server.reveal");
    tauri::async_runtime::spawn_blocking(move || {
        tt_codeserver::reveal(&registry, port, &file, line).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("code-server reveal task failed: {e}"))?
}

/// Put a checkout's uncommitted work on screen in its own workbench, through the
/// bridge extension — code-server's CLI cannot run a command (docs/CODE-SERVER.md).
/// Takes no lock and does not check the host: the click that calls this usually
/// opens the pane too, so the server is *about* to exist and [`bridge::show`]
/// waits for the workbench on the far end.
#[tauri::command]
pub async fn code_server_show_changes(dir: String) -> Result<(), String> {
    let bridge_dir = tt_config::code_server_bridge_dir();
    let folder = PathBuf::from(&dir);
    tracing::debug!(dir = %dir, "code_server.show_changes");
    tauri::async_runtime::spawn_blocking(move || {
        bridge::show(&bridge_dir, &folder).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("code-server show-changes task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::{Popup, popup_route};

    fn route(url: &str) -> Popup {
        popup_route(&url.parse().unwrap())
    }

    #[test]
    fn a_sign_in_stays_in_the_app() {
        for url in [
            "about:blank",
            "https://github.com/login/oauth/authorize?client_id=x",
            "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
            "https://accounts.google.com/o/oauth2/v2/auth",
            "https://tenant.auth0.com/authorize?scope=openid",
            "http://127.0.0.1:9/callback.html",
        ] {
            assert_eq!(route(url), Popup::Webview, "{url}");
        }
    }

    #[test]
    fn a_page_to_read_goes_to_the_browser() {
        for url in [
            "https://open-vsx.org/extension/vscodevim/vim",
            "https://github.com/microsoft/vscode",
            "https://code.visualstudio.com/docs/editor/extension-marketplace",
        ] {
            assert_eq!(route(url), Popup::Browser, "{url}");
        }
    }

    #[test]
    fn nothing_else_opens_at_all() {
        for url in [
            "file:///etc/passwd",
            "vscode://anthropic.claude-code/auth",
            "data:text/html,x",
        ] {
            assert_eq!(route(url), Popup::Dropped, "{url}");
        }
    }
}
