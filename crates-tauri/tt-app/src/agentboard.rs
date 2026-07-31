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

/// Tauri event carrying the state snapshot.
pub const STATE_EVENT: &str = "agentboard://state";

/// Managed Tauri state: the engine plus the task-signal handles.
pub struct Ab {
    pub engine: Arc<Mutex<Engine>>,
    /// Signals the debounced emitter to rebuild + emit.
    pub emit: Arc<Notify>,
    /// Signals the scan task to run an eager scan (fs-notify accelerant).
    pub scan: Arc<Notify>,
    /// First-entered "needs you" timestamps, carried across recomputes so a
    /// session's waiting-age is stable (see `tt_agentboard::bridge::NeedsSince`).
    /// Every payload the app stamps threads through this.
    pub needs_since: Mutex<tt_agentboard::bridge::NeedsSince>,
    /// Session ids seen with a live PTY at least once, so
    /// [`prune_dead_shells`] can tell "just exited" from "hasn't started yet"
    /// (the window between `ab_add_session` and `term_start`).
    pub ever_live: Mutex<HashSet<String>>,
}

/// Stamp `SessionData.live`/`shellKind`/`portDrift`/`agentState.status` from
/// the app's PTY registry — the engine can't see PTYs, and every payload
/// leaving the app passes through here first. Status is the load-bearing one:
/// the engine's verdict rides a 60s-cached `claude agents` snapshot, so
/// `tt_agentboard::pty_status` folds the PTY's direct observation over the
/// top (output activity vetoes; silence defers — see that module).
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
            // The one thing only this process can know (see `TaskPhases`):
            // whether a create/removal is running on this row right now.
            folder.phase = phases.get(&folder.dir);
            let mut has_port_drift = false;
            for session in &mut folder.sessions {
                session.live = live.contains(&session.id);
                session.shell_kind = shell_kinds.get(&session.id).cloned();
                // Only sessions this app actually hosts a PTY for: everything
                // else (another window's session, a row whose shell has
                // exited) has no direct evidence to apply.
                if let Some(signal) = pty_signals.get(&session.id)
                    && let Some(state) = session.agent_state.as_mut()
                {
                    state.status =
                        tt_agentboard::pty_status::resolve_status(Some(state.status), signal, now);
                }
                // Only a live PTY's drift is meaningful — a stopped shell's
                // last-known ports say nothing about anything running now.
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
    // With `live` truthful, recompute the placeholder `needs` counts and
    // stamp each session's `needs_since_ms`.
    tt_agentboard::bridge::recompute_needs(payload, since, now);
}

/// Delete a plain shell's session record the moment its PTY exits (an agent
/// pane keeps its last-known status; an exited shell is just an "Off" row).
/// Runs after [`stamp_pty_state`], which makes `session.live` truthful;
/// `ever_live` keeps a brand-new session that hasn't spawned its PTY yet from
/// being deleted out from under the user.
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

/// The stamped payload, recomputed now. Shared by `ab_get_state` and emitters.
/// The agent snapshot (claude CLI + `/proc` + transcript reads) is collected
/// BEFORE taking the engine lock so its subprocess work can't stall other
/// `ab_*` commands.
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

/// Fire a desktop notification per session that just flipped into needs-you
/// (edge-detected in the emitter loop). Status-report only — acting on the
/// agent happens in the real PTY. Skipped while the window is focused or
/// when the user's notification rules exclude it.
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
        // `window.focus_changed` to see whether the OS raised the window as a
        // side effect of this (it's the notification daemon's call, not ours;
        // see the worktree-delete-focus investigation).
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

/// The notification body wording for a needs-you edge, keyed off *why* the
/// session needs you. Text label only — no interaction happens here.
fn needs_you_body(edge: &tt_agentboard::NeedsYouEdge) -> String {
    use tt_agentboard::NeedsYouReason::*;
    let what = match edge.reason {
        WaitingForInput => "is waiting for input",
        Errored => "errored",
        Finished => "finished",
    };
    format!("{} {}", edge.session, what)
}

// Tauri commands.

/// Pull the current snapshot (initial mount).
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

