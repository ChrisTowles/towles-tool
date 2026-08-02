//! Tauri bridge for the Telemetry screen: reads `tt-telemetry`'s on-disk
//! event log (`events-<date>.jsonl`) for *this checkout's* `telemetry_dir()`
//! directly. No cache, unlike `claude_sessions.rs` — the screen refreshes on
//! a manual button and on regaining focus rather than needing to survive
//! rapid re-renders, so a fresh read per request is simpler. This does *not*
//! bound how much a request can cost: a busy day's file (observed: 75,000+
//! records) is still read, parsed, and shipped over IPC in full every time
//! (see `tt-telemetry`'s crate docs for the caveat).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{Duration, Utc};
use tt_telemetry::{AttentionSummary, KeyboardDay, KeyboardScore, TelemetryRecord};

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
/// interruptions, subprocess wait. Aggregated here rather than in a frontend
/// `useMemo`, so a 75,000-record day costs a few hundred bytes over IPC.
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

/// Days of history the keyboard habit is scored over — a fortnight, matching
/// the log's own retention, which is the most history there can be.
const KEYBOARD_WINDOW_DAYS: i64 = 14;

/// Finished days, keyed by date. This one is polled (the status-bar indicator)
/// *and* reads a fortnight per call, so uncached it would re-parse hundreds of
/// thousands of lines every tick. A past date's file never changes once the date
/// rolls over, so caching it is exact rather than a staleness trade.
static PAST_DAYS: Mutex<Option<HashMap<String, KeyboardDay>>> = Mutex::new(None);

/// The keyboard-shortcut habit: today's keyboard-vs-mouse split, the streak of
/// days that cleared the goal, and the bindings the pointer keeps winning.
/// Backs both the status-bar indicator and the Telemetry screen's Attention
/// tab, so the two can never disagree.
#[tauri::command]
pub async fn telemetry_keyboard() -> Result<KeyboardScore, String> {
    let dir = telemetry_dir()?;
    tauri::async_runtime::spawn_blocking(move || {
        // The writer names files by UTC date, so the window must be built in
        // UTC too — a local-midnight window would ask for a date that has no
        // file and miss the one that does.
        let today = Utc::now().date_naive();
        let mut days = Vec::with_capacity(KEYBOARD_WINDOW_DAYS as usize);
        for back in (0..KEYBOARD_WINDOW_DAYS).rev() {
            let date = (today - Duration::days(back)).format("%Y-%m-%d").to_string();
            days.push(keyboard_day(&dir, &date, back == 0)?);
        }
        // Days that have fallen out of the window can't be asked for again;
        // without this the cache grows by one entry per day of app uptime.
        let oldest = (today - Duration::days(KEYBOARD_WINDOW_DAYS)).format("%Y-%m-%d").to_string();
        if let Ok(mut cache) = PAST_DAYS.lock()
            && let Some(entries) = cache.as_mut()
        {
            entries.retain(|date, _| *date >= oldest);
        }
        Ok(tt_telemetry::keyboard_score(days))
    })
    .await
    .map_err(|e| format!("telemetry keyboard task panicked: {e}"))?
}

/// One day's split, served from [`PAST_DAYS`] unless it's today (still being
/// written) — a cache miss reads and summarizes the file.
fn keyboard_day(dir: &Path, date: &str, is_today: bool) -> Result<KeyboardDay, String> {
    if !is_today
        && let Ok(cache) = PAST_DAYS.lock()
        && let Some(day) = cache.as_ref().and_then(|c| c.get(date))
    {
        return Ok(day.clone());
    }
    let records = tt_telemetry::read_day(dir, date).map_err(|e| e.to_string())?;
    let day = tt_telemetry::summarize_keyboard(date, &records);
    if !is_today && let Ok(mut cache) = PAST_DAYS.lock() {
        cache.get_or_insert_with(HashMap::new).insert(date.to_string(), day.clone());
    }
    Ok(day)
}
