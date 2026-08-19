//! Towles Tool desktop app (Tauri 2). Hosts the agentboard bridge: an engine
//! (tracker/metadata/order/git/watcher) driven by tokio tasks that emits state
//! snapshots as the `agentboard://state` event and exposes client commands.
//! Also owns the embedded terminals (`terminal`): PTYs the app spawns and
//! kills on window close, rendered by xterm.js in the agentboard screen.

mod agentboard;
mod asset;
mod browser;
mod claude_sessions;
mod diagnostics;
mod doctor;
mod gh_actions;
mod ide;
mod instance_lock;
mod launch;
#[cfg(target_os = "linux")]
mod linux_desktop;
mod lsp;
mod macos_keys;
mod mcp;
mod mcp_http;
mod preview;
mod resume;
mod scheduler;
mod settings;
mod slack;
mod slack_socket;
mod store;
mod task;
mod task_explorer;
mod telemetry;
mod terminal;
mod update;
mod wdio_window;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{Emitter, Manager, WindowEvent};
use tokio::sync::Notify;

use agentboard::{Ab, Engine, STATE_EVENT, now_ms};
use tt_agentboard::fs_notify::{MultiFileNotifier, ScopedDirNotifier};

/// The checkout this binary was built from, baked in from `CARGO_MANIFEST_DIR`
/// so several tasks' windows tell apart with no runtime cwd/env plumbing.
pub(crate) fn task_label() -> String {
    label_from_manifest_dir(Path::new(env!("CARGO_MANIFEST_DIR")))
}

/// The repo-root directory name, two ancestors up from the manifest dir. Pure
/// so the rule is unit-testable without the compile-time `CARGO_MANIFEST_DIR`.
fn label_from_manifest_dir(manifest_dir: &Path) -> String {
    manifest_dir
        .ancestors()
        .nth(2)
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("towles-tool")
        .to_string()
}

/// What the header badge shows: the label and whether this is a task build.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppTask {
    label: String,
    is_worktree: bool,
}

#[tauri::command]
fn app_task() -> AppTask {
    AppTask {
        label: task_label(),
        is_worktree: is_task_manifest_dir(Path::new(env!("CARGO_MANIFEST_DIR"))),
    }
}

/// The one IPC seam for frontend `ui.action` telemetry: a stable action id, its
/// screen, and a word of `detail` — never content or continuous input.
#[tauri::command]
fn ui_action(action: String, screen: String, detail: Option<String>) {
    tracing::info!(%action, %screen, detail = %detail.as_deref().unwrap_or(""), "ui.action");
}

/// A task build's manifest dir is `<repo>/.claude/worktrees/<task>/crates-tauri/tt-app`
/// — ancestors 3/4 are the worktrees/.claude segments exactly then.
fn is_task_manifest_dir(manifest_dir: &Path) -> bool {
    manifest_dir.ancestors().nth(3).and_then(|p| p.file_name())
        == Some(std::ffi::OsStr::new("worktrees"))
        && manifest_dir.ancestors().nth(4).and_then(|p| p.file_name())
            == Some(std::ffi::OsStr::new(".claude"))
}

/// Per-task app identifier, so each worktree's self-installed `.desktop` entry
/// gets its own filename. Touches no GTK/D-Bus — see CLAUDE.md on `enableGTKAppId`.
fn app_identifier(base: &str) -> String {
    app_identifier_from(Path::new(env!("CARGO_MANIFEST_DIR")), base)
}

/// A task build gets `base.task-<label>`, folded to lowercase with
/// non-alphanumerics as `-` so it's a legal reverse-DNS segment.
fn app_identifier_from(manifest_dir: &Path, base: &str) -> String {
    if !is_task_manifest_dir(manifest_dir) {
        return base.to_string();
    }
    let suffix: String = label_from_manifest_dir(manifest_dir)
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    format!("{base}.task-{suffix}")
}