/// Remove the repo at `dir` from the rail. Takes the exact dir, not a resolved session
/// name — removing several repos in a row by name is unsafe (see `remove_repo_persisted`).
///
/// `dir` is not always a `repos.json` entry: a worktree deleted outside `tt task rm`
/// leaves only git's `.git/worktrees/<name>` registration at its owning checkout, which
/// is what the prune below clears. Async because `git worktree remove`/`prune` are real
/// subprocess waits, and per the crate's "never hold the Engine lock across git" rule
/// both the owner lookup and the git calls happen with the lock released.
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
        state.engine.lock().unwrap().invalidate_git(&owner);
    }
    tracing::info!(%dir, removed_tracked, pruned, "repo.removed");
    if removed_tracked || pruned {
        state.scan.notify_one();
        state.emit.notify_one();
    }
    Ok(())
}

/// Untrack every tracked repo whose directory is gone from disk (the rail's
/// "missing" ghosts — e.g. removed worktrees). Returns the dropped dirs
/// so the client can toast a count.
#[tauri::command]
pub fn ab_untrack_missing(state: State<Ab>) -> Vec<String> {
    let removed = state.engine.lock().unwrap().untrack_missing();
    tracing::info!(count = removed.len(), "repo.untrack_missing");
    if !removed.is_empty() {
        state.emit.notify_one();
    }
    removed
}

/// Read the add-repo picker's configured scan roots (`scanRoots` in repos.json).
/// Empty ⇒ the picker falls back to `~/code`.
#[tauri::command]
pub fn ab_get_scan_roots(state: State<Ab>) -> Vec<String> {
    state.engine.lock().unwrap().scan_roots()
}

/// Set the add-repo picker's scan roots. Blank entries are dropped; an empty
/// list clears the key so the picker falls back to `~/code`.
#[tauri::command]
pub fn ab_set_scan_roots(state: State<Ab>, roots: Vec<String>) {
    let cleaned: Vec<String> =
        roots.into_iter().map(|r| r.trim().to_string()).filter(|r| !r.is_empty()).collect();
    tracing::info!(count = cleaned.len(), "agentboard.scan_roots_set");
    state.engine.lock().unwrap().set_scan_roots(cleaned);
}

/// A repo candidate for the manage-repos picker: either already on the rail
/// or discoverable under a scan root.
#[derive(serde::Serialize)]
pub struct RepoCandidate {
    /// Friendly label, e.g. `p/towles-tool` (path relative to the scan root).
    pub name: String,
    /// Absolute path, passed back verbatim to `ab_add_repo`/`ab_remove_repo`.
    pub dir: String,
    /// Whether this repo is currently on the rail.
    pub active: bool,
}

/// Expand a leading `~`/`~/` in a configured scan root to the home dir.
fn expand_tilde(raw: &str, home: Option<&std::path::Path>) -> std::path::PathBuf {
    match (raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~")), home) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => std::path::PathBuf::from(raw),
    }
}

/// The manage-repos picker's candidates: repos discovered under `roots` ∪
/// `existing`, named relative to their root (bare dir outside every root),
/// `active` = already tracked. Split from `ab_discover_repos` for testing.
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

/// List every repo the manage-repos picker should show (see
/// `build_repo_candidates`) under the configured scan roots (`scanRoots` in
/// repos.json, defaulting to `~/code`).
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

        // "p/other" is already on the rail; "p/proj" is only discovered;
        // "/elsewhere/typed" is on the rail but outside every scan root.
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

/// Add a PTY session to a folder. Returns the new record so the client can
/// select it immediately.
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

/// The folder's first session, seeding the default one if it has none — the
/// task-creation flow's "session to type into", without a full state fetch
/// and without risking a second row when a default already exists.
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

/// Set the rail's repo order to `dirs` (the user dragging a row in Settings →
/// Agentboard → Repos). Tolerant of a stale list — see `reorder_repos`.
#[tauri::command]
pub fn ab_set_repo_order(state: State<Ab>, dirs: Vec<String>) -> Result<(), String> {
    // Returns the failure rather than swallowing it: a drag that didn't reach
    // disk otherwise looks settled and is simply gone on the next launch, and
    // the client's revert path would be unreachable code.
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

/// Set a repo's chosen icon/color identity. All-`None` resets it to the
/// default look. A `color` that isn't a hex color is stored as unset rather
/// than rejecting the whole edit — the picker validates first, so a malformed
/// value here means a hand-edited file, and dropping one field beats failing
/// the user's icon change along with it.
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
    // Not named `ui.action` — the click already emitted one of those; this is
    // the backend record of what actually changed on disk.
    tracing::info!(repo_dir = %dir, icon, color, changed, "repo.identity_set");
    if changed {
        state.emit.notify_one();
    }
}

