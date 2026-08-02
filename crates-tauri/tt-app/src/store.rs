//! Tauri bridge for the personal-dashboard store (`tt_store`) and journal logging
//! (`tt_journal`). Mirrors the agentboard bridge shape (see `agentboard.rs`): a
//! managed state wrapping the non-`Sync` `Store` in a `Mutex`, `#[tauri::command]`
//! fns, and a single `store://snapshot` event carrying the full `tt_store::Snapshot`.
//!
//! The store is opened once at startup (`StoreState::open`). Because
//! `Store::open_default` can fail (no data dir), the state holds an `Option<Store>`;
//! commands return `Err("store unavailable: …")` rather than panicking when it is
//! absent. Every successful write recomputes and re-emits the snapshot.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager, State};

use tt_store::{Snapshot, Store};

pub const SNAPSHOT_EVENT: &str = "store://snapshot";

/// These run through `tt_exec`, not a bare `Command`: an unbounded spawn could
/// wedge the caller on a stalled network, and `tt_exec` is the single seam where
/// every subprocess reaches the telemetry event log.
const GH_MUTATION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// The SQLite store, `None` when it could not be opened. `Clone` so `lib.rs`'s
/// git-info poll loop can hold its own handle without `AppHandle::state`.
#[derive(Clone)]
pub struct StoreState {
    store: Arc<Mutex<Option<Store>>>,
}

impl StoreState {
    /// Leaves the state empty on failure so the app still starts.
    pub fn open() -> StoreState {
        let store = match Store::open_default() {
            Ok(s) => Some(s),
            Err(e) => {
                eprintln!("store: unavailable ({e}); store commands will error until restart");
                None
            }
        };
        StoreState { store: Arc::new(Mutex::new(store)) }
    }

    #[cfg(test)]
    fn from_option(store: Option<Store>) -> StoreState {
        StoreState { store: Arc::new(Mutex::new(store)) }
    }

    /// `None` is "the store could not answer", not "no rows" — the caller keeps
    /// the previous list rather than emptying the rail on one bad read.
    pub fn rail_worktrees(&self) -> Option<Vec<tt_store::RailWorktree>> {
        let guard = self.store.lock().unwrap();
        guard.as_ref()?.rail_worktrees().ok()
    }

    /// Both halves are diff-driven by the engine, so the steady state passes two
    /// empty lists and touches the database not at all — this runs on the 2s
    /// scan tick against a file three other processes have open.
    pub fn reconcile_detected_worktrees(
        &self,
        found: &[tt_agentboard::UnrecordedWorktree],
        vanished: &[String],
        now_ms: i64,
    ) {
        if found.is_empty() && vanished.is_empty() {
            return;
        }
        let guard = self.store.lock().unwrap();
        let Some(store) = guard.as_ref() else {
            return;
        };
        for wt in found {
            if let Err(e) =
                store.record_detected_worktree(&wt.repo_root, &wt.dir, wt.branch.as_deref(), now_ms)
            {
                tracing::warn!(dir = %wt.dir, error = %e, "store: failed to record detected worktree");
            }
        }
        for dir in vanished {
            if let Err(e) = store.forget_detected_worktree(dir) {
                tracing::warn!(dir = %dir, error = %e, "store: failed to forget detected worktree");
            }
        }
    }

    /// Best-effort: a no-op if the store never opened.
    pub fn reconcile_repos(&self, repos: &[(String, String)], now_ms: i64) {
        if let Some(store) = self.store.lock().unwrap().as_ref()
            && let Err(e) = store.reconcile_repos(repos, now_ms)
        {
            tracing::warn!(error = %e, "store: failed to reconcile tracked-repo identity cache");
        }
    }

    /// The only path that moves a card between `backlog`/`doing` now that manual
    /// drag-and-drop is gone. Best-effort: a write failure logs and leaves that
    /// row for the next tick to retry.
    pub fn sync_worktree_task_statuses(
        &self,
        payload: &tt_agentboard::StatePayload,
        now_ms: i64,
    ) -> usize {
        let guard = self.store.lock().unwrap();
        let Some(store) = guard.as_ref() else {
            return 0;
        };
        match tt_agentboard::task_status::sync_worktree_task_statuses(store, payload, now_ms) {
            Ok(changed) => changed,
            Err(e) => {
                tracing::warn!(error = %e, "store: failed to sync worktree task statuses");
                0
            }
        }
    }
}

