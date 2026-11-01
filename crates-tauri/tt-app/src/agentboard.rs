//! Tauri bridge for agentboard. The engine itself lives in
//! `tt_agentboard::engine`; this module owns the Tauri glue: the managed state,
//! the `agentboard://state` event, and the `ab_*` commands. Agent state is
//! derived by scanning `~/.claude` (see `lib.rs`), not pushed over HTTP.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Notify;

use tt_agentboard::StatePayload;

pub use tt_agentboard::engine::{Engine, now_ms};

pub const STATE_EVENT: &str = "agentboard://state";
pub const AUTO_ARCHIVED_EVENT: &str = "agentboard://auto-archived";

/// How often the emit loop asks whether anything has gone quiet long enough to
/// archive: the window is hours at the shortest, and the ask reads the settings file.
pub const AUTO_ARCHIVE_EVERY_MS: i64 = 60_000;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AutoArchived {
    names: Vec<String>,
}

/// Archive what `agentboard.autoArchiveAfterHours` says has gone quiet. Blocking
/// (settings read, engine lock, `repos.json` write), so the emit loop runs it in
/// `spawn_blocking`. `payload` must be stamped — the engine alone can't see live
/// shells. Returns whether anything was archived.
pub fn auto_archive_tick(app: &AppHandle, payload: &StatePayload) -> bool {
    let Some(hours) = tt_config::load()
        .ok()
        .and_then(|s| s.agentboard.auto_archive_after_hours)
        .filter(|h| *h > 0)
    else {
        return false;
    };
    let result = app.state::<Ab>().engine.lock().unwrap().auto_archive(payload, hours, now_ms());
    let archived = match result {
        Ok(archived) => archived,
        Err(e) => {
            tracing::warn!(after_hours = hours, error = %e, "repo.auto_archived failed");
            return false;
        }
    };
    if archived.is_empty() {
        return false;
    }
    let names = payload
        .repos
        .iter()
        .filter(|r| archived.contains(&r.dir))
        .inspect(|r| tracing::info!(repo_dir = %r.dir, after_hours = hours, "repo.auto_archived"))
        .map(|r| r.name.clone())
        .collect();
    let _ = app.emit(AUTO_ARCHIVED_EVENT, AutoArchived { names });
    true
}

pub struct Ab {
    pub engine: Arc<Mutex<Engine>>,
    /// Signals the debounced emitter to rebuild + emit.
    pub emit: Arc<Notify>,
    /// Signals the scan task to run an eager scan (fs-notify accelerant).
    pub scan: Arc<Notify>,
    /// First-entered "needs you" timestamps, carried across recomputes so a
    /// session's waiting-age is stable. Every payload the app stamps threads here.
    pub needs_since: Mutex<tt_agentboard::bridge::SinceStamps>,
    /// Session ids seen with a live PTY at least once, so [`prune_ended_sessions`]
    /// can tell "just ended" from "hasn't started yet".
    pub ever_live: Mutex<HashSet<String>>,
    /// Set as the app goes down; see [`stop_pruning_for_shutdown`].
    pub shutting_down: AtomicBool,
    /// Needs-you edges waiting out the notification coalescing window.
    pub coalescer: Mutex<tt_agentboard::Coalescer>,
    /// The status each session last showed, for `agent.status_changed`.
    pub status_log: Mutex<tt_agentboard::status_log::StatusLog>,
}

/// Consecutive `claude agents` failures before the board says so out loud. Two,
/// not one: a single miss is covered by the next retry, and a banner that
/// flickers on every hiccup is one nobody reads.
const SCAN_FAILURES_BEFORE_DEGRADED: u32 = 2;

