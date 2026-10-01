//! In-memory agent-instance state machine.
//!
//! Pure logic: every prune method takes an explicit `now_ms`, so tests are
//! deterministic. Insertion order is preserved with `IndexMap`.

use indexmap::IndexMap;
use std::collections::{HashMap, HashSet};

use crate::types::{AgentEvent, AgentStatus};

const TERMINAL_PRUNE_MS: i64 = 5 * 60 * 1000;

/// The per-session instance-map key: `agent` or `agent:threadId`.
pub fn instance_key(agent: &str, thread_id: Option<&str>) -> String {
    match thread_id {
        Some(t) => format!("{agent}:{t}"),
        None => agent.to_string(),
    }
}

/// Tracks agent instances per session, their unseen state, pins, and prunes
/// dead/stale/terminal instances.
#[derive(Debug, Default)]
pub struct AgentTracker {
    /// session name → (instance key → latest event, `unseen` stamped),
    /// insertion-ordered.
    instances: IndexMap<String, IndexMap<String, AgentEvent>>,
    /// session → pinned instance keys (agents backed by a live pane process).
    pinned_keys: HashMap<String, HashSet<String>>,
}

impl AgentTracker {
    pub fn new() -> Self {
        Self::default()
    }

    fn remove_instance(&mut self, session: &str, key: &str) {
        if let Some(inner) = self.instances.get_mut(session) {
            inner.shift_remove(key);
        }
    }

    /// Drop any session whose instance map is now empty.
    fn drop_if_empty(&mut self, session: &str) {
        if self.instances.get(session).is_some_and(IndexMap::is_empty) {
            self.instances.shift_remove(session);
        }
    }

    /// Record an event. A terminal one is unseen until [`Self::mark_seen`].
    pub fn apply_event(&mut self, mut event: AgentEvent) {
        let key = instance_key(&event.agent, event.thread_id.as_deref());
        event.unseen = event.status.is_terminal().then_some(true);
        self.instances.entry(event.session.clone()).or_default().insert(key, event);
    }

    /// A session's instances, borrowed, in insertion order.
    pub fn agents(&self, session: &str) -> impl Iterator<Item = &AgentEvent> {
        self.instances.get(session).into_iter().flat_map(IndexMap::values)
    }

    /// All instances for a session, owned for a payload, newest-first.
    pub fn get_agents(&self, session: &str) -> Vec<AgentEvent> {
        let mut out: Vec<AgentEvent> = self.agents(session).cloned().collect();
        // Stable sort by descending ts, so ties keep insertion order.
        out.sort_by_key(|e| std::cmp::Reverse(e.ts));
        out
    }

    /// Clear unseen flags for a session. Returns whether anything was unseen.
    pub fn mark_seen(&mut self, session: &str) -> bool {
        if !self.is_unseen(session) {
            return false;
        }
        for event in self.instances.get_mut(session).into_iter().flat_map(IndexMap::values_mut) {
            event.unseen = None;
        }
        true
    }

    /// Remove every unpinned instance `drop` selects, then any emptied session.
    fn prune_where(&mut self, drop: impl Fn(&AgentEvent) -> bool) {
        let sessions: Vec<String> = self.instances.keys().cloned().collect();
        for session in sessions {
            let removable: Vec<String> = self.instances[&session]
                .iter()
                .filter(|(key, event)| !self.is_pinned(&session, key) && drop(event))
                .map(|(key, _)| key.clone())
                .collect();
            for key in removable {
                self.remove_instance(&session, &key);
            }
            self.drop_if_empty(&session);
        }
    }

    /// Prune instances whose last activity is older than `timeout_ms`, optionally
    /// restricted to one status; skips pinned.
    fn prune_by_age(&mut self, timeout_ms: i64, only_status: Option<AgentStatus>, now_ms: i64) {
        self.prune_where(|event| {
            let last_seen =
                event.details.as_ref().and_then(|d| d.last_activity_at).unwrap_or(event.ts);
            only_status.is_none_or(|s| event.status == s) && now_ms - last_seen > timeout_ms
        });
    }

    /// Prune any instance whose last activity is older than `timeout_ms`.
    pub fn prune_stale(&mut self, timeout_ms: i64, now_ms: i64) {
        self.prune_by_age(timeout_ms, None, now_ms);
    }

    /// Prune "idle" instances older than `timeout_ms` unless pinned.
    pub fn prune_idle(&mut self, timeout_ms: i64, now_ms: i64) {
        self.prune_by_age(timeout_ms, Some(AgentStatus::Idle), now_ms);
    }

    /// Prune terminal instances older than the terminal timeout, but only if seen
    /// and not pinned.
    pub fn prune_terminal(&mut self, now_ms: i64) {
        self.prune_where(|event| {
            event.status.is_terminal()
                && event.unseen != Some(true)
                && now_ms - event.ts > TERMINAL_PRUNE_MS
        });
    }