/// Guards against overlapping manual "refresh now" runs, which shell `gh`/Slack
/// for seconds — a jittery double-click could otherwise stack redundant sweeps.
#[derive(Default)]
pub struct CollectNowState {
    running: Arc<AtomicBool>,
}

/// The rail's "Sync now" guard. Keyed by repo dir, unlike [`CollectNowState`]'s
/// single global flag, so two repos syncing at once is fine.
#[derive(Default)]
pub struct RepoSyncState {
    running: Arc<Mutex<std::collections::HashSet<String>>>,
}

/// Clears one dir from [`RepoSyncState`] on every exit path, panic included.
struct ReleaseDirOnDrop(Arc<Mutex<std::collections::HashSet<String>>>, String);

impl Drop for ReleaseDirOnDrop {
    fn drop(&mut self) {
        self.0.lock().unwrap().remove(&self.1);
    }
}

/// Releases the flag on every exit path of the blocking worker, panic included.
struct ReleaseOnDrop(Arc<AtomicBool>);

impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Maps an unavailable store to the stable error string the frontend keys on.
fn with_store<T>(
    state: &StoreState,
    f: impl FnOnce(&Store) -> Result<T, String>,
) -> Result<T, String> {
    let guard = state.store.lock().unwrap();
    let store = guard.as_ref().ok_or("store unavailable: no data directory")?;
    f(store)
}

pub use tt_config::now_ms;

fn snapshot_of(state: &StoreState) -> Result<Snapshot, String> {
    with_store(state, |store| store.snapshot().map_err(|e| format!("store snapshot failed: {e}")))
}

/// Best-effort: a missing store or emit failure is swallowed, since the next
/// write (or an app restart) recovers.
pub fn emit_snapshot(app: &AppHandle, state: &StoreState) {
    if let Ok(snapshot) = snapshot_of(state) {
        let _ = app.emit(SNAPSHOT_EVENT, snapshot);
    }
}

/// The MCP HTTP transport needs this: its dispatcher writes through a *separate*
/// SQLite connection, so a mutating tool call would otherwise leave the UI stale
/// until its next poll.
pub fn emit_snapshot_from_app(app: &AppHandle) {
    let state = app.state::<StoreState>();
    emit_snapshot(app, &state);
}

/// `Ok(None)` is "no such task" — a real answer, not a failure.
pub fn task_by_id(app: &AppHandle, id: i64) -> Result<Option<tt_store::TaskItem>, String> {
    let state = app.state::<StoreState>();
    with_store(&state, |store| store.get_task(id).map_err(|e| format!("get_task failed: {e}")))
}

/// Store errors propagate: an unreadable store reported as "no task" would
/// remove the checkout and leave its row behind — the half-delete this stops.
pub fn task_id_for_worktree_dir(app: &AppHandle, dir: &str) -> Result<Option<i64>, String> {
    let state = app.state::<StoreState>();
    with_store(&state, |store| {
        store.task_for_worktree_dir(dir).map_err(|e| format!("task_for_worktree_dir failed: {e}"))
    })
    .map(|task| task.map(|task| task.id))
}

/// Deliberately not a Tauri command: a row-only delete is the half-delete that
/// used to strand worktrees on disk, so the only way in is
/// [`crate::task::delete_task_blocking`], which has verified nothing is bound.
pub fn delete_task_row(app: &AppHandle, id: i64) -> Result<(), String> {
    let state = app.state::<StoreState>();
    with_store(&state, |store| {
        store.delete_task(id).map_err(|e| format!("delete_task failed: {e}"))
    })?;
    tracing::info!(task_id = id, "task.deleted");
    emit_snapshot(app, &state);
    Ok(())
}

