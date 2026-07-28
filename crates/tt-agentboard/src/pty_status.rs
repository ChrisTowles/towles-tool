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
///
/// Sized against the slowest legitimate cadence: a *hidden* pane is throttled to
/// 2fps (`tt_vt::session`'s `HIDDEN_FRAME_INTERVAL`), so a backgrounded working
/// agent can go 0.5s between frames. 1.5s clears that while staying far below the
/// silence that follows a real turn ending.
pub const OUTPUT_ACTIVE_MS: i64 = 1_500;

/// How long output must have been *continuing* before it counts as work.
///
/// [`OUTPUT_ACTIVE_MS`] alone answers "did a frame land recently", a different
/// question: a finished pane still repaints every 1.5–2s, right at the activity
/// window. Treating each as proof of work flipped a correctly finished session out
/// of needs-you and back on almost every rebuild, re-firing the desktop
/// notification each time — 462 of them in one day, from the event log.
///
/// A working agent is unambiguous by contrast (0.27s max gap), so requiring output
/// to have *persisted* for a second separates the two. The cost is that rule 1 of
/// [`resolve_status`] arrives a second into a turn rather than instantly.
pub const SUSTAINED_OUTPUT_MS: i64 = 1_000;

/// How long a PTY must be silent before a backend `busy` is disbelieved.
///
/// The mirror of [`OUTPUT_ACTIVE_MS`]: against a 0.27s repaint gap, silence two
/// orders of magnitude longer is stale bookkeeping, not a slow turn. Without it an
/// agent that finished minutes ago alternates `busy`/`complete` as attribution
/// comes and goes, and every flap through `busy` re-stamps `needs_since_ms` so the
/// waiting-age resets instead of counting up. 20s is deliberately far past any
/// real gap; being wrong here shows idle for an agent working in total silence,
/// which nothing observed does.
pub const BUSY_SILENCE_MS: i64 = 20_000;

/// How long after an attention notification its own trailing repaint is still
/// attributed to that notification rather than to resumed work.
///
/// Claude Code fires the notification *before* painting the turn's final frame
/// (measured: notify at t=14.219s, last paint at t=14.685s), so output alone would
/// clear the flag a few hundred ms later, every time. Output beginning this long
/// *after* the notification is genuinely new work, and does clear it.
pub const ATTENTION_GRACE_MS: i64 = 2_000;

/// What the app's terminal layer observed for one session's PTY. Every field is an
/// epoch-ms stamp written by the app; this crate reads no clock.
///
/// `None` means "never happened", not "happened long ago" — a PTY that has
/// produced nothing yet is not one that went quiet.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PtySignal {
    /// Most recent screen-changing output from the program in this PTY.
    pub last_output_ms: Option<i64>,
    /// When the *current* unbroken run of output began — restamped whenever a
    /// frame lands after a gap of [`OUTPUT_ACTIVE_MS`] or more. With
    /// `last_output_ms` it gives the run's length, which is what
    /// [`SUSTAINED_OUTPUT_MS`] tests.
    pub output_since_ms: Option<i64>,
    /// Most recent attention notification (`OSC 9`/`OSC 777`, or a bell).
    pub attention_at_ms: Option<i64>,
    /// Most recent user input written into this PTY — anything that answers what
    /// the agent was asking.
    pub input_at_ms: Option<i64>,
}

impl PtySignal {
    /// Whether the program is writing to the screen *and has been* for long enough
    /// to count as working. The one claim strong enough to override a cached
    /// status, hence both halves: recent output alone is equally consistent with
    /// an idle pane's repaint (see [`SUSTAINED_OUTPUT_MS`]).
    pub fn output_active(&self, now_ms: i64) -> bool {
        self.last_output_ms.is_some_and(|last| now_ms.saturating_sub(last) < OUTPUT_ACTIVE_MS)
            && self.sustained_run()
    }

