//! The queue's app half: rebuilt on every agentboard emit tick from the
//! stamped payload plus the store, broadcast only when it changed.

use std::collections::HashSet;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};
use tt_agentboard::StatePayload;
use tt_agentboard::queue::{QueueInputs, TaskQueue, snooze_key};
use tt_store::{RankMove, SnoozeUntil};

use crate::store::{StoreState, now_ms};

pub const QUEUE_EVENT: &str = "queue://changed";
pub const AUTO_CLOSED_EVENT: &str = "task://auto-closed";

#[derive(Default)]
pub struct QueueState {
    payload: Mutex<Option<StatePayload>>,
    last: Mutex<Option<TaskQueue>>,
    /// Tasks auto-close has tried this run — one attempt each, so a refusal never loops.
    auto_tried: Mutex<HashSet<i64>>,
}

fn build(app: &AppHandle, payload: &StatePayload) -> Option<TaskQueue> {
    let (tasks, prs, ci_runs, snoozes) = app.state::<StoreState>().queue_inputs()?;
    Some(tt_agentboard::queue::build(QueueInputs {
        tasks: &tasks,
        state: payload,
        prs: &prs,
        ci_runs: &ci_runs,
        snoozes: &snoozes,
        now_ms: now_ms(),
    }))
}

/// Called from the emit loop with each stamped payload; emits on change.
pub fn observe(app: &AppHandle, payload: &StatePayload) {
    let state = app.state::<QueueState>();
    *state.payload.lock().unwrap() = Some(payload.clone());
    publish(app, &state, payload);
}

/// After a store write: rebuild from the last payload the emit loop saw.
pub fn refresh(app: &AppHandle) {
    let state = app.state::<QueueState>();
    // Before the first emit tick there is nothing to join against; that tick publishes.
    let Some(payload) = state.payload.lock().unwrap().clone() else {
        return;
    };
    publish(app, &state, &payload);
}

fn publish(app: &AppHandle, state: &QueueState, payload: &StatePayload) {
    if crate::sim::active(app) {
        return;
    }
    let Some(queue) = build(app, payload) else {
        return;
    };
    drop_spent_snoozes(app, &queue.spent_snoozes);
    auto_close(app, state, &queue);
    if let Some(at) = queue.settles_at_ms {
        let app = app.clone();
        let wait = u64::try_from(at - now_ms()).unwrap_or(0);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
            refresh(&app);
        });
    }
    let mut last = state.last.lock().unwrap();
    if last.as_ref() == Some(&queue) {
        return;
    }
    if let Some(prev) = last.as_ref() {
        log_lane_changes(prev, &queue);
    }
    if last.as_ref().map(|q| &q.next) != Some(&queue.next) {
        let head = queue.items.iter().find(|i| Some(&i.folder_dir) == queue.next.as_ref());
        tracing::info!(
            reason = head.and_then(|i| i.reason).map(|r| r.as_str()),
            waited_ms = head.and_then(|i| i.since_ms).map(|s| now_ms() - s),
            "queue.next_changed"
        );
    }
    let _ = app.emit(QUEUE_EVENT, &queue);
    *last = Some(queue);
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AutoClosed {
    title: String,
    folder_dir: String,
}

/// Close each landed, idle task as done — `/done` with nobody pressing it. The removal
/// guards still run, and a refusal is logged and never retried this run.
fn auto_close(app: &AppHandle, state: &QueueState, queue: &TaskQueue) {
    let fresh: Vec<_> = {
        let mut tried = state.auto_tried.lock().unwrap();
        queue
            .auto_close_candidates()
            .filter(|i| i.task_id.is_some_and(|id| tried.insert(id)))
            .cloned()
            .collect()
    };
    if fresh.is_empty() {
        return;
    }
    let on = tt_config::load()
        .ok()
        .and_then(|s| s.agentboard.auto_close_landed)
        .unwrap_or(tt_config::DEFAULT_AUTO_CLOSE_LANDED);
    if !on {
        return;
    }
    for item in fresh {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let Some(task_id) = item.task_id else {
                return;
            };
            let dir = std::path::Path::new(&item.folder_dir);
            let finished =
                finish_task(&app, task_id, dir, "Closed on its own: the work landed", false);
            tracing::info!(
                task_id,
                closed = finished.is_ok(),
                why = finished.as_ref().err(),
                "task.auto_close"
            );
            if finished.is_ok() {
                let _ = app.emit(
                    AUTO_CLOSED_EVENT,
                    AutoClosed { title: item.title.clone(), folder_dir: item.folder_dir.clone() },
                );
                after_write(&app);
            }
        });
    }
}