/// Record how a task ended and detach its worktree dir — what replaced
/// [`delete_task_row`] as the normal end of a task. Not a Tauri command for the
/// same reason: the frontend reaches it only through `task_delete`.
pub fn close_task_row(
    app: &AppHandle,
    id: i64,
    outcome: tt_store::TaskOutcome,
) -> Result<(), String> {
    let state = app.state::<StoreState>();
    let now = now_ms();
    // A `detected` row is bookkeeping for a worktree nobody claimed — no work to
    // record an outcome for, so removing the worktree removes the row.
    let detected = with_store(&state, |store| {
        Ok(store
            .get_task(id)
            .ok()
            .flatten()
            .is_some_and(|task| task.kind == tt_store::TaskKind::Detected))
    })
    .unwrap_or(false);
    if detected {
        with_store(&state, |store| {
            store.delete_task(id).map_err(|e| format!("delete_task failed: {e}"))
        })?;
        tracing::info!(task_id = id, "task.detected_row_dropped");
        emit_snapshot(app, &state);
        return Ok(());
    }
    with_store(&state, |store| {
        store.close_task(id, outcome, now).map_err(|e| format!("close_task failed: {e}"))
    })?;
    tracing::info!(task_id = id, outcome = outcome.as_str(), "task.closed");
    emit_snapshot(app, &state);
    Ok(())
}

/// Promote a detected rail row to the user's own work. A kind change on the
/// existing row, never a new one: the id, the links and the `created_at` that
/// fixes its place in the rail all survive, so adopting moves nothing on screen.
#[tauri::command]
pub fn task_adopt_worktree(app: AppHandle, id: i64) -> Result<(), String> {
    let state = app.state::<StoreState>();
    with_store(&state, |store| {
        store
            .adopt_detected_worktree(id)
            .map_err(|e| format!("adopt_detected_worktree failed: {e}"))
    })?;
    tracing::info!(task_id = id, "task.adopted");
    emit_snapshot(&app, &state);
    // The store snapshot alone wouldn't repaint the rail row's changed kind.
    app.state::<crate::agentboard::Ab>().emit.notify_one();
    Ok(())
}

#[tauri::command]
pub fn store_snapshot(state: State<StoreState>) -> Result<Snapshot, String> {
    snapshot_of(&state)
}

/// `status` picks the landing column: quick-add uses `backlog`, the new-task
/// flow puts worktree-backed tasks straight into `doing`.
#[tauri::command]
pub fn store_add_task(
    app: AppHandle,
    state: State<StoreState>,
    text: String,
    status: Option<String>,
    goal: Option<String>,
) -> Result<i64, String> {
    let status = status.unwrap_or_else(|| "backlog".to_string());
    let task = with_store(&state, |store| {
        store
            .add_task(&text, &status, None, goal.as_deref(), now_ms())
            .map_err(|e| format!("add_task failed: {e}"))
    })?;
    tracing::info!(task_id = task.id, %status, "task.created");
    emit_snapshot(&app, &state);
    Ok(task.id)
}

