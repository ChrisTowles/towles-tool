//! Calendar-event storage: the RFC-3339-preserving write path, the day-window
//! helpers, and the next-meeting read used by the focus features.

use rusqlite::params;

use crate::model::*;
use crate::{Result, Store};

/// Local midnight of `date` as epoch ms, resolving DST edges rather than
/// giving up on them. `None` only if the whole day is unrepresentable.
fn local_midnight(date: chrono::NaiveDate) -> Option<i64> {
    use chrono::{Local, LocalResult, TimeZone};

    match date.and_hms_opt(0, 0, 0).map(|dt| Local.from_local_datetime(&dt)) {
        Some(LocalResult::Single(dt)) => return Some(dt.timestamp_millis()),
        // Fall-back fold: take the earlier instant so the day window still
        // starts at the first occurrence of midnight.
        Some(LocalResult::Ambiguous(earlier, _)) => return Some(earlier.timestamp_millis()),
        _ => {}
    }
    // Spring-forward at 00:00: midnight doesn't exist, so walk to the first
    // instant that does. Bounded — a DST jump is never more than a few hours.
    for minute in 1..=180 {
        if let Some(dt) = date.and_hms_opt(0, 0, 0).map(|dt| dt + chrono::Duration::minutes(minute))
            && let Some(resolved) = Local.from_local_datetime(&dt).earliest()
        {
            return Some(resolved.timestamp_millis());
        }
    }
    None
}

impl Store {
    /// The `[start, end)` epoch-ms bounds of the local calendar day containing
    /// `reference_ms` — the window callers pass to [`Store::replace_events_for_source`].
    /// It lives beside the delete it scopes because **every writer must agree on it**;
    /// two copies with different DST fallbacks once swept two days of rows from one
    /// caller and none from another. An unresolvable boundary falls back to the
    /// *empty* window, never a wider one: stale rows beat destroyed data.
    pub fn local_day_bounds(reference_ms: i64) -> (i64, i64) {
        use chrono::{Duration, Local, TimeZone};

        let Some(reference) = Local.timestamp_millis_opt(reference_ms).single() else {
            return (reference_ms, reference_ms);
        };
        let date = reference.date_naive();
        let start = local_midnight(date);
        let end = local_midnight(date + Duration::days(1));
        match (start, end) {
            (Some(start), Some(end)) => (start, end),
            _ => (reference_ms, reference_ms),
        }
    }

    /// Drop calendar events older than the retention window, returning the row count.
    ///
    /// [`Store::replace_events_for_source`] sweeps as a side effect, but once the last
    /// calendar is switched off no write happens again and `calendar_next` feeds the
    /// countdown a meeting from the day collection stopped. So the collector calls
    /// this even on its nothing-to-do path.
    pub fn sweep_old_events(&self, now_ms: i64) -> Result<usize> {
        Ok(self.conn.execute(
            "DELETE FROM events WHERE starts_at_utc < ?1",
            params![utc_key(now_ms.saturating_sub(EVENT_RETAIN_MS))],
        )?)
    }

