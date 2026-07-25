//! Agent status derived from the PTY the app already owns, rather than from
//! polling `claude agents --all --json`.
//!
//! # Why this exists
//!
//! Status used to come exclusively from the Claude Code CLI
//! ([`crate::claude_cli`]), behind a 60s process-wide cache — the cache is
//! there because each miss costs a ~170ms Node spawn, and every consumer
//! ticks every 2-3s. That makes the *authoritative* signal refresh at most
//! once a minute, and nothing in the pipeline could contradict it: a session
//! whose CLI-reported status stuck at `waiting` kept a "needs you" badge (and
//! an ever-growing waiting-age) while its terminal was visibly mid-turn.
//!
//! The app hosts the PTY, so it observes the agent directly and for free.
//! Two signals come off that feed, and between them they pin down the two
//! states the CLI is slowest at:
//!
//! * **Screen output.** The vt session renders only when PTY bytes actually
//!   changed the screen ([`tt_vt`]'s render loop is data-driven; its frame
//!   interval is a rate cap, not a timer), so "a frame was produced" means
//!   "the program wrote something". Claude Code animates a spinner with a
//!   live elapsed counter for the whole of a turn, so a working agent is
//!   never quiet for long — measured against a real session, output paused at
//!   most **0.27s** during a turn and then went **15.6s** silent the instant
//!   it ended. There is no overlap to split, which is why a plain silence
//!   threshold works here and no TUI text has to be scraped.
//! * **Attention notifications.** Claude Code raises `OSC 777`
//!   (`notify;Claude Code;<what happened>`) at the moment it wants the user —
//!   turn finished, question asked, permission needed. [`crate::watchers`]
//!   never sees this; the terminal does, and [`tt_vt::osc_notify`] already
//!   parses it.
//!
//! # What this does and does not decide
//!
//! The PTY **vetoes**, it does not vote. It answers exactly one question —
//! *is this agent working right now?* — and it answers it in both
//! directions, because Claude Code's continuous repainting makes both
//! answers decisive:
//!
//! * Bytes on the wire in the last [`OUTPUT_ACTIVE_MS`] prove it **is**
//!   working. That beats any cached verdict — it is the fix for a stale
//!   `waiting` on a visibly running pane.
//! * Silence for [`BUSY_SILENCE_MS`] proves it is **not**. That is the mirror
//!   fix, for a stale `busy` that would otherwise flap a finished agent in and
//!   out of needs-you and keep resetting its waiting-age.
//!
//! What the PTY deliberately does *not* decide is which flavour of
//! not-working a quiet agent is in. Silence is equally consistent with
//! idle-at-the-prompt, blocked on a permission prompt, and finished, so —
//! absent an attention notification saying otherwise — a quiet pane falls
//! through to whatever the journal/CLI layer already concluded rather than
//! guessing between them.
//!
//! Permission prompts are the case with no other signal at all — they are
//! never written to the session JSONL (only `AskUserQuestion` is), so before
//! this the 60s-cached CLI field was the sole evidence in *both* directions.

use crate::types::AgentStatus;

/// How long after its last screen output an agent still counts as working.
///
/// Sized against the two cadences that have to fit under it: a visible pane
/// renders at up to ~90fps but a *hidden* one is throttled to 2fps
/// (`tt_vt::session`'s `HIDDEN_FRAME_INTERVAL`), so a backgrounded working
/// agent can legitimately go 0.5s between frames. 1.5s clears that with room
/// to spare while staying far below the multi-second silence that follows a
/// real turn ending.
pub const OUTPUT_ACTIVE_MS: i64 = 1_500;

/// How long a PTY must be silent before a backend `busy` is disbelieved.
///
/// The mirror of [`OUTPUT_ACTIVE_MS`], and it fixes the mirror bug. A working
/// Claude Code agent repaints a live elapsed counter for the whole of a turn
/// — measured max gap **0.27s**, and a *tool call* animates the same way — so
/// silence two orders of magnitude longer than that is not a slow turn, it is
/// stale bookkeeping. Without this the board flaps: an agent that finished
/// minutes ago alternates `busy`/`complete` as attribution comes and goes
/// between rebuilds, and every flap through `busy` drops the session out of
/// needs-you and re-stamps `needs_since_ms`, so the waiting-age resets to
/// zero every few seconds instead of counting up.
///
/// 20s is deliberately far past any real repaint gap: the cost of being wrong
/// here is showing idle for an agent that is genuinely working in total
/// silence, which nothing observed does.
pub const BUSY_SILENCE_MS: i64 = 20_000;

/// How long after an attention notification its own trailing repaint is still
/// attributed to that notification rather than to resumed work.
///
/// Claude Code fires the notification *before* painting the final frame of
/// the turn (measured: notify at t=14.219s, last paint at t=14.685s), so
/// output alone cannot clear the flag — it would clear it a few hundred
/// milliseconds later, every time. Output that begins this long *after* the
/// notification is genuinely new work (an agent continuing on its own),
/// which does clear it.
pub const ATTENTION_GRACE_MS: i64 = 2_000;

