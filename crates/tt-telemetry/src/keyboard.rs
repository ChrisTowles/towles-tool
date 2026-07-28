//! Keyboard-vs-mouse habit scoring: the same event log [`crate::summarize`]
//! reads, folded into the one question a keyboard-shortcut habit needs
//! answered — *am I actually using them, and am I getting better?*
//!
//! Two `ui.action` records make this measurable, both emitted through the one
//! `uiAction` seam: `shortcut.<id>` when a registry binding fired
//! (`apps/client/src/lib/shortcuts.tsx`), and `mouse.<id>` when the pointer did
//! the same thing binding `<id>` does. Only click targets with a genuine
//! shortcut twin emit the latter (`apps/client/src/lib/shortcut-coach.ts`), so
//! every `mouse.` record is a keystroke that was available and not taken.
//!
//! The share is `shortcut / (shortcut + mouse)` over *all* ids, not only ids
//! seen on both sides: a shortcut for something with no clickable equivalent is
//! still keyboard-first and belongs in the numerator, and a click with no
//! binding is not a miss and belongs nowhere. It does mean a frequently-fired
//! binding (`ab-focus-terminal` is bare Enter) carries real weight in the day's
//! share — the per-id [`ShortcutSplit`] breakdown, not the headline number, is
//! where a specific habit is read.
//!
//! Streaks skip idle days rather than breaking on them. A day with fewer than
//! [`GOAL_MIN_ACTIONS`] duel records is *neutral* — the app was barely used, so
//! it is neither win nor loss and the streak passes through; a weekend must not
//! cost a habit its streak. Today is the other special case: still in progress,
//! so failing the goal *so far* also passes through instead of zeroing a streak
//! the afternoon could still earn.

use serde::Serialize;

use crate::TelemetryRecord;
use crate::attention::event_name;

/// Prefix of a `ui.action` id emitted when a registry binding fired.
const SHORTCUT_PREFIX: &str = "shortcut.";

/// Prefix of a `ui.action` id emitted when the pointer did a bound action's
/// job instead.
const MOUSE_PREFIX: &str = "mouse.";

/// The message of the frontend's gesture event — the same one
/// [`crate::summarize`] counts.
const ACTION_EVENT: &str = "ui.action";

/// Share of duel actions taken by keyboard that wins the day.
pub const GOAL_SHARE: f64 = 0.75;

/// Duel actions a day needs before it can be won or lost at all. Below this
/// the day is neutral: three actions at 100% says nothing about a habit, and
/// three at 0% shouldn't cost a streak.
pub const GOAL_MIN_ACTIONS: usize = 10;

/// Longest "what to practice" list returned — the frontend renders it as
/// bars, and the tail is noise. Only [`KeyboardScore::top_missed`] is capped:
/// the per-id splits are bounded by the shortcut registry (a few dozen ids)
/// and are read by the `?` overlay and by the coach's fluency check, both of
/// which need *every* id rather than a ranked head.
const TOP_N: usize = 8;

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
    /// True when the day cleared [`GOAL_SHARE`] with at least
    /// [`GOAL_MIN_ACTIONS`] duel records.
    pub goal_met: bool,
    /// True when the day is too quiet to judge — see the module docs.
    pub idle: bool,
    /// Per-binding split — every id the day saw, ranked by how often the
    /// pointer won.
    pub by_shortcut: Vec<ShortcutSplit>,
}

/// One binding's own duel record.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutSplit {
    /// The registry shortcut id, without the `shortcut.`/`mouse.` prefix.
    pub id: String,
    pub shortcut: usize,
    pub mouse: usize,
}