    /// Whether any instance in the session is unseen.
    fn is_unseen(&self, session: &str) -> bool {
        self.agents(session).any(|e| e.unseen == Some(true))
    }

    /// Set pinned instance keys for multiple sessions at once.
    pub fn set_pinned_instances_multi(&mut self, keys_by_session: &HashMap<String, Vec<String>>) {
        self.pinned_keys.clear();
        for (session, keys) in keys_by_session {
            if !keys.is_empty() {
                self.pinned_keys.insert(session.clone(), keys.iter().cloned().collect());
            }
        }
    }

    /// Whether an instance is pinned (backed by a live pane).
    pub fn is_pinned(&self, session: &str, key: &str) -> bool {
        self.pinned_keys.get(session).is_some_and(|s| s.contains(key))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AgentEventDetails, AgentStatus};

    fn ev(session: &str, agent: &str, status: AgentStatus, ts: i64) -> AgentEvent {
        AgentEvent {
            agent: agent.into(),
            session: session.into(),
            status,
            ts,
            thread_id: None,
            thread_name: None,
            unseen: None,
            details: None,
        }
    }

    /// Whether `session` still tracks an instance of `agent` — the
    /// existence probe the prune tests assert with.
    fn has(t: &AgentTracker, session: &str, agent: &str) -> bool {
        t.get_agents(session).iter().any(|e| e.agent == agent)
    }

    #[test]
    fn instance_key_with_and_without_thread() {
        assert_eq!(instance_key("claude", None), "claude");
        assert_eq!(instance_key("claude", Some("t1")), "claude:t1");
    }

    #[test]
    fn get_agents_sorted_newest_first_with_unseen_stamp() {
        let mut t = AgentTracker::new();
        // seed=true → terminal marked unseen.
        t.apply_event(ev("s", "old", AgentStatus::Complete, 10));
        t.apply_event(ev("s", "new", AgentStatus::Busy, 20));
        let agents = t.get_agents("s");
        assert_eq!(agents[0].agent, "new");
        assert_eq!(agents[1].agent, "old");
        assert_eq!(agents[1].unseen, Some(true));
        assert_eq!(agents[0].unseen, None);
    }

    #[test]
    fn non_terminal_event_clears_unseen() {
        let mut t = AgentTracker::new();
        t.apply_event(ev("s", "a", AgentStatus::Complete, 1));
        assert!(t.is_unseen("s"));
        // Same instance goes back to running → seen again.
        t.apply_event(ev("s", "a", AgentStatus::Busy, 2));
        assert!(!t.is_unseen("s"));
    }

    #[test]
    fn mark_seen_reports_only_the_first_clear() {
        let mut t = AgentTracker::new();
        t.apply_event(ev("s1", "a", AgentStatus::Complete, 1));
        t.apply_event(ev("s2", "b", AgentStatus::Error, 1));
        assert!(t.mark_seen("s1"));
        assert!(!t.mark_seen("s1")); // already seen
        assert!(t.mark_seen("s2"));
    }

    #[test]
    fn pruning_skips_a_pinned_instance() {
        let mut t = AgentTracker::new();
        t.apply_event(ev("s", "a", AgentStatus::Idle, 0));
        t.apply_event(ev("s", "b", AgentStatus::Idle, 0));
        t.set_pinned_instances_multi(&HashMap::from([("s".to_string(), vec!["b".to_string()])]));
        t.prune_idle(1000, 5000);
        assert!(has(&t, "s", "b"));
        assert!(!has(&t, "s", "a"));
    }

    #[test]
    fn prune_terminal_keeps_unseen_and_pinned() {
        let mut t = AgentTracker::new();
        t.apply_event(ev("s", "seen", AgentStatus::Complete, 0));
        t.mark_seen("s"); // clears both; the second lands unseen again below
        t.apply_event(ev("s", "unseen", AgentStatus::Complete, 0));
        t.prune_terminal(10 * 60 * 1000); // > TERMINAL_PRUNE_MS
        assert!(!has(&t, "s", "seen")); // seen terminal pruned
        assert!(has(&t, "s", "unseen")); // unseen kept
    }

    #[test]
    fn prune_idle_only_targets_idle() {
        let mut t = AgentTracker::new();
        t.apply_event(ev("s", "idle", AgentStatus::Idle, 0));
        t.apply_event(ev("s", "run", AgentStatus::Busy, 0));
        t.prune_idle(1000, 5000);
        assert!(!has(&t, "s", "idle")); // idle pruned
        assert!(has(&t, "s", "run")); // running kept
    }

    #[test]
    fn prune_by_age_uses_last_activity_when_present() {
        let mut t = AgentTracker::new();
        let mut e = ev("s", "a", AgentStatus::Busy, 0);
        e.details = Some(AgentEventDetails { last_activity_at: Some(4500), ..Default::default() });
        t.apply_event(e);
        // event ts is 0 (very old) but lastActivityAt is recent → not stale.
        t.prune_stale(1000, 5000);
        assert!(has(&t, "s", "a"));
    }
}
