//! Compiler-diagnostics hub for the Claude Code IDE bridge (no LSP):
//! per-folder `cargo check --message-format=json` + `tsc` runs (the project's
//! own `node_modules/.bin/tsc`, never `npx`),
//! parsed by `tt_ide::diagnostics` into the `getDiagnostics` wire shape and
//! pushed to connected CLIs as `diagnostics_changed` staleness signals.
//!
//! Requests come from a CLI connecting (runs at once) and the git-stat poll
//! seeing a tree change (waits out `tt_ide::check_backoff` while results repeat).
//! Each is debounced per folder and run one folder at a time — a check is real
//! CPU. A folder with no *connected* Claude session is skipped: no reader, no run.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};

use crate::terminal::TermState;

/// Quiet gap after the last refresh request before a folder's checks run.
const DEBOUNCE: Duration = Duration::from_secs(2);
/// A cold `cargo check` on a big workspace is minutes, not seconds.
const CARGO_TIMEOUT: Duration = Duration::from_secs(300);
const TSC_TIMEOUT: Duration = Duration::from_secs(180);
/// How deep under the folder root to look for `tsconfig.json` projects
/// (this repo's lives at `apps/client/`), and how many to run.
const TSCONFIG_DEPTH: usize = 2;
const TSCONFIG_CAP: usize = 4;

pub struct DiagHub {
    /// Latest wire payload (`[{uri, diagnostics}]`) per folder.
    results: Mutex<HashMap<PathBuf, Value>>,
    backoff: Mutex<tt_ide::check_backoff::CheckBackoff>,
    /// `(folder, now)`: `now` skips the backoff.
    tx: UnboundedSender<(PathBuf, bool)>,
}

impl DiagHub {
    /// Start the manager task and hand back the shared handle (managed as
    /// Tauri state; terminal IDE servers query it per message).
    pub fn spawn(app: AppHandle) -> Arc<DiagHub> {
        let (tx, mut rx) = unbounded_channel::<(PathBuf, bool)>();
        let hub = Arc::new(DiagHub {
            results: Mutex::new(HashMap::new()),
            backoff: Mutex::new(Default::default()),
            tx,
        });
        let task_hub = hub.clone();
        tauri::async_runtime::spawn(async move {
            use tokio::time::{Instant, sleep_until};
            let mut pending: HashMap<PathBuf, (Instant, bool)> = HashMap::new();
            loop {
                let next_due = pending.values().map(|(at, _)| *at).min();
                tokio::select! {
                    request = rx.recv() => {
                        let Some((folder, now)) = request else { return };
                        let forced = now || pending.get(&folder).is_some_and(|(_, f)| *f);
                        pending.insert(folder, (Instant::now() + DEBOUNCE, forced));
                    }
                    () = async {
                        match next_due {
                            Some(deadline) => sleep_until(deadline).await,
                            None => std::future::pending().await,
                        }
                    } => {
                        let now = Instant::now();
                        let due: Vec<(PathBuf, bool)> = pending
                            .iter()
                            .filter(|(_, (deadline, _))| *deadline <= now)
                            .map(|(folder, (_, forced))| (folder.clone(), *forced))
                            .collect();
                        for (folder, forced) in due {
                            pending.remove(&folder);
                            let wait = task_hub.backoff_wait(&folder);
                            if !forced && !wait.is_zero() {
                                pending.insert(folder, (now + wait, false));
                                continue;
                            }
                            task_hub.run_folder(&app, folder).await;
                        }
                    }
                }
            }
        });
        hub
    }

    /// Ask for a (debounced) refresh of `folder`'s diagnostics after its tree changed.
    pub fn request(&self, folder: &Path) {
        let _ = self.tx.send((folder.to_path_buf(), false));
    }

    /// Ask for a (debounced) refresh that skips the backoff — a reader wants it now.
    pub fn request_now(&self, folder: &Path) {
        let _ = self.tx.send((folder.to_path_buf(), true));
    }

    fn backoff_wait(&self, folder: &Path) -> Duration {
        let now = tt_config::now_ms();
        let allowed = self.backoff.lock().unwrap().next_allowed_ms(folder, now);
        Duration::from_millis((allowed - now).max(0) as u64)
    }

    /// The folder's latest diagnostics in wire shape — what the IDE server
    /// feeds `getDiagnostics`. Empty array before the first completed run.
    pub fn wire_for(&self, folder: &Path) -> Value {
        self.results
            .lock()
            .unwrap()
            .get(folder)
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new()))
    }

    /// Run every applicable checker for `folder`, store the result, and
    /// signal staleness to that folder's connected CLIs.
    async fn run_folder(&self, app: &AppHandle, folder: PathBuf) {
        let mut connected = false;
        app.state::<TermState>().for_ide_servers(&folder, |s| connected |= s.connected());
        if !connected {
            return;
        }

        let run_dir = folder.clone();
        let Ok(by_file) = tauri::async_runtime::spawn_blocking(move || run_checks(&run_dir)).await
        else {
            return;
        };
        let wire = tt_ide::diagnostics::to_wire(&by_file);

        // Staleness covers files whose diagnostics appeared, changed, OR went
        // away — signal the union of old and new uris.
        let mut uris: Vec<String> = wire_uris(&wire);
        {
            let mut results = self.results.lock().unwrap();
            let previous = results.get(&folder);
            let changed = previous != Some(&wire);
            if let Some(previous) = previous {
                for uri in wire_uris(previous) {
                    if !uris.contains(&uri) {
                        uris.push(uri);
                    }
                }
            }
            self.backoff.lock().unwrap().record(&folder, changed, tt_config::now_ms());
            results.insert(folder.clone(), wire);
        }
        if !uris.is_empty() {
            app.state::<TermState>().for_ide_servers(&folder, |s| s.notify_diagnostics(&uris));
        }
    }
}