/// A window of days plus what they add up to as a habit.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyboardScore {
    /// The window, oldest first, one entry per requested date whether or not
    /// it had a log file — so the frontend charts real gaps.
    pub days: Vec<KeyboardDay>,
    /// The newest day in the window (today, for the live command). Duplicated
    /// out of `days` because every consumer wants it and an empty window
    /// would otherwise need handling at each one.
    pub today: KeyboardDay,
    /// Consecutive won days ending now, skipping idle days and an
    /// as-yet-unwon today.
    pub streak: usize,
    /// The longest such run anywhere in the window.
    pub best_streak: usize,
    /// Duel totals across the whole window.
    pub window_shortcut: usize,
    pub window_mouse: usize,
    pub window_share: Option<f64>,
    /// Every binding the window saw, keyboard and pointer counts side by
    /// side — what the `?` overlay annotates its rows with.
    pub by_shortcut: Vec<ShortcutSplit>,
    /// The head of that list, ranked by pointer wins — what to practice next.
    pub top_missed: Vec<ShortcutSplit>,
    /// The goal being scored against, echoed so the UI states it without
    /// restating the constants.
    pub goal_share: f64,
    pub goal_min_actions: usize,
}

impl KeyboardDay {
    /// An empty day — no log file, or one with no gestures in it.
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

    /// Duel records the day held.
    pub fn total(&self) -> usize {
        self.shortcut + self.mouse
    }
}

/// Reduce one day's records to its keyboard-vs-mouse split. Pure — no clock,
/// no filesystem — so the whole surface is unit-testable from a record list.
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

    // Ranked by pointer wins: the point of the list is what to practice, not
    // what already works.
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

/// Score a window of days (oldest first) as a habit: current streak, best
/// streak, window totals, and what the pointer keeps winning.
///
/// Pure, and separate from [`summarize_keyboard`] so the streak rules are
/// testable without building a day of records per case.
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
    let mut top_missed: Vec<ShortcutSplit> =
        by_shortcut.iter().filter(|s| s.mouse > 0).cloned().collect();
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

/// The entry for `id`, appending it if new. Linear scan for the same reason
/// [`crate::attention`]'s `bump` uses one: a few dozen ids at most, and
/// insertion order stays stable for equal counts.
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

    /// A day built straight from counts, for the streak rules — which care
    /// about `goal_met`/`idle`, not about how they were derived.
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
                // Neither side of the duel — an ordinary click with no
                // binding must not land in either total.
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

    /// Today is still in progress: below goal at noon must not zero a streak
    /// the afternoon can still save.
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

    /// Yesterday's loss is final, though — only the newest day gets the
    /// benefit of the doubt.
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
    fn top_missed_ranks_what_the_pointer_keeps_winning() {
        let monday = summarize_keyboard(
            "2026-07-24",
            &records(&["mouse.sidebar", "mouse.settings", "shortcut.settings"]),
        );
        let tuesday = summarize_keyboard(
            "2026-07-25",
            &records(&["mouse.settings", "mouse.settings", "shortcut.sidebar"]),
        );
        let score = keyboard_score(vec![monday, tuesday]);

        assert_eq!(score.window_shortcut, 2);
        assert_eq!(score.window_mouse, 4);
        assert_eq!(
            score.top_missed[0],
            ShortcutSplit { id: "settings".into(), shortcut: 1, mouse: 3 }
        );
        assert_eq!(
            score.top_missed[1],
            ShortcutSplit { id: "sidebar".into(), shortcut: 1, mouse: 1 }
        );
    }

    #[test]
    fn an_empty_window_still_yields_a_today() {
        let score = keyboard_score(Vec::new());
        assert_eq!(score.streak, 0);
        assert_eq!(score.window_share, None);
        assert!(score.today.idle);
    }

    /// The record's identity is its `message`, same as everywhere else in
    /// this crate — a span named `shortcut.something` must not be counted.
    #[test]
    fn only_ui_action_events_count() {
        let mut record = action("shortcut.sidebar");
        record.fields = Value::Object(serde_json::Map::new());
        record.name = "shortcut.sidebar".into();
        assert_eq!(summarize_keyboard("2026-07-25", &[record]).shortcut, 0);
    }
}
