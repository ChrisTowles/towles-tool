//! Self-update through `tauri-plugin-updater`: poll the signed `latest.json` of
//! the chosen channel, offer what it finds on the update banner, and on the
//! user's click download, install and relaunch. The stable channel reads the
//! newest published release; the main channel reads the `main-build`
//! prerelease every push to main refreshes. An install records what it
//! replaced, so Settings can roll back to that release. Only an installed
//! bundle updates itself — a from-source build (`bun start`) moves forward
//! with `git pull`, so it never checks.

use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, Url};
use tauri_plugin_updater::{RemoteRelease, Update, UpdaterExt};
use tt_config::UpdateChannel;

use crate::instance_lock::InstanceLock;

/// Pushed with an [`UpdateInfo`] whenever a check finds a newer build.
pub const UPDATE_AVAILABLE_EVENT: &str = "update://available";
/// Pushed when a check finds nothing, so a banner from another channel clears.
pub const UPDATE_CLEARED_EVENT: &str = "update://cleared";
/// Pushed with an [`UpdateProgress`] per downloaded chunk during an install.
pub const UPDATE_PROGRESS_EVENT: &str = "update://progress";

/// The app runs for days, so one check at startup would go stale.
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

const RELEASES: &str = "https://github.com/ChrisTowles/towles-tool/releases";
/// The rolling prerelease `main-build.yml` re-uploads on every push to main.
const MAIN_BUILD_TAG: &str = "main-build";

/// The build a check found, held for [`update_install`].
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
    /// The commit a main-channel build was made from; main builds share a
    /// version, so this is what tells them apart.
    pub build: Option<String>,
}

impl UpdateInfo {
    fn of(update: &Update) -> Self {
        Self {
            current_version: update.current_version.clone(),
            version: update.version.clone(),
            build: main_build_sha(update.body.as_deref()).map(short_sha),
        }
    }

