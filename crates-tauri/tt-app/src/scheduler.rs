//! Collector scheduler: fills tt.db while the app is open. Cadence comes from
//! `settings.collectors`. PRs split into two independent ticks: the open-PR sweep
//! (`Batch::PrsOpen`) every `prs.refresh_seconds`, which Board/Cockpit render from, and the
//! recently-merged sweep (`Batch::PrsMerged`) on the much looser
//! `prs.merged_refresh_minutes` — it only catches a just-merged branch before its worktree
//! goes. Calendar is gated by `calendar.enabled` because those runs cost tokens. Each batch
//! runs in a blocking task on its **own** store connection, so a slow `claude -p` never
//! holds the UI's store mutex.
//!
//! A batch can also fire early: [`spawn`]'s nudge-dir watch diffs each target's file mtime
//! and acts only on notes naming one of this instance's own PTY sessions ([`note_is_mine`]).

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};
use tt_config::now_ms;

use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;
use tokio::time::MissedTickBehavior;
use tt_config::CalendarSource;
use tt_store::{
    ChecksFailedWatch, MeetingStartWatch, ReviewRequestedWatch, StaleCollectorWatch,
    WatchedCollector,
};

use crate::store::SNAPSHOT_EVENT;

/// Independent of collector cadence (those can be slow or off): this reads the data
/// already in tt.db, so a notification fires within one tick of the event.
const NOTIFY_TICK_SECS: u64 = 15;

/// Cadence multiplier before a collector counts as stale — enough missed cycles that
/// it's clearly stuck, not just one skipped tick.
const STALE_CADENCE_MULT: i64 = 4;

/// Floor, so a fast collector still gets a few minutes of grace before it alarms.
const STALE_FLOOR_MS: i64 = 5 * 60_000;

/// One entry per *enabled* collector, so a disabled one never fires, with a threshold
/// derived from that collector's refresh cadence.
fn watched_collectors(collectors: &tt_config::CollectorsSettings) -> Vec<WatchedCollector> {
    fn threshold(cadence_ms: i64) -> i64 {
        (cadence_ms * STALE_CADENCE_MULT).max(STALE_FLOOR_MS)
    }
    let mut watched = Vec::new();
    if collectors.prs.enabled {
        watched.push(WatchedCollector {
            key: "prs".to_string(),
            stale_after_ms: threshold(collectors.prs.refresh_seconds.max(30) as i64 * 1000),
        });
    }
    if collectors.issues.enabled {
        watched.push(WatchedCollector {
            key: "issues".to_string(),
            stale_after_ms: threshold(collectors.issues.refresh_minutes.max(1) as i64 * 60_000),
        });
    }
    if collectors.calendar.enabled {
        watched.push(WatchedCollector {
            key: "claude:calendar".to_string(),
            stale_after_ms: threshold(collectors.calendar.refresh_minutes.max(1) as i64 * 60_000),
        });
    }
    if collectors.slack.enabled {
        watched.push(WatchedCollector {
            key: "slack:dm".to_string(),
            stale_after_ms: threshold(collectors.slack.refresh_seconds.max(30) as i64 * 1000),
        });
    }
    watched
}

#[derive(Clone)]
enum Batch {
    /// Fast cadence: authored + review-requested open PRs.
    PrsOpen {
        reuse_ms: i64,
    },
    /// Slow cadence: enough to catch a merged branch before its worktree is removed.
    PrsMerged {
        reuse_ms: i64,
    },
    Issues {
        reuse_ms: i64,
    },
    /// Sources snapshotted when the tick fired, so a settings reload mid-run can't
    /// change what this batch is pulling.
    Calendar(Arc<Vec<CalendarSource>>),
    SlackDm(tt_collect::SlackDmConfig),
}

/// How old another window's GitHub results may be before this batch fetches its own. A
/// tick settles for anything newer than its own cadence, which is what stops four open
/// windows making four identical sets of calls; a nudge never does.
fn reuse_window_ms(seconds: u64) -> i64 {
    seconds as i64 * 1_000
}

