//! In-memory agent-instance state machine.
//!
//! Pure logic: every prune method takes an explicit `now_ms`, so tests are
//! deterministic. Insertion order is preserved with `IndexMap`/`IndexSet`.

use indexmap::{IndexMap, IndexSet};
use std::collections::{HashMap, HashSet};

use crate::types::AgentEvent;

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
    /// session name → (instance key → latest event), insertion-ordered.
    instances: IndexMap<String, IndexMap<String, AgentEvent>>,
    /// Per-instance unseen tracking, keyed by `session\0instanceKey`.
    unseen_instances: IndexSet<String>,
    active: HashSet<String>,
    /// session → pinned instance keys (agents backed by a live pane process).
    pinned_keys: HashMap<String, HashSet<String>>,
}

fn unseen_key(session: &str, key: &str) -> String {
    format!("{session}\0{key}")
}

impl AgentTracker {
    pub fn new() -> Self {
        Self::default()
    }

    fn remove_instance(&mut self, session: &str, key: &str) {
        if let Some(inner) = self.instances.get_mut(session) {
            inner.shift_remove(key);
        }
        self.unseen_instances.shift_remove(&unseen_key(session, key));
    }

    /// Drop any session whose instance map is now empty.
    fn drop_if_empty(&mut self, session: &str) {
        if self.instances.get(session).is_some_and(IndexMap::is_empty) {
            self.instances.shift_remove(session);
        }
    }

    /// Record an event. `seed` marks pre-connection state, which always counts as
    /// unseen when terminal.
    pub fn apply_event(&mut self, event: AgentEvent, seed: bool) {
        let key = instance_key(&event.agent, event.thread_id.as_deref());
        let session = event.session.clone();
        let status = event.status;

        self.instances.entry(session.clone()).or_default().insert(key.clone(), event);

        let ukey = unseen_key(&session, &key);
        if status.is_terminal() {
            if seed || !self.active.contains(&session) {
                self.unseen_instances.insert(ukey);
            }
        } else {
            self.unseen_instances.shift_remove(&ukey);
        }
    }

    /// All instances for a session, unseen flag stamped, newest-first.
    pub fn get_agents(&self, session: &str) -> Vec<AgentEvent> {
        let Some(inner) = self.instances.get(session) else {
            return Vec::new();
        };
        let mut out: Vec<AgentEvent> = inner
            .values()
            .map(|event| {
                let key = instance_key(&event.agent, event.thread_id.as_deref());
                let mut ev = event.clone();
                if self.unseen_instances.contains(&unseen_key(session, &key)) {
                    ev.unseen = Some(true);
                }
                ev
            })
            .collect();
        // Stable sort by descending ts, so ties keep insertion order.
        out.sort_by_key(|e| std::cmp::Reverse(e.ts));
        out
    }

    fn clear_unseen(&mut self, session: &str) {
        let Some(inner) = self.instances.get(session) else {
            return;
        };
        let ukeys: Vec<String> = inner.keys().map(|k| unseen_key(session, k)).collect();
        for ukey in ukeys {
            self.unseen_instances.shift_remove(&ukey);
        }
    }

    /// Clear unseen flags for a session. Returns whether anything was unseen.
    pub fn mark_seen(&mut self, session: &str) -> bool {
        if !self.is_unseen(session) {
            return false;
        }
        self.clear_unseen(session);
        true
    }

    /// Remove a specific instance.
    pub fn dismiss(&mut self, session: &str, agent: &str, thread_id: Option<&str>) -> bool {
        let key = instance_key(agent, thread_id);
        let exists = self.instances.get(session).is_some_and(|inner| inner.contains_key(&key));
        if !exists {
            return false;
        }
        self.remove_instance(session, &key);
        self.drop_if_empty(session);
        true
    }