/// Set (or clear with `None`/blank) a folder's base-branch override — the
/// parent branch its diff pane compares against instead of the
/// origin/main-or-master auto-detect. For a long-running branch that didn't
/// fork from main.
#[tauri::command]
pub fn ab_set_folder_base_branch(state: State<Ab>, dir: String, branch: Option<String>) {
    let changed = state.engine.lock().unwrap().set_folder_base_branch(&dir, branch.as_deref());
    tracing::info!(%dir, branch = branch.as_deref().unwrap_or(""), changed, "folder.base_branch_set");
    if changed {
        state.emit.notify_one();
    }
}

/// Set (or clear) a folder's quiet override — forces it to count as quiet for
/// a narrowing rail filter regardless of its own activity.
#[tauri::command]
pub fn ab_set_folder_quiet(state: State<Ab>, dir: String, quiet: bool) {
    let changed = state.engine.lock().unwrap().set_folder_quiet(&dir, quiet);
    tracing::info!(%dir, quiet, changed, "folder.quiet_set");
    if changed {
        state.emit.notify_one();
    }
}

/// Set (or clear with `None`/blank) a session's user-authored purpose —
/// captured when starting Claude, so the rail can show why a session exists.
#[tauri::command]
pub fn ab_set_session_purpose(state: State<Ab>, id: String, text: Option<String>) {
    let changed = state.engine.lock().unwrap().set_session_purpose(&id, text.as_deref());
    tracing::info!(%id, changed, "session.purpose_set");
    if changed {
        state.emit.notify_one();
    }
}

/// Set the compact-nudge threshold (context-%), persisting to shared settings.
#[tauri::command]
pub fn ab_set_compact_percent(state: State<Ab>, percent: u8) {
    let changed = state.engine.lock().unwrap().set_compact_recommend_percent(percent);
    tracing::info!(percent, changed, "agentboard.compact_percent_set");
    if changed {
        state.emit.notify_one();
    }
}

/// Show (or hide) auto-discovered worktrees that `tt task` didn't create,
/// persisting to shared settings. Rust owns this one end to end — the engine
/// reads it when deciding which checkouts to discover — so the client toggles
/// it here rather than writing the settings file itself.
#[tauri::command]
pub fn ab_set_show_unmanaged_worktrees(state: State<Ab>, show: bool) {
    let changed = state.engine.lock().unwrap().set_show_unmanaged_worktrees(show);
    tracing::info!(show, changed, "agentboard.show_unmanaged_worktrees_set");
    if changed {
        state.emit.notify_one();
    }
}

/// Persist the window layout (frontend-owned; saved debounced from the client).
/// Deliberately does NOT re-emit — echoing the blob back would clobber
/// rapid-fire local edits; the client's copy is the live truth.
/// `touched_folders` are the folder dirs the client actually mutated since its
/// last save — see `WindowsStore::save`'s doc comment for why a whole-blob
/// save can't be applied blindly across every folder.
#[tauri::command]
pub fn ab_save_windows(
    state: State<Ab>,
    payload: tt_agentboard::WindowsPayload,
    touched_folders: Vec<String>,
) {
    state.engine.lock().unwrap().set_windows(payload, &touched_folders);
}

/// Set (or clear) one folder-rail row's collapsed state (issue #52).
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

/// Changed-file list for the diff pane's Monaco diff editor. `mode` picks the
/// baseline: `"uncommitted"` diffs the working tree vs HEAD, anything else
/// diffs vs the merge-base with `base_branch` (the folder's base-branch
/// override, from `FolderData.baseBranch`) or origin/main if unset. Async:
/// a large branch diff is real work, even in-process.
#[tauri::command]
pub async fn ab_get_diff_files(
    dir: String,
    mode: String,
    base_branch: Option<String>,
) -> Vec<tt_agentboard::DiffFile> {
    let mode = parse_diff_mode(&mode);
    tauri::async_runtime::spawn_blocking(move || {
        tt_agentboard::diff_files(&dir, mode, base_branch.as_deref())
    })
    .await
    .unwrap_or_default()
}

/// A file's content at the diff baseline (`git show`), the original side of
/// the diff editor. `None` when the file doesn't exist at the base
/// (added/untracked).
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

/// Per-commit line-count breakdown for a folder's `DiffButton` hover, oldest
/// commit first — see `tt_agentboard::commit_stats`. `base_branch` is the
/// folder's base-branch override, same as [`ab_get_diff_files`]. Async for the
/// same reason: a many-commit branch means one tree diff per commit.
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
