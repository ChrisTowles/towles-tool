//! Notes the user sent an agent from the app, and the Claude mod's model spend.
//! Only the app writes a note; the Claude mod in the addressed session leases it over
//! MCP, hands it to the model, then acks it.

use rusqlite::{OptionalExtension, params};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{Result, Store};

/// The mod's model questions each keep their own daily budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpendLedger {
    NextPrompt,
}

impl SpendLedger {
    fn table(self) -> &'static str {
        match self {
            SpendLedger::NextPrompt => "suggest_spend",
        }
    }
}

/// Delivered notes older than this are swept on the next add.
const DELIVERED_KEEP_MS: i64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum NoteSource {
    /// Typed in the app's note box.
    Note,
    /// An annotated Preview capture.
    Feedback,
}

/// How the mod handed the note over: read at the agent's next step, or a prompt of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum NoteDelivery {
    MidTurn,
    Prompt,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgentNote {
    pub id: i64,
    /// The rail's session id: the `TT_SESSION_ID` its terminal carries.
    pub session: String,
    pub body: String,
    pub source: NoteSource,
    /// Absolute paths of staged images (an annotated capture).
    pub images: Vec<String>,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivered_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivered_how: Option<NoteDelivery>,
}

fn source_str(source: NoteSource) -> &'static str {
    match source {
        NoteSource::Note => "note",
        NoteSource::Feedback => "feedback",
    }
}

fn delivery_str(how: NoteDelivery) -> &'static str {
    match how {
        NoteDelivery::MidTurn => "midTurn",
        NoteDelivery::Prompt => "prompt",
    }
}

const NOTE_COLUMNS: &str =
    "id, session, body, source, images, created_at, delivered_at, delivered_how";

fn note_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<AgentNote> {
    let source: String = r.get(3)?;
    let images: String = r.get(4)?;
    let how: Option<String> = r.get(7)?;
    Ok(AgentNote {
        id: r.get(0)?,
        session: r.get(1)?,
        body: r.get(2)?,
        source: if source == "feedback" { NoteSource::Feedback } else { NoteSource::Note },
        images: serde_json::from_str(&images).unwrap_or_default(),
        created_at: r.get(5)?,
        delivered_at: r.get(6)?,
        delivered_how: how
            .map(|h| if h == "midTurn" { NoteDelivery::MidTurn } else { NoteDelivery::Prompt }),
    })
}