fn wire_uris(wire: &Value) -> Vec<String> {
    wire.as_array()
        .map(|entries| {
            entries
                .iter()
                .filter_map(|e| e.get("uri").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Run cargo and/or tsc for whatever project files exist under `folder`,
/// merging per-file results. Subprocess failures degrade to empty output —
/// a broken toolchain must never wedge the hub — but a non-zero exit that
/// yields no diagnostics is logged as `diagnostics.check_failed`.
fn run_checks(folder: &Path) -> tt_ide::diagnostics::DiagnosticsByFile {
    let mut maps = Vec::new();

    if folder.join("Cargo.toml").exists() {
        let out = tt_exec::run_in_dir_with_timeout(
            "cargo",
            &["check", "--workspace", "--message-format=json", "--quiet"],
            folder,
            CARGO_TIMEOUT,
        );
        if let Ok(out) = out {
            let map = tt_ide::diagnostics::parse_cargo_json(&out.stdout, folder);
            report_if_silent_failure(folder, "cargo", out.exit_code, &map);
            maps.push(map);
        }
    }

    for project in find_tsconfig_dirs(folder) {
        let Some(tsc) = tt_ide::checker::resolve_tsc(&project, folder) else {
            tracing::debug!(project = %project.display(), "diagnostics.tsc_not_installed");
            continue;
        };
        // Solution-style configs (`files: []` + `references`, the Vite
        // template) check NOTHING under plain `tsc --noEmit` — they need
        // `tsc -b`, which walks the referenced projects.
        let solution = std::fs::read_to_string(project.join("tsconfig.json"))
            .map(|s| s.contains("\"references\""))
            .unwrap_or(false);
        let args: &[&str] = if solution {
            &["-b", "--pretty", "false"]
        } else {
            &["--noEmit", "--pretty", "false"]
        };
        let out =
            tt_exec::run_in_dir_with_timeout(&tsc.to_string_lossy(), args, &project, TSC_TIMEOUT);
        if let Ok(out) = out {
            let map = tt_ide::diagnostics::parse_tsc(&out.stdout, &project);
            report_if_silent_failure(folder, "tsc", out.exit_code, &map);
            maps.push(map);
        }
    }

    tt_ide::diagnostics::merge(maps)
}

fn report_if_silent_failure(
    folder: &Path,
    tool: &str,
    exit_code: i32,
    parsed: &tt_ide::diagnostics::DiagnosticsByFile,
) {
    let count = parsed.values().map(Vec::len).sum();
    if tt_ide::checker::is_silent_failure(exit_code, count) {
        tracing::warn!(folder = %folder.display(), tool, exit_code, "diagnostics.check_failed");
    }
}

/// Directories holding a `tsconfig.json`, from the folder root down
/// [`TSCONFIG_DEPTH`] levels, skipping dependency/build trees. Capped.
fn find_tsconfig_dirs(folder: &Path) -> Vec<PathBuf> {
    const SKIP: &[&str] = &["node_modules", "target", "dist", "build"];
    let mut found = Vec::new();
    let mut level = vec![folder.to_path_buf()];
    for _ in 0..=TSCONFIG_DEPTH {
        let mut next = Vec::new();
        for dir in level {
            if found.len() >= TSCONFIG_CAP {
                return found;
            }
            if dir.join("tsconfig.json").exists() {
                found.push(dir.clone());
                continue; // nested tsconfigs belong to this project
            }
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if path.is_dir() && !name.starts_with('.') && !SKIP.contains(&name.as_ref()) {
                    next.push(path);
                }
            }
        }
        level = next;
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_tsconfig_dirs_walks_two_levels_and_skips_dep_trees() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("apps/client")).unwrap();
        std::fs::write(root.join("apps/client/tsconfig.json"), "{}").unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::write(root.join("node_modules/pkg/tsconfig.json"), "{}").unwrap();
        std::fs::create_dir_all(root.join("apps/client/sub")).unwrap();
        std::fs::write(root.join("apps/client/sub/tsconfig.json"), "{}").unwrap();

        let dirs = find_tsconfig_dirs(root);
        assert_eq!(dirs, vec![root.join("apps/client")], "dep trees and nested configs skipped");
    }

    #[test]
    fn wire_uris_lists_every_entry() {
        let wire = serde_json::json!([
            { "uri": "file:///a.rs", "diagnostics": [] },
            { "uri": "file:///b.ts", "diagnostics": [] },
        ]);
        assert_eq!(wire_uris(&wire), vec!["file:///a.rs", "file:///b.ts"]);
    }
}