    /// Whether this session has asked for the user and not yet been answered.
    ///
    /// Cleared by user input (the direct answer) and by *work* starting more than
    /// [`ATTENTION_GRACE_MS`] after the notification (the agent carried on by
    /// itself), never by the notification's own trailing repaint.
    ///
    /// "Work" means a *run* of output (see [`SUSTAINED_OUTPUT_MS`]), not any frame:
    /// read loosely, a finished pane's lone repaint cleared the flag seconds after
    /// every turn, discarding the fastest evidence an agent wants you and leaving
    /// needs-you to wait on the 60s-cached CLI (measured: 62s late).
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

    /// Whether the current run of output has lasted long enough to be work rather
    /// than a lone repaint. Says nothing about *when* — pair with a recency check.
    fn sustained_run(&self) -> bool {
        match (self.last_output_ms, self.output_since_ms) {
            (Some(last), Some(since)) => last.saturating_sub(since) >= SUSTAINED_OUTPUT_MS,
            _ => false,
        }
    }

    /// Whether this PTY has been silent long enough to disprove a claim that the
    /// agent is working. `false` when it has produced nothing at all — a
    /// just-started shell has no silence to measure.
    pub fn silent_past_busy(&self, now_ms: i64) -> bool {
        self.last_output_ms.is_some_and(|at| now_ms.saturating_sub(at) >= BUSY_SILENCE_MS)
    }
}