/// Stamp `SessionData.live`/`shellKind`/`portDrift`/`agentState.status` from the
/// app's PTY registry — the engine can't see PTYs, and every payload leaving the
/// app passes through here first. Status is load-bearing: the engine's verdict
/// is the session journal's, which can't see a permission prompt, so the PTY's
/// direct observation folds over the top.
pub fn stamp_pty_state(
    payload: &mut StatePayload,
    terms: &crate::terminal::TermState,
    phases: &crate::task::TaskPhases,
    since: &mut tt_agentboard::bridge::SinceStamps,
    log: &mut tt_agentboard::status_log::StatusLog,
    now: i64,
) {
    let crate::terminal::PtyEmitState { sessions: ptys, mut port_drift } = terms.emit_state();
    // One failure is a hiccup the retry covers; a run of them means the rows
    // below are missing agents rather than reporting none.
    payload.agent_scan_ok =
        tt_agentboard::claude_cli::consecutive_scan_failures() < SCAN_FAILURES_BEFORE_DEGRADED;
    for repo in &mut payload.repos {
        for folder in &mut repo.folders {
            // Only this process knows whether a create/removal is running here.
            folder.phase = phases.get(&folder.dir);
            let mut has_port_drift = false;
            for session in &mut folder.sessions {
                let pty = ptys.get(&session.id);
                session.live = pty.is_some();
                session.shell_kind = pty.map(|p| p.shell_kind.clone());
                // Only sessions this app hosts a PTY for; everything else has no
                // direct evidence to apply.
                let journal = session.agent_state.as_ref().map(|s| s.status);
                if let Some(pty) = pty
                    && let Some(state) = session.agent_state.as_mut()
                {
                    state.status = tt_agentboard::pty_status::resolve_status(
                        state.status,
                        state.background_out() > 0,
                        &pty.signal,
                        now,
                    );
                }
                session.working = session.agent_state.as_ref().is_some_and(|e| e.is_working());
                if let (Some(pty), Some(state)) = (pty, session.agent_state.as_ref()) {
                    log_status_change(
                        log,
                        &folder.name,
                        &session.id,
                        journal,
                        state,
                        &pty.signal,
                        now,
                    );
                }
                // A stopped shell's last-known ports say nothing about now.
                session.port_drift = if session.live {
                    port_drift.remove(&session.id).unwrap_or_default()
                } else {
                    Vec::new()
                };
                has_port_drift |= !session.port_drift.is_empty();
            }
            folder.has_port_drift = has_port_drift;
        }
    }
    let present = payload
        .repos
        .iter()
        .flat_map(|r| &r.folders)
        .flat_map(|f| &f.sessions)
        .map(|s| s.id.as_str())
        .collect();
    log.retain(&present);
    // Only now is `live` truthful enough to recompute the `needs` counts.
    tt_agentboard::bridge::recompute_needs(payload, since, now);
}

/// One record per move of a session's shown status, carrying what decided it:
/// the journal's reading, the background count, and the PTY evidence's ages.
/// `thread` is Claude Code's session id, which `examples/sim.rs` keys on.
fn log_status_change(
    log: &mut tt_agentboard::status_log::StatusLog,
    folder: &str,
    session_id: &str,
    journal: Option<tt_agentboard::AgentStatus>,
    state: &tt_agentboard::AgentEvent,
    pty: &tt_agentboard::pty_status::PtySignal,
    now: i64,
) {
    let working = state.is_working();
    let Some(prev) = log.observe(session_id, (state.status, working)) else {
        return;
    };
    let age = |at: Option<i64>| at.map(|t| now - t);
    tracing::info!(
        session = session_id,
        thread = state.thread_id.as_deref(),
        folder,
        from = prev.map(|p| format!("{:?}", p.0).to_lowercase()),
        to = format!("{:?}", state.status).to_lowercase(),
        was_working = prev.map(|p| p.1),
        working,
        journal = journal.map(|j| format!("{j:?}").to_lowercase()),
        background = state.background_out(),
        output_age_ms = age(pty.last_output_ms),
        run_ms = pty.output_since_ms.zip(pty.last_output_ms).map(|(since, last)| last - since),
        attention_age_ms = age(pty.attention_at_ms),
        input_age_ms = age(pty.input_at_ms),
        "agent.status_changed"
    );
}