/// An "until CI finishes" snooze ends with the run, so the next push can't re-hide its row.
fn drop_spent_snoozes(app: &AppHandle, keys: &[String]) {
    if keys.is_empty() {
        return;
    }
    let result = app.state::<StoreState>().with(|s| {
        keys.iter().try_for_each(|k| s.unsnooze_queue_item(k)).map_err(|e| e.to_string())
    });
    tracing::info!(count = keys.len(), ok = result.is_ok(), "queue.snooze_spent");
}

/// One record per row that changed lane — the queue jumping, as the eye sees it.
fn log_lane_changes(prev: &TaskQueue, next: &TaskQueue) {
    for item in &next.items {
        let Some(was) = prev.items.iter().find(|p| p.folder_dir == item.folder_dir) else {
            continue;
        };
        if was.lane != item.lane {
            let folder = item.folder_dir.rsplit('/').next().unwrap_or_default();
            tracing::info!(
                folder,
                session = item.session_id.as_deref(),
                from = ?was.lane,
                to = ?item.lane,
                reason = item.reason.map(|r| r.as_str()),
                "queue.lane_changed"
            );
        }
    }
}

#[tauri::command]
pub fn queue_get(app: AppHandle) -> Option<TaskQueue> {
    current(&app)
}

/// The queue as the rail last saw it, or built now before the first emit tick.
pub fn current(app: &AppHandle) -> Option<TaskQueue> {
    if let Some(simulated) = crate::sim::queue(app) {
        return Some(simulated);
    }
    if let Some(queue) = app.state::<QueueState>().last.lock().unwrap().clone() {
        return Some(queue);
    }
    let payload = crate::agentboard::stamped_payload(app);
    build(app, &payload)
}

/// Rank changes show on the Board too; the snapshot emit also rebuilds the queue.
fn after_write(app: &AppHandle) {
    crate::store::emit_snapshot_from_app(app);
}

#[tauri::command]
pub fn queue_move(
    app: AppHandle,
    store: State<StoreState>,
    id: i64,
    to: RankMove,
) -> Result<(), String> {
    let result = store.with(|s| s.move_task(id, to).map_err(|e| e.to_string()));
    tracing::info!(task_id = id, to = ?to, ok = result.is_ok(), "task.rank_set");
    result?;
    after_write(&app);
    Ok(())
}

#[tauri::command]
pub fn queue_snooze(
    app: AppHandle,
    store: State<StoreState>,
    folder_dir: String,
    reason: String,
    until_ms: Option<i64>,
    until_ci: bool,
) -> Result<(), String> {
    let key = snooze_key(&folder_dir);
    let until = SnoozeUntil { reason: &reason, until_ms, until_ci };
    let result =
        store.with(|s| s.snooze_queue_item(&key, until, now_ms()).map_err(|e| e.to_string()));
    tracing::info!(reason, until_ms, until_ci, ok = result.is_ok(), "queue.snoozed");
    result?;
    after_write(&app);
    Ok(())
}

#[tauri::command]
pub fn queue_unsnooze(
    app: AppHandle,
    store: State<StoreState>,
    folder_dir: String,
) -> Result<(), String> {
    let key = snooze_key(&folder_dir);
    let result = store.with(|s| s.unsnooze_queue_item(&key).map_err(|e| e.to_string()));
    tracing::info!(ok = result.is_ok(), "queue.unsnoozed");
    result?;
    after_write(&app);
    Ok(())
}

