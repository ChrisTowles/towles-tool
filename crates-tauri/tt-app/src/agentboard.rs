//! Tauri bridge for agentboard. The engine itself lives in
//! `tt_agentboard::engine`; this module owns the Tauri glue: the managed state,
//! the `agentboard://state` event, and the `ab_*` commands. Agent state is
//! derived by scanning `~/.claude` (see `lib.rs`), not pushed over HTTP.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Notify;

use tt_agentboard::StatePayload;

pub use tt_agentboard::engine::{Engine, now_ms};

pub const STATE_EVENT: &str = "agentboard://state";

pub struct Ab {
    pub engine: Arc<Mutex<Engine>>,
    /// Signals the debounced emitter to rebuild + emit.
    pub emit: Arc<Notify>,
    /// Signals the scan task to run an eager scan (fs-notify accelerant).
    pub scan: Arc<Notify>,
    /// First-entered "needs you" timestamps, carried across recomputes so a
    /// session's waiting-age is stable. Every payload the app stamps threads here.
    pub needs_since: Mutex<tt_agentboard::bridge::NeedsSince>,
    /// Session ids seen with a live PTY at least once, so [`prune_dead_shells`]
    /// can tell "just exited" from "hasn't started yet".
    pub ever_live: Mutex<HashSet<String>>,
}

/// Stamp `SessionData.live`/`shellKind`/`portDrift`/`agentState.status` from the
/// app's PTY registry — the engine can't see PTYs, and every payload leaving the
/// app passes through here first. Status is load-bearing: the engine's verdict
/// rides a 60s-cached `claude agents` snapshot, so the PTY's direct observation
/// folds over the top.
pub fn stamp_pty_state(
    payload: &mut StatePayload,
    terms: &crate::terminal::TermState,
    phases: &crate::task::TaskPhases,
    since: &mut tt_agentboard::bridge::NeedsSince,
    now: i64,
) {
    let crate::terminal::PtyEmitState { live, shell_kinds, signals: pty_signals, port_drift } =
        terms.emit_state();
    for repo in &mut payload.repos {
        for folder in &mut repo.folders {
            // Only this process knows whether a create/removal is running here.
            folder.phase = phases.get(&folder.dir);
            let mut has_port_drift = false;
            for session in &mut folder.sessions {
                session.live = live.contains(&session.id);
                session.shell_kind = shell_kinds.get(&session.id).cloned();
                // Only sessions this app hosts a PTY for; everything else has no
                // direct evidence to apply.
                if let Some(signal) = pty_signals.get(&session.id)
                    && let Some(state) = session.agent_state.as_mut()
                {
                    state.status =
                        tt_agentboard::pty_status::resolve_status(Some(state.status), signal, now);
                }
                // A stopped shell's last-known ports say nothing about now.
                session.port_drift = if session.live {
                    port_drift.get(&session.id).cloned().unwrap_or_default()
                } else {
                    Vec::new()
                };
                has_port_drift |= !session.port_drift.is_empty();
            }
            folder.has_port_drift = has_port_drift;
        }
    }
    // Only now is `live` truthful enough to recompute the `needs` counts.
    tt_agentboard::bridge::recompute_needs(payload, since, now);
}

/// Delete a plain shell's session record the moment its PTY exits (an agent pane
/// keeps its last-known status). Must run after [`stamp_pty_state`]; `ever_live`
/// keeps a session that hasn't spawned its PTY yet from being deleted.
fn prune_dead_shells(
    payload: &mut StatePayload,
    engine: &Mutex<Engine>,
    ever_live: &Mutex<HashSet<String>>,
) {
    let mut engine = engine.lock().unwrap();
    let mut ever_live = ever_live.lock().unwrap();
    for repo in &mut payload.repos {
        for folder in &mut repo.folders {
            folder.sessions.retain(|session| {
                if session.live {
                    ever_live.insert(session.id.clone());
                    return true;
                }
                let was_live = ever_live.remove(&session.id);
                let dead_shell = was_live && session.agent_state.is_none();
                if dead_shell {
                    tracing::info!(session_id = %session.id, "session.pruned_exited_shell");
                    engine.close_session(&session.id, now_ms());
                }
                !dead_shell
            });
        }
    }
}