/// Delete a session's record the moment its PTY ends — exit, crash or kill,
/// agent pane or plain shell — so a shell that is gone never lingers as a row.
/// Must run after [`stamp_pty_state`]; `ever_live` keeps a session that hasn't
/// spawned its PTY yet from being deleted.
fn prune_ended_sessions(payload: &mut StatePayload, ab: &Ab) {
    if ab.shutting_down.load(Ordering::SeqCst) {
        return;
    }
    let mut engine = ab.engine.lock().unwrap();
    let mut ever_live = ab.ever_live.lock().unwrap();
    for repo in &mut payload.repos {
        for folder in &mut repo.folders {
            folder.sessions.retain(|session| {
                if session.live {
                    ever_live.insert(session.id.clone());
                    return true;
                }
                if !ever_live.remove(&session.id) {
                    return true;
                }
                tracing::info!(session_id = %session.id, "session.pruned_ended");
                engine.close_session(&session.id, now_ms());
                false
            });
        }
    }
}

/// App shutdown kills every PTY, and those records must outlive it — restart
/// respawns their panes and the resume picker reads them — so pruning stops
/// before the kill can read as every session ending.
pub fn stop_pruning_for_shutdown(app: &AppHandle) {
    if let Some(ab) = app.try_state::<Ab>() {
        ab.shutting_down.store(true, Ordering::SeqCst);
    }
}

/// Rebuilds from the engine's cached agent snapshot — the scan task owns the
/// claude CLI, `/proc` and transcript reads, so an emit does none of them.
pub fn stamped_payload(app: &AppHandle) -> StatePayload {
    if let Some(simulated) = crate::sim::state(app) {
        return simulated;
    }
    let ab = app.state::<Ab>();
    let live = app.state::<crate::terminal::TermState>().live_ids();
    let mut payload = {
        let mut engine = ab.engine.lock().unwrap();
        engine.set_live_sessions(live);
        engine.compute_payload(now_ms())
    };
    stamp_pty_state(
        &mut payload,
        &app.state::<crate::terminal::TermState>(),
        &app.state::<crate::task::TaskPhases>(),
        &mut ab.needs_since.lock().unwrap(),
        &mut ab.status_log.lock().unwrap(),
        now_ms(),
    );
    prune_ended_sessions(&mut payload, &ab);
    payload
}

/// Hold freshly flipped needs-you edges for the coalescing window, then fire
/// one desktop notification for the batch. Focus and the settings toggle are
/// judged when the window closes, so a user who came back meanwhile isn't pinged.
/// Status-report only — acting on the agent happens in the real PTY.
pub fn notify_needs_you(app: &AppHandle, edges: &[tt_agentboard::NeedsYouEdge]) {
    let Some(ab) = app.try_state::<Ab>() else {
        return;
    };
    let Some(due_ms) = ab.coalescer.lock().unwrap().push(now_ms(), edges) else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let wait = u64::try_from(due_ms - now_ms()).unwrap_or(0);
        tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
        let batch = app.state::<Ab>().coalescer.lock().unwrap().take_due(now_ms());
        if let Some(batch) = batch {
            fire_needs_you(&app, &batch);
        }
    });
}

fn fire_needs_you(app: &AppHandle, batch: &[tt_agentboard::NeedsYouEdge]) {
    use tauri_plugin_notification::NotificationExt;

    let Some((title, body)) = tt_agentboard::coalesce::summarize(batch) else {
        return;
    };
    let focused = app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false);
    if focused {
        tracing::debug!(edges = batch.len(), "notify_needs_you: skipped, window focused");
        return;
    }
    if !crate::settings::notify_allowed(tt_config::NotifyKind::NeedsYou) {
        tracing::debug!(edges = batch.len(), "notify_needs_you: skipped, notifications off");
        return;
    }
    // The only record of a native notification firing — correlate against
    // `window.focus_changed` to see if the OS raised the window off it. One
    // record per notification; `edges` is how many agents it covered, and
    // repo/session/reason name the longest-waiting one.
    let head = &batch[0];
    tracing::info!(
        repo = head.repo,
        session = head.session,
        reason = ?head.reason,
        edges = batch.len(),
        coalesced = batch.len() - 1,
        "notify_needs_you: fired"
    );
    let _ = app.notification().builder().title(title).body(body).show();
}