impl Store {
    pub fn add_note(
        &self,
        session: &str,
        body: &str,
        source: NoteSource,
        images: &[String],
        now_ms: i64,
    ) -> Result<i64> {
        self.conn.execute(
            "DELETE FROM agent_notes WHERE delivered_at IS NOT NULL AND delivered_at < ?1",
            params![now_ms - DELIVERED_KEEP_MS],
        )?;
        self.conn.execute(
            "INSERT INTO agent_notes (session, body, source, images, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                session,
                body,
                source_str(source),
                serde_json::to_string(images)?,
                now_ms
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Undelivered notes for `session` not already leased, leased now for `lease_ms`. One
    /// statement, so two polls can never take the same note; an expired lease re-offers it.
    pub fn lease_notes(&self, session: &str, now_ms: i64, lease_ms: i64) -> Result<Vec<AgentNote>> {
        let mut stmt = self.conn.prepare(&format!(
            "UPDATE agent_notes SET leased_until = ?2
             WHERE session = ?1 AND delivered_at IS NULL
               AND (leased_until IS NULL OR leased_until <= ?3)
             RETURNING {NOTE_COLUMNS}"
        ))?;
        let rows = stmt.query_map(params![session, now_ms + lease_ms, now_ms], note_from_row)?;
        let mut notes = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        notes.sort_by_key(|n| n.id);
        Ok(notes)
    }

    /// Idempotent: a note already delivered, or another session's, is not counted.
    pub fn mark_notes_delivered(
        &self,
        session: &str,
        ids: &[i64],
        how: NoteDelivery,
        now_ms: i64,
    ) -> Result<Vec<AgentNote>> {
        let mut delivered = Vec::new();
        let mut stmt = self.conn.prepare(&format!(
            "UPDATE agent_notes SET delivered_at = ?3, delivered_how = ?4
             WHERE id = ?1 AND session = ?2 AND delivered_at IS NULL
             RETURNING {NOTE_COLUMNS}"
        ))?;
        for id in ids {
            if let Some(note) = stmt
                .query_row(params![id, session, now_ms, delivery_str(how)], note_from_row)
                .optional()?
            {
                delivered.push(note);
            }
        }
        Ok(delivered)
    }

    /// Every undelivered note, plus those delivered since `since_ms`: what the rail's chips show.
    pub fn recent_notes(&self, since_ms: i64) -> Result<Vec<AgentNote>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {NOTE_COLUMNS} FROM agent_notes
             WHERE delivered_at IS NULL OR delivered_at >= ?1 ORDER BY id"
        ))?;
        let rows = stmt.query_map(params![since_ms], note_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// What `ledger` has spent on `day` (the caller's local `YYYY-MM-DD`).
    pub fn model_spend(&self, ledger: SpendLedger, day: &str) -> Result<f64> {
        let sql = format!("SELECT cost_usd FROM {} WHERE day = ?1", ledger.table());
        Ok(self.conn.query_row(&sql, params![day], |r| r.get(0)).optional()?.unwrap_or(0.0))
    }

    pub fn add_model_spend(&self, ledger: SpendLedger, day: &str, cost_usd: f64) -> Result<()> {
        let sql = format!(
            "INSERT INTO {} (day, calls, cost_usd) VALUES (?1, 1, ?2)
             ON CONFLICT(day) DO UPDATE SET calls = calls + 1, cost_usd = cost_usd + excluded.cost_usd",
            ledger.table()
        );
        self.conn.execute(&sql, params![day, cost_usd])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_leased_note_is_not_offered_again_until_the_lease_expires() {
        let store = Store::open_in_memory().unwrap();
        let id = store.add_note("s1", "use the band", NoteSource::Note, &[], 0).unwrap();
        let first = store.lease_notes("s1", 10, 1_000).unwrap();
        assert_eq!(first.iter().map(|n| n.id).collect::<Vec<_>>(), [id]);
        assert!(store.lease_notes("s1", 500, 1_000).unwrap().is_empty());
        assert_eq!(store.lease_notes("s1", 1_010, 1_000).unwrap().len(), 1);
    }

    #[test]
    fn notes_are_only_offered_to_their_own_session() {
        let store = Store::open_in_memory().unwrap();
        store.add_note("s1", "a", NoteSource::Note, &[], 0).unwrap();
        assert!(store.lease_notes("s2", 10, 1_000).unwrap().is_empty());
        assert_eq!(store.lease_notes("s1", 10, 1_000).unwrap().len(), 1);
    }

    #[test]
    fn delivery_is_idempotent_and_scoped_to_the_session() {
        let store = Store::open_in_memory().unwrap();
        let id = store.add_note("s1", "a", NoteSource::Note, &[], 0).unwrap();
        assert!(
            store.mark_notes_delivered("s2", &[id], NoteDelivery::Prompt, 5).unwrap().is_empty()
        );
        let done = store.mark_notes_delivered("s1", &[id], NoteDelivery::MidTurn, 5).unwrap();
        assert_eq!(done[0].delivered_how, Some(NoteDelivery::MidTurn));
        assert!(
            store.mark_notes_delivered("s1", &[id], NoteDelivery::Prompt, 6).unwrap().is_empty()
        );
        assert!(store.lease_notes("s1", 10_000, 1_000).unwrap().is_empty());
    }

    #[test]
    fn recent_notes_keeps_pending_and_freshly_delivered() {
        let store = Store::open_in_memory().unwrap();
        let old = store.add_note("s1", "old", NoteSource::Note, &[], 0).unwrap();
        let images = vec!["/tmp/a.png".to_string()];
        store.add_note("s1", "new", NoteSource::Feedback, &images, 0).unwrap();
        store.mark_notes_delivered("s1", &[old], NoteDelivery::Prompt, 100).unwrap();
        let recent = store.recent_notes(200).unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].images, images);
        assert_eq!(store.recent_notes(50).unwrap().len(), 2);
    }

    #[test]
    fn spend_accumulates_per_day() {
        let store = Store::open_in_memory().unwrap();
        let next = SpendLedger::NextPrompt;
        assert_eq!(store.model_spend(next, "2026-10-15").unwrap(), 0.0);
        store.add_model_spend(next, "2026-10-15", 0.25).unwrap();
        store.add_model_spend(next, "2026-10-15", 0.5).unwrap();
        assert!((store.model_spend(next, "2026-10-15").unwrap() - 0.75).abs() < 1e-9);
        assert_eq!(store.model_spend(next, "2026-10-16").unwrap(), 0.0);
    }
}
