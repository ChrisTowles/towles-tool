//! Edge detection for "an agent just stopped working in this checkout".
//!
//! The working-tree half of a checkout's git stats (`dirty`, `uncommitted_*`)
//! has no `.git` file to watch: an edit that is never staged moves none of the
//! five control files the host's watcher registers, so those numbers ride a
//! slow backup poll. The app does know something git cannot, though — which
//! checkout an agent was just editing. lazygit refreshes the moment a command
//! *it* ran returns; here the actor is the agent, and its turn ending is the
//! same signal arriving by a different route.
//!
//! Pure state diffing over successive snapshots, like [`crate::notify`]: a
//! busy→not-busy edge per folder, never a level, so a finished agent costs one
//! recompute rather than one per tick for as long as it stays finished.

use std::collections::HashMap;

use crate::StatePayload;
use crate::types::AgentStatus;

/// Tracks whether each folder had a working agent in the previous snapshot.
#[derive(Debug, Default)]
pub struct TurnEndWatch {
    /// folder dir → any session there was [`AgentStatus::Busy`] last time.
    prev: HashMap<String, bool>,
}

impl TurnEndWatch {
    pub fn new() -> Self {
        Self::default()
    }

    /// Folder dirs whose last working agent just stopped, sorted. Updates the
    /// baseline as a side effect.
    ///
    /// No priming skip, unlike [`crate::notify::NeedsYouWatch`]: an empty
    /// baseline reports nothing anyway, and a spurious edge costs one git read
    /// rather than a desktop notification. Status must already be PTY-stamped —
    /// a backend that still believes an agent is busy has not seen a turn end.
    pub fn observe(&mut self, payload: &StatePayload) -> Vec<String> {
        let mut current: HashMap<String, bool> = HashMap::with_capacity(self.prev.len());
        for repo in &payload.repos {
            for folder in &repo.folders {
                let busy = folder
                    .sessions
                    .iter()
                    .any(|s| s.agent_state.as_ref().is_some_and(|a| a.status == AgentStatus::Busy));
                current.insert(folder.dir.clone(), busy);
            }
        }
        let mut ended: Vec<String> = current
            .iter()
            .filter(|(dir, busy)| !**busy && self.prev.get(*dir).copied().unwrap_or(false))
            .map(|(dir, _)| dir.clone())
            .collect();
        ended.sort();
        self.prev = current;
        ended
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AgentEvent, FolderData, RepoData, SessionData};

    fn session(id: &str, status: Option<AgentStatus>) -> SessionData {
        SessionData {
            id: id.to_string(),
            name: id.to_string(),
            agent_state: status.map(|s| AgentEvent {
                agent: "claude".into(),
                session: id.to_string(),
                status: s,
                ts: 1,
                thread_id: None,
                thread_name: None,
                unseen: None,
                details: None,
            }),
            ..Default::default()
        }
    }

    fn payload(folders: Vec<(&str, Vec<SessionData>)>) -> StatePayload {
        StatePayload {
            repos: vec![RepoData {
                key: "path:/repo".into(),
                dir: "/repo".into(),
                name: "repo".into(),
                origin_url: None,
                meta: None,
                needs: 0,
                folders: folders
                    .into_iter()
                    .map(|(dir, sessions)| FolderData {
                        name: dir.to_string(),
                        dir: dir.to_string(),
                        branch: "main".into(),
                        sessions,
                        ..Default::default()
                    })
                    .collect(),
            }],
            compact_recommend_percent: 30,
            windows: crate::windows::WindowsPayload::default(),
            collapsed: Default::default(),
            ts: 0,
        }
    }

    #[test]
    fn busy_then_finished_is_one_edge() {
        let mut w = TurnEndWatch::new();
        let busy = payload(vec![("/repo/a", vec![session("s1", Some(AgentStatus::Busy))])]);
        let done = payload(vec![("/repo/a", vec![session("s1", Some(AgentStatus::Complete))])]);

        assert!(w.observe(&busy).is_empty(), "first sight of busy is not an end");
        assert_eq!(w.observe(&done), vec!["/repo/a".to_string()]);
        assert!(w.observe(&done).is_empty(), "a level, not a repeat");
    }

    /// The whole point of the watch: a checkout that stays finished must not
    /// re-invalidate every tick, or it becomes the unconditional poll it exists
    /// to avoid.
    #[test]
    fn an_idle_folder_never_fires() {
        let mut w = TurnEndWatch::new();
        let idle = payload(vec![("/repo/a", vec![session("s1", Some(AgentStatus::Idle))])]);
        assert!(w.observe(&idle).is_empty());
        assert!(w.observe(&idle).is_empty());
        assert!(w.observe(&idle).is_empty());
    }

    /// A folder is busy while *any* of its panes is: an agent finishing beside
    /// one still working hasn't finished changing the tree.
    #[test]
    fn a_folder_ends_only_when_its_last_agent_does() {
        let mut w = TurnEndWatch::new();
        let both = payload(vec![(
            "/repo/a",
            vec![
                session("s1", Some(AgentStatus::Busy)),
                session("s2", Some(AgentStatus::Busy)),
            ],
        )]);
        let one = payload(vec![(
            "/repo/a",
            vec![
                session("s1", Some(AgentStatus::Complete)),
                session("s2", Some(AgentStatus::Busy)),
            ],
        )]);
        let neither = payload(vec![(
            "/repo/a",
            vec![
                session("s1", Some(AgentStatus::Complete)),
                session("s2", Some(AgentStatus::Complete)),
            ],
        )]);

        w.observe(&both);
        assert!(w.observe(&one).is_empty());
        assert_eq!(w.observe(&neither), vec!["/repo/a".to_string()]);
    }

    #[test]
    fn each_folder_is_tracked_on_its_own() {
        let mut w = TurnEndWatch::new();
        let busy = payload(vec![
            ("/repo/a", vec![session("s1", Some(AgentStatus::Busy))]),
            ("/repo/b", vec![session("s2", Some(AgentStatus::Busy))]),
        ]);
        let a_done = payload(vec![
            ("/repo/a", vec![session("s1", Some(AgentStatus::Complete))]),
            ("/repo/b", vec![session("s2", Some(AgentStatus::Busy))]),
        ]);

        w.observe(&busy);
        assert_eq!(w.observe(&a_done), vec!["/repo/a".to_string()]);
    }

    /// A pane closed mid-turn leaves no session to report a status, which is
    /// still the tree going quiet — and the folder must not stay latched busy.
    #[test]
    fn a_folder_whose_sessions_vanish_ends() {
        let mut w = TurnEndWatch::new();
        let busy = payload(vec![("/repo/a", vec![session("s1", Some(AgentStatus::Busy))])]);
        let gone = payload(vec![("/repo/a", vec![])]);

        w.observe(&busy);
        assert_eq!(w.observe(&gone), vec!["/repo/a".to_string()]);
        assert!(w.observe(&gone).is_empty());
    }
}
