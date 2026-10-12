//! The queue's app half: rebuilt on every agentboard emit tick from the
//! stamped payload plus the store, broadcast only when it changed.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};
use tt_agentboard::StatePayload;
use tt_agentboard::queue::{QueueInputs, TaskQueue, snooze_key};
use tt_store::RankMove;

use crate::store::{StoreState, now_ms};

pub const QUEUE_EVENT: &str = "queue://changed";

#[derive(Default)]
pub struct QueueState {
    payload: Mutex<Option<StatePayload>>,
    last: Mutex<Option<TaskQueue>>,
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
    let Some(queue) = build(app, payload) else {
        return;
    };
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
    folder_dir: String,
    reason: String,
    until_ms: Option<i64>,
) -> Result<(), String> {
    let key = snooze_key(&folder_dir);
    let result = store.with(|s| {
        s.snooze_queue_item(&key, &reason, until_ms, now_ms()).map_err(|e| e.to_string())
    });
    tracing::info!(reason, until_ms, ok = result.is_ok(), "queue.snoozed");
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