/// One in-flight flag per collector: a batch is spawned fire-and-forget so the select!
/// loop never parks on it, and the flag keeps a slow run from stacking a second run of
/// the *same* collector. Persisted across settings reloads, like the watchers.
#[derive(Default)]
struct BatchGuards {
    prs_open: Arc<AtomicBool>,
    prs_merged: Arc<AtomicBool>,
    issues: Arc<AtomicBool>,
    calendar: Arc<AtomicBool>,
    slack: Arc<AtomicBool>,
}

/// `true` when the slot was free and is now claimed — the caller must release it when
/// the batch finishes. `false` skips this tick.
fn claim_in_flight(guard: &AtomicBool) -> bool {
    guard.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_ok()
}

/// Last-observed mtime per nudge file, so [`changed_nudge_batches`] can tell *which*
/// target changed — the watcher only reports that the directory did.
#[derive(Default)]
struct NudgeSeen {
    prs: Option<SystemTime>,
    issues: Option<SystemTime>,
    slack: Option<SystemTime>,
}

/// Every instance watches the same machine-global dir, so a note says who it is for or
/// everyone sweeps `gh` for one terminal's mutation. A note naming nobody still reaches
/// everyone: that is what a caller outside an app terminal writes.
fn note_is_mine(dir: &Path, target: tt_collect::NudgeTarget, mine: &dyn Fn(&str) -> bool) -> bool {
    match tt_collect::nudge::session_of(dir, target) {
        Some(session) => mine(&session),
        None => true,
    }
}

/// Off a debounced "something changed" wakeup, the batches whose file advanced *and*
/// was addressed here. `mine` answers "is this one of my PTY sessions?"; `seen` advances
/// even for a note addressed elsewhere, so it is skipped once, not re-read.
fn changed_nudge_batches(
    dir: &Path,
    seen: &mut NudgeSeen,
    slack_config: &tt_collect::SlackDmConfig,
    mine: &dyn Fn(&str) -> bool,
) -> Vec<Batch> {
    fn mtime(dir: &Path, target: tt_collect::NudgeTarget) -> Option<SystemTime> {
        std::fs::metadata(dir.join(target.file_name())).and_then(|m| m.modified()).ok()
    }

    let mut changed = Vec::new();
    let prs_mtime = mtime(dir, tt_collect::NudgeTarget::Prs);
    if prs_mtime.is_some()
        && prs_mtime != seen.prs
        && note_is_mine(dir, tt_collect::NudgeTarget::Prs, mine)
    {
        // Both halves, so a just-merged PR shows up now rather than on the next
        // slow merged-cadence tick.
        changed.push(Batch::PrsOpen { reuse_ms: tt_collect::FETCH_NOW });
        changed.push(Batch::PrsMerged { reuse_ms: tt_collect::FETCH_NOW });
    }
    seen.prs = prs_mtime;
    let issues_mtime = mtime(dir, tt_collect::NudgeTarget::Issues);
    if issues_mtime.is_some()
        && issues_mtime != seen.issues
        && note_is_mine(dir, tt_collect::NudgeTarget::Issues, mine)
    {
        changed.push(Batch::Issues { reuse_ms: tt_collect::FETCH_NOW });
    }
    seen.issues = issues_mtime;
    let slack_mtime = mtime(dir, tt_collect::NudgeTarget::SlackDm);
    if slack_mtime.is_some()
        && slack_mtime != seen.slack
        && note_is_mine(dir, tt_collect::NudgeTarget::SlackDm, mine)
    {
        changed.push(Batch::SlackDm(slack_config.clone()));
    }
    seen.slack = slack_mtime;
    changed
}