#[tauri::command]
pub fn store_attach_task_issue(
    app: AppHandle,
    state: State<StoreState>,
    id: i64,
    repo: String,
    number: i64,
    url: String,
) -> Result<(), String> {
    with_store(&state, |store| {
        store
            .attach_task_issue(id, &repo, number, &url)
            .map_err(|e| format!("attach_task_issue failed: {e}"))
    })?;
    tracing::info!(task_id = id, %repo, number, "task.issue_attached");
    emit_snapshot(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn store_detach_task_issue(
    app: AppHandle,
    state: State<StoreState>,
    id: i64,
    repo: String,
    number: i64,
) -> Result<(), String> {
    with_store(&state, |store| {
        store
            .detach_task_issue(id, &repo, number)
            .map_err(|e| format!("detach_task_issue failed: {e}"))
    })?;
    tracing::info!(task_id = id, %repo, number, "task.issue_detached");
    emit_snapshot(&app, &state);
    Ok(())
}

/// PRs from the task's own branch attach automatically on collect; this is the
/// manual path for cross-repo or extra PRs.
#[tauri::command]
pub fn store_attach_task_pr(
    app: AppHandle,
    state: State<StoreState>,
    id: i64,
    repo: String,
    number: i64,
    url: String,
) -> Result<(), String> {
    with_store(&state, |store| {
        store
            .attach_task_pr(id, &repo, number, &url)
            .map_err(|e| format!("attach_task_pr failed: {e}"))
    })?;
    tracing::info!(task_id = id, %repo, number, "task.pr_attached");
    emit_snapshot(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn store_detach_task_pr(
    app: AppHandle,
    state: State<StoreState>,
    id: i64,
    repo: String,
    number: i64,
) -> Result<(), String> {
    with_store(&state, |store| {
        store.detach_task_pr(id, &repo, number).map_err(|e| format!("detach_task_pr failed: {e}"))
    })?;
    tracing::info!(task_id = id, %repo, number, "task.pr_detached");
    emit_snapshot(&app, &state);
    Ok(())
}

/// The new-task flow calls this at submit with the repo alone (`branch`/`dir`
/// `None`) so the task has a Board swimlane immediately, then again once
/// `task_create` resolves. `repo` as `owner/name` enables PR auto-attach.
#[tauri::command]
pub fn store_task_set_worktree(
    app: AppHandle,
    state: State<StoreState>,
    id: i64,
    repo_root: String,
    repo: Option<String>,
    branch: Option<String>,
    dir: Option<String>,
) -> Result<(), String> {
    with_store(&state, |store| {
        store
            .set_task_worktree(id, &repo_root, repo.as_deref(), branch.as_deref(), dir.as_deref())
            .map_err(|e| format!("set_task_worktree failed: {e}"))
    })?;
    tracing::info!(task_id = id, branch = branch.as_deref().unwrap_or(""), "task.worktree_bound");
    emit_snapshot(&app, &state);
    // The engine only learns of the binding by re-reading `rail_worktrees` in
    // the scan loop — wake it so the row lands now, not a poll tick later.
    app.state::<crate::agentboard::Ab>().scan.notify_one();
    Ok(())
}

/// Syncs GitHub when this crosses the `done` boundary (see
/// [`spawn_gh_status_sync`]). Used by the "Move to" menu.
#[tauri::command]
pub fn store_set_task_status(
    app: AppHandle,
    state: State<StoreState>,
    id: i64,
    status: String,
) -> Result<(), String> {
    let before = with_store(&state, |store| {
        let before = store.get_task(id).map_err(|e| format!("get_task failed: {e}"))?;
        store
            .set_task_status(id, &status, now_ms())
            .map_err(|e| format!("set_task_status failed: {e}"))?;
        Ok(before)
    })?;
    tracing::info!(
        task_id = id,
        from = before.as_ref().map(|b| b.status.as_str()).unwrap_or(""),
        to = %status,
        "task.status_set"
    );
    emit_snapshot(&app, &state);
    if let Some(before) = before {
        spawn_gh_status_sync(&before.status, &status, &before.issues);
    }
    Ok(())
}

/// Fire-and-forget close/reopen of a task's linked issues; a failed gh call
/// self-heals on the next collector poll. The single call site for this decision
/// so the behavior can't drift (#246). Only board-originated commands sync — the
/// collectors' rollup writes through `tt_store`, so GitHub never echoes back.
fn spawn_gh_status_sync(old_status: &str, new_status: &str, issues: &[tt_store::TaskIssueLink]) {
    let targets = tt_store::gh_close_reopen_targets(old_status, new_status, issues);
    if targets.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        for (repo, number, close) in targets {
            let verb = if close { "close" } else { "reopen" };
            let result =
                if close { close_gh_issue(&repo, number) } else { reopen_gh_issue(&repo, number) };
            match result {
                Ok(()) => tracing::info!(%repo, number, verb, "task.gh_issue_sync"),
                Err(e) => eprintln!("gh issue {verb} sync failed for {repo}#{number}: {e}"),
            }
        }
    });
}

fn close_gh_issue(repo: &str, number: i64) -> Result<(), String> {
    run_gh_issue_state_change(repo, number, "close")
}

fn reopen_gh_issue(repo: &str, number: i64) -> Result<(), String> {
    run_gh_issue_state_change(repo, number, "reopen")
}

fn run_gh_issue_state_change(repo: &str, number: i64, verb: &str) -> Result<(), String> {
    let output = tt_exec::run_with_timeout(
        "gh",
        &["issue", verb, "--repo", repo, &number.to_string()],
        GH_MUTATION_TIMEOUT,
    )
    .map_err(|e| format!("failed to run gh: {e}"))?;
    if !output.ok() {
        return Err(format!("gh issue {verb} failed: {}", output.stderr.trim()));
    }
    Ok(())
}

/// A full replace of both fields — `null` clears notes.
#[tauri::command]
pub fn store_update_task(
    app: AppHandle,
    state: State<StoreState>,
    id: i64,
    text: String,
    notes: Option<String>,
) -> Result<(), String> {
    with_store(&state, |store| {
        store
            .update_task(id, &text, notes.as_deref())
            .map(|_| ())
            .map_err(|e| format!("update_task failed: {e}"))
    })?;
    tracing::info!(task_id = id, "task.updated");
    emit_snapshot(&app, &state);
    Ok(())
}

/// The "Archive done" button — rows are hidden, never deleted. A deliberate
/// manual action, so it ignores [`tt_store::ARCHIVE_AFTER_MS`]: that grace
/// period exists only for the unattended collector-side sweep.
#[tauri::command]
pub fn store_archive_done(app: AppHandle, state: State<StoreState>) -> Result<usize, String> {
    let now = now_ms();
    let archived = with_store(&state, |store| {
        store
            .archive_closed_tasks(now + 1, now)
            .map_err(|e| format!("archive_closed_tasks failed: {e}"))
    })?;
    tracing::info!(count = archived, "task.done_archived");
    emit_snapshot(&app, &state);
    Ok(archived)
}

/// The card's "Restore" action.
#[tauri::command]
pub fn store_unarchive_task(
    app: AppHandle,
    state: State<StoreState>,
    id: i64,
) -> Result<(), String> {
    with_store(&state, |store| {
        store.unarchive_task(id).map_err(|e| format!("unarchive_task failed: {e}"))
    })?;
    tracing::info!(task_id = id, "task.unarchived");
    emit_snapshot(&app, &state);
    Ok(())
}

/// Mark the watched DM's message at `ts` handled (banner dismissal), then re-emit.
#[tauri::command]
pub fn store_dm_dismiss(
    app: AppHandle,
    state: State<StoreState>,
    channel: String,
    ts: i64,
) -> Result<(), String> {
    with_store(&state, |store| {
        store.dismiss_dm(&channel, ts).map_err(|e| format!("dismiss_dm failed: {e}"))
    })?;
    tracing::info!(%channel, "dm.dismissed");
    emit_snapshot(&app, &state);
    Ok(())
}

/// `kind` is `"issue"` or `"pr"`. The item drops out of the attention feed until
/// the collector observes an `updatedTs` newer than the one passed in.
#[tauri::command]
pub fn store_item_dismiss(
    app: AppHandle,
    state: State<StoreState>,
    kind: String,
    repo: String,
    number: i64,
    updated_ts: i64,
) -> Result<(), String> {
    with_store(&state, |store| {
        store
            .dismiss_item(&kind, &repo, number, updated_ts)
            .map_err(|e| format!("dismiss_item failed: {e}"))
    })?;
    tracing::info!(%kind, %repo, number, "item.dismissed");
    emit_snapshot(&app, &state);
    Ok(())
}

/// Clear every dismissed issue/PR at once — the "clear all dismissals" action.
#[tauri::command]
pub fn store_dismissals_clear(app: AppHandle, state: State<StoreState>) -> Result<usize, String> {
    let count = with_store(&state, |store| {
        store.clear_dismissals().map_err(|e| format!("clear_dismissals failed: {e}"))
    })?;
    tracing::info!(count, "items.dismissals_cleared");
    emit_snapshot(&app, &state);
    Ok(count)
}

/// Promote a local todo into a real GitHub issue in `repo` (owner/name), then
/// link that issue back to the todo. Async: the network round-trip runs on a
/// blocking worker so a slow GitHub call can't stall the main thread.
#[tauri::command]
pub async fn store_promote_task_to_issue(
    app: AppHandle,
    state: State<'_, StoreState>,
    id: i64,
    repo: String,
) -> Result<(), String> {
    let (title, body) = with_store(&state, |store| {
        let task = store
            .get_task(id)
            .map_err(|e| format!("get_task failed: {e}"))?
            .ok_or_else(|| format!("no todo with id {id}"))?;
        Ok((task.text, render_promoted_issue_body(task.notes.as_deref())))
    })?;

    let gh_repo = repo.clone();
    let (number, url) =
        tauri::async_runtime::spawn_blocking(move || create_gh_issue(&gh_repo, &title, &body))
            .await
            .map_err(|e| format!("gh issue create task failed: {e}"))??;

    with_store(&state, |store| {
        store
            .attach_task_issue(id, &repo, number, &url)
            .map_err(|e| format!("attach_task_issue failed: {e}"))
    })?;
    tracing::info!(task_id = id, %repo, number, "task.promoted_to_issue");
    emit_snapshot(&app, &state);
    Ok(())
}

/// The new-task flow's issue picker; `assigned_to_me` toggles `--assignee @me`.
/// Read-only — no store write.
#[tauri::command]
pub async fn store_gh_issues_list(
    dir: String,
    assigned_to_me: bool,
) -> Result<Vec<tt_store::IssueInput>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        tt_collect::fetch_importable_issues(std::path::Path::new(&dir), assigned_to_me)
    })
    .await
    .map_err(|e| format!("gh issues list task failed: {e}"))?
}

