//! The status each session last showed, so the app records the moment it moves
//! (`agent.status_changed`) and not every ~2s restatement of it. Those records are
//! the only account of the PTY-resolved status after the fact — the journal
//! replays, the terminal does not — and `examples/sim.rs` reads them back.

use std::collections::{HashMap, HashSet};

use crate::types::AgentStatus;

/// What the board showed: the resolved status and whether it counted as working.
pub type Shown = (AgentStatus, bool);

#[derive(Debug, Default)]
pub struct StatusLog {
    last: HashMap<String, Shown>,
}

impl StatusLog {
    pub fn new() -> Self {
        Self::default()
    }

    /// `Some(previous)` when `session_id` now shows something else; a session's
    /// first sighting is `Some(None)`.
    pub fn observe(&mut self, session_id: &str, shown: Shown) -> Option<Option<Shown>> {
        let prev = self.last.insert(session_id.to_string(), shown);
        (prev != Some(shown)).then_some(prev)
    }

    /// Forget sessions no longer on the board, so a reused id starts fresh.
    pub fn retain(&mut self, present: &HashSet<&str>) {
        self.last.retain(|id, _| present.contains(id.as_str()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_change_is_reported() {
        let mut log = StatusLog::new();
        assert_eq!(log.observe("s", (AgentStatus::Busy, true)), Some(None));
        assert_eq!(log.observe("s", (AgentStatus::Busy, true)), None);
        assert_eq!(
            log.observe("s", (AgentStatus::Complete, true)),
            Some(Some((AgentStatus::Busy, true)))
        );
        assert_eq!(
            log.observe("s", (AgentStatus::Complete, false)),
            Some(Some((AgentStatus::Complete, true)))
        );
    }

    #[test]
    fn a_session_gone_from_the_board_starts_over() {
        let mut log = StatusLog::new();
        log.observe("s", (AgentStatus::Busy, true));
        log.retain(&HashSet::new());
        assert_eq!(log.observe("s", (AgentStatus::Busy, true)), Some(None));
    }
}