/// Spawn the scheduler loop. Settings are re-read whenever `reload` is signalled, so
/// edits in the Settings screen take effect live.
pub fn spawn(app: AppHandle, reload: Arc<Notify>) {
    tauri::async_runtime::spawn(async move {
        // Watchers persist across settings reloads: their edge state must survive a
        // cadence rebuild so a reload never re-fires a stale edge.
        let mut meeting_watch = MeetingStartWatch::new();
        let mut review_watch = ReviewRequestedWatch::new();
        let mut checks_watch = ChecksFailedWatch::new();
        let mut stale_watch = StaleCollectorWatch::new();
        // Kept across ticks: the tick fires every 15s and `Store::open` runs the full
        // migration pass every time.
        let mut notify_store: Option<tt_store::Store> = None;
        // Guards persist across reloads too: a batch spawned under the old cadence must
        // still block a duplicate under the new one.
        let guards = BatchGuards::default();
        // Eager-refresh accelerant: the plugin's PostToolUse hook runs `tt task nudge`
        // after a `gh` mutation so that view updates before its next scheduled tick.
        // `.ok()` falls back to the poll cadence.
        let nudge_dir = tt_config::nudge_dir_path().ok();
        let nudge_notify = Arc::new(Notify::new());
        let _nudge_watcher = nudge_dir.as_ref().and_then(|dir| {
            std::fs::create_dir_all(dir).ok()?;
            let n = nudge_notify.clone();
            tt_agentboard::fs_notify::DirNotifier::watch(dir, move || n.notify_one()).ok()
        });
        let mut nudge_seen = NudgeSeen::default();
        loop {
            let collectors = tt_config::load().map(|s| s.collectors).unwrap_or_default();
            // Rebuilt each cycle so cadence edits change what's watched; the watch's
            // edge state persists across the rebuild.
            let watched = watched_collectors(&collectors);
            let calendar_sources = Arc::new(collectors.calendar.sources.clone());
            let calendar_period_ms = collectors.calendar.refresh_minutes.max(1) as i64 * 60_000;

            // Each tick's cadence doubles as its reuse window — see `reuse_window_ms`.
            let pr_seconds = collectors.prs.refresh_seconds.max(30);
            let pr_merged_seconds = collectors.prs.merged_refresh_minutes.max(1) * 60;
            let issue_seconds = collectors.issues.refresh_minutes.max(1) * 60;
            let pr_reuse_ms = reuse_window_ms(pr_seconds);
            let pr_merged_reuse_ms = reuse_window_ms(pr_merged_seconds);
            let issue_reuse_ms = reuse_window_ms(issue_seconds);

            let mut pr_tick = tokio::time::interval(Duration::from_secs(pr_seconds));
            pr_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
            let mut pr_merged_tick = tokio::time::interval(Duration::from_secs(pr_merged_seconds));
            pr_merged_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
            let mut issue_tick = tokio::time::interval(Duration::from_secs(issue_seconds));
            issue_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
            let mut calendar_tick =
                tokio::time::interval(Duration::from_millis(calendar_period_ms as u64));
            calendar_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
            let mut slack_tick = tokio::time::interval(Duration::from_secs(
                collectors.slack.refresh_seconds.max(30),
            ));
            slack_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
            // Fixed cadence: the watchers only read existing tt.db rows.
            let mut notify_tick = tokio::time::interval(Duration::from_secs(NOTIFY_TICK_SECS));
            notify_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
            // Enabled but unconfigured stays quiet: every tick would record the
            // same failure.
            let slack_on = collectors.slack.enabled && !collectors.slack.token.trim().is_empty();
            let slack_config = tt_collect::SlackDmConfig {
                token: collectors.slack.token.clone(),
                watch_user_id: collectors.slack.watch_user_id.clone(),
                watch_name: collectors.slack.watch_name.clone(),
            };

            // Runs the current cadence until settings change, then rebuilds from the top.
            loop {
                tokio::select! {
                    _ = reload.notified() => break,
                    _ = pr_tick.tick(), if collectors.prs.enabled => {
                        let batch = Batch::PrsOpen { reuse_ms: pr_reuse_ms };
                        spawn_batch(&app, batch, calendar_period_ms, &guards.prs_open);
                    }
                    _ = pr_merged_tick.tick(), if collectors.prs.enabled => {
                        let batch = Batch::PrsMerged { reuse_ms: pr_merged_reuse_ms };
                        spawn_batch(&app, batch, calendar_period_ms, &guards.prs_merged);
                    }
                    _ = issue_tick.tick(), if collectors.issues.enabled => {
                        let batch = Batch::Issues { reuse_ms: issue_reuse_ms };
                        spawn_batch(&app, batch, calendar_period_ms, &guards.issues);
                    }
                    _ = calendar_tick.tick(), if collectors.calendar.enabled => {
                        // Outside working hours, skip the token-costing `claude -p`
                        // run entirely.
                        if tt_collect::should_run_calendar(
                            now_ms(),
                            &collectors.calendar.quiet_hours,
                        ) {
                            spawn_batch(
                                &app,
                                Batch::Calendar(calendar_sources.clone()),
                                calendar_period_ms,
                                &guards.calendar,
                            );
                        }
                    }
                    _ = slack_tick.tick(), if slack_on => {
                        spawn_batch(
                            &app,
                            Batch::SlackDm(slack_config.clone()),
                            calendar_period_ms,
                            &guards.slack,
                        );
                    }
                    _ = nudge_notify.notified() => {
                        if let Some(dir) = &nudge_dir {
                            // Once per wakeup: this takes the keystroke path's lock.
                            let live = app.state::<crate::terminal::TermState>().live_ids();
                            let mine = |session: &str| live.contains(session);
                            for batch in
                                changed_nudge_batches(dir, &mut nudge_seen, &slack_config, &mine)
                            {
                                let guard = match batch {
                                    Batch::PrsOpen { .. } if collectors.prs.enabled => &guards.prs_open,
                                    Batch::PrsMerged { .. } if collectors.prs.enabled => &guards.prs_merged,
                                    Batch::Issues { .. } if collectors.issues.enabled => &guards.issues,
                                    Batch::SlackDm(_) if slack_on => &guards.slack,
                                    _ => continue,
                                };
                                spawn_batch(&app, batch, calendar_period_ms, guard);
                            }
                        }
                    }
                    _ = notify_tick.tick() => {
                        run_notify_check(
                            &app,
                            &mut notify_store,
                            &mut meeting_watch,
                            &mut review_watch,
                            &mut checks_watch,
                            &mut stale_watch,
                            &watched,
                        )
                        .await;
                    }
                }
            }
        }
    });
}