    fn key(&self) -> String {
        format!("{}@{}", self.version, self.build.as_deref().unwrap_or(""))
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

/// What the last install replaced. Written on install, cleared on rollback so
/// the button can't ping-pong between two builds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateHistory {
    previous_version: String,
}

/// What Settings → General shows under "Updates".
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// False for a from-source build, which never checks or installs.
    pub installed: bool,
    pub current_version: String,
    pub build: String,
    pub channel: UpdateChannel,
    /// The release a rollback would install, when an install recorded one.
    pub rollback_to: Option<String>,
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

fn channel_endpoint(channel: UpdateChannel) -> String {
    match channel {
        UpdateChannel::Stable => format!("{RELEASES}/latest/download/latest.json"),
        UpdateChannel::Main => format!("{RELEASES}/download/{MAIN_BUILD_TAG}/latest.json"),
    }
}

fn release_endpoint(version: &str) -> String {
    format!("{RELEASES}/download/v{version}/latest.json")
}

/// The workflow stamps the commit into a main build's `latest.json` notes.
fn main_build_sha(notes: Option<&str>) -> Option<&str> {
    notes.map(str::trim).filter(|sha| sha.len() >= 7 && sha.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn short_sha(sha: &str) -> String {
    sha.chars().take(7).collect()
}

/// Main builds share a version, so a different commit is the newer build.
/// Notes without a commit (a half-published build) offer nothing.
fn main_build_is_new(notes: Option<&str>, own_sha: &str) -> bool {
    main_build_sha(notes).is_some_and(|sha| sha != own_sha)
}

fn current_channel() -> UpdateChannel {
    tt_config::load().map(|s| s.updates.channel).unwrap_or_default()
}

fn read_history() -> Option<UpdateHistory> {
    let path = tt_config::update_history_path().ok()?;
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn write_history(history: Option<&UpdateHistory>) {
    let Ok(path) = tt_config::update_history_path() else {
        return;
    };
    let result = match history {
        Some(h) => path
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| std::fs::write(&path, serde_json::to_vec(h).unwrap_or_default())),
        None => match std::fs::remove_file(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other,
        },
    };
    if let Err(e) = result {
        tracing::warn!(error = %e, "update.history_write_failed");
    }
}

fn endpoint_url(raw: &str) -> tauri_plugin_updater::Result<Url> {
    Ok(Url::parse(raw)?)
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
                Ok(Some(info)) if notified.as_ref() != Some(&info.key()) => {
                    notify(&app, &info);
                    notified = Some(info.key());
                }
                Ok(_) => {}
                Err(e) => tracing::warn!(error = %e, "update.check_failed"),
            }
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

async fn check(app: &AppHandle) -> tauri_plugin_updater::Result<Option<UpdateInfo>> {
    let channel = current_channel();
    let mut builder =
        app.updater_builder().endpoints(vec![endpoint_url(&channel_endpoint(channel))?])?;
    if channel == UpdateChannel::Main {
        builder = builder.version_comparator(|_current, remote: RemoteRelease| {
            main_build_is_new(remote.notes.as_deref(), tt_telemetry::BUILD_SHA)
        });
    }
    let found = builder.build()?.check().await?;
    let pending = app.state::<PendingUpdate>();
    let Some(update) = found else {
        if pending.0.lock().unwrap().take().is_some() {
            let _ = app.emit(UPDATE_CLEARED_EVENT, ());
        }
        return Ok(None);
    };
    let info = UpdateInfo::of(&update);
    *pending.0.lock().unwrap() = Some(update);
    let _ = app.emit(UPDATE_AVAILABLE_EVENT, &info);
    Ok(Some(info))
}

fn notify(app: &AppHandle, info: &UpdateInfo) {
    use tauri_plugin_notification::NotificationExt;
    let label = match &info.build {
        Some(build) => format!("main build {build}"),
        None => info.version.clone(),
    };
    let _ = app
        .notification()
        .builder()
        .title("Towles Tool update available")
        .body(format!("{label} is ready to install — you're on {}", info.current_version))
        .show();
}

/// The build a check already found, for a banner mounted after its event.
#[tauri::command]
pub fn update_pending(pending: State<'_, PendingUpdate>) -> Option<UpdateInfo> {
    pending.0.lock().unwrap().as_ref().map(UpdateInfo::of)
}

#[tauri::command]
pub fn update_status(app: AppHandle) -> UpdateStatus {
    let installed = is_installed_bundle();
    UpdateStatus {
        installed,
        current_version: app.package_info().version.to_string(),
        build: short_sha(tt_telemetry::BUILD_SHA),
        channel: current_channel(),
        rollback_to: installed.then(read_history).flatten().map(|h| h.previous_version),
    }
}

/// Check the saved channel now — Settings calls it after switching channels,
/// so the banner reflects the new channel without waiting six hours.
#[tauri::command]
pub async fn update_check_now(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    if !is_installed_bundle() {
        return Err("a from-source build updates with git pull".into());
    }
    let channel = current_channel();
    let result = check(&app).await;
    let outcome = match &result {
        Ok(Some(_)) => "found",
        Ok(None) => "up_to_date",
        Err(_) => "failed",
    };
    tracing::info!(?channel, outcome, "update.checked");
    result.map_err(|e| e.to_string())
}

/// Download and install the pending build, then relaunch into it. Running
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
    let previous = UpdateHistory { previous_version: update.current_version.clone() };
    install(&app, &update, "update.install").await?;
    write_history(Some(&previous));
    restart(&app, &lock)
}

/// Reinstall the release the last install replaced. The downgrade needs its
/// own comparator: the default one only ever moves forward.
#[tauri::command]
pub async fn update_rollback(
    app: AppHandle,
    lock: State<'_, AppInstanceLock>,
) -> Result<(), String> {
    let Some(history) = read_history() else {
        return Err("no earlier install is recorded".into());
    };
    let found = async {
        app.updater_builder()
            .endpoints(vec![endpoint_url(&release_endpoint(&history.previous_version))?])?
            .version_comparator(|_, _| true)
            .build()?
            .check()
            .await
    }
    .await
    .map_err(|e| e.to_string())?;
    let Some(update) = found else {
        return Err(format!("release {} has no update manifest", history.previous_version));
    };
    install(&app, &update, "update.rollback").await?;
    write_history(None);
    restart(&app, &lock)
}

async fn install(app: &AppHandle, update: &Update, event: &'static str) -> Result<(), String> {
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
        tracing::warn!(version = %update.version, outcome = "failed", error = %e, "{event}");
        return Err(e.to_string());
    }
    tracing::info!(version = %update.version, outcome = "installed", "{event}");
    Ok(())
}

fn restart(app: &AppHandle, lock: &State<'_, AppInstanceLock>) -> ! {
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

    #[test]
    fn each_channel_reads_its_own_manifest() {
        assert!(
            channel_endpoint(UpdateChannel::Stable)
                .ends_with("/releases/latest/download/latest.json")
        );
        assert!(
            channel_endpoint(UpdateChannel::Main).ends_with("/download/main-build/latest.json")
        );
        assert!(release_endpoint("0.2.0").ends_with("/download/v0.2.0/latest.json"));
    }

    #[test]
    fn a_main_build_is_new_only_when_its_commit_differs() {
        let own = "49666964aaaabbbbccccddddeeeeffff00001111";
        let other = "68349f5a1111222233334444555566667777aaaa";
        assert!(main_build_is_new(Some(other), own));
        assert!(main_build_is_new(Some(&format!("  {other}\n")), own));
        assert!(!main_build_is_new(Some(own), own));
        assert!(!main_build_is_new(None, own), "no commit stamped yet");
        assert!(!main_build_is_new(Some("Towles Tool v0.2.0"), own), "release notes aren't a sha");
    }

    #[test]
    fn update_info_names_a_main_build_by_its_short_commit() {
        assert_eq!(main_build_sha(Some("68349f5a1111")).map(short_sha).as_deref(), Some("68349f5"));
        assert_eq!(main_build_sha(Some("abc")), None, "too short to be a commit");
    }

    #[test]
    fn history_round_trips_camel_case() {
        let h = UpdateHistory { previous_version: "0.2.0".to_string() };
        let json = serde_json::to_string(&h).unwrap();
        assert_eq!(json, r#"{"previousVersion":"0.2.0"}"#);
        assert_eq!(serde_json::from_str::<UpdateHistory>(&json).unwrap(), h);
    }
}
