//! SQLite-backed store for the towles-tool "personal dashboard" data: calendar
//! events, kanban todos, issues, PR status, and collector run bookkeeping.
//!
//! Tauri-free, since both the CLI and the app depend on it. Clocks are injected as
//! `now_ms` so logic stays deterministic under test, and the public output structs
//! serialize `camelCase` to match the frontend contract.
//!
//! **Calendar events are the one exception to epoch-ms storage.** Their
//! `starts_at`/`ends_at` are RFC 3339 strings keeping the offset the calendar reported
//! (`2026-07-20T15:00:00+01:00`), because an epoch integer says *when* a meeting is
//! but never that it was booked as 3pm London. Everything else is still epoch ms; see
//! [`Store::replace_events_for_source`] for how the two meet.

use rusqlite::Connection;
use thiserror::Error;

pub mod attention;
pub use attention::{
    ChecksFailedEdge, ChecksFailedWatch, FAIL_STREAK, MeetingStartEdge, MeetingStartWatch,
    ReviewRequestedEdge, ReviewRequestedWatch, StaleCollectorEdge, StaleCollectorWatch,
    WatchedCollector,
};

mod collect;
mod events;
mod github;
mod model;
mod notes;
mod schema;
mod tasks;

pub use model::*;
pub use notes::{AgentNote, NoteDelivery, NoteSource, SpendLedger};

#[derive(Debug, Error)]
pub enum Error {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("could not resolve a data directory")]
    NoDataDir,

    #[error(
        "database is schema v{found}; this build reads v{min} and newer. Delete the file to \
         start fresh."
    )]
    SchemaTooOld { found: i64, min: i64 },

    #[error(
        "database is schema v{found} but this build only knows v{supported}: a newer build \
         migrated it. Rebuild and restart this build from main."
    )]
    SchemaTooNew { found: i64, supported: i64 },

    #[error("no task with id {0}")]
    TaskNotFound(i64),

    #[error("{branch} is already recorded on task #{other_task_id}")]
    BranchTaken { branch: String, other_task_id: i64 },
}

pub type Result<T> = std::result::Result<T, Error>;

/// A handle to the SQLite store.
pub struct Store {
    pub(crate) conn: Connection,
    /// The shared handled-DM ledger this store reads `dismissed_ts` from;
    /// `None` only for in-memory stores. See [`Store::dms`].
    pub(crate) dm_dismissals_path: Option<std::path::PathBuf>,
}

#[cfg(test)]
mod tests;