/// The agent snapshot (claude CLI + `/proc` + transcript reads) is collected
/// BEFORE taking the engine lock, so its subprocess work can't stall `ab_*`.
pub fn stamped_payload(app: &AppHandle) -> StatePayload {
    let snapshot = tt_agentboard::engine::collect_agent_snapshot(
        now_ms(),
        &tt_agentboard::procenv::InstanceScope::this_app(),
    );
    let ab = app.state::<Ab>();
    let mut payload = {
        let mut engine = ab.engine.lock().unwrap();
        engine.compute_payload_with(&snapshot, now_ms())
    };
    stamp_pty_state(
        &mut payload,
        &app.state::<crate::terminal::TermState>(),
        &app.state::<crate::task::TaskPhases>(),
        &mut ab.needs_since.lock().unwrap(),
        now_ms(),
    );
    prune_dead_shells(&mut payload, &ab.engine, &ab.ever_live);
    payload
}

/// Fire a desktop notification per session that just flipped into needs-you.
/// Status-report only — acting on the agent happens in the real PTY.
pub fn notify_needs_you(app: &AppHandle, edges: &[tt_agentboard::NeedsYouEdge]) {
    use tauri_plugin_notification::NotificationExt;

    if edges.is_empty() {
        return;
    }
    let focused = app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false);
    if focused {
        tracing::debug!(edges = edges.len(), "notify_needs_you: skipped, window focused");
        return;
    }
    if !crate::settings::notify_allowed(tt_config::NotifyKind::NeedsYou) {
        tracing::debug!(edges = edges.len(), "notify_needs_you: skipped, notifications off");
        return;
    }
    for edge in edges {
        // The only record of a native notification firing — correlate against
        // `window.focus_changed` to see if the OS raised the window off it.
        tracing::info!(
            repo = edge.repo,
            session = edge.session,
            reason = ?edge.reason,
            "notify_needs_you: fired"
        );
        let _ = app
            .notification()
            .builder()
            .title(format!("{} — {}", edge.repo, edge.session))
            .body(needs_you_body(edge))
            .show();
    }
}

/// Text label only — no interaction happens here.
fn needs_you_body(edge: &tt_agentboard::NeedsYouEdge) -> String {
    use tt_agentboard::NeedsYouReason::*;
    let what = match edge.reason {
        WaitingForInput => "is waiting for input",
        Errored => "errored",
        Finished => "finished",
    };
    format!("{} {}", edge.session, what)
}

#[tauri::command]
pub fn ab_get_state(app: AppHandle) -> StatePayload {
    stamped_payload(&app)
}

/// Clear unseen for a session (fast-path: patch + re-emit, no full rebuild).
#[tauri::command]
pub fn ab_mark_seen(state: State<Ab>, app: AppHandle, name: String) {
    let patched = {
        let mut engine = state.engine.lock().unwrap();
        engine.mark_seen_patch(&name)
    };
    if let Some(mut payload) = patched {
        stamp_pty_state(
            &mut payload,
            &app.state::<crate::terminal::TermState>(),
            &app.state::<crate::task::TaskPhases>(),
            &mut state.needs_since.lock().unwrap(),
            now_ms(),
        );
        prune_dead_shells(&mut payload, &state.engine, &state.ever_live);
        let _ = app.emit(STATE_EVENT, payload);
    }
}

#[tauri::command]
pub fn ab_add_repo(state: State<Ab>, path: String) {
    state.engine.lock().unwrap().add_repo(&path);
    tracing::info!(%path, "repo.added");
    state.scan.notify_one(); // discover the new repo's sessions
    state.emit.notify_one();
}

/// Takes the exact dir, not a resolved session name — removing several by name
/// in a row is unsafe (see `remove_repo_persisted`). `dir` is not always a
/// `repos.json` entry either: a worktree deleted outside `tt task rm` leaves only
/// git's `.git/worktrees/<name>` registration, which the prune below clears.
#[tauri::command]
pub async fn ab_remove_repo(state: State<'_, Ab>, dir: String) -> Result<(), String> {
    let removed_tracked = {
        let mut engine = state.engine.lock().unwrap();
        engine.remove_repo(&dir)
    };
    let owner = { state.engine.lock().unwrap().find_worktree_owner(&dir) };
    let pruned = if let Some(owner) = owner.clone() {
        let dir = dir.clone();
        tauri::async_runtime::spawn_blocking(move || {
            tt_agentboard::prune_stale_worktree(&owner, &dir)
        })
        .await
        .unwrap_or(false)
    } else {
        false
    };
    if let Some(owner) = owner {
        state
            .engine
            .lock()
            .unwrap()
            .invalidate_git(&owner, tt_agentboard::GitInvalidation::WorktreeRemoved);
    }
    tracing::info!(%dir, removed_tracked, pruned, "repo.removed");
    if removed_tracked || pruned {
        state.scan.notify_one();
        state.emit.notify_one();
    }
    Ok(())
}