    /// Replace one calendar's events within one day window, leaving every other
    /// calendar — and every other day — untouched. Deliberately *not* a full-table
    /// swap: calendars are pulled independently into one timeline, so a global delete
    /// meant whichever pulled second erased the first. `source` is assigned by the
    /// *caller*, never the data — a model-authored payload must not name its lane.
    pub fn replace_events_for_source(
        &self,
        source: &str,
        day_start_ms: i64,
        day_end_ms: i64,
        events: &[EventInput],
        now_ms: i64,
    ) -> Result<usize> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM events WHERE source = ?1
               AND starts_at_utc >= ?2 AND starts_at_utc < ?3",
            params![source, utc_key(day_start_ms), utc_key(day_end_ms)],
        )?;
        // The delete above is scoped to one lane and one day, so it bounds nothing
        // over time; sweeping by *age* is what reclaims rows of a calendar the user
        // renamed or removed, which no per-source write will ever visit again.
        // `tx` is an `unchecked_transaction` on `self.conn`, so this call joins it.
        self.sweep_old_events(now_ms)?;
        // De-duplicate by external_id: the upsert would otherwise let a repeated id
        // overwrite its own earlier row inside the loop while the returned count still
        // claimed both landed. Last occurrence wins, matching the upsert's semantics.
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        let deduped: Vec<&EventInput> = events
            .iter()
            .rev()
            .filter(|e| seen.insert(e.external_id.as_str()))
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        {
            let mut stmt = tx.prepare(
                "INSERT INTO events
                   (source, external_id, title, starts_at, ends_at, attendees, location, join_url,
                    updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(source, external_id) DO UPDATE SET
                   title = excluded.title,
                   starts_at = excluded.starts_at,
                   ends_at = excluded.ends_at,
                   attendees = excluded.attendees,
                   location = excluded.location,
                   join_url = excluded.join_url,
                   updated_at = excluded.updated_at",
            )?;
            for e in &deduped {
                stmt.execute(params![
                    source,
                    e.external_id,
                    e.title,
                    e.start.to_rfc3339(),
                    e.end.map(|end| end.to_rfc3339()),
                    serde_json::to_string(&e.attendees)?,
                    e.location,
                    e.join_url,
                    now_ms,
                ])?;
            }
        }
        tx.commit()?;
        Ok(deduped.len())
    }

    // Queries

    /// Events starting within `[start_ms, end_ms)`, ordered by start time.
    pub fn events_between(&self, start_ms: i64, end_ms: i64) -> Result<Vec<CalEvent>> {
        self.query_events(
            &format!(
                "SELECT {EVENT_COLS} FROM events
                 WHERE starts_at_utc >= ?1 AND starts_at_utc < ?2 ORDER BY starts_at_utc ASC"
            ),
            params![utc_key(start_ms), utc_key(end_ms)],
        )
    }

    /// The meeting to surface at `now_ms`: the one in progress right now, or
    /// the soonest still to start — whichever begins first.
    ///
    /// A meeting stays selected until it actually ends rather than vanishing the
    /// instant it starts. An event with no `end_ts` is a point in time, returned
    /// only while still in the future.
    pub fn current_or_next_event(&self, now_ms: i64) -> Result<Option<CalEvent>> {
        Ok(self
            .query_events(
                &format!(
                    "SELECT {EVENT_COLS} FROM events
                     WHERE (ends_at_utc IS NOT NULL AND ends_at_utc > ?1)
                        OR (ends_at_utc IS NULL AND starts_at_utc >= ?1)
                     ORDER BY starts_at_utc ASC LIMIT 1"
                ),
                [utc_key(now_ms)],
            )?
            .into_iter()
            .next())
    }

    pub(crate) fn query_events(
        &self,
        sql: &str,
        params: impl rusqlite::Params,
    ) -> Result<Vec<CalEvent>> {
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map(params, |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, Option<String>>(7)?,
                r.get::<_, Option<String>>(8)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (
                id,
                source,
                external_id,
                title,
                starts_at,
                ends_at,
                attendees_json,
                location,
                join_url,
            ) = row?;
            let attendees: Vec<String> = serde_json::from_str(&attendees_json)?;
            // Rows are written from a `DateTime`, so an unparseable value means
            // the column was hand-edited. Skip the row rather than fail the query:
            // one bad row must not blank the countdown, and it ages out.
            let Some(start) = parse_rfc3339(&starts_at) else {
                log_unparseable_event(&external_id, &starts_at);
                continue;
            };
            out.push(CalEvent {
                id,
                source,
                external_id,
                title,
                start,
                end: ends_at.as_deref().and_then(parse_rfc3339),
                attendees,
                location,
                join_url,
            });
        }
        Ok(out)
    }
}
