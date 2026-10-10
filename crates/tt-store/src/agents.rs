//! Personal Slack agents' bookkeeping. The conversation itself lives in Slack and the
//! agents' memory in their own folders; this is only what the app needs to route,
//! resume and audit.

use rusqlite::{OptionalExtension, params};

use crate::{Result, Store};

/// The session an agent resumes, and the MEMORY.md hash it last saw.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentSession {
    pub session_id: String,
    pub memory_hash: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentReminder {
    pub id: i64,
    pub agent: String,
    pub channel: String,
    pub thread_ts: String,
    pub note: String,
    pub due_at: i64,
}

/// How a turn ended, for the audit log.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TurnOutcome {
    Ok,
    Error,
    Timeout,
}

impl TurnOutcome {
    fn as_str(self) -> &'static str {
        match self {
            TurnOutcome::Ok => "ok",
            TurnOutcome::Error => "error",
            TurnOutcome::Timeout => "timeout",
        }
    }
}

impl Store {
    pub fn agent_session(&self, agent: &str) -> Result<Option<AgentSession>> {
        Ok(self
            .conn
            .query_row(
                "SELECT session_id, memory_hash FROM agent_sessions WHERE agent = ?1",
                params![agent],
                |r| Ok(AgentSession { session_id: r.get(0)?, memory_hash: r.get(1)? }),
            )
            .optional()?)
    }

    pub fn set_agent_session(
        &self,
        agent: &str,
        session: &AgentSession,
        now_ms: i64,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO agent_sessions (agent, session_id, memory_hash, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(agent) DO UPDATE SET session_id = excluded.session_id,
               memory_hash = excluded.memory_hash, updated_at = excluded.updated_at",
            params![agent, session.session_id, session.memory_hash, now_ms],
        )?;
        Ok(())
    }

    /// Forget a session the CLI can no longer resume; the next turn starts fresh.
    pub fn clear_agent_session(&self, agent: &str) -> Result<()> {
        self.conn.execute("DELETE FROM agent_sessions WHERE agent = ?1", params![agent])?;
        Ok(())
    }

