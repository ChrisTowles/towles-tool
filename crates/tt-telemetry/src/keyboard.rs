//! Keyboard-vs-mouse habit scoring — *am I actually using them, and getting
//! better?* Only click targets with a genuine twin emit `mouse.<id>`
//! (`lib/shortcut-coach.ts`), so every one is a keystroke that was available
//! and not taken. The share spans *all* ids, not only ids seen on both sides:
//! a shortcut with no clickable equivalent is still keyboard-first.

use serde::Serialize;

use crate::TelemetryRecord;
use crate::attention::event_name;

const SHORTCUT_PREFIX: &str = "shortcut.";
const MOUSE_PREFIX: &str = "mouse.";
const ACTION_EVENT: &str = "ui.action";

/// Share of duel actions taken by keyboard that wins the day.
pub const GOAL_SHARE: f64 = 0.75;

/// Below this a day is neutral, not won or lost: three actions at 100% says
/// nothing about a habit, and three at 0% shouldn't cost a streak.
pub const GOAL_MIN_ACTIONS: usize = 10;

/// Caps [`KeyboardScore::top_missed`] only — the `?` overlay and the coach's
/// fluency check read `by_shortcut` and need *every* id, not a ranked head.
const TOP_N: usize = 8;

/// Below this a binding is ranked after every one the floor can judge: a
/// single stray click is a 0% binding and must not head the practice list.
const PRACTICE_MIN_ACTIONS: usize = 3;

/// One day's keyboard-vs-mouse split.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyboardDay {
    /// The log day this covers (UTC, matching the file name).
    pub date: String,
    /// `shortcut.*` records: bindings that fired.
    pub shortcut: usize,
    /// `mouse.*` records: bound actions taken with the pointer instead.
    pub mouse: usize,
    /// `shortcut / (shortcut + mouse)`, or `None` on a day with no duel
    /// records at all — which is not the same as 0%.
    pub share: Option<f64>,
    pub goal_met: bool,
    /// Too quiet to judge — see [`GOAL_MIN_ACTIONS`].
    pub idle: bool,
    pub by_shortcut: Vec<ShortcutSplit>,
}

/// One binding's own duel record.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutSplit {
    /// Registry shortcut id, without the `shortcut.`/`mouse.` prefix.
    pub id: String,
    pub shortcut: usize,
    pub mouse: usize,
}

/// A window of days plus what they add up to as a habit.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyboardScore {
    /// One entry per requested date, log file or not, so gaps chart as gaps.
    pub days: Vec<KeyboardDay>,
    /// Duplicated out of `days`: an empty window would otherwise need
    /// handling at every consumer.
    pub today: KeyboardDay,
    /// Skips idle days and an as-yet-unwon today.
    pub streak: usize,
    pub best_streak: usize,
    pub window_shortcut: usize,
    pub window_mouse: usize,
    pub window_share: Option<f64>,
    /// Every binding the window saw — what the `?` overlay annotates rows with.
    pub by_shortcut: Vec<ShortcutSplit>,
    /// Worst keyboard share first; bindings too thin to judge sort last.
    pub top_missed: Vec<ShortcutSplit>,
    /// Echoed so the UI states the goal without restating the constants.
    pub goal_share: f64,
    pub goal_min_actions: usize,
}

impl KeyboardDay {
    /// No log file, or one with no gestures in it.
    pub fn empty(date: &str) -> Self {
        KeyboardDay {
            date: date.to_string(),
            shortcut: 0,
            mouse: 0,
            share: None,
            goal_met: false,
            idle: true,
            by_shortcut: Vec::new(),
        }
    }

    pub fn total(&self) -> usize {
        self.shortcut + self.mouse
    }
}

/// One day's records reduced to its split. Pure — no clock, no filesystem.
pub fn summarize_keyboard(date: &str, records: &[TelemetryRecord]) -> KeyboardDay {
    let mut splits: Vec<ShortcutSplit> = Vec::new();
    let mut shortcut = 0usize;
    let mut mouse = 0usize;

    for record in records.iter().filter(|r| event_name(r) == ACTION_EVENT) {
        let Some(action) = record.fields.get("action").and_then(|v| v.as_str()) else {
            continue;
        };
        if let Some(id) = action.strip_prefix(SHORTCUT_PREFIX) {
            shortcut += 1;
            split(&mut splits, id).shortcut += 1;
        } else if let Some(id) = action.strip_prefix(MOUSE_PREFIX) {
            mouse += 1;
            split(&mut splits, id).mouse += 1;
        }
    }

    let total = shortcut + mouse;
    let share = (total > 0).then(|| shortcut as f64 / total as f64);
    let idle = total < GOAL_MIN_ACTIONS;

    // The point of the list is what to practice, not what already works.
    splits.sort_by(|a, b| b.mouse.cmp(&a.mouse).then(b.shortcut.cmp(&a.shortcut)));

    KeyboardDay {
        date: date.to_string(),
        shortcut,
        mouse,
        share,
        goal_met: !idle && share.is_some_and(|s| s >= GOAL_SHARE),
        idle,
        by_shortcut: splits,
    }
}

