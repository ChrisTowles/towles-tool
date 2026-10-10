//! The task queue's app half: rebuilt on every agentboard emit tick from the
//! stamped payload plus the store, broadcast only when it changed.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};
use tt_agentboard::StatePayload;
use tt_agentboard::queue::{QueueInputs, TaskQueue};
use tt_store::RankMove;

use crate::store::{StoreState, now_ms};

pub const QUEUE_EVENT: &str = "queue://changed";

#[derive(Default)]
pub struct QueueState {
    payload: Mutex<Option<StatePayload>>,
    last: Mutex<Option<TaskQueue>>,
}

fn build(app: &AppHandle, payload: &StatePayload) -> Option<TaskQueue> {
    let (tasks, prs, snoozes) = app.state::<StoreState>().queue_inputs()?;
    Some(tt_agentboard::queue::build(QueueInputs {
        tasks: &tasks,
        state: payload,
        prs: &prs,
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
    let Some(queue) = build(app, payload) else {
        return;
    };
    let mut last = state.last.lock().unwrap();
    if last.as_ref() == Some(&queue) {
        return;
    }
    if last.as_ref().map(|q| &q.next) != Some(&queue.next) {
        let head = queue.items.iter().find(|i| Some(&i.key) == queue.next.as_ref());
        tracing::info!(
            reason = head.and_then(|i| i.reason).map(|r| r.as_str()),
            waited_ms = head.and_then(|i| i.since_ms).map(|s| now_ms() - s),
            "queue.next_changed"
        );
    }
    let _ = app.emit(QUEUE_EVENT, &queue);
    *last = Some(queue);
}

#[tauri::command]
pub fn queue_get(app: AppHandle, state: State<QueueState>) -> Option<TaskQueue> {
    if let Some(queue) = state.last.lock().unwrap().clone() {
        return Some(queue);
    }
    let payload = crate::agentboard::stamped_payload(&app);
    build(&app, &payload)
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
    id: i64,
    reason: String,
    until_ms: Option<i64>,
) -> Result<(), String> {
    let result =
        store.with(|s| s.snooze_task(id, &reason, until_ms, now_ms()).map_err(|e| e.to_string()));
    tracing::info!(task_id = id, reason, until_ms, ok = result.is_ok(), "task.snoozed");
    result?;
    after_write(&app);
    Ok(())
}

#[tauri::command]
pub fn queue_unsnooze(app: AppHandle, store: State<StoreState>, id: i64) -> Result<(), String> {
    let result = store.with(|s| s.unsnooze_task(id).map_err(|e| e.to_string()));
    tracing::info!(task_id = id, ok = result.is_ok(), "task.unsnoozed");
    result?;
    after_write(&app);
    Ok(())
}

/// Same guards and branch naming as MCP `task_start`, then the same `+` flow.
#[tauri::command]
pub fn queue_start(app: AppHandle, store: State<StoreState>, id: i64) -> Result<(), String> {
    let task = store.with(|s| s.task_by_id(id).map_err(|e| e.to_string()))?;
    let req = tt_mcp::task_start_request(&task, None, None)?;
    crate::mcp_http::emit_task_start(&app, req)
}

/// File a worktree's loose agent as a task: adopt its detected row, or mint one.
/// The main checkout is refused — a task owns its dir, and removal would follow.
#[tauri::command]
pub fn queue_file_unfiled(
    app: AppHandle,
    store: State<StoreState>,
    state: State<QueueState>,
    folder_dir: String,
) -> Result<i64, String> {
    let folder = state
        .payload
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|p| {
            p.repos.iter().flat_map(|r| &r.folders).find(|f| f.dir == folder_dir).cloned()
        })
        .ok_or_else(|| format!("no checkout at {folder_dir}"))?;
    if !folder.is_worktree {
        return Err(
            "the main checkout can't be filed as a task — start a task for this work instead"
                .into(),
        );
    }
    let id = store.with(|s| {
        let err = |e: tt_store::Error| e.to_string();
        if let Some(row) = s.task_for_worktree_dir(&folder_dir).map_err(err)? {
            return s.adopt_detected_worktree(row.id).map(|t| t.id).map_err(err);
        }
        let task = s.add_task(&folder.branch, "backlog", None, None, now_ms()).map_err(err)?;
        s.set_task_worktree(
            task.id,
            &folder.repo_root,
            None,
            Some(&folder.branch),
            Some(&folder_dir),
        )
        .map_err(err)?;
        Ok(task.id)
    });
    tracing::info!(ok = id.is_ok(), "task.filed");
    let id = id?;
    after_write(&app);
    Ok(id)
}
