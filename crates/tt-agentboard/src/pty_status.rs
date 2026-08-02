//! Agent status derived from the PTY the app already owns, rather than from
//! polling `claude agents --all --json`. That CLI verdict sits behind a 60s cache,
//! so nothing could contradict it: a session stuck at `waiting` kept a "needs you"
//! badge while its terminal was visibly mid-turn. The app hosts the PTY, so it
//! observes the agent directly and for free — [`tt_vt`] renders only when bytes
//! changed the screen, and Claude Code animates a live elapsed counter for a whole
//! turn. Measured on a real session: output paused at most **0.27s** mid-turn,
//! then went **15.6s** silent the instant it ended.
//!
//! The PTY **vetoes, it does not vote** — only *is this agent working right now?*,
//! in both directions. Which flavour of not-working is the journal/CLI layer's:
//! silence fits idle, blocked and finished equally.

use crate::types::AgentStatus;

/// How long after its last screen output an agent still counts as working.
/// Sized against the slowest legitimate cadence: a *hidden* pane is throttled to
/// 2fps (`tt_vt::session`'s `HIDDEN_FRAME_INTERVAL`).
pub const OUTPUT_ACTIVE_MS: i64 = 1_500;

/// How long output must have been *continuing* before it counts as work.
///
/// A finished pane still repaints every 1.5–2s, right at the activity window;
/// treating each repaint as proof of work flipped finished sessions out of
/// needs-you and back, re-firing the notification 462 times in one day. A real
/// turn's gaps top out at 0.27s, so persistence separates the two — at the cost
/// of rule 1 of [`resolve_status`] arriving a second into a turn.
pub const SUSTAINED_OUTPUT_MS: i64 = 1_000;

/// How long a PTY must be silent before a backend `busy` is disbelieved.
///
/// Two orders of magnitude past a real repaint gap, so silence this long is
/// stale bookkeeping. Without it a finished agent alternates `busy`/`complete`
/// as attribution comes and goes, and each flap re-stamps `needs_since_ms`.
pub const BUSY_SILENCE_MS: i64 = 20_000;

/// How long after an attention notification its own trailing repaint is still
/// attributed to that notification rather than to resumed work.
///
/// Claude Code notifies *before* painting the turn's final frame (measured:
/// 14.219s vs 14.685s), so output alone would clear the flag every time.
pub const ATTENTION_GRACE_MS: i64 = 2_000;

/// What the app's terminal layer observed for one session's PTY. Every field is
/// an epoch-ms stamp written by the app; this crate reads no clock. `None` means
/// "never happened" — a PTY that produced nothing has not gone quiet.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PtySignal {
    /// Most recent screen-changing output from the program in this PTY.
    pub last_output_ms: Option<i64>,
    /// When the *current* unbroken run of output began — restamped whenever a
    /// frame lands after a gap of [`OUTPUT_ACTIVE_MS`] or more.
    pub output_since_ms: Option<i64>,
    /// Most recent attention notification (`OSC 9`/`OSC 777`, or a bell).
    pub attention_at_ms: Option<i64>,
    /// Most recent user input written into this PTY.
    pub input_at_ms: Option<i64>,
}

impl PtySignal {
    /// Whether the program is writing to the screen *and has been* for long
    /// enough to count as working — the one claim strong enough to override a
    /// cached status, hence both halves (see [`SUSTAINED_OUTPUT_MS`]).
    pub fn output_active(&self, now_ms: i64) -> bool {
        self.last_output_ms.is_some_and(|last| now_ms.saturating_sub(last) < OUTPUT_ACTIVE_MS)
            && self.sustained_run()
    }

    /// Whether this session has asked for the user and not yet been answered.
    ///
    /// Cleared by user input, and by a *run* of output (see
    /// [`SUSTAINED_OUTPUT_MS`]) starting more than [`ATTENTION_GRACE_MS`] after
    /// the notification — never by a lone frame, which used to clear it seconds
    /// after every turn and left needs-you on the 60s-cached CLI.
    pub fn attention_pending(&self, now_ms: i64) -> bool {
        let Some(at) = self.attention_at_ms else {
            return false;
        };
        if self.input_at_ms.is_some_and(|input| input >= at) {
            return false;
        }
        let began_after_grace =
            self.output_since_ms.is_some_and(|since| since > at.saturating_add(ATTENTION_GRACE_MS));
        let resumed = began_after_grace && self.sustained_run();
        !resumed && !self.output_active(now_ms)
    }