/// Build the Tauri app and run its event loop until the last window closes.
///
/// # Panics
///
/// On a failed build or dead event loop: no window is left to report it in.
pub fn run() {
    // Every span/event also streams to this task's on-disk event log at debug —
    // the app runs unattended for hours, so telemetry must already be captured
    // when a question comes up. A failure here must never block startup.
    let _ = tt_telemetry::init("tt-app", "error");

    // WebKitGTK's DMABUF renderer flashes artifacts under NVIDIA (tauri#9304):
    // opt out before any webview exists, never over an explicit user setting.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
        && std::path::Path::new("/proc/driver/nvidia/version").exists()
    {
        // SAFETY: called before Tauri/GTK spawn any threads.
        unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
    }

    let mut context = tauri::generate_context!();
    let identifier = app_identifier(&context.config().identifier);
    context.config_mut().identifier = identifier.clone();

    // Set by dev-drive.mjs/e2e.mjs: verification launches must not yank the
    // user's focus. A runtime signal, not the merely-correlated `wdio` feature.
    if std::env::var_os("TT_NO_FOCUS_STEAL").is_some() {
        for window in &mut context.config_mut().app.windows {
            window.focus = false;
        }
    }

    // With `enableGTKAppId` off, nothing else stops one checkout launching
    // twice, duplicating windows/PTYs/polling. A killed process's lock is stolen.
    let Some(_instance_lock) =
        instance_lock::InstanceLock::try_acquire(&format!("app-{identifier}"))
    else {
        eprintln!("Towles Tool ({identifier}) is already running — focus its existing window.");
        return;
    };

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init());

    // Repo bytes served over their own URI scheme — see `asset`'s module doc
    // for why not base64 over IPC, and the guards on a hostile README.
    let builder = asset::register(builder);

    // WebdriverIO E2E plugins, only under `--features wdio` (see e2e/): the
    // execute/mock IPC surface plus the in-app WebDriver server wdio dials.
    #[cfg(feature = "wdio")]
    let builder =
        builder.plugin(tauri_plugin_wdio::init()).plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .setup(|app| {
            // Runtime so normal builds never reference the plugins' ACL.
            #[cfg(feature = "wdio")]
            app.handle().add_capability(include_str!("../wdio-capability.json"))?;

            // See linux_desktop's module doc for why this is needed even
            // outside a packaged build.
            #[cfg(target_os = "linux")]
            linux_desktop::ensure_installed(&app.config().identifier);

            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_title(&format!("Towles Tool — {}", task_label()));
            }

            // No-op off macOS — see macos_keys' module doc.
            macos_keys::install(app.handle());

            // Fire-and-forget release check → update banner + OS notification.
            update::check_on_startup(app.handle().clone());

            // A Debug-mode Zig parser saturates a core at ~130 KB/s of PTY
            // output; be loud if the dev-profile override regresses.
            if tt_vt::parser_optimize_mode() == "Debug" {
                eprintln!(
                    "warning: libghostty-vt compiled in Zig Debug mode (~1000x slower parsing; \
                     busy terminals will peg a core) — restore the \
                     [profile.dev.package.libghostty-vt-sys] override in Cargo.toml"
                );
            }

            // Heal `repos.json` first: worktrees double-tracked as repos shadow
            // their task records as duplicates. See `nested_task_paths`.
            match tt_agentboard::repos::untrack_nested_tasks_persisted(
                &tt_agentboard::repos::default_repos_path(),
            ) {
                Ok((_, dropped)) if !dropped.is_empty() => {
                    tracing::info!(count = dropped.len(), ?dropped, "repos.nested_tasks_untracked");
                }
                _ => {}
            }

            // sessions.json is shared across instances, so another running
            // app's PTY can carry the same session id — not ours to report.
            let engine = Arc::new(Mutex::new(Engine::new(
                tt_agentboard::procenv::InstanceScope::this_app(),
            )));
            let emit = Arc::new(Notify::new());
            let scan = Arc::new(Notify::new());

            // fs-notify accelerant: a journal change signals an eager scan.
            // Scoped to tracked checkouts' subdirs, not the whole projects tree.
            let projects_dir = engine.lock().unwrap().projects_dir();
            let scan_for_notify = scan.clone();
            let notifier = Arc::new(Mutex::new(
                ScopedDirNotifier::new(move || scan_for_notify.notify_one()).ok(),
            ));

            // Watching `.git` internals invalidates just that repo on a commit/
            // fetch/switch, not the TTL. Unstaged edits still need the poll.
            let git_watch_index: Arc<Mutex<HashMap<PathBuf, String>>> = Arc::default();
            let git_watcher = {
                let engine = engine.clone();
                let scan = scan.clone();
                let index = git_watch_index.clone();
                Arc::new(Mutex::new(
                    MultiFileNotifier::new(move |changed: Vec<PathBuf>| {
                        let dirs: HashSet<String> = {
                            let idx = index.lock().unwrap();
                            changed.iter().filter_map(|p| idx.get(p).cloned()).collect()
                        };
                        if dirs.is_empty() {
                            return;
                        }
                        {
                            let mut e = engine.lock().unwrap();
                            for dir in &dirs {
                                e.invalidate_git(dir, tt_agentboard::GitInvalidation::ControlFile);
                            }
                        }
                        scan.notify_one();
                    })
                    .ok(),
                ))
            };

            // Shared by both git pollers: nothing spawns for a git read any
            // more, so this is the only account of what they cost.
            let git_meter = Arc::new(Mutex::new(tt_agentboard::GitWorkMeter::new(now_ms())));

            app.manage(Ab {
                engine: engine.clone(),
                emit: emit.clone(),
                scan: scan.clone(),
                needs_since: Mutex::new(tt_agentboard::bridge::NeedsSince::new()),
                ever_live: Mutex::new(std::collections::HashSet::new()),
            });

            // Compiler-diagnostics hub for the Claude Code IDE bridge, consumed
            // by the per-terminal IDE servers' getDiagnostics.
            let diag_hub = diagnostics::DiagHub::spawn(app.handle().clone());
            app.manage(diag_hub.clone());

            let handle = app.handle().clone();

            // Coalesce a burst of triggers into one rebuild (on a blocking
            // worker) and broadcast only a changed payload: every emit costs
            // the webview a deserialize plus a React render.
            {
                let emit = emit.clone();
                let engine = engine.clone();
                let scan = scan.clone();
                tauri::async_runtime::spawn(async move {
                    // Compared with `ts` zeroed: the stamp changes every rebuild.
                    let mut last: Option<tt_agentboard::StatePayload> = None;
                    // Fires once per flip into needs-you, never on the level.
                    let mut needs_watch = tt_agentboard::NeedsYouWatch::new();
                    // …and once per folder whose last agent stopped working.
                    let mut turn_watch = tt_agentboard::TurnEndWatch::new();
                    loop {
                        emit.notified().await;
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        let rebuild_handle = handle.clone();
                        let Ok(payload) = tauri::async_runtime::spawn_blocking(move || {
                            agentboard::stamped_payload(&rebuild_handle)
                        })
                        .await
                        else {
                            continue;
                        };
                        // The only path that moves a Board card. Every tick, not
                        // just on a changed payload: the signal is agent
                        // liveness, which this loop's dedup would swallow.
                        let store_state = handle.state::<store::StoreState>();
                        if store_state.sync_worktree_task_statuses(&payload, store::now_ms()) > 0 {
                            store::emit_snapshot_from_app(&handle);
                        }

                        let mut probe = payload.clone();
                        probe.ts = 0;
                        if last.as_ref() != Some(&probe) {
                            last = Some(probe);
                            // An agent's turn ending is the only notice that a
                            // checkout's *working tree* moved — an edit it never
                            // staged touched no watched `.git` file, so without
                            // this those stats wait out the backup poll.
                            let ended = turn_watch.observe(&payload);
                            if !ended.is_empty() {
                                {
                                    let mut e = engine.lock().unwrap();
                                    for dir in &ended {
                                        e.invalidate_git(
                                            dir,
                                            tt_agentboard::GitInvalidation::TurnEnd,
                                        );
                                    }
                                }
                                scan.notify_one();
                            }
                            let edges = needs_watch.observe(&payload);
                            agentboard::notify_needs_you(&handle, &edges);
                            let _ = handle.emit(STATE_EVENT, payload);
                        }
                    }
                });
            }

            // Every 2s, or eagerly on fs-notify. Stale git-cache entries warm
            // OUTSIDE the engine lock — git under it freezes every `ab_*`
            // command on the GTK thread.
            {
                let engine = engine.clone();
                let emit = emit.clone();
                let scan = scan.clone();
                let notifier = notifier.clone();
                let projects_dir = projects_dir.clone();
                let git_watcher = git_watcher.clone();
                let git_watch_index = git_watch_index.clone();
                let git_meter = git_meter.clone();
                let store_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let mut interval = tokio::time::interval(Duration::from_millis(2000));
                    let mut git_watched: HashSet<PathBuf> = HashSet::new();
                    loop {
                        tokio::select! {
                            _ = interval.tick() => {}
                            _ = scan.notified() => {}
                        }
                        let now = now_ms();
                        let warm_engine = engine.clone();
                        let stale = tauri::async_runtime::spawn_blocking(move || {
                            warm_engine.lock().unwrap().stale_git_targets(now)
                        })
                        .await
                        .unwrap_or_default();
                        if !stale.is_empty() {
                            let warmed = tauri::async_runtime::spawn_blocking(move || {
                                stale
                                    .into_iter()
                                    .map(|(dir, base_branch, previous)| {
                                        let started = std::time::Instant::now();
                                        let info = tt_agentboard::git_info::compute_git_info(
                                            &dir,
                                            base_branch.as_deref(),
                                            Some(&previous),
                                            now_ms(),
                                        );
                                        (dir, info, started.elapsed().as_millis() as i64)
                                    })
                                    .collect::<Vec<_>>()
                            })
                            .await
                            .unwrap_or_default();
                            let warmed = {
                                let mut meter = git_meter.lock().unwrap();
                                warmed
                                    .into_iter()
                                    .map(|(dir, info, took)| {
                                        meter.record(&dir, took);
                                        (dir, info)
                                    })
                                    .collect()
                            };
                            // The time the batch *finished*: stamped with the
                            // scheduling `now`, a batch outrunning the TTL
                            // births every entry stale and recomputes forever.
                            let warmed_at = now_ms();
                            engine.lock().unwrap().warm_git_cache(warmed, warmed_at);
                        }
                        // Reconcile rows before pushing them, so a worktree
                        // discovered this tick is a row on this tick — as diffs,
                        // so a steady state writes nothing. Gated on the
                        // show-unmanaged toggle: minting rows nobody can see
                        // would write to a shared database every tick.
                        let store_state = store_handle.try_state::<store::StoreState>();
                        if let Some(state) = &store_state {
                            let (found, vanished) = {
                                let mut e = engine.lock().unwrap();
                                if e.show_unmanaged_worktrees() {
                                    (e.unrecorded_worktrees(), e.vanished_detected_records())
                                } else {
                                    (Vec::new(), Vec::new())
                                }
                            };
                            state.reconcile_detected_worktrees(&found, &vanished, now);
                        }
                        let rows = store_state.and_then(|s| s.rail_worktrees());
                        {
                            let mut e = engine.lock().unwrap();
                            if let Some(rows) = rows {
                                e.set_task_worktrees(rows);
                            }
                            e.scan_once(now);
                        }
                        // Narrow the accelerant to what's actually polled —
                        // a no-op unless the tracked set moved.
                        let targets = engine.lock().unwrap().watch_targets();
                        if let Some(n) = notifier.lock().unwrap().as_mut() {
                            n.set_targets(&projects_dir, &targets);
                        }
                        // Same for the control-file watch: register only the
                        // delta, rebuild the path→dir index.
                        let desired = engine.lock().unwrap().control_watch_files();
                        if let Some(w) = git_watcher.lock().unwrap().as_mut() {
                            let desired_keys: HashSet<PathBuf> = desired.keys().cloned().collect();
                            for stale in
                                git_watched.difference(&desired_keys).cloned().collect::<Vec<_>>()
                            {
                                w.remove(&stale);
                            }
                            for fresh in
                                desired_keys.difference(&git_watched).cloned().collect::<Vec<_>>()
                            {
                                let _ = w.add(&fresh);
                            }
                            git_watched = desired_keys;
                            // Settle registrations whose `.git` parent didn't
                            // exist yet (packed ref — see `MultiFileNotifier`).
                            w.rewatch_pending();
                        }
                        *git_watch_index.lock().unwrap() = desired;
                        if let Some(work) = git_meter.lock().unwrap().take_due(now_ms()) {
                            tracing::debug!(
                                count = work.count,
                                total_ms = work.total_ms,
                                slowest_ms = work.slowest_ms,
                                slowest_dir = %work.slowest_dir,
                                window_ms = work.window_ms,
                                "git.recompute_window"
                            );
                        }
                        emit.notify_one();
                    }
                });
            }

            // The diagnostics-hub half, also outside the engine lock. Gated on
            // the same `stale_git_targets` signal `warm_git_cache` uses: two
            // signals and either loop defeats the other's savings.
            {
                let engine = engine.clone();
                let emit = emit.clone();
                let diag = diag_hub.clone();
                let git_meter = git_meter.clone();
                tauri::async_runtime::spawn(async move {
                    let mut interval = tokio::time::interval(Duration::from_secs(10));
                    loop {
                        interval.tick().await;
                        let poll_engine = engine.clone();
                        let poll_meter = git_meter.clone();
                        let now = now_ms();
                        let changed_dirs = tauri::async_runtime::spawn_blocking(move || {
                            let targets = poll_engine.lock().unwrap().stale_git_targets(now);
                            let mut changed_dirs = Vec::new();
                            for (dir, base_branch, previous) in targets {
                                let started = std::time::Instant::now();
                                let info = tt_agentboard::git_info::compute_git_info(
                                    &dir,
                                    base_branch.as_deref(),
                                    Some(&previous),
                                    now_ms(),
                                );
                                poll_meter
                                    .lock()
                                    .unwrap()
                                    .record(&dir, started.elapsed().as_millis() as i64);
                                let stored = poll_engine.lock().unwrap().store_git_info(
                                    &dir,
                                    info,
                                    now_ms(),
                                );
                                if stored {
                                    changed_dirs.push(dir);
                                }
                            }
                            changed_dirs
                        })
                        .await
                        .unwrap_or_default();
                        if !changed_dirs.is_empty() {
                            emit.notify_one();
                            // The hub skips folders without a connected session.
                            for dir in &changed_dirs {
                                diag.request(std::path::Path::new(dir));
                            }
                        }
                    }
                });
            }

            // `git fetch origin`: the poll only reads cached remote refs, so
            // without this "behind main" never moves. The tick is the *fastest*
            // cadence any repo can earn — `fetch_targets` decides which repos
            // are actually due, so an idle fork costs an hour, not 3 minutes.
            {
                let engine = engine.clone();
                tauri::async_runtime::spawn(async move {
                    let mut interval = tokio::time::interval(Duration::from_secs(180));
                    loop {
                        interval.tick().await;
                        let fetch_engine = engine.clone();
                        let _ = tauri::async_runtime::spawn_blocking(move || {
                            let targets = fetch_engine.lock().unwrap().fetch_targets(now_ms());
                            tt_agentboard::git_info::fetch_all(&targets);
                        })
                        .await;
                    }
                });
            }

            // Open the store once; on failure the app still runs and store
            // commands return an error.
            let store_state = store::StoreState::open();
            store::emit_snapshot(&app.handle().clone(), &store_state);
            let repo_cache_store = store_state.clone();
            app.manage(store_state);

            // Identity cache (root -> `owner/repo`) off already-computed
            // origins — what lets `task_create` validate `repo` against a real
            // slug. `repos.json` stays the truth about which repos exist.
            {
                let engine = engine.clone();
                tauri::async_runtime::spawn(async move {
                    let mut interval = tokio::time::interval(Duration::from_secs(10));
                    loop {
                        interval.tick().await;
                        let now = now_ms();
                        let origins = engine.lock().unwrap().tracked_repo_origins();
                        let slugs: Vec<(String, String)> = origins
                            .into_iter()
                            .filter_map(|(dir, origin_url)| {
                                let url = origin_url?;
                                // Case-preserving: a folded copy reads as a
                                // second repo next to `gh`-reported slugs.
                                let slug =
                                    tt_git::task_assign::repo_slug_from_remote_preserving_case(
                                        &url,
                                    )?;
                                Some((dir, slug))
                            })
                            .collect();
                        repo_cache_store.reconcile_repos(&slugs, now);
                    }
                });
            }

            // MCP over loopback on *this checkout's* claimed port, so a session
            // in this app's terminal reaches this app's board. After
            // `manage(store_state)`: a mutating call re-emits through it.
            mcp_http::spawn(app.handle().clone(), tt_mcp::port::for_this_checkout());

            // Overlap guards for the manual "refresh now" / "Sync now" commands.
            app.manage(store::CollectNowState::default());
            app.manage(store::RepoSyncState::default());

            // Collector scheduler: fills tt.db and re-emits the snapshot; the
            // signal lets `settings_set` make cadence edits take effect live.
            let scheduler_reload = Arc::new(Notify::new());
            // Slack Socket Mode gets its own reload signal so a settings write
            // reliably reaches it alongside the scheduler.
            let slack_socket_reload = Arc::new(Notify::new());
            app.manage(settings::SettingsSignal {
                scheduler: scheduler_reload.clone(),
                slack_socket: slack_socket_reload.clone(),
            });
            scheduler::spawn(app.handle().clone(), scheduler_reload);
            slack_socket::spawn(app.handle().clone(), slack_socket_reload);

            // So Claude Code never dials a dead server's lockfile.
            ide::sweep_stale_lockfiles();

            // Keeps the prior run's estimated end time close to real (`resume`).
            resume::spawn_heartbeat(app.handle().clone());

            // Kick an initial scan so the first snapshot has data.
            scan.notify_one();
            Ok(())
        })
        .manage(browser::BrowserHost::default())
        // Shared: a pane outlives the command that created it (see `tt-pane`).
        .manage(tt_pane::PaneHost::shared())
        .manage(resume::ResumeState::begin())
        .manage(terminal::TermState::default())
        .manage(task::TaskPhases::default())
        .manage(launch::LaunchState::default())
        .manage(lsp::Lsp::default())
        .manage(ide::DiffRequests::default())
        .manage(ide::ViewerWatches::default())
        .manage(ide::ExplorerWatches::default())
        .manage(ide::EditorPrefs::default())
        .manage(preview::PreviewWatches::default())
        .manage(asset::AssetScopes::default())
        .manage(task_explorer::ExplorerState::default())
        .manage(claude_sessions::ClaudeSessionsCache::default())
        .on_window_event(|window, event| match event {
            // Without a record an orderly close is indistinguishable from a
            // kill or crash — a real triage dead-end once.
            WindowEvent::CloseRequested { .. } => {
                tracing::info!(window = window.label(), "window.close_requested");
            }
            WindowEvent::Destroyed => {
                tracing::info!(window = window.label(), "window.destroyed");
                terminal::on_window_destroyed(window.app_handle(), window.label());
                // The exact shutdown moment beats the last stale heartbeat.
                resume::on_window_destroyed(window.app_handle());
            }
            // The only record of OS-level focus history — answers "did the app
            // steal focus, and when?" after the fact.
            WindowEvent::Focused(focused) => {
                tracing::info!(focused = *focused, window = window.label(), "window.focus_changed");
                // Backgrounded, the pollers stretch their cadences; coming back
                // invalidates so the board is current by the time it is read,
                // rather than serving whatever the wide ceiling still allows.
                if let Some(ab) = window.app_handle().try_state::<Ab>() {
                    let moved = ab.engine.lock().unwrap().set_window_focused(*focused);
                    if moved && *focused {
                        ab.scan.notify_one();
                    }
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            app_task,
            ui_action,
            tt_pane::commands::pane_attach,
            tt_pane::commands::pane_set_rect,
            tt_pane::commands::pane_set_visible,
            tt_pane::commands::pane_detach,
            wdio_window::wdio_place_on_test_monitor,
            task_explorer::task_explorer_snapshot,
            agentboard::ab_get_state,
            agentboard::ab_mark_seen,
            agentboard::ab_add_repo,
            agentboard::ab_remove_repo,
            agentboard::ab_untrack_missing,
            agentboard::ab_discover_repos,
            agentboard::ab_get_scan_roots,
            agentboard::ab_set_scan_roots,
            agentboard::ab_add_session,
            resume::ab_resume_candidates,
            agentboard::ab_rename_session,
            agentboard::ab_close_session,
            agentboard::ab_set_repo_meta,
            agentboard::ab_set_repo_order,
            agentboard::ab_set_folder_base_branch,
            agentboard::ab_set_folder_quiet,
            agentboard::ab_set_session_purpose,
            agentboard::ab_set_compact_percent,
            agentboard::ab_set_show_unmanaged_worktrees,
            agentboard::ab_save_windows,
            agentboard::ab_save_collapsed,
            agentboard::ab_get_diff_files,
            agentboard::ab_set_diff_focus,
            agentboard::ab_get_base_file,
            agentboard::ab_get_index_file,
            agentboard::ab_stage_file,
            agentboard::ab_unstage_file,
            agentboard::ab_stage_buffer,
            agentboard::ab_get_commit_stats,
            browser::browser_status,
            browser::browser_open,
            browser::browser_navigate,
            browser::browser_input,
            browser::browser_set_viewport,
            browser::browser_set_visible,
            browser::browser_capture,
            browser::browser_close,
            browser::browser_popout,
            launch::launch_configs,
            launch::launch_register,
            preview::preview_capture,
            preview::preview_read_file,
            preview::preview_watch_file,
            preview::preview_unwatch_file,
            preview::preview_write_feedback,
            task::task_base_branches,
            task::task_check_branch,
            task::task_create,
            task::task_delete,
            task::task_stop_port,
            task::task_run_setup,
            task::task_suggest,
            task::task_write_pasted_images,
            task::read_clipboard_image,
            store::store_snapshot,
            store::store_add_task,
            store::store_attach_task_issue,
            store::store_detach_task_issue,
            store::store_attach_task_pr,
            store::store_detach_task_pr,
            store::store_task_set_worktree,
            store::task_adopt_worktree,
            store::store_set_task_status,
            store::store_update_task,
            store::store_archive_done,
            store::store_unarchive_task,
            store::store_promote_task_to_issue,
            store::store_gh_issues_list,
            store::store_search_issues,
            store::store_collect_now,
            store::store_sync_repo,
            gh_actions::cockpit_assign_issue,
            gh_actions::cockpit_create_issue_branch,
            store::store_dm_dismiss,
            store::store_item_dismiss,
            store::store_dismissals_clear,
            mcp::mcp_tool_docs,
            mcp_http::mcp_status,
            mcp_http::mcp_test_call,
            slack::slack_dm_history,
            slack::slack_dm_send,
            slack::slack_dm_file,
            slack::slack_list_users,
            store::journal_log,
            claude_sessions::claude_sessions_summary,
            claude_sessions::claude_usage_limits,
            claude_sessions::claude_sessions_search,
            claude_sessions::claude_sessions_insights,
            claude_sessions::claude_sessions_breakdown,
            claude_sessions::claude_sessions_cadence,
            telemetry::telemetry_days,
            telemetry::telemetry_events,
            telemetry::telemetry_attention,
            telemetry::telemetry_keyboard,
            agentboard::ab_ensure_session,
            doctor::doctor_run,
            settings::settings_get,
            settings::settings_set,
            settings::settings_default_prompt_improvers,
            terminal::spawn::term_start,
            terminal::spawn::term_kill,
            terminal::input::term_write,
            terminal::input::term_key,
            terminal::input::term_mouse,
            terminal::input::term_paste,
            terminal::input::term_paste_clipboard,
            terminal::view::term_resize,
            terminal::view::term_scroll,
            terminal::view::term_scroll_to,
            terminal::view::term_wheel,
            terminal::view::term_request_full,
            terminal::view::term_visibility,
            terminal::view::term_select,
            terminal::view::term_pointer,
            terminal::view::term_copy,
            terminal::view::term_search,
            terminal::view::term_clear,
            terminal::view::term_theme,
            terminal::view::term_focus,
            terminal::open_path::term_open_path,
            terminal::open_path::term_resolve_path,
            ide::ide_set_selection,
            ide::ide_clear_selection,
            ide::ide_at_mention,
            ide::ide_status,
            ide::ide_set_open_file,
            ide::ide_set_diff_dirty,
            ide::ide_read_file,
            asset::asset_allow_dir,
            ide::ide_stat,
            ide::ide_read_dir,
            ide::ide_create_dir,
            ide::ide_delete,
            ide::ide_rename,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            lsp::lsp_stop_all,
            ide::ide_write_file,
            ide::ide_watch_files,
            ide::ide_unwatch_files,
            ide::ide_watch_dir,
            ide::ide_unwatch_dir,
            ide::ide_prefs_load,
            ide::ide_prefs_save,
            ide::ide_diff_resolve,
        ])
        .run(context)
        .expect("error while running Towles Tool application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_is_the_repo_root_two_ancestors_up() {
        assert_eq!(
            label_from_manifest_dir(Path::new(
                "/home/u/code/towles-tool-primary/crates-tauri/tt-app"
            )),
            "towles-tool-primary"
        );
        assert_eq!(
            label_from_manifest_dir(Path::new(
                "/home/u/repo/.claude/worktrees/feat-thing/crates-tauri/tt-app"
            )),
            "feat-thing"
        );
    }

    #[test]
    fn label_falls_back_when_the_path_is_too_shallow() {
        assert_eq!(label_from_manifest_dir(Path::new("/tt-app")), "towles-tool");
    }

    #[test]
    fn task_detection_requires_the_claude_worktrees_nesting() {
        assert!(is_task_manifest_dir(Path::new(
            "/home/u/repo/.claude/worktrees/feat-thing/crates-tauri/tt-app"
        )));
        assert!(!is_task_manifest_dir(Path::new(
            "/home/u/code/towles-tool-primary/crates-tauri/tt-app"
        )));
        assert!(!is_task_manifest_dir(Path::new(
            "/home/u/repo/worktrees/feat-thing/crates-tauri/tt-app"
        )));
    }

    #[test]
    fn identifier_stays_unscoped_for_a_main_checkout() {
        assert_eq!(
            app_identifier_from(
                Path::new("/home/u/code/towles-tool-primary/crates-tauri/tt-app"),
                "dev.towles.tool"
            ),
            "dev.towles.tool"
        );
    }

    #[test]
    fn identifier_is_task_scoped_and_sanitized_under_worktrees() {
        assert_eq!(
            app_identifier_from(
                Path::new("/home/u/repo/.claude/worktrees/feat-thing/crates-tauri/tt-app"),
                "dev.towles.tool"
            ),
            "dev.towles.tool.task-feat-thing"
        );
        assert_eq!(
            app_identifier_from(
                Path::new("/home/u/repo/.claude/worktrees/Chore_Repo.Audit/crates-tauri/tt-app"),
                "dev.towles.tool"
            ),
            "dev.towles.tool.task-chore-repo-audit"
        );
    }

    #[test]
    fn identifier_requires_both_worktrees_and_claude_segments() {
        assert_eq!(
            app_identifier_from(
                Path::new("/home/u/repo/worktrees/feat-thing/crates-tauri/tt-app"),
                "dev.towles.tool"
            ),
            "dev.towles.tool"
        );
    }
}
