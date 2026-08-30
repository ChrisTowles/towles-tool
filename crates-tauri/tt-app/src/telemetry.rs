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
use tt_telemetry::query::{EventDb, QueryResult};
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

/// Days the Query tab loads — the log's retention, so "everything there is".
const QUERY_WINDOW_DAYS: usize = 14;

/// The Query tab's database, kept for the UTC day it was built on: loading a
/// fortnight of JSONL (~30 MB) per Run would dwarf any query, but today's file
/// keeps growing, so the day rollover and an explicit reload are the two
/// rebuild triggers.
static QUERY_DB: Mutex<Option<(String, EventDb)>> = Mutex::new(None);

fn build_query_db(dir: &Path) -> Result<EventDb, String> {
    let days = tt_telemetry::recent_days(dir, QUERY_WINDOW_DAYS).map_err(|e| e.to_string())?;
    let records = tt_telemetry::read_days(dir, &days).map_err(|e| e.to_string())?;
    EventDb::build(&records).map_err(|e| e.to_string())
}

fn utc_today() -> String {
    Utc::now().format("%Y-%m-%d").to_string()
}

/// One read-only statement over the last fortnight of records. A run is a
/// user gesture, so it's logged — shape and outcome only, never the SQL.
#[tauri::command]
pub async fn telemetry_query(sql: String) -> Result<QueryResult, String> {
    let dir = telemetry_dir()?;
    tauri::async_runtime::spawn_blocking(move || {
        let today = utc_today();
        let mut slot = QUERY_DB.lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_ref().is_none_or(|(day, _)| *day != today) {
            let db = build_query_db(&dir)?;
            *slot = Some((today, db));
        }
        let Some((_, db)) = slot.as_ref() else {
            return Err("telemetry query database missing after build".to_string());
        };
        let result = tt_telemetry::query::run(db, &sql, tt_telemetry::query::ROW_CAP);
        match &result {
            Ok(r) => tracing::info!(
                rows = r.rows.len(),
                truncated = r.truncated,
                elapsed_ms = r.elapsed_ms,
                outcome = "ok",
                "telemetry.query_ran"
            ),
            Err(e) => tracing::info!(
                rows = 0,
                truncated = false,
                elapsed_ms = 0,
                outcome = e.outcome(),
                "telemetry.query_ran"
            ),
        }
        result.map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("telemetry query task panicked: {e}"))?
}

/// Rebuilds the Query tab's database from disk now, so lines written since
/// the last build (today's file is live) are queryable before the day rolls.
#[tauri::command]
pub async fn telemetry_query_reload() -> Result<(), String> {
    let dir = telemetry_dir()?;
    tauri::async_runtime::spawn_blocking(move || {
        let db = build_query_db(&dir)?;
        tracing::info!(records = db.record_count(), "telemetry.query_reloaded");
        *QUERY_DB.lock().unwrap_or_else(|e| e.into_inner()) = Some((utc_today(), db));
        Ok(())
    })
    .await
    .map_err(|e| format!("telemetry query reload task panicked: {e}"))?
}