/// Fire-and-forget a collect batch so the select! loop stays hot. A tick whose
/// collector is still in flight is skipped.
fn spawn_batch(app: &AppHandle, batch: Batch, calendar_period_ms: i64, guard: &Arc<AtomicBool>) {
    if !claim_in_flight(guard) {
        return;
    }
    let app = app.clone();
    let guard = guard.clone();
    tauri::async_runtime::spawn(async move {
        run_batch(&app, batch, calendar_period_ms).await;
        guard.store(false, Ordering::Release);
    });
}

async fn run_batch(app: &AppHandle, batch: Batch, calendar_period_ms: i64) {
    let app = app.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        run_batch_blocking(&app, batch, calendar_period_ms)
    })
    .await;
}

fn run_batch_blocking(app: &AppHandle, batch: Batch, calendar_period_ms: i64) {
    let store = match tt_store::Store::open_default() {
        Ok(store) => store,
        Err(e) => {
            eprintln!("scheduler: store unavailable ({e}); skipping collect batch");
            return;
        }
    };
    let now = now_ms();

    match batch {
        Batch::PrsOpen { reuse_ms } => {
            let repos = tt_collect::tracked_repo_dirs();
            log_failure(tt_collect::collect_prs_open(&store, &repos, reuse_ms, now));
        }
        Batch::PrsMerged { reuse_ms } => {
            let repos = tt_collect::tracked_repo_dirs();
            log_failure(tt_collect::collect_prs_merged(&store, &repos, reuse_ms, now));
        }
        Batch::Issues { reuse_ms } => {
            let repos = tt_collect::tracked_repo_dirs();
            log_failure(tt_collect::collect_issues(&store, &repos, reuse_ms, now));
        }
        Batch::Calendar(sources) => {
            // Token-cost guard: an interval's first tick fires at startup, so a relaunch
            // inside half a refresh period would re-bill `claude -p`. Any recorded run
            // counts as fresh, failures included — a failed run already burned tokens.
            if claude_ran_within(&store, now, calendar_period_ms / 2) {
                return;
            }
            log_failure(tt_collect::collect_calendar(&store, &sources, now));
        }
        Batch::SlackDm(config) => {
            log_failure(tt_collect::collect_slack_dm(&store, &config, now));
        }
    }

    if let Ok(snapshot) = store.snapshot() {
        let _ = app.emit(SNAPSHOT_EVENT, snapshot);
    }
}