/// Searches every state, so a task can be linked to any existing issue — not
/// just the open, assigned ones [`store_gh_issues_list`] returns. A blank query
/// returns an empty list without shelling out.
#[tauri::command]
pub async fn store_search_issues(
    dir: String,
    query: String,
) -> Result<Vec<tt_store::IssueInput>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        tt_collect::search_repo_issues(std::path::Path::new(&dir), &query)
    })
    .await
    .map_err(|e| format!("gh issues search task failed: {e}"))?
}

fn create_gh_issue(repo: &str, title: &str, body: &str) -> Result<(i64, String), String> {
    let output = tt_exec::run_with_timeout(
        "gh",
        &[
            "issue", "create", "--repo", repo, "--title", title, "--body", body,
        ],
        GH_MUTATION_TIMEOUT,
    )
    .map_err(|e| format!("failed to run gh: {e}"))?;
    parse_gh_issue_create_output(&output)
}

/// The todo's `notes` verbatim (dropped when blank), plus an origin footer.
fn render_promoted_issue_body(notes: Option<&str>) -> String {
    let mut body = String::new();
    if let Some(notes) = notes.map(str::trim).filter(|n| !n.is_empty()) {
        body.push_str(notes);
        body.push_str("\n\n");
    }
    body.push_str("Promoted from tt board");
    body
}