/// A window of days (oldest first) scored as a habit. Separate from
/// [`summarize_keyboard`] so the streak rules are testable without building a
/// day of records per case.
pub fn keyboard_score(days: Vec<KeyboardDay>) -> KeyboardScore {
    let today = days.last().cloned().unwrap_or_else(|| KeyboardDay::empty(""));

    let mut streak = 0usize;
    for (from_end, day) in days.iter().rev().enumerate() {
        if day.idle {
            continue;
        }
        if day.goal_met {
            streak += 1;
        } else if from_end == 0 {
            // Today, not yet at goal — still in progress, not a loss.
            continue;
        } else {
            break;
        }
    }

    let mut best_streak = 0usize;
    let mut run = 0usize;
    for day in &days {
        if day.idle {
            continue;
        }
        if day.goal_met {
            run += 1;
            best_streak = best_streak.max(run);
        } else {
            run = 0;
        }
    }
    best_streak = best_streak.max(streak);

    let window_shortcut: usize = days.iter().map(|d| d.shortcut).sum();
    let window_mouse: usize = days.iter().map(|d| d.mouse).sum();
    let window_total = window_shortcut + window_mouse;

    let mut by_shortcut: Vec<ShortcutSplit> = Vec::new();
    for day in &days {
        for s in &day.by_shortcut {
            let entry = split(&mut by_shortcut, &s.id);
            entry.shortcut += s.shortcut;
            entry.mouse += s.mouse;
        }
    }
    by_shortcut.sort_by(|a, b| b.mouse.cmp(&a.mouse).then(b.shortcut.cmp(&a.shortcut)));
    // Practice ranks by the *habit*, not the click count: a binding the
    // pointer wins 133-to-3 is worth more than one it wins 133-to-100.
    let mut ranked: Vec<(u8, f64, usize, ShortcutSplit)> = by_shortcut
        .iter()
        .filter(|s| s.mouse > 0)
        .map(|s| {
            let total = s.shortcut + s.mouse;
            let thin = u8::from(total < PRACTICE_MIN_ACTIONS);
            (thin, s.shortcut as f64 / total as f64, usize::MAX - s.mouse, s.clone())
        })
        .collect();
    ranked.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)).then(a.2.cmp(&b.2)));
    let mut top_missed: Vec<ShortcutSplit> = ranked.into_iter().map(|r| r.3).collect();
    top_missed.truncate(TOP_N);

    KeyboardScore {
        days,
        today,
        streak,
        best_streak,
        window_shortcut,
        window_mouse,
        window_share: (window_total > 0).then(|| window_shortcut as f64 / window_total as f64),
        by_shortcut,
        top_missed,
        goal_share: GOAL_SHARE,
        goal_min_actions: GOAL_MIN_ACTIONS,
    }
}

