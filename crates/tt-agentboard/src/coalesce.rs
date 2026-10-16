//! Burst coalescing for needs-you desktop notifications.
//!
//! Several agents going idle together would ping once each. [`Coalescer`]
//! holds edges for a short window opened by the first one, then releases them
//! as a single batch. Time is passed in, never read, and the host owns the
//! timer: [`Coalescer::push`] says when to come back, [`Coalescer::take_due`]
//! hands over the batch once the window has closed. Status itself is untouched;
//! only how often the user is interrupted changes.

use crate::notify::NeedsYouEdge;
use crate::types::NeedsYouReason;

/// Long enough to gather agents finishing together, short enough that a lone
/// event still feels immediate.
pub const WINDOW_MS: i64 = 2_000;

#[derive(Debug, Default)]
pub struct Coalescer {
    pending: Vec<NeedsYouEdge>,
    /// When the open window started; `None` while nothing is held.
    opened_ms: Option<i64>,
}

impl Coalescer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Hold `edges`. A session already held keeps its slot with the newest
    /// reason, so one agent flipping twice in a window counts once. Returns the
    /// instant the host should call [`Self::take_due`] when this push opened a
    /// new window, and `None` when it joined one already open (or was empty).
    pub fn push(&mut self, now_ms: i64, edges: &[NeedsYouEdge]) -> Option<i64> {
        if edges.is_empty() {
            return None;
        }
        for edge in edges {
            match self.pending.iter_mut().find(|p| p.session_id == edge.session_id) {
                Some(held) => held.reason = edge.reason,
                None => self.pending.push(edge.clone()),
            }
        }
        if self.opened_ms.is_some() {
            return None;
        }
        self.opened_ms = Some(now_ms);
        Some(now_ms + WINDOW_MS)
    }

    /// The batch, once the window opened by the first push has elapsed.
    pub fn take_due(&mut self, now_ms: i64) -> Option<Vec<NeedsYouEdge>> {
        let opened = self.opened_ms?;
        if now_ms - opened < WINDOW_MS {
            return None;
        }
        self.opened_ms = None;
        Some(std::mem::take(&mut self.pending))
    }
}

/// Notification title and body for a released batch. A lone edge keeps its
/// per-session wording; several become "3 agents need you: a, b, c".
pub fn summarize(edges: &[NeedsYouEdge]) -> Option<(String, String)> {
    match edges {
        [] => None,
        [edge] => {
            let what = match edge.reason {
                NeedsYouReason::WaitingForInput => "is waiting for input",
                NeedsYouReason::Errored => "errored",
                NeedsYouReason::Finished => "finished",
            };
            Some((format!("{} — {}", edge.repo, edge.session), format!("{} {what}", edge.session)))
        }
        many => {
            let names: Vec<&str> = many.iter().map(|e| e.session.as_str()).collect();
            let title = format!("{} agents need you", many.len());
            Some((title.clone(), format!("{title}: {}", names.join(", "))))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edge(id: &str, reason: NeedsYouReason) -> NeedsYouEdge {
        NeedsYouEdge {
            session_id: id.into(),
            repo: "repo".into(),
            session: format!("shell {id}"),
            reason,
            needs_since_ms: None,
        }
    }

    fn ids(batch: &[NeedsYouEdge]) -> Vec<&str> {
        batch.iter().map(|e| e.session_id.as_str()).collect()
    }

    #[test]
    fn lone_event_releases_after_one_window() {
        let mut c = Coalescer::new();
        assert_eq!(c.push(1_000, &[edge("a", NeedsYouReason::Finished)]), Some(1_000 + WINDOW_MS));
        assert!(c.take_due(1_000 + WINDOW_MS - 1).is_none());
        let batch = c.take_due(1_000 + WINDOW_MS).unwrap();
        assert_eq!(ids(&batch), ["a"]);
        assert!(c.take_due(10_000).is_none());
    }

    #[test]
    fn burst_inside_window_is_one_batch() {
        let mut c = Coalescer::new();
        assert!(c.push(0, &[edge("a", NeedsYouReason::Finished)]).is_some());
        assert!(c.push(500, &[edge("b", NeedsYouReason::Errored)]).is_none());
        assert!(c.push(1_900, &[edge("c", NeedsYouReason::WaitingForInput)]).is_none());
        let batch = c.take_due(WINDOW_MS).unwrap();
        assert_eq!(ids(&batch), ["a", "b", "c"]);
    }

    #[test]
    fn events_straddling_the_window_are_two_batches() {
        let mut c = Coalescer::new();
        c.push(0, &[edge("a", NeedsYouReason::Finished)]);
        assert_eq!(ids(&c.take_due(WINDOW_MS).unwrap()), ["a"]);
        assert_eq!(
            c.push(WINDOW_MS + 1, &[edge("b", NeedsYouReason::Finished)]),
            Some(WINDOW_MS * 2 + 1)
        );
        assert_eq!(ids(&c.take_due(WINDOW_MS * 2 + 1).unwrap()), ["b"]);
    }

    #[test]
    fn same_agent_twice_counts_once_with_newest_reason() {
        let mut c = Coalescer::new();
        c.push(0, &[edge("a", NeedsYouReason::Finished)]);
        c.push(100, &[edge("a", NeedsYouReason::Errored)]);
        let batch = c.take_due(WINDOW_MS).unwrap();
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].reason, NeedsYouReason::Errored);
    }

    #[test]
    fn empty_push_opens_nothing() {
        let mut c = Coalescer::new();
        assert!(c.push(0, &[]).is_none());
        assert!(c.take_due(WINDOW_MS * 5).is_none());
    }

    #[test]
    fn summary_names_everyone_in_a_burst() {
        let one = [edge("a", NeedsYouReason::Finished)];
        assert_eq!(summarize(&one), Some(("repo — shell a".into(), "shell a finished".into())));
        let three = [
            edge("a", NeedsYouReason::Finished),
            edge("b", NeedsYouReason::Finished),
            edge("c", NeedsYouReason::Errored),
        ];
        let (title, body) = summarize(&three).unwrap();
        assert_eq!(title, "3 agents need you");
        assert_eq!(body, "3 agents need you: shell a, shell b, shell c");
        assert!(summarize(&[]).is_none());
    }
}