/// Untrack every tracked repo whose directory is gone from disk (the rail's
/// "missing" ghosts). Returns the dropped dirs so the client can toast a count.
#[tauri::command]
pub fn ab_untrack_missing(state: State<Ab>) -> Vec<String> {
    let removed = state.engine.lock().unwrap().untrack_missing();
    tracing::info!(count = removed.len(), "repo.untrack_missing");
    if !removed.is_empty() {
        state.emit.notify_one();
    }
    removed
}

/// Empty ⇒ the picker falls back to `~/code`.
#[tauri::command]
pub fn ab_get_scan_roots(state: State<Ab>) -> Vec<String> {
    state.engine.lock().unwrap().scan_roots()
}

/// Blank entries are dropped; an empty list clears the key.
#[tauri::command]
pub fn ab_set_scan_roots(state: State<Ab>, roots: Vec<String>) {
    let cleaned: Vec<String> =
        roots.into_iter().map(|r| r.trim().to_string()).filter(|r| !r.is_empty()).collect();
    tracing::info!(count = cleaned.len(), "agentboard.scan_roots_set");
    state.engine.lock().unwrap().set_scan_roots(cleaned);
}

/// Either already on the rail or discoverable under a scan root.
#[derive(serde::Serialize)]
pub struct RepoCandidate {
    /// Friendly label, e.g. `p/towles-tool` (path relative to the scan root).
    pub name: String,
    pub dir: String,
    pub active: bool,
}

fn expand_tilde(raw: &str, home: Option<&std::path::Path>) -> std::path::PathBuf {
    match (raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~")), home) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => std::path::PathBuf::from(raw),
    }
}

/// Repos under `roots` ∪ `existing`, named relative to their root (bare dir
/// outside every root). Split from `ab_discover_repos` for testing.
fn build_repo_candidates(existing: &[String], roots: &[std::path::PathBuf]) -> Vec<RepoCandidate> {
    use std::collections::HashSet;
    let existing_set: HashSet<&String> = existing.iter().collect();
    let name_for = |dir: &str| {
        roots
            .iter()
            .find_map(|root| std::path::Path::new(dir).strip_prefix(root).ok())
            .and_then(|p| p.to_str())
            .map(str::to_string)
            .unwrap_or_else(|| dir.to_string())
    };

    let mut dirs: Vec<String> = tt_agentboard::repos::discover_git_repos(roots, 4);
    for dir in existing {
        if !dirs.contains(dir) {
            dirs.push(dir.clone());
        }
    }
    dirs.sort();
    dirs.dedup();

    dirs.into_iter()
        .map(|dir| {
            let name = name_for(&dir);
            let active = existing_set.contains(&dir);
            RepoCandidate { name, dir, active }
        })
        .collect()
}

/// Scan roots come from `scanRoots` in repos.json, defaulting to `~/code`.
#[tauri::command]
pub fn ab_discover_repos(state: State<Ab>) -> Vec<RepoCandidate> {
    let (existing, configured): (Vec<String>, Vec<String>) = {
        let mut engine = state.engine.lock().unwrap();
        (engine.repo_dirs(), engine.scan_roots())
    };
    let home = dirs::home_dir();
    let roots: Vec<std::path::PathBuf> = if configured.is_empty() {
        home.iter().map(|h| h.join("code")).collect()
    } else {
        configured.iter().map(|r| expand_tilde(r, home.as_deref())).collect()
    };
    build_repo_candidates(&existing, &roots)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_union_discovered_and_existing_marking_active() {
        let root = tempfile::TempDir::new().unwrap();
        let base = root.path();
        std::fs::create_dir_all(base.join("p/proj/.git")).unwrap();
        std::fs::create_dir_all(base.join("p/other/.git")).unwrap();

        // On the rail: "p/other" and "/elsewhere/typed" (outside every root).
        let other_dir = base.join("p/other").to_str().unwrap().to_string();
        let existing = vec![other_dir.clone(), "/elsewhere/typed".to_string()];
        let candidates = build_repo_candidates(&existing, &[base.to_path_buf()]);

        let proj = candidates.iter().find(|c| c.dir.ends_with("p/proj")).unwrap();
        assert!(!proj.active);
        assert_eq!(proj.name, "p/proj");

        let other = candidates.iter().find(|c| c.dir == other_dir).unwrap();
        assert!(other.active);
        assert_eq!(other.name, "p/other");

        let typed = candidates.iter().find(|c| c.dir == "/elsewhere/typed").unwrap();
        assert!(typed.active);
        assert_eq!(typed.name, "/elsewhere/typed"); // outside every root → bare dir
    }
}