/// `gh` prints the new issue's URL on stdout; the trailing segment is its number.
fn parse_gh_issue_create_output(output: &tt_exec::Output) -> Result<(i64, String), String> {
    if !output.ok() {
        return Err(format!("gh issue create failed: {}", output.stderr.trim()));
    }
    let url = output.stdout.trim().to_string();
    let number = url
        .rsplit('/')
        .next()
        .and_then(|n| n.parse::<i64>().ok())
        .ok_or_else(|| format!("could not parse issue number from gh output: {url}"))?;
    Ok((number, url))
}

/// Independent of the store (it writes a markdown file), so it works even when
/// the store is unavailable. The frontend owns the line format, so the bullet is
/// written verbatim; only the local date, for section placement, resolves here.
#[tauri::command]
pub fn journal_log(app: AppHandle, state: State<StoreState>, text: String) -> Result<(), String> {
    let line = text.trim();
    if line.is_empty() {
        return Err("journal text is required".into());
    }
    let settings = tt_config::load().map_err(|e| format!("failed to load settings: {e}"))?;
    let date = chrono::Local::now().date_naive();
    tt_journal::entries::append_bullet_to_daily(&settings.journal_settings, date, line)
        .map_err(|e| format!("journal append failed: {e}"))?;
    tracing::info!("journal.logged");
    // Journal writes don't change the store; re-emitted only to match the
    // write-command contract.
    emit_snapshot(&app, &state);
    Ok(())
}

