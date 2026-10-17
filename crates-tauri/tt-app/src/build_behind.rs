//! How far `origin/main` has moved past the commit a from-source build was made
//! from, for the status bar's "rebuild" chip. Only a build whose checkout is
//! still on disk answers; an installed bundle has the update banner instead.
//! Reads `origin/main` as the agentboard's own fetch left it, never fetching.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Notify;

/// Pushed with the new `Option<BuildBehind>` whenever the answer changes.
pub const BUILD_BEHIND_EVENT: &str = "build-behind://changed";

/// The fallback when no fetch nudges: covers a checkout agentboard doesn't track.
const RECHECK_INTERVAL: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildBehind {
    pub commits: u64,
    pub build: String,
}

#[derive(Default)]
pub struct BuildBehindState {
    current: Mutex<Option<BuildBehind>>,
    nudge: Notify,
}

/// The checkout this binary was built in, if it is still on disk. A packaged
/// build's baked-in path belongs to a CI runner, so this is `None` there.
fn source_checkout() -> Option<PathBuf> {
    tt_config::checkout_root_from_dir(Path::new(env!("CARGO_MANIFEST_DIR")))
}

/// `None` unless `origin/main` is ahead of `sha`: zero is nothing to show, an
/// unknown `sha` or a missing `origin/main` is nothing to say.
fn behind(checkout: &Path, sha: &str) -> Option<BuildBehind> {
    let repo = tt_git::repo::open(checkout).ok()?;
    let commits = repo.commits_beyond(sha, "origin/main").filter(|n| *n > 0)?;
    Some(BuildBehind { commits, build: sha.chars().take(7).collect() })
}

/// Re-read now; call after a fetch moved `origin/main`.
pub fn nudge(app: &AppHandle) {
    app.state::<BuildBehindState>().nudge.notify_one();
}

pub fn spawn(app: AppHandle) {
    if crate::update::is_installed_bundle() {
        return;
    }
    let Some(checkout) = source_checkout() else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        loop {
            let dir = checkout.clone();
            let found =
                tauri::async_runtime::spawn_blocking(move || behind(&dir, tt_telemetry::BUILD_SHA))
                    .await
                    .unwrap_or(None);
            let state = app.state::<BuildBehindState>();
            let changed = {
                let mut current = state.current.lock().unwrap();
                let changed = *current != found;
                *current = found.clone();
                changed
            };
            if changed {
                let _ = app.emit(BUILD_BEHIND_EVENT, &found);
            }
            let _ = tokio::time::timeout(RECHECK_INTERVAL, state.nudge.notified()).await;
        }
    });
}

#[tauri::command]
pub fn build_behind(state: State<'_, BuildBehindState>) -> Option<BuildBehind> {
    state.current.lock().unwrap().clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tt_git::testing::git;

    fn repo_with_main_moved(by: usize) -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        git(dir.path(), &["init", "--quiet", "-b", "main"]);
        git(dir.path(), &["commit", "--quiet", "--allow-empty", "-m", "built"]);
        let built = git(dir.path(), &["rev-parse", "HEAD"]);
        for _ in 0..by {
            git(dir.path(), &["commit", "--quiet", "--allow-empty", "-m", "next"]);
        }
        git(dir.path(), &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        (dir, built)
    }

    #[test]
    fn reports_the_commits_main_gained_with_a_short_build() {
        let (dir, built) = repo_with_main_moved(3);
        let found = behind(dir.path(), &built).expect("behind");
        assert_eq!(found, BuildBehind { commits: 3, build: built[..7].to_string() });
    }

    #[test]
    fn says_nothing_when_up_to_date_or_the_sha_is_unknown() {
        let (dir, _) = repo_with_main_moved(0);
        let head = git(dir.path(), &["rev-parse", "HEAD"]);
        assert_eq!(behind(dir.path(), &head), None);
        assert_eq!(behind(dir.path(), "unknown"), None);
    }

    #[test]
    fn says_nothing_without_an_origin_main() {
        let (dir, built) = repo_with_main_moved(2);
        git(dir.path(), &["update-ref", "-d", "refs/remotes/origin/main"]);
        assert_eq!(behind(dir.path(), &built), None);
    }
}