/// Returns the new record so the client can select it immediately.
#[tauri::command]
pub fn ab_add_session(
    state: State<Ab>,
    dir: String,
    name: Option<String>,
) -> tt_agentboard::SessionRecord {
    let record = state.engine.lock().unwrap().add_session(&dir, name.as_deref(), now_ms());
    tracing::info!(%dir, session_id = %record.id, "session.added");
    state.emit.notify_one();
    record
}

/// The folder's first session, seeding the default if it has none — the
/// task-creation flow's "session to type into", without a full state fetch.
#[tauri::command]
pub fn ab_ensure_session(
    state: State<Ab>,
    dir: String,
) -> Result<tt_agentboard::SessionRecord, String> {
    let record = state
        .engine
        .lock()
        .unwrap()
        .ensure_session(&dir, now_ms())
        .ok_or_else(|| format!("no session for {dir}"))?;
    state.emit.notify_one();
    Ok(record)
}

#[tauri::command]
pub fn ab_rename_session(state: State<Ab>, id: String, name: String) {
    state.engine.lock().unwrap().rename_session(&id, &name);
    tracing::info!(%id, "session.renamed");
    state.emit.notify_one();
}

#[tauri::command]
pub fn ab_close_session(state: State<Ab>, id: String) {
    state.engine.lock().unwrap().close_session(&id, now_ms());
    tracing::info!(%id, "session.closed");
    state.emit.notify_one();
}

/// Tolerant of a stale list — see `reorder_repos`.
#[tauri::command]
pub fn ab_set_repo_order(state: State<Ab>, dirs: Vec<String>) -> Result<(), String> {
    // Surfaced rather than swallowed: a drag that didn't reach disk otherwise
    // looks settled and is simply gone on the next launch.
    let result = state.engine.lock().unwrap().set_repo_order(&dirs);
    match result {
        Ok(()) => {
            tracing::info!(count = dirs.len(), "repo.order_set");
            state.emit.notify_one();
            Ok(())
        }
        Err(e) => {
            tracing::warn!(count = dirs.len(), error = %e, "repo.order_set failed");
            Err(format!("Couldn't save the repo order: {e}"))
        }
    }
}

/// All-`None` resets to the default look. A `color` that isn't hex is stored as
/// unset rather than rejecting the whole edit — the picker validates first, so a
/// malformed value here means a hand-edited file.
#[tauri::command]
pub fn ab_set_repo_meta(
    state: State<Ab>,
    dir: String,
    icon: Option<String>,
    color: Option<String>,
    style: Option<tt_agentboard::RepoAccentStyle>,
) {
    let meta = tt_agentboard::RepoMeta {
        icon: icon.map(|i| i.trim().to_string()).filter(|i| !i.is_empty()),
        color: color.as_deref().and_then(tt_agentboard::HexColor::parse),
        style,
    };
    // Field values have to be read before `meta` moves into the engine.
    let (icon, color) = (
        meta.icon.clone().unwrap_or_default(),
        meta.color.as_ref().map(|c| c.as_str().to_string()).unwrap_or_default(),
    );
    let changed = state.engine.lock().unwrap().set_repo_meta(&dir, meta);
    tracing::info!(repo_dir = %dir, icon, color, changed, "repo.identity_set");
    if changed {
        state.emit.notify_one();
    }
}

/// The parent branch a folder's diff pane compares against instead of the
/// origin/main-or-master auto-detect, for a branch that didn't fork from main.
#[tauri::command]
pub fn ab_set_folder_base_branch(state: State<Ab>, dir: String, branch: Option<String>) {
    let changed = state.engine.lock().unwrap().set_folder_base_branch(&dir, branch.as_deref());
    tracing::info!(%dir, branch = branch.as_deref().unwrap_or(""), changed, "folder.base_branch_set");
    if changed {
        state.emit.notify_one();
    }
}

/// Claim the short git-freshness ceiling while a diff pane is mounted. Not
/// instrumented: pane visibility fires on every folder switch.
#[tauri::command]
pub fn ab_set_diff_focus(state: State<Ab>, dir: String, focused: bool) {
    if state.engine.lock().unwrap().set_diff_focus(&dir, focused) {
        state.scan.notify_one();
    }
}