/// `started` is `false` when a manual refresh was already in flight and this
/// call was a no-op, so the frontend keeps its spinner off.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectNowResult {
    pub started: bool,
}

/// Config's "Refresh now". Calendar is intentionally left out (it spends
/// `claude` tokens). Runs on a blocking worker with its own store connection so
/// the `gh`/Slack round-trips never hold the UI's store mutex.
#[tauri::command]
pub async fn store_collect_now(
    app: AppHandle,
    collect: State<'_, CollectNowState>,
) -> Result<CollectNowResult, String> {
    let running = collect.running.clone();
    // Acquire the guard: swap in `true`; if it was already `true`, bail.
    if running.swap(true, Ordering::SeqCst) {
        tracing::info!(outcome = "already_running", "collect.manual");
        return Ok(CollectNowResult { started: false });
    }
    tracing::info!(outcome = "started", "collect.manual");
    tauri::async_runtime::spawn_blocking(move || {
        let _release = ReleaseOnDrop(running);
        run_collect_now_blocking(&app);
    })
    .await
    .map_err(|e| format!("collect-now worker failed: {e}"))?;
    Ok(CollectNowResult { started: true })
}

/// Per-collector failures are logged, never surfaced as a command error, so one
/// dead collector doesn't sink the whole refresh.
fn run_collect_now_blocking(app: &AppHandle) {
    let store = match Store::open_default() {
        Ok(store) => store,
        Err(e) => {
            eprintln!("collect-now: store unavailable ({e}); skipping manual refresh");
            return;
        }
    };
    let collectors = tt_config::load().map(|s| s.collectors).unwrap_or_default();
    let repos = tt_collect::tracked_repo_dirs();
    let slack = manual_slack_config(&collectors);
    for summary in tt_collect::collect_manual(&store, &repos, slack.as_ref(), now_ms()) {
        if !summary.ok {
            eprintln!(
                "collect-now: {} failed: {}",
                summary.collector,
                summary.message.as_deref().unwrap_or("unknown")
            );
        }
    }
    if let Ok(snapshot) = store.snapshot() {
        let _ = app.emit(SNAPSHOT_EVENT, snapshot);
    }
}

/// `started: false` means a sync for this dir was already in flight and the call
/// was a deduped no-op — treat it quietly. Otherwise `ok`/`count`/`message`
/// mirror the combined issues+PRs outcome, `ok` only when both succeeded.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSyncResult {
    pub started: bool,
    pub ok: bool,
    pub count: usize,
    pub message: Option<String>,
}

/// The rail's "Sync now" action, bypassing the poll cadence. Overlap-guarded per
/// dir; blocking worker with its own store connection, like
/// [`store_collect_now`], so the `gh` round-trip never holds the UI's mutex.
#[tauri::command]
pub async fn store_sync_repo(
    app: AppHandle,
    sync: State<'_, RepoSyncState>,
    dir: String,
) -> Result<RepoSyncResult, String> {
    let running = sync.running.clone();
    {
        let mut guard = running.lock().unwrap();
        if !guard.insert(dir.clone()) {
            tracing::info!(%dir, outcome = "already_running", "repo.synced");
            return Ok(RepoSyncResult { started: false, ok: true, count: 0, message: None });
        }
    }
    tracing::info!(%dir, outcome = "started", "repo.synced");
    tauri::async_runtime::spawn_blocking(move || {
        let _release = ReleaseDirOnDrop(running, dir.clone());
        run_sync_repo_blocking(&app, &dir)
    })
    .await
    .map_err(|e| format!("repo sync worker failed: {e}"))
}