#[tauri::command]
pub fn ab_get_state(app: AppHandle) -> StatePayload {
    stamped_payload(&app)
}

/// Clear unseen for a session (fast-path: patch + re-emit, no full rebuild).
#[tauri::command]
pub fn ab_mark_seen(state: State<Ab>, app: AppHandle, name: String) {
    if crate::sim::active(&app) {
        return;
    }
    let patched = {
        let mut engine = state.engine.lock().unwrap();
        engine.mark_seen_patch(&name)
    };
    if let Some(mut payload) = patched {
        let thread = payload
            .repos
            .iter()
            .flat_map(|r| &r.folders)
            .flat_map(|f| &f.sessions)
            .find(|s| s.id == name)
            .and_then(|s| s.agent_state.as_ref()?.thread_id.clone());
        tracing::info!(session = name, thread, "session.seen");
        stamp_pty_state(
            &mut payload,
            &app.state::<crate::terminal::TermState>(),
            &app.state::<crate::task::TaskPhases>(),
            &mut state.needs_since.lock().unwrap(),
            &mut state.status_log.lock().unwrap(),
            now_ms(),
        );
        prune_ended_sessions(&mut payload, &state);
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

async fn provision_and_track(
    state: State<'_, Ab>,
    make: impl FnOnce() -> tt_git::repo::Result<std::path::PathBuf> + Send + 'static,
) -> Result<String, String> {
    let dir = tauri::async_runtime::spawn_blocking(make)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let path = dir.to_string_lossy().to_string();
    ab_add_repo(state, path.clone());
    Ok(path)
}

/// Returns the new repo's directory, already tracked.
#[tauri::command]
pub async fn ab_create_repo(
    state: State<'_, Ab>,
    parent: String,
    name: String,
) -> Result<String, String> {
    let parent = tt_config::expand_tilde(&parent);
    provision_and_track(state, move || tt_git::provision::init_repo(&parent, &name)).await
}

/// `source` is `owner/repo` or a clone URL; `name` defaults to the repo's own.
#[tauri::command]
pub async fn ab_clone_repo(
    state: State<'_, Ab>,
    source: String,
    parent: String,
    name: Option<String>,
) -> Result<String, String> {
    let (url, default_name) = tt_git::provision::parse_clone_source(&source)
        .ok_or_else(|| format!("\"{}\" isn't owner/repo or a clone URL", source.trim()))?;
    let name = name.filter(|n| !n.trim().is_empty()).unwrap_or(default_name);
    let parent = tt_config::expand_tilde(&parent);
    provision_and_track(state, move || tt_git::provision::clone_repo(&url, &parent, name.trim()))
        .await
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
        configured.iter().map(|r| tt_config::expand_tilde(r)).collect()
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

/// Hides a repo from the rail without untracking it: its checkouts, tasks and
/// sessions are untouched, and restoring it is the same call with `false`.
#[tauri::command]
pub fn ab_set_repo_archived(state: State<Ab>, dir: String, archived: bool) -> Result<(), String> {
    let dirs = [dir];
    let result = state.engine.lock().unwrap().set_repos_archived(&dirs, archived, now_ms());
    let [dir] = dirs;
    match result {
        Ok(changed) => {
            let changed = !changed.is_empty();
            tracing::info!(repo_dir = %dir, archived, changed, "repo.archived_set");
            if changed {
                state.emit.notify_one();
            }
            Ok(())
        }
        Err(e) => {
            tracing::warn!(repo_dir = %dir, archived, error = %e, "repo.archived_set failed");
            Err(format!("Couldn't save the archive: {e}"))
        }
    }
}

/// Rust owns this setting, like `showUnmanagedWorktrees`: the engine sorts the
/// payload, so the client sets it here rather than writing the settings file.
#[tauri::command]
pub fn ab_set_rail_sort(
    state: State<Ab>,
    repos: Option<tt_config::RailSort>,
    tasks: Option<tt_config::RailSort>,
) {
    let changed = state.engine.lock().unwrap().set_rail_sort(repos, tasks);
    tracing::info!(repos = ?repos, tasks = ?tasks, changed, "agentboard.rail_sort_set");
    if changed {
        state.emit.notify_one();
    }
}

/// All-`None` resets to the default look. A `color` outside the palette is
/// stored as unset rather than rejecting the whole edit — the picker offers only
/// the palette, so anything else here came from somewhere hand-edited.
#[tauri::command]
pub fn ab_set_repo_meta(
    state: State<Ab>,
    dir: String,
    icon: Option<String>,
    color: Option<String>,
) {
    let meta = tt_agentboard::RepoMeta {
        icon: icon.map(|i| i.trim().to_string()).filter(|i| !i.is_empty()),
        color: color
            .as_deref()
            .and_then(tt_agentboard::HexColor::parse)
            .filter(|c| tt_agentboard::repo_meta::palette_pin(c).is_some()),
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

/// The parent branch a folder's git stats are measured against instead of the
/// origin/main-or-master auto-detect, for a branch that didn't fork from main.
#[tauri::command]
pub fn ab_set_folder_base_branch(state: State<Ab>, dir: String, branch: Option<String>) {
    let changed = state.engine.lock().unwrap().set_folder_base_branch(&dir, branch.as_deref());
    tracing::info!(%dir, branch = branch.as_deref().unwrap_or(""), changed, "folder.base_branch_set");
    if changed {
        state.emit.notify_one();
    }
}

/// Claim the short git-freshness ceiling while a folder's files pane is mounted.
/// Not instrumented: pane visibility fires on every folder switch.
#[tauri::command]
pub fn ab_set_folder_focus(state: State<Ab>, dir: String, focused: bool) {
    if state.engine.lock().unwrap().set_folder_focus(&dir, focused) {
        state.scan.notify_one();
    }
}

/// Forces checkouts to count as quiet for a narrowing rail filter regardless of
/// their own activity. A set, not one dir: the rail's repo menu marks a whole
/// repo, meaning its root checkout and every worktree under it.
#[tauri::command]
pub fn ab_set_folder_quiet(state: State<Ab>, dirs: Vec<String>, quiet: bool) {
    let changed = state.engine.lock().unwrap().set_folder_quiet(&dirs, quiet);
    tracing::info!(count = dirs.len(), quiet, changed, "folder.quiet_set");
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

/// The delete dialog's branch-vs-base summary. Async: two diffs plus one tree
/// diff per commit.
#[tauri::command]
pub async fn ab_get_branch_diff(
    dir: String,
    base_branch: Option<String>,
) -> Option<tt_agentboard::BranchDiff> {
    tauri::async_runtime::spawn_blocking(move || {
        tt_agentboard::branch_diff(&dir, base_branch.as_deref())
    })
    .await
    .ok()
    .flatten()
}

/// One file of the branch diff as hunks, for the quick diff view.
#[tauri::command]
pub async fn ab_get_file_patch(
    dir: String,
    base_branch: Option<String>,
    path: String,
    old_path: Option<String>,
) -> Option<tt_agentboard::FilePatch> {
    tauri::async_runtime::spawn_blocking(move || {
        tt_agentboard::file_patch(&dir, base_branch.as_deref(), &path, old_path.as_deref())
    })
    .await
    .ok()
    .flatten()
}

/// Per-commit line counts for the committed chip's hover card, oldest commit
/// first. Async: a many-commit branch is one tree diff per commit.
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