/// Forces a folder to count as quiet for a narrowing rail filter regardless of
/// its own activity.
#[tauri::command]
pub fn ab_set_folder_quiet(state: State<Ab>, dir: String, quiet: bool) {
    let changed = state.engine.lock().unwrap().set_folder_quiet(&dir, quiet);
    tracing::info!(%dir, quiet, changed, "folder.quiet_set");
    if changed {
        state.emit.notify_one();
    }
}

/// Captured when starting Claude, so the rail can show why a session exists.
#[tauri::command]
pub fn ab_set_session_purpose(state: State<Ab>, id: String, text: Option<String>) {
    let changed = state.engine.lock().unwrap().set_session_purpose(&id, text.as_deref());
    tracing::info!(%id, changed, "session.purpose_set");
    if changed {
        state.emit.notify_one();
    }
}

#[tauri::command]
pub fn ab_set_compact_percent(state: State<Ab>, percent: u8) {
    let changed = state.engine.lock().unwrap().set_compact_recommend_percent(percent);
    tracing::info!(percent, changed, "agentboard.compact_percent_set");
    if changed {
        state.emit.notify_one();
    }
}

/// Show (or hide) auto-discovered worktrees that `tt task` didn't create. Rust
/// owns this end to end — the engine reads it when deciding what to discover —
/// so the client toggles it here rather than writing the settings file itself.
#[tauri::command]
pub fn ab_set_show_unmanaged_worktrees(state: State<Ab>, show: bool) {
    let changed = state.engine.lock().unwrap().set_show_unmanaged_worktrees(show);
    tracing::info!(show, changed, "agentboard.show_unmanaged_worktrees_set");
    if changed {
        state.emit.notify_one();
    }
}

/// Deliberately does NOT re-emit — echoing the blob back would clobber rapid
/// local edits. `touched_folders` are the dirs the client actually mutated; see
/// `WindowsStore::save` for why a whole-blob save can't be applied blindly.
#[tauri::command]
pub fn ab_save_windows(
    state: State<Ab>,
    payload: tt_agentboard::WindowsPayload,
    touched_folders: Vec<String>,
) {
    state.engine.lock().unwrap().set_windows(payload, &touched_folders);
}

/// Deliberately does NOT re-emit — same rationale as `ab_save_windows`.
#[tauri::command]
pub fn ab_save_collapsed(state: State<Ab>, key: String, collapsed: bool) {
    state.engine.lock().unwrap().set_collapsed(&key, collapsed);
}

fn parse_diff_mode(mode: &str) -> tt_agentboard::DiffMode {
    if mode == "uncommitted" {
        tt_agentboard::DiffMode::Uncommitted
    } else {
        tt_agentboard::DiffMode::Main
    }
}

/// `mode` picks the baseline: `"uncommitted"` diffs the working tree vs HEAD,
/// anything else diffs vs the merge-base with `base_branch` (or origin/main if
/// unset). Async: a large branch diff is real work, even in-process.
#[tauri::command]
pub async fn ab_get_diff_files(
    dir: String,
    mode: String,
    base_branch: Option<String>,
) -> tt_agentboard::DiffFiles {
    let mode = parse_diff_mode(&mode);
    tauri::async_runtime::spawn_blocking(move || {
        tt_agentboard::diff_files(&dir, mode, base_branch.as_deref())
    })
    .await
    .unwrap_or_default()
}

/// The original side of the diff editor. `None` when the file doesn't exist at
/// the base (added/untracked).
#[tauri::command]
pub async fn ab_get_base_file(
    dir: String,
    mode: String,
    base_branch: Option<String>,
    path: String,
) -> Option<String> {
    let mode = parse_diff_mode(&mode);
    tauri::async_runtime::spawn_blocking(move || {
        tt_agentboard::base_file_content(&dir, mode, base_branch.as_deref(), &path)
    })
    .await
    .unwrap_or_default()
}

/// Per-commit line counts for the `DiffButton` hover, oldest commit first. Async
/// like [`ab_get_diff_files`]: a many-commit branch is one tree diff per commit.
#[tauri::command]
pub async fn ab_get_commit_stats(
    dir: String,
    base_branch: Option<String>,
) -> Vec<tt_agentboard::CommitStat> {
    tauri::async_runtime::spawn_blocking(move || {
        tt_agentboard::commit_stats(&dir, base_branch.as_deref())
    })
    .await
    .unwrap_or_default()
}
