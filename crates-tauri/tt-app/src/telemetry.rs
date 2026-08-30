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
use tt_telemetry::{
    AttentionSummary, Bucket, BuildKey, BuildSnapshot, DashboardSummary, Delta, GroupBy,
    KeyboardDay, KeyboardScore, TelemetryRecord,
};

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

/// The last `days` UTC calendar days, today included: an empty day shows as a
/// gap rather than the range silently reaching further back.
#[tauri::command]
pub async fn telemetry_dashboard(days: u32, group_by: String) -> Result<DashboardSummary, String> {
    let dir = telemetry_dir()?;
    let group_by =
        GroupBy::parse(&group_by).ok_or_else(|| format!("unknown group_by: {group_by}"))?;
    let days = i64::from(days).clamp(1, KEYBOARD_WINDOW_DAYS);
    tauri::async_runtime::spawn_blocking(move || {
        let today = Utc::now().date_naive();
        let dates: Vec<String> = (0..days)
            .rev()
            .map(|back| (today - Duration::days(back)).format("%Y-%m-%d").to_string())
            .collect();
        let records = tt_telemetry::read_days(&dir, &dates).map_err(|e| e.to_string())?;
        let bucket = if days == 1 { Bucket::Hour } else { Bucket::Day };
        Ok(tt_telemetry::summarize_dashboard(&dates, &records, bucket, group_by))
    })
    .await
    .map_err(|e| format!("telemetry dashboard task panicked: {e}"))?
}

/// One snapshot per build × day over the newest `days` files on disk — the
/// Builds tab's experiment list. Reads whole days, so the same 75,000-record
/// caveat as the dashboard applies.
#[tauri::command]
pub async fn telemetry_builds(days: u32) -> Result<Vec<BuildSnapshot>, String> {
    let dir = telemetry_dir()?;
    let days = (days as usize).clamp(1, KEYBOARD_WINDOW_DAYS as usize);
    tauri::async_runtime::spawn_blocking(move || {
        let dates = tt_telemetry::recent_days(&dir, days).map_err(|e| e.to_string())?;
        let records = tt_telemetry::read_days(&dir, &dates).map_err(|e| e.to_string())?;
        Ok(tt_telemetry::snapshots(&records))
    })
    .await
    .map_err(|e| format!("telemetry builds task panicked: {e}"))?
}

/// `other` measured against `base`. Only the two days named are read, so a
/// re-compare after a chip change costs two files, not the fortnight.
#[tauri::command]
pub async fn telemetry_build_compare(
    base: BuildKey,
    other: BuildKey,
) -> Result<Vec<Delta>, String> {
    let dir = telemetry_dir()?;
    tauri::async_runtime::spawn_blocking(move || {
        let dates = vec![base.day.clone(), other.day.clone()];
        let records = tt_telemetry::read_days(&dir, &dates).map_err(|e| e.to_string())?;
        let snapshots = tt_telemetry::snapshots(&records);
        let find = |key: &BuildKey| {
            snapshots
                .iter()
                .find(|s| s.key() == *key)
                .ok_or_else(|| format!("no telemetry for build {} on {}", key.sha, key.day))
        };
        Ok(tt_telemetry::compare(find(&base)?, find(&other)?))
    })
    .await
    .map_err(|e| format!("telemetry build compare task panicked: {e}"))?
}

/// The newest `limit` matches plus the full count, so the bar can say "684
/// rows" while the DOM holds a few hundred.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordPage {
    pub records: Vec<TelemetryRecord>,
    pub total: usize,
}

/// The Log tab's query over the last `days` files, filtered here because a
/// fortnight can be a million records and only the page should cross IPC.
#[tauri::command]
pub async fn telemetry_records(
    days: u32,
    filters: Vec<tt_telemetry::Filter>,
    query: String,
    limit: usize,
) -> Result<RecordPage, String> {
    let dir = telemetry_dir()?;
    tauri::async_runtime::spawn_blocking(move || {
        let dates =
            tt_telemetry::recent_days(&dir, days.max(1) as usize).map_err(|e| e.to_string())?;
        let all = tt_telemetry::read_days(&dir, &dates).map_err(|e| e.to_string())?;
        let hits = tt_telemetry::apply(&all, &filters, &query);
        let total = hits.len();
        let records = hits.iter().rev().take(limit).map(|r| (*r).clone()).collect();
        Ok(RecordPage { records, total })
    })
    .await
    .map_err(|e| format!("telemetry records task panicked: {e}"))?
}

/// The records written inside the span that closed at `ts` on `day`. Several
/// spans can close in one millisecond; the longest wins, its tree holds the rest.
#[tauri::command]
pub async fn telemetry_trace(ts: String, day: String) -> Result<Vec<TelemetryRecord>, String> {
    let dir = telemetry_dir()?;
    tauri::async_runtime::spawn_blocking(move || {
        let records = tt_telemetry::read_day(&dir, &day).map_err(|e| e.to_string())?;
        let Some(parent) = records
            .iter()
            .filter(|r| r.ts == ts && r.duration_ms.is_some())
            .max_by_key(|r| r.duration_ms)
        else {
            return Ok(Vec::new());
        };
        Ok(tt_telemetry::children_of(parent, &records).into_iter().cloned().collect())
    })
    .await
    .map_err(|e| format!("telemetry trace task panicked: {e}"))?
}
