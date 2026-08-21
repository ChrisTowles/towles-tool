//! code-server host for the editor pane (spike — docs/CODE-SERVER-SPIKE.md).
//!
//! One process per app instance, started lazily on the first pane and dropped
//! with the host; every folder is a URL against it, so opening a second
//! checkout costs an iframe, not a server. Launch blocks on the child's first
//! log line, so the commands are async and never run on the GTK main thread.

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::State;
use tt_codeserver::{CodeServerChild, CodeServerConfig, find_code_server, folder_url};

#[derive(Default)]
pub struct CodeServerHost {
    child: Mutex<Option<CodeServerChild>>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeServerInfo {
    pub url: String,
    pub port: u16,
    pub binary: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeServerStatus {
    pub running: bool,
    pub port: Option<u16>,
    /// Absent means the binary is missing — the one failure worth its own UI.
    pub binary: Option<String>,
}

/// Whether a code-server exists to embed, without starting one.
#[tauri::command]
pub fn code_server_status(state: State<CodeServerHost>) -> CodeServerStatus {
    let mut guard = state.child.lock().expect("code-server host poisoned");
    let running = guard.as_mut().is_some_and(CodeServerChild::is_running);
    CodeServerStatus {
        running,
        port: running.then(|| guard.as_ref().map(|c| c.port)).flatten(),
        binary: find_code_server(None).map(|p| p.display().to_string()),
    }
}

/// The workbench URL for `dir`, starting the server if this is the first pane.
/// A child that died since the last call is replaced rather than reported.
#[tauri::command]
pub async fn code_server_open(
    state: State<'_, CodeServerHost>,
    dir: String,
) -> Result<CodeServerInfo, String> {
    let folder = PathBuf::from(&dir);
    if !folder.is_dir() {
        return Err(format!("not a directory: {dir}"));
    }
    let binary = find_code_server(None)
        .ok_or_else(|| tt_codeserver::CodeServerError::NoBinary.to_string())?;

    let mut guard = state.child.lock().map_err(|_| "code-server host poisoned".to_string())?;
    if !guard.as_mut().is_some_and(CodeServerChild::is_running) {
        let cfg = CodeServerConfig {
            binary: binary.clone(),
            user_data_dir: tt_config::code_server_user_data_dir().map_err(|e| e.to_string())?,
            extensions_dir: tt_config::code_server_extensions_dir().map_err(|e| e.to_string())?,
            config_file: tt_config::code_server_user_data_dir()
                .map_err(|e| e.to_string())?
                .join("config.yaml"),
        };
        *guard = Some(CodeServerChild::launch(&cfg).map_err(|e| e.to_string())?);
    }
    let child = guard.as_ref().ok_or_else(|| "code-server not running".to_string())?;
    Ok(CodeServerInfo {
        url: folder_url(child.port, &folder),
        port: child.port,
        binary: binary.display().to_string(),
    })
}

/// Stop the server. Every pane's iframe goes dead, by design — the panes are
/// views over one process, so this is the "restart the editor" gesture.
#[tauri::command]
pub async fn code_server_stop(state: State<'_, CodeServerHost>) -> Result<(), String> {
    let mut guard = state.child.lock().map_err(|_| "code-server host poisoned".to_string())?;
    if let Some(mut child) = guard.take() {
        child.shutdown();
    }
    Ok(())
}
