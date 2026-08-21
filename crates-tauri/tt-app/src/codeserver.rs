//! code-server host for the Files pane (docs/CODE-SERVER.md).
//!
//! One process per app instance, started lazily on the first pane and dropped
//! with the host; every folder is a URL against it, so opening a second
//! checkout costs an iframe, not a server. Launch blocks on the child's first
//! log line and a reveal polls a socket, so both run on blocking threads and
//! never on the GTK main thread.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, State};
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
    Ok(CodeServerConfig {
        binary,
        config_file: user_data_dir.join("config.yaml"),
        user_data_dir,
        extensions_dir: tt_config::code_server_extensions_dir().map_err(|e| e.to_string())?,
        session_socket: tt_config::code_server_session_socket(),
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
