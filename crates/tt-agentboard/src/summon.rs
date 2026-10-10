//! The `summon` MCP tool's state: who asked for the user, and when each request ends. Pure — the
//! host polls PTY input stamps, plays the chime, and feeds both clocks in.

use std::collections::HashMap;

/// Why a summon ended: the user typed, the cap ran out, a newer summon took over, or the
/// caller's terminal went away.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopCause {
    Input,
    Cap,
    Replaced,
    Closed,
}

impl StopCause {
    pub fn as_str(self) -> &'static str {
        match self {
            StopCause::Input => "input",
            StopCause::Cap => "cap",
            StopCause::Replaced => "replaced",
            StopCause::Closed => "closed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stopped {
    pub id: u64,
    pub session: Option<String>,
    pub cause: StopCause,
    pub after_ms: i64,
}

#[derive(Debug, Clone)]
struct Active {
    id: u64,
    session: Option<String>,
    started_ms: i64,
    until_ms: i64,
}

/// Active summons, at most one per calling session; `None` is a caller outside any app terminal,
/// answered by input to *any* terminal.
#[derive(Debug, Default)]
pub struct Summons {
    active: Vec<Active>,
    next_id: u64,
}

impl Summons {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.active.is_empty()
    }

    /// Start a summon, returning its id and the one it replaced, if any.
    pub fn start(
        &mut self,
        session: Option<String>,
        max_minutes: u32,
        now_ms: i64,
    ) -> (u64, Option<Stopped>) {
        let replaced = self.active.iter().position(|a| a.session == session).map(|i| {
            let old = self.active.remove(i);
            stopped(old, StopCause::Replaced, now_ms)
        });
        self.next_id += 1;
        let id = self.next_id;
        let until_ms = now_ms + i64::from(max_minutes) * 60_000;
        self.active.push(Active { id, session, started_ms: now_ms, until_ms });
        (id, replaced)
    }

    /// End every summon its user answered, its cap reached, or its terminal lost. `input_at`
    /// maps each *live* session to its last user-input stamp.
    pub fn tick(&mut self, now_ms: i64, input_at: &HashMap<String, Option<i64>>) -> Vec<Stopped> {
        let any_input_after = |t: i64| input_at.values().flatten().any(|&at| at > t);
        let mut ended = Vec::new();
        self.active.retain(|a| {
            let cause = match &a.session {
                Some(s) => match input_at.get(s) {
                    None => Some(StopCause::Closed),
                    Some(Some(at)) if *at > a.started_ms => Some(StopCause::Input),
                    _ => None,
                },
                None => any_input_after(a.started_ms).then_some(StopCause::Input),
            }
            .or((now_ms >= a.until_ms).then_some(StopCause::Cap));
            match cause {
                Some(cause) => {
                    ended.push(stopped(a.clone(), cause, now_ms));
                    false
                }
                None => true,
            }
        });
        ended
    }
}

fn stopped(a: Active, cause: StopCause, now_ms: i64) -> Stopped {
    Stopped { id: a.id, session: a.session, cause, after_ms: now_ms - a.started_ms }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live(pairs: &[(&str, Option<i64>)]) -> HashMap<String, Option<i64>> {
        pairs.iter().map(|(s, t)| (s.to_string(), *t)).collect()
    }

    #[test]
    fn input_after_the_start_answers_it() {
        let mut s = Summons::new();
        s.start(Some("a".into()), 15, 1_000);
        assert!(s.tick(2_000, &live(&[("a", Some(500))])).is_empty());
        let ended = s.tick(3_000, &live(&[("a", Some(2_500))]));
        assert_eq!(ended[0].cause, StopCause::Input);
        assert_eq!(ended[0].after_ms, 2_000);
        assert!(s.is_empty());
    }

    #[test]
    fn input_to_another_session_does_not_answer_a_session_summon() {
        let mut s = Summons::new();
        s.start(Some("a".into()), 15, 1_000);
        assert!(s.tick(2_000, &live(&[("a", None), ("b", Some(1_500))])).is_empty());
    }

    #[test]
    fn a_sessionless_summon_is_answered_by_any_terminal() {
        let mut s = Summons::new();
        s.start(None, 15, 1_000);
        let ended = s.tick(2_000, &live(&[("b", Some(1_500))]));
        assert_eq!(ended[0].cause, StopCause::Input);
    }

    #[test]
    fn the_cap_ends_it() {
        let mut s = Summons::new();
        s.start(Some("a".into()), 1, 0);
        assert!(s.tick(59_999, &live(&[("a", None)])).is_empty());
        assert_eq!(s.tick(60_000, &live(&[("a", None)]))[0].cause, StopCause::Cap);
    }

    #[test]
    fn a_closed_terminal_ends_it() {
        let mut s = Summons::new();
        s.start(Some("a".into()), 15, 0);
        assert_eq!(s.tick(10, &live(&[]))[0].cause, StopCause::Closed);
    }

    #[test]
    fn a_second_summon_from_one_session_replaces_the_first() {
        let mut s = Summons::new();
        let (first, _) = s.start(Some("a".into()), 15, 0);
        let (second, replaced) = s.start(Some("a".into()), 15, 100);
        let replaced = replaced.expect("the first is replaced");
        assert_eq!((replaced.id, replaced.cause), (first, StopCause::Replaced));
        assert_ne!(first, second);
        assert!(s.start(Some("b".into()), 15, 100).1.is_none());
    }
}
