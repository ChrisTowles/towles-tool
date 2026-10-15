//! Self-update through `tauri-plugin-updater`: poll the signed `latest.json`
//! the release workflow attaches to the newest GitHub release, offer what it
//! finds on the update banner, and on the user's click download, install and
//! relaunch. Only an installed bundle updates itself — a from-source build
//! (`bun start`) moves forward with `git pull`, so it never checks.

use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::instance_lock::InstanceLock;

/// Pushed with an [`UpdateInfo`] whenever a check finds a newer release.
pub const UPDATE_AVAILABLE_EVENT: &str = "update://available";
/// Pushed with an [`UpdateProgress`] per downloaded chunk during an install.
pub const UPDATE_PROGRESS_EVENT: &str = "update://progress";

/// The app runs for days, so one check at startup would go stale.
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// The release a check found, held for [`update_install`].
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

/// This checkout's single-instance lock, held here so an update can release it
/// before relaunching: the new process would otherwise find it still held by
/// the old one and exit as "already running".
pub struct AppInstanceLock(pub Mutex<Option<InstanceLock>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub version: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

/// Whether this binary was installed from a release bundle the updater can
/// replace. On Linux the bundler stamps the bundle type into the binary; macOS
/// reports `App` unconditionally, so there the exe must sit inside a `.app`.
fn is_installed_bundle() -> bool {
    if cfg!(target_os = "macos") {
        std::env::current_exe().is_ok_and(|exe| is_inside_app_bundle(&exe))
    } else {
        tauri::utils::platform::bundle_type().is_some()
    }
}

fn is_inside_app_bundle(exe: &Path) -> bool {
    let mut dirs = exe.ancestors().skip(1).map(|p| p.file_name().and_then(|n| n.to_str()));
    dirs.next() == Some(Some("MacOS"))
        && dirs.next() == Some(Some("Contents"))
        && dirs.next().flatten().is_some_and(|n| n.ends_with(".app"))
}

/// Check now and every [`CHECK_INTERVAL`] after. Failures (offline, GitHub
/// down) are logged and dropped — a background check must never nag.
pub fn spawn_checks(app: AppHandle) {
    if !is_installed_bundle() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut notified: Option<String> = None;
        loop {
            match check(&app).await {
                Ok(Some(info)) if notified.as_ref() != Some(&info.version) => {
                    notify(&app, &info);
                    notified = Some(info.version);
                }
                Ok(_) => {}
                Err(e) => tracing::warn!(error = %e, "update.check_failed"),
            }
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

async fn check(app: &AppHandle) -> tauri_plugin_updater::Result<Option<UpdateInfo>> {
    let Some(update) = app.updater()?.check().await? else {
        return Ok(None);
    };
    let info = UpdateInfo {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
    };
    *app.state::<PendingUpdate>().0.lock().unwrap() = Some(update);
    let _ = app.emit(UPDATE_AVAILABLE_EVENT, &info);
    Ok(Some(info))
}

fn notify(app: &AppHandle, info: &UpdateInfo) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title("Towles Tool update available")
        .body(format!("{} is ready to install — you're on {}", info.version, info.current_version))
        .show();
}

/// The release a check already found, for a banner mounted after its event.
#[tauri::command]
pub fn update_pending(pending: State<'_, PendingUpdate>) -> Option<UpdateInfo> {
    pending.0.lock().unwrap().as_ref().map(|u| UpdateInfo {
        current_version: u.current_version.clone(),
        version: u.version.clone(),
    })
}

/// Download and install the pending release, then relaunch into it. Running
/// terminals end with this process; the resume picker offers them back.
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
    lock: State<'_, AppInstanceLock>,
) -> Result<(), String> {
    let Some(update) = pending.0.lock().unwrap().clone() else {
        return Err("no update is pending".into());
    };
    let mut downloaded = 0u64;
    let result = update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = app.emit(UPDATE_PROGRESS_EVENT, UpdateProgress { downloaded, total });
            },
            || {},
        )
        .await;
    if let Err(e) = result {
        tracing::warn!(version = %update.version, outcome = "failed", error = %e, "update.install");
        return Err(e.to_string());
    }
    tracing::info!(version = %update.version, outcome = "installed", "update.install");
    lock.0.lock().unwrap().take();
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_exe_inside_a_dot_app_counts_as_a_bundle() {
        assert!(is_inside_app_bundle(Path::new(
            "/Applications/Towles Tool.app/Contents/MacOS/tt-app"
        )));
        assert!(!is_inside_app_bundle(Path::new("/repo/target/release/tt-app")));
        assert!(!is_inside_app_bundle(Path::new("/x/Contents/MacOS/tt-app")));
        assert!(!is_inside_app_bundle(Path::new("tt-app")));
    }
}
