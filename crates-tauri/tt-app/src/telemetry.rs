//! Tauri bridge for the Telemetry screen: reads `tt-telemetry`'s on-disk
//! event log (`events-<date>.jsonl`) for *this checkout's* `telemetry_dir()`
//! directly. No cache, unlike `claude_sessions.rs` — the screen refreshes on
//! a manual button and on regaining focus rather than needing to survive
//! rapid re-renders, so a fresh read per request is simpler. This does *not*
//! bound how much a request can cost: a busy day's file (observed: 75,000+
//! records) is still read, parsed, and shipped over IPC in full every time
//! (see `tt-telemetry`'s crate docs for the caveat).

use std::path::PathBuf;

use tt_telemetry::{AttentionSummary, TelemetryRecord};

fn telemetry_dir() -> Result<PathBuf, String> {
    tt_config::telemetry_dir().map_err(|e| e.to_string())
}

/// Dates with a log file on disk, newest first.
#[tauri::command]
pub async fn telemetry_days() -> Result<Vec<String>, String> {
    let dir = telemetry_dir()?;
    tauri::async_runtime::spawn_blocking(move || {
        tt_telemetry::list_days(&dir).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("telemetry day list task panicked: {e}"))?
}

/// One day's records, in the order they were written.
#[tauri::command]
pub async fn telemetry_events(date: String) -> Result<Vec<TelemetryRecord>, String> {
    let dir = telemetry_dir()?;
    tauri::async_runtime::spawn_blocking(move || {
        tt_telemetry::read_day(&dir, &date).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("telemetry read task panicked: {e}"))?
}

/// One day's attention picture — focused time, gestures per screen,
/// interruptions, subprocess wait. Reads the same file as
/// [`telemetry_events`] but aggregates it here, so the Attention tab costs a
/// few hundred bytes over IPC instead of a day's worth of records; on the
/// 75,000-record days that motivated the caveat above, that difference is the
/// whole reason this is its own command rather than a frontend `useMemo` over
/// the records the Log tab already holds.
#[tauri::command]
pub async fn telemetry_attention(date: String) -> Result<AttentionSummary, String> {
    let dir = telemetry_dir()?;
    tauri::async_runtime::spawn_blocking(move || {
        let records = tt_telemetry::read_day(&dir, &date).map_err(|e| e.to_string())?;
        Ok(tt_telemetry::summarize(&date, &records))
    })
    .await
    .map_err(|e| format!("telemetry attention task panicked: {e}"))?
}