/// What the app's terminal layer observed for one session's PTY. Every field
/// is an epoch-ms stamp written by the app; this crate reads the clock from
/// nowhere (see the determinism rule in `.claude/rules/rust.md`).
///
/// Absent (`None`) means "never happened", not "happened long ago" — a
/// session whose PTY has produced nothing yet is not the same as one that
/// went quiet.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PtySignal {
    /// Most recent screen-changing output from the program in this PTY.
    pub last_output_ms: Option<i64>,
    /// Most recent attention notification (`OSC 9`/`OSC 777`, or a bell).
    pub attention_at_ms: Option<i64>,
    /// Most recent user input written into this PTY — a keystroke, pasted
    /// text, anything that answers whatever the agent was asking.
    pub input_at_ms: Option<i64>,
}

impl PtySignal {
    /// Whether the program wrote to the screen recently enough to count as
    /// working. The one claim strong enough to override a cached status.
    pub fn output_active(&self, now_ms: i64) -> bool {
        self.last_output_ms.is_some_and(|at| now_ms.saturating_sub(at) < OUTPUT_ACTIVE_MS)
    }

    /// Whether this session has asked for the user and not yet been answered.
    ///
    /// Cleared by user input (the direct answer) and by output that starts
    /// more than [`ATTENTION_GRACE_MS`] after the notification (the agent
    /// carried on by itself) — but never by the notification's own trailing
    /// repaint, which is why output inside the grace window doesn't count.
    pub fn attention_pending(&self, now_ms: i64) -> bool {
        let Some(at) = self.attention_at_ms else {
            return false;
        };
        if self.input_at_ms.is_some_and(|input| input >= at) {
            return false;
        }
        let resumed =
            self.last_output_ms.is_some_and(|out| out > at.saturating_add(ATTENTION_GRACE_MS));
        !resumed && !self.output_active(now_ms)
    }

    /// Whether this PTY has been silent long enough to disprove a claim that
    /// the agent is working. `false` when the PTY has produced nothing at all
    /// — a pane whose shell just started has no silence to measure.
    pub fn silent_past_busy(&self, now_ms: i64) -> bool {
        self.last_output_ms.is_some_and(|at| now_ms.saturating_sub(at) >= BUSY_SILENCE_MS)
    }
}