/// How one row of a batch landing ended.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LandResult {
    pub folder_dir: String,
    pub title: String,
    /// `landed` (merged and closed), `merged` (merged, the task stays open), `skipped`
    /// (no longer approved and green) or `failed` (nothing merged).
    pub status: &'static str,
    pub message: Option<String>,
}

/// Merge every picked row's approved, green PR, then close its task as done — `/done`'s gate
/// and removal, so a row that still holds work keeps its worktree. Serial: one checkout at a
/// time, the way a human would land them.
#[tauri::command]
pub async fn queue_land(
    app: AppHandle,
    folder_dirs: Vec<String>,
) -> Result<Vec<LandResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let queue = current(&app).ok_or("the queue isn't ready yet")?;
        let results: Vec<LandResult> = folder_dirs
            .iter()
            .map(|dir| match queue.items.iter().find(|i| &i.folder_dir == dir) {
                Some(item) => land_one(&app, item),
                None => LandResult {
                    folder_dir: dir.clone(),
                    title: dir.clone(),
                    status: "skipped",
                    message: Some("no longer on the queue".to_string()),
                },
            })
            .collect();
        after_write(&app);
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn land_one(app: &AppHandle, item: &tt_agentboard::queue::QueueItem) -> LandResult {
    let result = |status, message: Option<String>| LandResult {
        folder_dir: item.folder_dir.clone(),
        title: item.title.clone(),
        status,
        message,
    };
    let (Some(task_id), Some(pr), true) = (item.task_id, item.pr.as_ref(), item.landable()) else {
        return result("skipped", Some("no longer approved and green".to_string()));
    };
    let dir = std::path::Path::new(&item.folder_dir);
    let number = u64::try_from(pr.number).unwrap_or_default();
    let admin = match tt_tasks::pr::merge(dir, number) {
        Ok(admin) => admin,
        Err(e) => {
            tracing::info!(task_id, pr = number, status = "failed", "queue.land");
            return result("failed", Some(e));
        }
    };
    let finished =
        finish_task(app, task_id, dir, &format!("Landed PR #{number} from the queue"), true);
    tracing::info!(task_id, pr = number, admin, closed = finished.is_ok(), "queue.land");
    match finished {
        Ok(()) => result("landed", admin.then(|| "merged as admin".to_string())),
        Err(why) => result("merged", Some(why)),
    }
}

/// `task_done` without the agent: the live finish gate, then the guarded removal as done.
/// `Err` says why the task stays open. `stop_claimed` stops every listener on the task's
/// claimed ports first; without it, removal stops only the ones running inside the task.
fn finish_task(
    app: &AppHandle,
    task_id: i64,
    dir: &std::path::Path,
    summary: &str,
    stop_claimed: bool,
) -> Result<(), String> {
    use crate::task::{DeleteTarget, TaskDeleteOutcome};

    let branch = tt_tasks::ops::head_branch(dir).ok_or("the checkout is on no branch")?;
    let (blockers, _) = tt_tasks::ops::finish_blockers(dir, &branch);
    if let Some(first) = blockers.first() {
        return Err(first.message.clone());
    }
    if stop_claimed {
        tt_tasks::ops::stop_own_listeners(dir)?;
    }
    app.state::<StoreState>().with(|s| {
        s.set_task_summary(task_id, summary, now_ms()).map(drop).map_err(|e| e.to_string())
    })?;
    let outcome = crate::task::delete_task_blocking(
        app,
        DeleteTarget::Board(task_id),
        false,
        Some(tt_store::TaskOutcome::Done),
        false,
    )?;
    match outcome {
        TaskDeleteOutcome::Deleted { .. } => Ok(()),
        TaskDeleteOutcome::Blocked { blockers, .. } => Err(blockers
            .first()
            .map(|b| b.message.clone())
            .unwrap_or_else(|| "the removal guards refused".to_string())),
    }
}