/// Fires notifications for new edges even while minimized: an unattended window is
/// exactly when one matters. `store_slot` carries the connection between ticks, dodging
/// `Store::open`'s migration pass; it moves into the closure and back.
async fn run_notify_check(
    app: &AppHandle,
    store_slot: &mut Option<tt_store::Store>,
    meeting_watch: &mut MeetingStartWatch,
    review_watch: &mut ReviewRequestedWatch,
    checks_watch: &mut ChecksFailedWatch,
    stale_watch: &mut StaleCollectorWatch,
    watched: &[WatchedCollector],
) {
    let carried = store_slot.take();
    let read = tauri::async_runtime::spawn_blocking(move || {
        let store = match carried {
            Some(store) => store,
            None => tt_store::Store::open_default().ok()?,
        };
        let now = now_ms();
        let next = store.current_or_next_event(now).ok().flatten();
        let prs = store.prs().unwrap_or_default();
        let runs = store.runs().unwrap_or_default();
        Some((store, now, next, prs, runs))
    })
    .await;

    let Ok(Some((store, now, next, prs, runs))) = read else {
        return;
    };
    *store_slot = Some(store);

    if let Some(edge) = meeting_watch.observe(now, next.as_ref()) {
        notify_meeting_start(app, &edge);
    }
    for edge in review_watch.observe(&prs) {
        notify_review_requested(app, &edge);
    }
    for edge in checks_watch.observe(&prs) {
        notify_checks_failed(app, &edge);
    }
    for edge in stale_watch.observe(now, watched, &runs) {
        notify_stale_collector(app, &edge);
    }
}

/// Suppressed when focused — the header countdown already shows it.
fn notify_meeting_start(app: &AppHandle, edge: &tt_store::MeetingStartEdge) {
    use tauri_plugin_notification::NotificationExt;

    if window_focused(app) {
        return;
    }
    if !crate::settings::notify_allowed(tt_config::NotifyKind::MeetingStart) {
        return;
    }
    let _ = app.notification().builder().title("Meeting starting now").body(&edge.title).show();
}

/// Suppressed when focused — the header already shows review-requested PRs.
fn notify_review_requested(app: &AppHandle, edge: &tt_store::ReviewRequestedEdge) {
    use tauri_plugin_notification::NotificationExt;

    if window_focused(app) {
        return;
    }
    if !crate::settings::notify_allowed(tt_config::NotifyKind::ReviewRequested) {
        return;
    }
    let _ = app
        .notification()
        .builder()
        .title(format!("Review requested — {}#{}", edge.repo, edge.number))
        .body(&edge.title)
        .show();
}

/// Suppressed when focused — the header already surfaces PR check state.
fn notify_checks_failed(app: &AppHandle, edge: &tt_store::ChecksFailedEdge) {
    use tauri_plugin_notification::NotificationExt;

    if window_focused(app) {
        return;
    }
    if !crate::settings::notify_allowed(tt_config::NotifyKind::ChecksFailed) {
        return;
    }
    let _ = app
        .notification()
        .builder()
        .title(format!("CI failing on {}#{}", edge.repo, edge.number))
        .body(&edge.title)
        .show();
}

/// Unlike the notifications above this is *not* suppressed while focused: with no
/// always-on surface for collector health, a focused user would never learn one died.
fn notify_stale_collector(app: &AppHandle, edge: &tt_store::StaleCollectorEdge) {
    use tauri_plugin_notification::NotificationExt;

    if !crate::settings::notify_allowed(tt_config::NotifyKind::StaleCollector) {
        return;
    }

    let name = collector_label(&edge.key);
    let mut body =
        format!("{name} collector hasn't refreshed in {}", human_duration(edge.stale_for_ms));
    if let Some(msg) = &edge.last_message {
        body.push_str(&format!(" — {msg}"));
    }
    let _ = app.notification().builder().title("Collector went stale").body(body).show();
}

/// Human collector name for a notification body, from its `record_run` key.
fn collector_label(key: &str) -> &str {
    match key {
        "prs" => "PRs",
        "issues" => "issues",
        "claude:calendar" => "calendar",
        "slack:dm" => "Slack",
        other => other,
    }
}

