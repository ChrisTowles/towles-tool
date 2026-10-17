use super::*;

pub(crate) const CALENDAR_KEY: &str = "claude:calendar";

/// The contract handed to `claude -p --json-schema`, which is why the prompt can be
/// a question and nothing else. Times are `date-time`, never epochs a model can't
/// check; optional fields are *omitted* — serde's default won't take a `null`.
pub(crate) const CALENDAR_SCHEMA: &str = r#"{
  "type": "object",
  "properties": {
    "events": {
      "type": "array",
      "description": "today's events, or [] if there are none",
      "items": {
        "type": "object",
        "properties": {
          "externalId": { "type": "string", "description": "stable event id from the calendar" },
          "title": { "type": "string" },
          "start": { "type": "string", "format": "date-time", "description": "RFC 3339 with the UTC offset the calendar reported, e.g. 2026-07-20T15:00:00-05:00; never converted to UTC" },
          "end": { "type": "string", "format": "date-time", "description": "same format as start; omit if unknown" },
          "attendees": { "type": "array", "items": { "type": "string" }, "description": "attendee display names; omit if unknown" },
          "location": { "type": "string", "description": "omit if unknown" },
          "joinUrl": { "type": "string", "description": "omit if unknown" }
        },
        "required": ["externalId", "title", "start"],
        "additionalProperties": false
      }
    }
  },
  "required": ["events"],
  "additionalProperties": false
}"#;

#[derive(Debug, serde::Deserialize)]
pub(crate) struct CalendarAnswer {
    pub(crate) events: Vec<EventInput>,
}

/// Collect today's events, one `claude -p` per **enabled** [`CalendarSource`], each
/// into its own store lane. One `claude:calendar` run key covers them all, and a
/// failing source contributes a note without costing the others their rows.
pub fn collect_calendar(store: &Store, sources: &[CalendarSource], now_ms: i64) -> CollectSummary {
    let enabled: Vec<&CalendarSource> = sources.iter().filter(|s| s.enabled).collect();
    if enabled.is_empty() {
        // Retention otherwise rides a write; without this the table would freeze.
        let _ = store.sweep_old_events(now_ms);
        let msg = "no calendar sources enabled".to_string();
        return finish(store, CALENDAR_KEY, true, 0, Some(msg), now_ms);
    }

    let (day_start_ms, day_end_ms) = Store::local_day_bounds(now_ms);
    let mut count = 0usize;
    let mut notes: Vec<String> = Vec::new();
    let mut ok = true;
    let mut wrote = false;
    // Ids name store lanes: a repeat's DELETE would wipe the first pull's rows.
    let mut seen_ids: Vec<&str> = Vec::new();
    for source in enabled {
        let id = source.id.trim();
        if !id.is_empty() && seen_ids.contains(&id) {
            ok = false;
            notes.push(format!("{id}: duplicate source id; only the first is pulled"));
            continue;
        }
        seen_ids.push(id);
        match collect_calendar_source(store, source, day_start_ms, day_end_ms, now_ms) {
            Ok(n) => {
                count += n;
                wrote = true;
            }
            Err(msg) => {
                ok = false;
                notes.push(format!("{}: {msg}", source.id));
            }
        }
    }

    // Every source failed, so no write carried retention with it.
    if !wrote {
        let _ = store.sweep_old_events(now_ms);
    }

    let message = if notes.is_empty() { None } else { Some(notes.join("; ")) };
    finish(store, CALENDAR_KEY, ok, count, message, now_ms)
}

/// Pull one source into its own `(source, day)` lane. The caller aggregates into
/// the single `claude:calendar` run record, so this records no run of its own.
pub(crate) fn collect_calendar_source(
    store: &Store,
    source: &CalendarSource,
    day_start_ms: i64,
    day_end_ms: i64,
    now_ms: i64,
) -> Result<usize, String> {
    // `calendar_set` trims what it writes, so a padded id here would open a second
    // lane the MCP push path can never target — every meeting listed twice.
    let id = source.id.trim();
    if id.is_empty() {
        return Err("source has no id".to_string());
    }
    if source.prompt.trim().is_empty() {
        return Err("source has no prompt".to_string());
    }
    let events = run_claude_calendar(&source.prompt)?;
    store_calendar_events(store, id, day_start_ms, day_end_ms, &events, now_ms)
}

/// Apply one source's result, guarding a suspicious empty sweep: `[]` from a hedging
/// model or a downed MCP would blank the Cockpit countdown, so an empty result
/// contradicting rows **this source** still holds keeps them and errors instead.
pub(crate) fn store_calendar_events(
    store: &Store,
    source: &str,
    day_start_ms: i64,
    day_end_ms: i64,
    events: &[EventInput],
    now_ms: i64,
) -> Result<usize, String> {
    if events.is_empty() && has_future_events_today(store, source, now_ms, day_end_ms)? {
        return Err("returned no events but future events remain for today; \
                    kept existing events"
            .to_string());
    }
    store
        .replace_events_for_source(source, day_start_ms, day_end_ms, events, now_ms)
        .map_err(|e| e.to_string())
}

/// Whether `source` holds an event still upcoming today; other lanes filtered out.
pub(crate) fn has_future_events_today(
    store: &Store,
    source: &str,
    now_ms: i64,
    day_end_ms: i64,
) -> Result<bool, String> {
    store
        .events_between(now_ms, day_end_ms)
        .map(|events| events.iter().any(|e| e.source == source))
        .map_err(|e| e.to_string())
}

/// Ask `claude -p` for one calendar's events, capped at [`CLAUDE_TIMEOUT`]. The error
/// distinguishes a claude-side failure (credit, auth, rate limit) from a shape
/// complaint — collapsed, an expired MCP auth reads as unparseable output.
pub(crate) fn run_claude_calendar(prompt: &str) -> Result<Vec<EventInput>, String> {
    log::debug!("claude -p ({} byte prompt)", prompt.len());
    let answer: CalendarAnswer = tt_exec::claude::Ask::new(prompt, CALENDAR_SCHEMA, CLAUDE_TIMEOUT)
        .run()
        .map_err(|e| e.brief())?
        .answer;
    Ok(answer.events)
}