/// Opens its own store connection; summarizes the outcome for the caller.
fn run_sync_repo_blocking(app: &AppHandle, dir: &str) -> RepoSyncResult {
    let store = match Store::open_default() {
        Ok(store) => store,
        Err(e) => {
            let msg = format!("store unavailable: {e}");
            eprintln!("repo-sync: {msg}");
            return RepoSyncResult { started: true, ok: false, count: 0, message: Some(msg) };
        }
    };
    let summaries = tt_collect::collect_repo_now(&store, std::path::Path::new(dir), now_ms());
    let ok = summaries.iter().all(|s| s.ok);
    let count = summaries.iter().map(|s| s.count).sum();
    let message = summaries.iter().find(|s| !s.ok).and_then(|s| s.message.clone());
    if !ok {
        eprintln!("repo-sync: sync failed for {dir}: {}", message.as_deref().unwrap_or("unknown"));
    }
    if let Ok(snapshot) = store.snapshot() {
        let _ = app.emit(SNAPSHOT_EVENT, snapshot);
    }
    RepoSyncResult { started: true, ok, count, message }
}

/// `None` when the collector is disabled or tokenless — the same gate the
/// scheduler applies, so a manual refresh never records a failure it would skip.
fn manual_slack_config(
    collectors: &tt_config::CollectorsSettings,
) -> Option<tt_collect::SlackDmConfig> {
    let slack = &collectors.slack;
    if !slack.enabled || slack.token.trim().is_empty() {
        return None;
    }
    Some(tt_collect::SlackDmConfig {
        token: slack.token.clone(),
        watch_user_id: slack.watch_user_id.clone(),
        watch_name: slack.watch_name.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_slack_config_off_when_disabled_or_tokenless() {
        let mut collectors = tt_config::CollectorsSettings::default();
        assert!(manual_slack_config(&collectors).is_none(), "disabled by default");

        collectors.slack.enabled = true;
        assert!(manual_slack_config(&collectors).is_none(), "enabled but no token stays off");

        collectors.slack.token = "  ".to_string();
        assert!(manual_slack_config(&collectors).is_none(), "whitespace token stays off");

        collectors.slack.token = "xoxp-real".to_string();
        collectors.slack.watch_user_id = "U1".to_string();
        let config = manual_slack_config(&collectors).expect("enabled + token → configured");
        assert_eq!(config.token, "xoxp-real");
        assert_eq!(config.watch_user_id, "U1");
    }

    #[test]
    fn promoted_body_carries_notes_verbatim() {
        let body = render_promoted_issue_body(Some("line one\nline two"));
        assert_eq!(body, "line one\nline two\n\nPromoted from tt board");
    }

    #[test]
    fn promoted_body_footer_only_when_notes_blank() {
        assert_eq!(render_promoted_issue_body(None), "Promoted from tt board");
        assert_eq!(render_promoted_issue_body(Some("   \n  ")), "Promoted from tt board");
    }

    #[test]
    fn snapshot_of_empty_store_is_empty() {
        let state = StoreState::from_option(Some(Store::open_in_memory().unwrap()));
        let snap = snapshot_of(&state).unwrap();
        assert!(snap.tasks.is_empty());
        assert!(snap.events.is_empty());
        assert!(snap.issues.is_empty());
    }

    #[test]
    fn snapshot_reflects_writes() {
        let store = Store::open_in_memory().unwrap();
        store.add_task("buy milk", "backlog", None, None, 1).unwrap();
        let state = StoreState::from_option(Some(store));
        let snap = snapshot_of(&state).unwrap();
        assert_eq!(snap.tasks.len(), 1);
        assert_eq!(snap.tasks[0].text, "buy milk");
    }

    #[test]
    fn snapshot_reflects_task_edit_and_delete() {
        let store = Store::open_in_memory().unwrap();
        let a = store.add_task("draft", "backlog", None, None, 1).unwrap();
        let b = store.add_task("scrap", "backlog", None, None, 2).unwrap();
        store.update_task(a.id, "final", Some("done")).unwrap();
        store.delete_task(b.id).unwrap();
        let state = StoreState::from_option(Some(store));
        let snap = snapshot_of(&state).unwrap();
        assert_eq!(snap.tasks.len(), 1);
        assert_eq!(snap.tasks[0].text, "final");
        assert_eq!(snap.tasks[0].notes.as_deref(), Some("done"));
    }

    #[test]
    fn snapshot_of_unavailable_store_errors() {
        let state = StoreState::from_option(None);
        let err = snapshot_of(&state).unwrap_err();
        assert!(err.contains("store unavailable"), "got: {err}");
    }
}