/// The entry for `id`, appending it if new. Linear scan like
/// [`crate::attention`]'s `bump`: a few dozen ids, and insertion order stays
/// stable for equal counts.
fn split<'a>(splits: &'a mut Vec<ShortcutSplit>, id: &str) -> &'a mut ShortcutSplit {
    match splits.iter().position(|s| s.id == id) {
        Some(i) => &mut splits[i],
        None => {
            splits.push(ShortcutSplit { id: id.to_string(), shortcut: 0, mouse: 0 });
            let last = splits.len() - 1;
            &mut splits[last]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn action(id: &str) -> TelemetryRecord {
        TelemetryRecord {
            ts: "2026-07-25T10:00:00+00:00".into(),
            kind: "event".into(),
            level: "INFO".into(),
            target: "tt_app_lib".into(),
            name: "event crates-tauri/tt-app/src/lib.rs:81".into(),
            tt_task: None,
            tt_build_sha: None,
            duration_ms: None,
            fields: json!({ "message": ACTION_EVENT, "action": id, "screen": "agentboard" }),
            raw: String::new(),
        }
    }

    fn records(ids: &[&str]) -> Vec<TelemetryRecord> {
        ids.iter().map(|id| action(id)).collect()
    }

    /// Straight from counts: the streak rules care about `goal_met`/`idle`,
    /// not how they were derived.
    fn day(date: &str, shortcut: usize, mouse: usize) -> KeyboardDay {
        let ids: Vec<String> = (0..shortcut)
            .map(|_| "shortcut.sidebar".to_string())
            .chain((0..mouse).map(|_| "mouse.sidebar".to_string()))
            .collect();
        let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        summarize_keyboard(date, &records(&refs))
    }

    #[test]
    fn splits_shortcut_and_mouse_records_by_binding() {
        let day = summarize_keyboard(
            "2026-07-25",
            &records(&[
                "shortcut.sidebar",
                "mouse.sidebar",
                "shortcut.palette",
                "shortcut.palette",
                // An ordinary click with no binding is not a miss.
                "board.archive_done",
            ]),
        );

        assert_eq!(day.shortcut, 3);
        assert_eq!(day.mouse, 1);
        assert_eq!(day.share, Some(0.75));
        assert_eq!(
            day.by_shortcut[0],
            ShortcutSplit { id: "sidebar".into(), shortcut: 1, mouse: 1 }
        );
        assert_eq!(
            day.by_shortcut[1],
            ShortcutSplit { id: "palette".into(), shortcut: 2, mouse: 0 }
        );
    }

    #[test]
    fn a_day_with_no_gestures_has_no_share_rather_than_zero() {
        let day = summarize_keyboard("2026-07-25", &[]);
        assert_eq!(day.share, None);
        assert!(day.idle);
        assert!(!day.goal_met);
        assert_eq!(day.total(), 0);
    }

    /// A perfect share over three actions is not evidence of a habit.
    #[test]
    fn a_quiet_day_is_neutral_not_won() {
        let day = day("2026-07-25", 3, 0);
        assert_eq!(day.share, Some(1.0));
        assert!(day.idle);
        assert!(!day.goal_met);
    }

    #[test]
    fn the_goal_needs_both_the_share_and_the_volume() {
        assert!(day("2026-07-25", 15, 5).goal_met); // 75%, 20 actions
        assert!(!day("2026-07-25", 14, 6).goal_met); // 70%
        assert!(!day("2026-07-25", 9, 0).goal_met); // 100% of too little
    }

    #[test]
    fn streak_counts_consecutive_won_days_ending_today() {
        let score = keyboard_score(vec![
            day("2026-07-21", 10, 10), // lost
            day("2026-07-22", 20, 0),
            day("2026-07-23", 20, 0),
            day("2026-07-24", 20, 0),
        ]);
        assert_eq!(score.streak, 3);
        assert_eq!(score.best_streak, 3);
    }

    /// The habit's whole point is daily practice; a weekend the app never
    /// opened is not a lapse.
    #[test]
    fn an_idle_day_passes_the_streak_through() {
        let score = keyboard_score(vec![
            day("2026-07-22", 20, 0),
            day("2026-07-23", 0, 0), // app not opened
            day("2026-07-24", 20, 0),
        ]);
        assert_eq!(score.streak, 2);
    }

    /// Below goal at noon must not zero a streak the afternoon can save.
    #[test]
    fn today_below_goal_does_not_break_the_streak_yet() {
        let score = keyboard_score(vec![
            day("2026-07-23", 20, 0),
            day("2026-07-24", 20, 0),
            day("2026-07-25", 5, 15), // today, losing so far
        ]);
        assert_eq!(score.streak, 2);
        assert_eq!(score.today.date, "2026-07-25");
        assert!(!score.today.goal_met);
    }

    /// Only the newest day gets that benefit of the doubt.
    #[test]
    fn a_lost_yesterday_breaks_the_streak() {
        let score = keyboard_score(vec![
            day("2026-07-23", 20, 0),
            day("2026-07-24", 5, 15), // lost
            day("2026-07-25", 20, 0), // won
        ]);
        assert_eq!(score.streak, 1);
        assert_eq!(score.best_streak, 1);
    }

    #[test]
    fn top_missed_ranks_the_worst_habit_not_the_loudest() {
        // `loud` loses more clicks in absolute terms, but `stuck` is the
        // binding whose habit never formed — practice that one first.
        let mut actions: Vec<String> = Vec::new();
        actions.extend((0..8).map(|_| "mouse.loud".to_string()));
        actions.extend((0..8).map(|_| "shortcut.loud".to_string()));
        actions.extend((0..5).map(|_| "mouse.stuck".to_string()));
        let refs: Vec<&str> = actions.iter().map(String::as_str).collect();
        let score = keyboard_score(vec![summarize_keyboard("2026-07-24", &records(&refs))]);

        assert_eq!(
            score.top_missed[0],
            ShortcutSplit { id: "stuck".into(), shortcut: 0, mouse: 5 }
        );
        assert_eq!(score.top_missed[1], ShortcutSplit { id: "loud".into(), shortcut: 8, mouse: 8 });
    }

    #[test]
    fn a_binding_too_thin_to_judge_never_heads_the_practice_list() {
        // One stray click is a 0% binding; it must not outrank a real habit.
        let score = keyboard_score(vec![summarize_keyboard(
            "2026-07-24",
            &records(&[
                "mouse.stray",
                "mouse.real",
                "mouse.real",
                "mouse.real",
                "shortcut.real",
            ]),
        )]);

        assert_eq!(score.top_missed[0].id, "real");
        assert_eq!(score.top_missed[1].id, "stray");
    }

    #[test]
    fn an_empty_window_still_yields_a_today() {
        let score = keyboard_score(Vec::new());
        assert_eq!(score.streak, 0);
        assert_eq!(score.window_share, None);
        assert!(score.today.idle);
    }

    /// Identity is the `message`, as everywhere in this crate: a span named
    /// `shortcut.something` must not be counted.
    #[test]
    fn only_ui_action_events_count() {
        let mut record = action("shortcut.sidebar");
        record.fields = Value::Object(serde_json::Map::new());
        record.name = "shortcut.sidebar".into();
        assert_eq!(summarize_keyboard("2026-07-25", &[record]).shortcut, 0);
    }
}