/// Fold the PTY's direct observation into the status the journal/CLI layer
/// already derived, returning the status to report.
///
/// `backend` is whatever [`crate::watchers`] concluded — `None` when nothing
/// detected an agent here. The PTY only speaks where it has evidence:
///
/// 1. **Output right now → [`AgentStatus::Busy`]**, unconditionally. Nothing
///    outranks bytes on the wire; this is the stale-`waiting` fix.
/// 2. **Quiet with attention pending → the agent wants the user.** A backend
///    already saying `Complete`/`Error` keeps its more specific verdict (both
///    count as needing you); otherwise [`AgentStatus::Waiting`].
/// 3. **Long silence against a `Busy` backend → [`AgentStatus::Idle`]** — the
///    mirror of rule 1, see [`BUSY_SILENCE_MS`].
/// 4. **Otherwise → `backend` unchanged.** Ordinary silence proves nothing.
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

    /// A run of output that has been going for `age`..now — what a working
    /// agent's continuous repainting looks like.
    fn working(age: i64) -> PtySignal {
        PtySignal {
            last_output_ms: Some(NOW - age),
            output_since_ms: Some(NOW - age - 5_000),
            ..Default::default()
        }
    }

    /// One frame landed `age` ago with nothing before it — a finished pane's own
    /// repaint. The run is 0ms long, because a frame arriving after a gap wider
    /// than `OUTPUT_ACTIVE_MS` restamps the run start onto itself.
    fn lone_repaint(age: i64) -> PtySignal {
        PtySignal {
            last_output_ms: Some(NOW - age),
            output_since_ms: Some(NOW - age),
            ..Default::default()
        }
    }

    // --- The reported bug: a stale `waiting` against a visibly working pane ---

    #[test]
    fn live_output_overrides_a_stale_waiting() {
        // The screenshot case: CLI said `waiting` 12 minutes ago and never
        // re-derived, while the terminal was mid-turn throughout.
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
        // HIDDEN_FRAME_INTERVAL is 500ms; a working agent must not decay between frames.
        let pty = working(500);
        assert_eq!(resolve_status(Some(AgentStatus::Idle), &pty, NOW), AgentStatus::Busy);
    }

    #[test]
    fn output_older_than_the_threshold_is_not_activity() {
        let pty = working(OUTPUT_ACTIVE_MS);
        assert!(!pty.output_active(NOW));
        assert_eq!(resolve_status(Some(AgentStatus::Idle), &pty, NOW), AgentStatus::Idle);
    }

    // --- Silence defers rather than guesses ---

    #[test]
    fn a_quiet_pty_leaves_the_backend_verdict_alone() {
        // Silence fits idle, blocked and finished alike; it invents no verdict.
        for backend in [
            AgentStatus::Idle,
            AgentStatus::Waiting,
            AgentStatus::Complete,
        ] {
            assert_eq!(resolve_status(Some(backend), &quiet(), NOW), backend, "{backend:?}");
        }
    }

    // --- The mirror bug: a stale `busy` against a long-silent pane ---

    #[test]
    fn long_silence_disproves_a_stale_busy() {
        let pty = working(BUSY_SILENCE_MS);
        assert_eq!(resolve_status(Some(AgentStatus::Busy), &pty, NOW), AgentStatus::Idle);
    }

    #[test]
    fn ordinary_between_paint_silence_does_not_disprove_busy() {
        // Past OUTPUT_ACTIVE_MS, nowhere near BUSY_SILENCE_MS: backend keeps the doubt.
        let pty = working(5_000);
        assert_eq!(resolve_status(Some(AgentStatus::Busy), &pty, NOW), AgentStatus::Busy);
    }

    #[test]
    fn silence_only_disproves_busy_never_a_terminal_verdict() {
        // A finished or blocked agent is *supposed* to be silent — not laundered to idle.
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
        // A just-spawned PTY has no silence to measure; idle would fight startup.
        let pty = PtySignal::default();
        assert!(!pty.silent_past_busy(NOW));
        assert_eq!(resolve_status(Some(AgentStatus::Busy), &pty, NOW), AgentStatus::Busy);
    }

    #[test]
    fn a_finished_agent_stops_flapping_out_of_needs_you() {
        // Observed live: a long-finished agent alternated busy/complete as backend
        // attribution came and went, and every flap through `busy` reset its
        // needs-since stamp. Quiet throughout with an unanswered notification, so
        // neither backend reading may resolve to `Busy`.
        let pty = PtySignal {
            attention_at_ms: Some(NOW - 300_000),
            input_at_ms: Some(NOW - 360_000),
            ..working(299_000)
        };
        assert!(pty.attention_pending(NOW));
        assert_eq!(resolve_status(Some(AgentStatus::Complete), &pty, NOW), AgentStatus::Complete);
        // `Waiting` rather than `Complete` is the better landing: `Complete` counts
        // as needing you only while `unseen` holds, so a seen-then-flapping row
        // could still fall out, whereas `Waiting` needs you unconditionally.
        assert_eq!(resolve_status(Some(AgentStatus::Busy), &pty, NOW), AgentStatus::Waiting);
    }

    #[test]
    fn no_backend_and_no_signal_is_idle() {
        assert_eq!(resolve_status(None, &PtySignal::default(), NOW), AgentStatus::Idle);
    }

    // --- Attention notifications ---

    #[test]
    fn a_pending_notification_means_waiting() {
        let pty = PtySignal { attention_at_ms: Some(NOW - 5_000), ..quiet() };
        assert_eq!(resolve_status(Some(AgentStatus::Idle), &pty, NOW), AgentStatus::Waiting);
    }

    #[test]
    fn a_pending_notification_keeps_a_more_specific_terminal_verdict() {
        // `Complete`/`Error` already count as needing you and say more about
        // why; downgrading them to a generic `Waiting` would lose the reason.
        let pty = PtySignal { attention_at_ms: Some(NOW - 5_000), ..quiet() };
        assert_eq!(resolve_status(Some(AgentStatus::Complete), &pty, NOW), AgentStatus::Complete);
        assert_eq!(resolve_status(Some(AgentStatus::Error), &pty, NOW), AgentStatus::Error);
    }

    #[test]
    fn the_notifications_own_trailing_repaint_does_not_clear_it() {
        // Measured against a real turn: notify fires ~0.5s before the final
        // frame. If that paint cleared the flag, needs-you would never latch.
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
        // The user's last keystroke is what *started* the turn that has now
        // come back asking a question.
        let pty = PtySignal {
            attention_at_ms: Some(NOW - 5_000),
            input_at_ms: Some(NOW - 60_000),
            ..quiet()
        };
        assert!(pty.attention_pending(NOW));
    }

    #[test]
    fn an_agent_that_resumes_on_its_own_clears_it() {
        // Output well past the grace window is new work, not the tail of the
        // notification — so the badge drops without the user touching it.
        let pty = PtySignal { attention_at_ms: Some(NOW - 60_000), ..working(30_000) };
        assert!(!pty.attention_pending(NOW));
        assert_eq!(resolve_status(Some(AgentStatus::Idle), &pty, NOW), AgentStatus::Idle);
    }

    #[test]
    fn working_again_outranks_a_pending_notification() {
        let pty = PtySignal { attention_at_ms: Some(NOW - 3_000), ..working(100) };
        assert_eq!(resolve_status(Some(AgentStatus::Waiting), &pty, NOW), AgentStatus::Busy);
    }

    // --- Whole-turn walkthrough against the measured capture ---

    #[test]
    fn a_full_turn_walks_idle_busy_waiting_idle() {
        // Timings taken from a real `claude` PTY capture: prompt submitted at
        // t=9.0s, continuous output to t=14.7s, OSC 777 at t=14.2s, then
        // silence.
        let at = |secs: f64| (secs * 1000.0) as i64;
        let mut pty = PtySignal::default();

        // Sitting at the prompt before anything is typed.
        assert_eq!(resolve_status(Some(AgentStatus::Idle), &pty, at(8.0)), AgentStatus::Idle);

        // Mid-turn: the spinner never pauses more than ~0.27s, so the run of
        // output that began when the turn did is still unbroken.
        pty.input_at_ms = Some(at(9.0));
        pty.output_since_ms = Some(at(9.1));
        pty.last_output_ms = Some(at(12.35));
        assert_eq!(resolve_status(Some(AgentStatus::Idle), &pty, at(12.6)), AgentStatus::Busy);

        // Turn ends: notification, then the last paint, then quiet.
        pty.attention_at_ms = Some(at(14.219));
        pty.last_output_ms = Some(at(14.685));
        assert_eq!(resolve_status(Some(AgentStatus::Idle), &pty, at(15.0)), AgentStatus::Busy);
        assert_eq!(resolve_status(Some(AgentStatus::Idle), &pty, at(17.0)), AgentStatus::Waiting);
        assert_eq!(resolve_status(Some(AgentStatus::Idle), &pty, at(30.0)), AgentStatus::Waiting);

        // The user comes back and types the next prompt.
        pty.input_at_ms = Some(at(31.0));
        assert_eq!(resolve_status(Some(AgentStatus::Idle), &pty, at(31.1)), AgentStatus::Idle);
    }

    // --- The flicker: a finished pane's lone repaints are not work ---

    /// Reproduced live against the real app: with the CLI reporting the session
    /// `idle` and its transcript ended on `end_turn` — i.e. a settled, correct
    /// `Complete` — the reported status still alternated `busy`/`complete`
    /// sub-second, taking the "⚑ Needs you" callout with it. A finished Claude
    /// Code pane keeps repainting on its own every second or two, and each lone
    /// frame satisfied "output in the last 1.5s" on its own.
    ///
    /// However recently the frame landed, a run of zero length is not work —
    /// which is what keeps an idling pane from ever accumulating into `Busy`,
    /// since every frame spaced past `OUTPUT_ACTIVE_MS` restarts the run.
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
        // A single frame, well past the grace window — under the old rule this
        // read as "carried on by itself" and cleared the flag.
        let pty = PtySignal { attention_at_ms: Some(NOW - 30_000), ..lone_repaint(3_000) };
        assert!(pty.attention_pending(NOW));
        assert_eq!(resolve_status(Some(AgentStatus::Busy), &pty, NOW), AgentStatus::Waiting);
    }

    /// The rule must not swallow real work: output that has been going for
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