/// Fold the PTY's direct observation into the status the journal/CLI layer
/// already derived, returning the status to report.
///
/// `backend` is whatever [`crate::watchers`] concluded (CLI status, refined
/// by the journal) — `None` when nothing detected an agent in this session.
/// The PTY only speaks where it has evidence:
///
/// 1. **Output right now → [`AgentStatus::Busy`]**, unconditionally. This is
///    the fix for the stale-`waiting` bug; nothing outranks bytes on the wire.
/// 2. **Quiet with attention pending → the agent wants the user.** A backend
///    that already says `Complete`/`Error` keeps its (more specific) verdict —
///    both already count as needing you — otherwise this is
///    [`AgentStatus::Waiting`].
/// 3. **Long silence against a `Busy` backend → [`AgentStatus::Idle`].** The
///    mirror of rule 1: nothing that works is silent for
///    [`BUSY_SILENCE_MS`], so this is stale bookkeeping. Left alone, it flaps
///    the session in and out of needs-you and resets its waiting-age (see
///    that constant's docs).
/// 4. **Otherwise → `backend` unchanged.** Ordinary silence is not evidence
///    of anything in particular.
///
/// Sessions with no PTY at all (no pane open) never reach here; the caller
/// passes only what its terminal registry knows about.
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
        PtySignal { last_output_ms: Some(NOW - 30_000), ..Default::default() }
    }

    // --- The reported bug: a stale `waiting` against a visibly working pane ---

    #[test]
    fn live_output_overrides_a_stale_waiting() {
        // The screenshot case: CLI said `waiting` 12 minutes ago and never
        // re-derived, while the terminal was mid-turn the whole time.
        let pty = PtySignal { last_output_ms: Some(NOW - 200), ..Default::default() };
        assert_eq!(resolve_status(Some(AgentStatus::Waiting), &pty, NOW), AgentStatus::Busy);
    }

    #[test]
    fn live_output_overrides_every_backend_verdict() {
        let pty = PtySignal { last_output_ms: Some(NOW - 100), ..Default::default() };
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
        // HIDDEN_FRAME_INTERVAL is 500ms; a backgrounded working agent must
        // not decay to idle between frames.
        let pty = PtySignal { last_output_ms: Some(NOW - 500), ..Default::default() };
        assert_eq!(resolve_status(Some(AgentStatus::Idle), &pty, NOW), AgentStatus::Busy);
    }

    #[test]
    fn output_older_than_the_threshold_is_not_activity() {
        let pty = PtySignal { last_output_ms: Some(NOW - OUTPUT_ACTIVE_MS), ..Default::default() };
        assert!(!pty.output_active(NOW));
        assert_eq!(resolve_status(Some(AgentStatus::Idle), &pty, NOW), AgentStatus::Idle);
    }

    // --- Silence defers rather than guesses ---

    #[test]
    fn a_quiet_pty_leaves_the_backend_verdict_alone() {
        // Silence is consistent with idle, blocked and finished alike, so it
        // must not manufacture a verdict of its own.
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
        let pty = PtySignal { last_output_ms: Some(NOW - BUSY_SILENCE_MS), ..Default::default() };
        assert_eq!(resolve_status(Some(AgentStatus::Busy), &pty, NOW), AgentStatus::Idle);
    }

    #[test]
    fn ordinary_between_paint_silence_does_not_disprove_busy() {
        // Well past OUTPUT_ACTIVE_MS but nowhere near BUSY_SILENCE_MS: the
        // backend still gets the benefit of the doubt.
        let pty = PtySignal { last_output_ms: Some(NOW - 5_000), ..Default::default() };
        assert_eq!(resolve_status(Some(AgentStatus::Busy), &pty, NOW), AgentStatus::Busy);
    }

    #[test]
    fn silence_only_disproves_busy_never_a_terminal_verdict() {
        // A finished or blocked agent is *supposed* to be silent — the rule
        // must not launder those into idle and drop them out of needs-you.
        for backend in [
            AgentStatus::Complete,
            AgentStatus::Waiting,
            AgentStatus::Error,
        ] {
            let pty = PtySignal { last_output_ms: Some(NOW - 600_000), ..Default::default() };
            assert_eq!(resolve_status(Some(backend), &pty, NOW), backend, "{backend:?}");
        }
    }

    #[test]
    fn a_pane_that_never_produced_output_is_not_treated_as_silent() {
        // A shell whose PTY just spawned has no silence to measure; calling
        // it idle would fight the backend during session startup.
        let pty = PtySignal::default();
        assert!(!pty.silent_past_busy(NOW));
        assert_eq!(resolve_status(Some(AgentStatus::Busy), &pty, NOW), AgentStatus::Busy);
    }

    #[test]
    fn a_finished_agent_stops_flapping_out_of_needs_you() {
        // Observed live: an agent whose turn ended minutes ago alternated
        // busy/complete as backend attribution came and went, and every flap
        // through `busy` reset its needs-since stamp. The PTY has been quiet
        // throughout and its notification is unanswered, so neither backend
        // reading may resolve to `Busy` — that is the flap, and it is what
        // drops the row out of needs-you and resets the age.
        let pty = PtySignal {
            attention_at_ms: Some(NOW - 300_000),
            last_output_ms: Some(NOW - 299_000),
            input_at_ms: Some(NOW - 360_000),
        };
        assert!(pty.attention_pending(NOW));
        assert_eq!(resolve_status(Some(AgentStatus::Complete), &pty, NOW), AgentStatus::Complete);
        // The disproven `busy` resolves through the pending notification to
        // `Waiting` rather than to `Complete`. That is the better of the two:
        // `Complete` only counts as needing you while `unseen` holds, so a
        // seen-then-flapping row could still fall out, whereas `Waiting`
        // needs you unconditionally.
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
        let pty = PtySignal {
            attention_at_ms: Some(NOW - 10_000),
            last_output_ms: Some(NOW - 9_600),
            ..Default::default()
        };
        assert!(pty.attention_pending(NOW));
        assert_eq!(resolve_status(Some(AgentStatus::Idle), &pty, NOW), AgentStatus::Waiting);
    }

    #[test]
    fn answering_the_prompt_clears_it() {
        let pty = PtySignal {
            attention_at_ms: Some(NOW - 10_000),
            input_at_ms: Some(NOW - 9_000),
            last_output_ms: Some(NOW - 8_000),
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
        let pty = PtySignal {
            attention_at_ms: Some(NOW - 60_000),
            last_output_ms: Some(NOW - 30_000),
            ..Default::default()
        };
        assert!(!pty.attention_pending(NOW));
        assert_eq!(resolve_status(Some(AgentStatus::Idle), &pty, NOW), AgentStatus::Idle);
    }

    #[test]
    fn working_again_outranks_a_pending_notification() {
        let pty = PtySignal {
            attention_at_ms: Some(NOW - 3_000),
            last_output_ms: Some(NOW - 100),
            ..Default::default()
        };
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

        // Mid-turn: the spinner never pauses more than ~0.27s.
        pty.input_at_ms = Some(at(9.0));
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
}