    pub fn thread_owner(&self, channel: &str, thread_ts: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT agent FROM agent_threads WHERE channel = ?1 AND thread_ts = ?2",
                params![channel, thread_ts],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// First owner wins: a thread never silently changes hands.
    pub fn claim_thread(&self, channel: &str, thread_ts: &str, agent: &str) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO agent_threads (channel, thread_ts, agent) VALUES (?1, ?2, ?3)",
            params![channel, thread_ts, agent],
        )?;
        Ok(())
    }

    pub fn record_agent_post(
        &self,
        channel: &str,
        ts: &str,
        agent: &str,
        now_ms: i64,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO agent_posts (channel, ts, agent, posted_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![channel, ts, agent, now_ms],
        )?;
        Ok(())
    }

    /// Whether `ts` is something an agent posted — the echo guard, since agents post as Chris.
    pub fn is_agent_post(&self, channel: &str, ts: &str) -> Result<bool> {
        Ok(self
            .conn
            .query_row(
                "SELECT 1 FROM agent_posts WHERE channel = ?1 AND ts = ?2",
                params![channel, ts],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    pub fn add_agent_reminder(&self, reminder: &AgentReminder, now_ms: i64) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO agent_reminders (agent, channel, thread_ts, note, due_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                reminder.agent,
                reminder.channel,
                reminder.thread_ts,
                reminder.note,
                reminder.due_at,
                now_ms
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Claim every reminder due by `now_ms` in one statement, so two ticks (or two
    /// processes) can never fire the same one.
    pub fn take_due_agent_reminders(&self, now_ms: i64) -> Result<Vec<AgentReminder>> {
        let mut stmt = self.conn.prepare(
            "UPDATE agent_reminders SET fired_at = ?1
             WHERE fired_at IS NULL AND due_at <= ?1
             RETURNING id, agent, channel, thread_ts, note, due_at",
        )?;
        let rows = stmt.query_map(params![now_ms], |r| {
            Ok(AgentReminder {
                id: r.get(0)?,
                agent: r.get(1)?,
                channel: r.get(2)?,
                thread_ts: r.get(3)?,
                note: r.get(4)?,
                due_at: r.get(5)?,
            })
        })?;
        let mut out = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        out.sort_by_key(|r| (r.due_at, r.id));
        Ok(out)
    }

    pub fn start_agent_turn(
        &self,
        agent: &str,
        channel: &str,
        thread_ts: &str,
        now_ms: i64,
    ) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO agent_turns (agent, channel, thread_ts, started_at) VALUES (?1, ?2, ?3, ?4)",
            params![agent, channel, thread_ts, now_ms],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn finish_agent_turn(
        &self,
        id: i64,
        outcome: TurnOutcome,
        cost_usd: Option<f64>,
        denials: &[String],
        error: Option<&str>,
        now_ms: i64,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE agent_turns SET finished_at = ?2, outcome = ?3, cost_usd = ?4, denials = ?5,
               error = ?6 WHERE id = ?1",
            params![
                id,
                now_ms,
                outcome.as_str(),
                cost_usd,
                serde_json::to_string(denials)?,
                error
            ],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reminder(agent: &str, due_at: i64) -> AgentReminder {
        AgentReminder {
            id: 0,
            agent: agent.into(),
            channel: "D1".into(),
            thread_ts: "1.0".into(),
            note: "book the car".into(),
            due_at,
        }
    }

    #[test]
    fn a_session_round_trips_and_can_be_forgotten() {
        let store = Store::open_in_memory().unwrap();
        assert_eq!(store.agent_session("atlas").unwrap(), None);
        let s = AgentSession { session_id: "abc".into(), memory_hash: "h1".into() };
        store.set_agent_session("atlas", &s, 1).unwrap();
        let s2 = AgentSession { session_id: "abc".into(), memory_hash: "h2".into() };
        store.set_agent_session("atlas", &s2, 2).unwrap();
        assert_eq!(store.agent_session("atlas").unwrap(), Some(s2));
        store.clear_agent_session("atlas").unwrap();
        assert_eq!(store.agent_session("atlas").unwrap(), None);
    }

    #[test]
    fn the_first_agent_to_claim_a_thread_keeps_it() {
        let store = Store::open_in_memory().unwrap();
        store.claim_thread("D1", "1.0", "atlas").unwrap();
        store.claim_thread("D1", "1.0", "zeus").unwrap();
        assert_eq!(store.thread_owner("D1", "1.0").unwrap().as_deref(), Some("atlas"));
        assert_eq!(store.thread_owner("D1", "2.0").unwrap(), None);
    }

    #[test]
    fn agent_posts_are_recognised_per_channel() {
        let store = Store::open_in_memory().unwrap();
        store.record_agent_post("D1", "5.5", "atlas", 1).unwrap();
        assert!(store.is_agent_post("D1", "5.5").unwrap());
        assert!(!store.is_agent_post("D2", "5.5").unwrap());
    }

    #[test]
    fn due_reminders_fire_exactly_once_in_due_order() {
        let store = Store::open_in_memory().unwrap();
        store.add_agent_reminder(&reminder("atlas", 200), 0).unwrap();
        store.add_agent_reminder(&reminder("zeus", 100), 0).unwrap();
        store.add_agent_reminder(&reminder("atlas", 900), 0).unwrap();
        let due = store.take_due_agent_reminders(500).unwrap();
        assert_eq!(due.iter().map(|r| r.agent.as_str()).collect::<Vec<_>>(), ["zeus", "atlas"]);
        assert!(store.take_due_agent_reminders(500).unwrap().is_empty());
        assert_eq!(store.take_due_agent_reminders(1000).unwrap().len(), 1);
    }

    #[test]
    fn a_turn_is_logged_with_its_outcome() {
        let store = Store::open_in_memory().unwrap();
        let id = store.start_agent_turn("atlas", "D1", "1.0", 10).unwrap();
        store
            .finish_agent_turn(id, TurnOutcome::Ok, Some(0.02), &["Read".into()], None, 20)
            .unwrap();
        let (outcome, denials): (String, String) = store
            .conn
            .query_row("SELECT outcome, denials FROM agent_turns WHERE id = ?1", [id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(outcome, "ok");
        assert_eq!(denials, r#"["Read"]"#);
    }
}