    /// Whether the current run of output has lasted long enough to be work
    /// rather than a lone repaint. Says nothing about *when*.
    fn sustained_run(&self) -> bool {
        match (self.last_output_ms, self.output_since_ms) {
            (Some(last), Some(since)) => last.saturating_sub(since) >= SUSTAINED_OUTPUT_MS,
            _ => false,
        }
    }

    /// Whether this PTY has been silent long enough to disprove a claim that the
    /// agent is working. A just-started shell has no silence to measure.
    pub fn silent_past_busy(&self, now_ms: i64) -> bool {
        self.last_output_ms.is_some_and(|at| now_ms.saturating_sub(at) >= BUSY_SILENCE_MS)
    }
}

/// Fold the PTY's direct observation into `backend`, whatever
/// [`crate::watchers`] concluded. The PTY only speaks where it has evidence:
/// output right now is unconditionally `Busy`; quiet with attention pending
/// means the agent wants the user (keeping a more specific `Complete`/`Error`);
/// silence past [`BUSY_SILENCE_MS`] retracts a `Busy`; otherwise `backend`
/// stands, because ordinary silence proves nothing.
pub fn resolve_status(backend: Option<AgentStatus>, pty: &PtySignal, now_ms: i64) -> AgentStatus {
    if pty.output_active(now_ms) {
        return AgentStatus::Busy;
    }
    if pty.attention_pending(now_ms) {
        return match backend {
            Some(status @ (AgentStatus::Complete | AgentStatus::Error)) => status,
            _ => AgentStatus::Waiting,
        };
    }
    if backend == Some(AgentStatus::Busy) && pty.silent_past_busy(now_ms) {
        return AgentStatus::Idle;
    }
    backend.unwrap_or(AgentStatus::Idle)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_000_000;

    fn quiet() -> PtySignal {
        PtySignal {
            last_output_ms: Some(NOW - 30_000),
            output_since_ms: Some(NOW - 40_000),
            ..Default::default()
        }
    }

    /// A run of output going for `age`..now — a working agent's repainting.
    fn working(age: i64) -> PtySignal {
        PtySignal {
            last_output_ms: Some(NOW - age),
            output_since_ms: Some(NOW - age - 5_000),
            ..Default::default()
        }
    }

    /// A finished pane's own repaint: one frame `age` ago, a 0ms run.
    fn lone_repaint(age: i64) -> PtySignal {
        PtySignal {
            last_output_ms: Some(NOW - age),
            output_since_ms: Some(NOW - age),
            ..Default::default()
        }
    }

    #[test]
    fn live_output_overrides_a_stale_waiting() {
        let pty = working(200);
        assert_eq!(resolve_status(Some(AgentStatus::Waiting), &pty, NOW), AgentStatus::Busy);
    }

    #[test]
    fn live_output_overrides_every_backend_verdict() {
        let pty = working(100);
        for backend in [
            AgentStatus::Idle,
            AgentStatus::Waiting,
            AgentStatus::Complete,
            AgentStatus::Error,
            AgentStatus::Interrupted,
        ] {
            assert_eq!(resolve_status(Some(backend), &pty, NOW), AgentStatus::Busy, "{backend:?}");
        }
    }

    #[test]
    fn a_hidden_pane_at_two_fps_still_counts_as_working() {
        let pty = working(500);
        assert_eq!(resolve_status(Some(AgentStatus::Idle), &pty, NOW), AgentStatus::Busy);
    }

    #[test]
    fn output_older_than_the_threshold_is_not_activity() {
        let pty = working(OUTPUT_ACTIVE_MS);
        assert!(!pty.output_active(NOW));
        assert_eq!(resolve_status(Some(AgentStatus::Idle), &pty, NOW), AgentStatus::Idle);
    }

    #[test]
    fn a_quiet_pty_leaves_the_backend_verdict_alone() {
        for backend in [
            AgentStatus::Idle,
            AgentStatus::Waiting,
            AgentStatus::Complete,
        ] {
            assert_eq!(resolve_status(Some(backend), &quiet(), NOW), backend, "{backend:?}");
        }
    }

    #[test]
    fn long_silence_disproves_a_stale_busy() {
        let pty = working(BUSY_SILENCE_MS);
        assert_eq!(resolve_status(Some(AgentStatus::Busy), &pty, NOW), AgentStatus::Idle);
    }

    #[test]
    fn ordinary_between_paint_silence_does_not_disprove_busy() {
        let pty = working(5_000);
        assert_eq!(resolve_status(Some(AgentStatus::Busy), &pty, NOW), AgentStatus::Busy);
    }

    #[test]
    fn silence_only_disproves_busy_never_a_terminal_verdict() {
        for backend in [
            AgentStatus::Complete,
            AgentStatus::Waiting,
            AgentStatus::Error,
        ] {
            let pty = working(600_000);
            assert_eq!(resolve_status(Some(backend), &pty, NOW), backend, "{backend:?}");
        }
    }

    #[test]
    fn a_pane_that_never_produced_output_is_not_treated_as_silent() {
        let pty = PtySignal::default();
        assert!(!pty.silent_past_busy(NOW));
        assert_eq!(resolve_status(Some(AgentStatus::Busy), &pty, NOW), AgentStatus::Busy);
    }

    #[test]
    fn a_finished_agent_stops_flapping_out_of_needs_you() {
        // Observed live: a long-finished agent alternated busy/complete as
        // backend attribution came and went, resetting needs-since each flap.
        let pty = PtySignal {
            attention_at_ms: Some(NOW - 300_000),
            input_at_ms: Some(NOW - 360_000),
            ..working(299_000)
        };
        assert!(pty.attention_pending(NOW));
        assert_eq!(resolve_status(Some(AgentStatus::Complete), &pty, NOW), AgentStatus::Complete);
        // `Waiting` beats `Complete` here: `Complete` needs you only while
        // `unseen` holds, so a seen-then-flapping row could still fall out.
        assert_eq!(resolve_status(Some(AgentStatus::Busy), &pty, NOW), AgentStatus::Waiting);
    }

    #[test]
    fn no_backend_and_no_signal_is_idle() {
        assert_eq!(resolve_status(None, &PtySignal::default(), NOW), AgentStatus::Idle);
    }

    #[test]
    fn a_pending_notification_means_waiting() {
        let pty = PtySignal { attention_at_ms: Some(NOW - 5_000), ..quiet() };
        assert_eq!(resolve_status(Some(AgentStatus::Idle), &pty, NOW), AgentStatus::Waiting);
    }

    #[test]
    fn a_pending_notification_keeps_a_more_specific_terminal_verdict() {
        let pty = PtySignal { attention_at_ms: Some(NOW - 5_000), ..quiet() };
        assert_eq!(resolve_status(Some(AgentStatus::Complete), &pty, NOW), AgentStatus::Complete);
        assert_eq!(resolve_status(Some(AgentStatus::Error), &pty, NOW), AgentStatus::Error);
    }

    #[test]
    fn the_notifications_own_trailing_repaint_does_not_clear_it() {
        // Notify fires ~0.5s before the final frame, so needs-you never latches.
        let pty = PtySignal { attention_at_ms: Some(NOW - 10_000), ..working(9_600) };
        assert!(pty.attention_pending(NOW));
        assert_eq!(resolve_status(Some(AgentStatus::Idle), &pty, NOW), AgentStatus::Waiting);
    }

    #[test]
    fn answering_the_prompt_clears_it() {
        let pty = PtySignal {
            attention_at_ms: Some(NOW - 10_000),
            input_at_ms: Some(NOW - 9_000),
            ..working(8_000)
        };
        assert!(!pty.attention_pending(NOW));
        assert_eq!(resolve_status(Some(AgentStatus::Idle), &pty, NOW), AgentStatus::Idle);
    }

    #[test]
    fn input_before_the_notification_does_not_clear_it() {
        let pty = PtySignal {
            attention_at_ms: Some(NOW - 5_000),
            input_at_ms: Some(NOW - 60_000),
            ..quiet()
        };
        assert!(pty.attention_pending(NOW));
    }

    #[test]
    fn an_agent_that_resumes_on_its_own_clears_it() {
        let pty = PtySignal { attention_at_ms: Some(NOW - 60_000), ..working(30_000) };
        assert!(!pty.attention_pending(NOW));
        assert_eq!(resolve_status(Some(AgentStatus::Idle), &pty, NOW), AgentStatus::Idle);
    }

    #[test]
    fn working_again_outranks_a_pending_notification() {
        let pty = PtySignal { attention_at_ms: Some(NOW - 3_000), ..working(100) };
        assert_eq!(resolve_status(Some(AgentStatus::Waiting), &pty, NOW), AgentStatus::Busy);
    }

    #[test]
    fn a_full_turn_walks_idle_busy_waiting_idle() {
        // From a real `claude` PTY capture: prompt at t=9.0s, continuous output
        // to t=14.7s, OSC 777 at t=14.2s, then silence.
        let at = |secs: f64| (secs * 1000.0) as i64;
        let mut pty = PtySignal::default();

        assert_eq!(resolve_status(Some(AgentStatus::Idle), &pty, at(8.0)), AgentStatus::Idle);

        pty.input_at_ms = Some(at(9.0));
        pty.output_since_ms = Some(at(9.1));
        pty.last_output_ms = Some(at(12.35));
        assert_eq!(resolve_status(Some(AgentStatus::Idle), &pty, at(12.6)), AgentStatus::Busy);

        pty.attention_at_ms = Some(at(14.219));
        pty.last_output_ms = Some(at(14.685));
        assert_eq!(resolve_status(Some(AgentStatus::Idle), &pty, at(15.0)), AgentStatus::Busy);
        assert_eq!(resolve_status(Some(AgentStatus::Idle), &pty, at(17.0)), AgentStatus::Waiting);
        assert_eq!(resolve_status(Some(AgentStatus::Idle), &pty, at(30.0)), AgentStatus::Waiting);

        pty.input_at_ms = Some(at(31.0));
        assert_eq!(resolve_status(Some(AgentStatus::Idle), &pty, at(31.1)), AgentStatus::Idle);
    }

    /// Reproduced live: a settled `Complete` still alternated `busy`/`complete`
    /// sub-second, taking the "⚑ Needs you" callout with it, because a finished
    /// pane's own repaint satisfied "output in the last 1.5s". However recent
    /// the frame, a run of zero length is not work.
    #[test]
    fn a_lone_repaint_does_not_retract_a_finished_turn() {
        for age in [10, 100, OUTPUT_ACTIVE_MS - 1] {
            let blip = lone_repaint(age);
            assert!(!blip.output_active(NOW), "{age}");
            assert_eq!(
                resolve_status(Some(AgentStatus::Complete), &blip, NOW),
                AgentStatus::Complete,
                "{age}"
            );
            assert_eq!(
                resolve_status(Some(AgentStatus::Waiting), &blip, NOW),
                AgentStatus::Waiting,
                "{age}"
            );
        }
    }

    /// The turn-end notification must survive the pane's own idle repaints, or
    /// the board falls back to the 60s-cached CLI and the agent sits there
    /// wanting you, unbadged, for up to a minute (measured: 62s).
    #[test]
    fn a_lone_repaint_does_not_count_as_the_agent_resuming() {
        let pty = PtySignal { attention_at_ms: Some(NOW - 30_000), ..lone_repaint(3_000) };
        assert!(pty.attention_pending(NOW));
        assert_eq!(resolve_status(Some(AgentStatus::Busy), &pty, NOW), AgentStatus::Waiting);
    }

    /// The rule must not swallow real work: output going for
    /// `SUSTAINED_OUTPUT_MS` is a turn, and still overrides a stale verdict.
    #[test]
    fn sustained_output_still_overrides_a_stale_verdict() {
        let just_under = PtySignal {
            last_output_ms: Some(NOW),
            output_since_ms: Some(NOW - SUSTAINED_OUTPUT_MS + 1),
            ..Default::default()
        };
        assert!(!just_under.output_active(NOW));

        let sustained = PtySignal {
            last_output_ms: Some(NOW),
            output_since_ms: Some(NOW - SUSTAINED_OUTPUT_MS),
            ..Default::default()
        };
        assert!(sustained.output_active(NOW));
        assert_eq!(resolve_status(Some(AgentStatus::Waiting), &sustained, NOW), AgentStatus::Busy);
    }
}