/// A compact `Nh`/`Nm`/`Ns` string, rounded down to the largest whole unit.
fn human_duration(ms: i64) -> String {
    let secs = ms.max(0) / 1000;
    if secs >= 3600 {
        format!("{}h", secs / 3600)
    } else if secs >= 60 {
        format!("{}m", secs / 60)
    } else {
        format!("{secs}s")
    }
}

/// Unknown states count as not-focused, so a notification still fires.
fn window_focused(app: &AppHandle) -> bool {
    app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false)
}

fn log_failure(summary: tt_collect::CollectSummary) {
    if !summary.ok {
        eprintln!(
            "scheduler: {} collect failed: {}",
            summary.collector,
            summary.message.as_deref().unwrap_or("unknown")
        );
    }
}

/// Failed runs count: an invocation that burned tokens and then failed parsing must not
/// be retried at relaunch speed.
fn claude_ran_within(store: &tt_store::Store, now: i64, max_age_ms: i64) -> bool {
    match store.runs() {
        Ok(runs) => runs
            .iter()
            .filter(|r| r.collector.starts_with("claude:"))
            .any(|r| now - r.ran_at < max_age_ms),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claim_in_flight_claims_a_free_slot_then_blocks_until_released() {
        let guard = AtomicBool::new(false);
        assert!(claim_in_flight(&guard), "a free slot is claimable");
        assert!(!claim_in_flight(&guard), "an in-flight slot is not re-claimable");
        assert!(!claim_in_flight(&guard), "repeated ticks keep skipping");
        guard.store(false, Ordering::Release);
        assert!(claim_in_flight(&guard), "a released slot is claimable again");
    }

    #[test]
    fn claim_in_flight_is_independent_per_guard() {
        let prs = AtomicBool::new(false);
        let calendar = AtomicBool::new(false);
        // A slow calendar run holding its guard must not block the PR tick.
        assert!(claim_in_flight(&calendar), "calendar claims its own slot");
        assert!(claim_in_flight(&prs), "prs is unaffected by calendar in-flight");
        assert!(!claim_in_flight(&calendar), "calendar still in flight");
    }

    fn batch_names(batches: &[Batch]) -> Vec<&'static str> {
        batches
            .iter()
            .map(|b| match b {
                Batch::PrsOpen { .. } => "prs_open",
                Batch::PrsMerged { .. } => "prs_merged",
                Batch::Issues { .. } => "issues",
                Batch::Calendar(_) => "calendar",
                Batch::SlackDm(_) => "slack",
            })
            .collect()
    }

    fn test_slack_config() -> tt_collect::SlackDmConfig {
        tt_collect::SlackDmConfig {
            token: "xoxb-test".to_string(),
            watch_user_id: "U123".to_string(),
            watch_name: "Someone".to_string(),
        }
    }

    /// For the tests writing bare notes, where the predicate is never consulted.
    fn anyone(_: &str) -> bool {
        true
    }

    /// Write a nudge note the way `tt task nudge` does, addressed to `session`.
    fn note(dir: &Path, target: tt_collect::NudgeTarget, session: Option<&str>) {
        tt_collect::nudge::write(dir, target, session, 1_700_000_000_000).unwrap();
    }

    #[test]
    fn a_nudge_from_another_instances_terminal_is_skipped() {
        // The bug this prevents: every checkout's app watches one nudge dir, so
        // a `gh pr create` in one task used to make all of them sweep `gh`.
        let dir = tempfile::tempdir().unwrap();
        let mut seen = NudgeSeen::default();
        let slack = test_slack_config();
        let mine = |s: &str| s == "mine";

        note(dir.path(), tt_collect::NudgeTarget::Prs, Some("theirs"));
        assert!(
            changed_nudge_batches(dir.path(), &mut seen, &slack, &mine).is_empty(),
            "a note addressed to another instance must not fire this one"
        );
    }

    #[test]
    fn a_nudge_from_my_own_terminal_fires() {
        let dir = tempfile::tempdir().unwrap();
        let mut seen = NudgeSeen::default();
        let slack = test_slack_config();
        let mine = |s: &str| s == "mine";

        note(dir.path(), tt_collect::NudgeTarget::Prs, Some("mine"));
        assert_eq!(
            batch_names(&changed_nudge_batches(dir.path(), &mut seen, &slack, &mine)),
            vec!["prs_open", "prs_merged"]
        );
    }

    #[test]
    fn a_nudge_naming_nobody_still_reaches_every_instance() {
        // A session outside an app terminal has no `TT_SESSION_ID` to pass on, and
        // losing its nudge is worse than running it in more than one window.
        let dir = tempfile::tempdir().unwrap();
        let mut seen = NudgeSeen::default();
        let slack = test_slack_config();
        let owns_nothing = |_: &str| false;

        note(dir.path(), tt_collect::NudgeTarget::Issues, None);
        assert_eq!(
            batch_names(&changed_nudge_batches(dir.path(), &mut seen, &slack, &owns_nothing)),
            vec!["issues"]
        );
    }

    #[test]
    fn a_skipped_nudge_is_not_reconsidered_on_the_next_wakeup() {
        // `seen` advances even for someone else's note, or every later wakeup
        // re-reads and re-rejects the same file.
        let dir = tempfile::tempdir().unwrap();
        let mut seen = NudgeSeen::default();
        let slack = test_slack_config();
        let owns_nothing = |_: &str| false;

        note(dir.path(), tt_collect::NudgeTarget::Prs, Some("theirs"));
        assert!(changed_nudge_batches(dir.path(), &mut seen, &slack, &owns_nothing).is_empty());
        assert!(
            changed_nudge_batches(dir.path(), &mut seen, &slack, &anyone).is_empty(),
            "the skipped note is already acknowledged, not pending"
        );
    }

    /// Basenames must match what the CLI writer touches; both sides resolve them
    /// through `tt_collect::NudgeTarget::file_name`.
    #[test]
    fn nudge_file_names_match_the_shared_contract() {
        assert_eq!(tt_collect::NudgeTarget::Prs.file_name(), "prs");
        assert_eq!(tt_collect::NudgeTarget::Issues.file_name(), "issues");
        assert_eq!(tt_collect::NudgeTarget::SlackDm.file_name(), "slack");
    }

    #[test]
    fn changed_nudge_batches_detects_a_freshly_written_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut seen = NudgeSeen::default();
        let slack = test_slack_config();
        assert!(
            changed_nudge_batches(dir.path(), &mut seen, &slack, &anyone).is_empty(),
            "nothing written yet"
        );

        std::fs::write(dir.path().join("prs"), "1").unwrap();
        assert_eq!(
            batch_names(&changed_nudge_batches(dir.path(), &mut seen, &slack, &anyone)),
            vec!["prs_open", "prs_merged"],
            "a gh pr/issue mutation refreshes both PR cadences immediately"
        );
        assert!(changed_nudge_batches(dir.path(), &mut seen, &slack, &anyone).is_empty());
    }

    #[test]
    fn changed_nudge_batches_tracks_each_target_independently() {
        let dir = tempfile::tempdir().unwrap();
        let mut seen = NudgeSeen::default();
        let slack = test_slack_config();
        std::fs::write(dir.path().join("issues"), "1").unwrap();
        assert_eq!(
            batch_names(&changed_nudge_batches(dir.path(), &mut seen, &slack, &anyone)),
            vec!["issues"]
        );

        std::fs::write(dir.path().join("prs"), "1").unwrap();
        assert_eq!(
            batch_names(&changed_nudge_batches(dir.path(), &mut seen, &slack, &anyone)),
            vec!["prs_open", "prs_merged"],
            "issues was already acknowledged in the prior poll"
        );
    }

    #[test]
    fn changed_nudge_batches_fires_the_slack_sweep_on_a_slack_touch() {
        let dir = tempfile::tempdir().unwrap();
        let mut seen = NudgeSeen::default();
        let slack = test_slack_config();
        // The nudge file is `slack`, distinct from the `slack:dm` collector key.
        std::fs::write(dir.path().join("slack"), "1").unwrap();
        let batches = changed_nudge_batches(dir.path(), &mut seen, &slack, &anyone);
        assert_eq!(batch_names(&batches), vec!["slack"]);
        match &batches[0] {
            Batch::SlackDm(config) => assert_eq!(config.token, "xoxb-test"),
            _ => panic!("expected a SlackDm batch"),
        }
        assert!(changed_nudge_batches(dir.path(), &mut seen, &slack, &anyone).is_empty());
    }

    #[test]
    fn changed_nudge_batches_fires_again_on_a_later_re_touch() {
        let dir = tempfile::tempdir().unwrap();
        let mut seen = NudgeSeen::default();
        let slack = test_slack_config();
        let path = dir.path().join("prs");
        std::fs::write(&path, "1").unwrap();
        changed_nudge_batches(dir.path(), &mut seen, &slack, &anyone);

        // Only the mtime is ever read, so bump it explicitly rather than relying on
        // filesystem resolution across two quick writes.
        let file = std::fs::File::open(&path).unwrap();
        file.set_modified(SystemTime::now() + Duration::from_secs(5)).unwrap();
        assert_eq!(
            batch_names(&changed_nudge_batches(dir.path(), &mut seen, &slack, &anyone)),
            vec!["prs_open", "prs_merged"]
        );
    }

    #[test]
    fn claude_ran_within_counts_only_claude_collectors() {
        let store = tt_store::Store::open_in_memory().unwrap();
        store.record_run("prs", true, None, 90).unwrap();
        store.record_run("issues", true, None, 95).unwrap();
        assert!(!claude_ran_within(&store, 100, 50), "gh collectors never suppress calendar");

        store.record_run("claude:calendar", true, None, 90).unwrap();
        assert!(claude_ran_within(&store, 100, 50));
    }

    #[test]
    fn claude_ran_within_respects_the_age_window() {
        let store = tt_store::Store::open_in_memory().unwrap();
        store.record_run("claude:calendar", true, None, 10).unwrap();
        assert!(claude_ran_within(&store, 40, 50), "run 30ms old, window 50ms");
        assert!(!claude_ran_within(&store, 100, 50), "run 90ms old, window 50ms");
    }

    #[test]
    fn claude_ran_within_counts_failed_runs_as_backoff() {
        let store = tt_store::Store::open_in_memory().unwrap();
        store.record_run("claude:calendar", false, Some("no parseable JSON"), 90).unwrap();
        assert!(claude_ran_within(&store, 100, 50), "a failed paid run still suppresses retry");
    }

    #[test]
    fn claude_ran_within_is_not_fresh_on_query_error_or_empty() {
        let store = tt_store::Store::open_in_memory().unwrap();
        assert!(!claude_ran_within(&store, 100, 50));
    }

    #[test]
    fn watched_collectors_skips_disabled_and_derives_thresholds() {
        let mut c = tt_config::CollectorsSettings::default();
        // Defaults: prs+issues enabled, calendar+slack disabled.
        c.calendar.enabled = false;
        c.slack.enabled = false;
        let watched = watched_collectors(&c);
        let keys: Vec<&str> = watched.iter().map(|w| w.key.as_str()).collect();
        assert_eq!(keys, vec!["prs", "issues"]);
        // issues: 15m cadence * 4 = 60m.
        let issues = watched.iter().find(|w| w.key == "issues").unwrap();
        assert_eq!(issues.stale_after_ms, 60 * 60_000);
        // prs: 1200s (20m) cadence * 4 = 80m.
        let prs = watched.iter().find(|w| w.key == "prs").unwrap();
        assert_eq!(prs.stale_after_ms, 80 * 60_000);
    }

    #[test]
    fn watched_collectors_thresholds_honor_the_floor() {
        let mut c = tt_config::CollectorsSettings::default();
        c.slack.enabled = true;
        c.slack.refresh_seconds = 30; // 30s * 4 = 2m, below the 5m floor.
        let watched = watched_collectors(&c);
        let slack = watched.iter().find(|w| w.key == "slack:dm").unwrap();
        assert_eq!(slack.stale_after_ms, STALE_FLOOR_MS);
    }

    #[test]
    fn human_duration_rounds_to_largest_unit() {
        assert_eq!(human_duration(45_000), "45s");
        assert_eq!(human_duration(32 * 60_000), "32m");
        assert_eq!(human_duration(2 * 3_600_000 + 60_000), "2h");
        assert_eq!(human_duration(-5), "0s");
    }
}