    /// Prune "running" instances older than `timeout_ms` (unless pinned).
    pub fn prune_stuck(&mut self, timeout_ms: i64, now_ms: i64) {
        let sessions: Vec<String> = self.instances.keys().cloned().collect();
        for session in sessions {
            let removable: Vec<String> = self.instances[&session]
                .iter()
                .filter(|(key, event)| {
                    event.status == crate::types::AgentStatus::Busy
                        && now_ms - event.ts > timeout_ms
                        && !self.is_pinned(&session, key)
                })
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
    fn prune_by_age(
        &mut self,
        timeout_ms: i64,
        only_status: Option<crate::types::AgentStatus>,
        now_ms: i64,
    ) {
        let sessions: Vec<String> = self.instances.keys().cloned().collect();
        for session in sessions {
            let removable: Vec<String> = self.instances[&session]
                .iter()
                .filter(|(key, event)| {
                    if let Some(s) = only_status
                        && event.status != s
                    {
                        return false;
                    }
                    if self.is_pinned(&session, key) {
                        return false;
                    }
                    let last_seen =
                        event.details.as_ref().and_then(|d| d.last_activity_at).unwrap_or(event.ts);
                    now_ms - last_seen > timeout_ms
                })
                .map(|(key, _)| key.clone())
                .collect();
            for key in removable {
                self.remove_instance(&session, &key);
            }
            self.drop_if_empty(&session);
        }
    }

    /// Prune any instance whose last activity is older than `timeout_ms`.
    pub fn prune_stale(&mut self, timeout_ms: i64, now_ms: i64) {
        self.prune_by_age(timeout_ms, None, now_ms);
    }

    /// Prune "idle" instances older than `timeout_ms` unless pinned.
    pub fn prune_idle(&mut self, timeout_ms: i64, now_ms: i64) {
        self.prune_by_age(timeout_ms, Some(crate::types::AgentStatus::Idle), now_ms);
    }

    /// Prune terminal instances older than the terminal timeout, but only if seen
    /// and not pinned.
    pub fn prune_terminal(&mut self, now_ms: i64) {
        let sessions: Vec<String> = self.instances.keys().cloned().collect();
        for session in sessions {
            let removable: Vec<String> = self.instances[&session]
                .iter()
                .filter(|(key, event)| {
                    event.status.is_terminal()
                        && !self.unseen_instances.contains(&unseen_key(&session, key))
                        && !self.is_pinned(&session, key)
                        && now_ms - event.ts > TERMINAL_PRUNE_MS
                })
                .map(|(key, _)| key.clone())
                .collect();
            for key in removable {
                self.remove_instance(&session, &key);
            }
            self.drop_if_empty(&session);
        }
    }

    /// Whether any instance in the session is unseen.
    fn is_unseen(&self, session: &str) -> bool {
        let Some(inner) = self.instances.get(session) else {
            return false;
        };
        inner.keys().any(|key| self.unseen_instances.contains(&unseen_key(session, key)))
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

    #[test]
    fn instance_key_with_and_without_thread() {
        assert_eq!(instance_key("claude", None), "claude");
        assert_eq!(instance_key("claude", Some("t1")), "claude:t1");
    }

    #[test]
    fn get_agents_sorted_newest_first_with_unseen_stamp() {
        let mut t = AgentTracker::new();
        // seed=true → terminal marked unseen.
        t.apply_event(ev("s", "old", AgentStatus::Complete, 10), true);
        t.apply_event(ev("s", "new", AgentStatus::Busy, 20), false);
        let agents = t.get_agents("s");
        assert_eq!(agents[0].agent, "new");
        assert_eq!(agents[1].agent, "old");
        assert_eq!(agents[1].unseen, Some(true));
        assert_eq!(agents[0].unseen, None);
    }

    #[test]
    fn non_terminal_event_clears_unseen() {
        let mut t = AgentTracker::new();
        t.apply_event(ev("s", "a", AgentStatus::Complete, 1), true);
        assert!(t.is_unseen("s"));
        // Same instance goes back to running → seen again.
        t.apply_event(ev("s", "a", AgentStatus::Busy, 2), false);
        assert!(!t.is_unseen("s"));
    }

    #[test]
    fn mark_seen_reports_only_the_first_clear() {
        let mut t = AgentTracker::new();
        t.apply_event(ev("s1", "a", AgentStatus::Complete, 1), true);
        t.apply_event(ev("s2", "b", AgentStatus::Error, 1), true);
        assert!(t.mark_seen("s1"));
        assert!(!t.mark_seen("s1")); // already seen
        assert!(t.mark_seen("s2"));
    }

    #[test]
    fn dismiss_removes_instance_and_empty_session() {
        let mut t = AgentTracker::new();
        t.apply_event(ev("s", "a", AgentStatus::Busy, 1), false);
        assert!(t.dismiss("s", "a", None));
        assert!(!t.dismiss("s", "a", None));
        assert!(t.get_agents("s").is_empty());
    }

    #[test]
    fn prune_stuck_removes_old_running_unless_pinned() {
        let mut t = AgentTracker::new();
        t.apply_event(ev("s", "a", AgentStatus::Busy, 0), false);
        t.apply_event(ev("s", "b", AgentStatus::Busy, 0), false);
        t.set_pinned_instances_multi(&HashMap::from([("s".to_string(), vec!["b".to_string()])]));
        t.prune_stuck(1000, 5000); // both are 5000ms old > 1000
        assert!(t.dismiss("s", "b", None)); // b survived (pinned)
        assert!(!t.dismiss("s", "a", None)); // a was pruned
    }

    #[test]
    fn prune_terminal_keeps_unseen_and_pinned() {
        let mut t = AgentTracker::new();
        t.apply_event(ev("s", "seen", AgentStatus::Complete, 0), true);
        t.mark_seen("s"); // clears both; the second lands unseen again below
        t.apply_event(ev("s", "unseen", AgentStatus::Complete, 0), true);
        t.prune_terminal(10 * 60 * 1000); // > TERMINAL_PRUNE_MS
        assert!(!t.dismiss("s", "seen", None)); // seen terminal pruned
        assert!(t.dismiss("s", "unseen", None)); // unseen kept
    }

    #[test]
    fn prune_idle_only_targets_idle() {
        let mut t = AgentTracker::new();
        t.apply_event(ev("s", "idle", AgentStatus::Idle, 0), false);
        t.apply_event(ev("s", "run", AgentStatus::Busy, 0), false);
        t.prune_idle(1000, 5000);
        assert!(!t.dismiss("s", "idle", None)); // idle pruned
        assert!(t.dismiss("s", "run", None)); // running kept
    }

    #[test]
    fn prune_by_age_uses_last_activity_when_present() {
        let mut t = AgentTracker::new();
        let mut e = ev("s", "a", AgentStatus::Busy, 0);
        e.details = Some(AgentEventDetails { last_activity_at: Some(4500), ..Default::default() });
        t.apply_event(e, false);
        // event ts is 0 (very old) but lastActivityAt is recent → not stale.
        t.prune_stale(1000, 5000);
        assert!(t.dismiss("s", "a", None));
    }
}
