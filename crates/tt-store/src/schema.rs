//! Schema definitions and migrations: the `CREATE TABLE` batches, the on-disk
//! schema version, and the in-place migrations that carry an older database
//! forward. `Store::open`/`open_default`/`open_in_memory` live here too, since
//! opening a store is exactly "connect, then migrate".

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};

use crate::{Error, Result, Store};

/// Current on-disk schema version, stored in the `meta` table.
pub(crate) const SCHEMA_VERSION: i64 = 19;

/// Oldest version [`Store::open`] accepts; see [`Store::check_version_floor`].
pub(crate) const MIN_SUPPORTED_VERSION: i64 = 16;

/// Schema v1. Every statement is `IF NOT EXISTS` so `migrate` is idempotent.
const SCHEMA_V1: &str = "\
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    title TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    starts_at_utc TEXT GENERATED ALWAYS AS (strftime('%Y-%m-%dT%H:%M:%fZ', starts_at)) STORED,
    ends_at TEXT,
    ends_at_utc TEXT GENERATED ALWAYS AS (strftime('%Y-%m-%dT%H:%M:%fZ', ends_at)) STORED,
    attendees TEXT NOT NULL DEFAULT '[]',
    location TEXT,
    join_url TEXT,
    updated_at INTEGER NOT NULL,
    UNIQUE(source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_events_starts_at_utc ON events(starts_at_utc);
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'backlog',
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    notes TEXT,
    worktree_repo_root TEXT,
    worktree_repo TEXT,
    worktree_branch TEXT,
    worktree_dir TEXT,
    outcome TEXT,
    archived_at INTEGER
);
CREATE TABLE IF NOT EXISTS issues (
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    labels TEXT NOT NULL DEFAULT '[]',
    state TEXT NOT NULL,
    url TEXT NOT NULL,
    updated_ts INTEGER NOT NULL,
    PRIMARY KEY (repo, number)
);
CREATE TABLE IF NOT EXISTS pr_status (
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    branch TEXT NOT NULL,
    state TEXT NOT NULL,
    checks TEXT NOT NULL,
    review_state TEXT NOT NULL,
    url TEXT NOT NULL,
    updated_ts INTEGER NOT NULL,
    PRIMARY KEY (repo, number)
);
CREATE TABLE IF NOT EXISTS collect_runs (
    collector TEXT PRIMARY KEY,
    ran_at INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    message TEXT
);
CREATE TABLE IF NOT EXISTS dm_status (
    channel TEXT PRIMARY KEY,
    from_name TEXT NOT NULL,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL,
    from_me INTEGER NOT NULL,
    url TEXT,
    fetched_at INTEGER NOT NULL,
    dismissed_ts INTEGER NOT NULL DEFAULT 0
);
";

/// v5: the MCP server's incoming-call log, one row per JSON-RPC request handled.
const SCHEMA_MCP_CALLS_V5: &str = "\
CREATE TABLE IF NOT EXISTS mcp_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    method TEXT NOT NULL,
    tool TEXT,
    args TEXT,
    ok INTEGER NOT NULL,
    error TEXT,
    duration_ms INTEGER,
    client TEXT
);
";

/// v7: a task links 0..N GitHub issues and 0..N PRs. Link rows cache the last
/// observed `state` (and `checks`) because absence from the collector snapshot is
/// ambiguous — once a ref is seen closed/merged, that must survive it leaving.
const SCHEMA_TASK_LINKS_V7: &str = "\
CREATE TABLE IF NOT EXISTS task_issues (
    task_id INTEGER NOT NULL,
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    url TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'open',
    state_ts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (task_id, repo, number)
);
CREATE TABLE IF NOT EXISTS task_prs (
    task_id INTEGER NOT NULL,
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    url TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'open',
    checks TEXT NOT NULL DEFAULT 'none',
    state_ts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (task_id, repo, number)
);
";

/// v12: tracked-repo identity cache (repo root -> GitHub `owner/repo` slug).
/// Reconciled wholesale by the Agentboard poll loop, so `repos.json` stays the sole
/// source of truth and this is a self-healing cache with no untrack path to sync.
const SCHEMA_REPOS_V12: &str = "\
CREATE TABLE IF NOT EXISTS repos (
    repo_root TEXT PRIMARY KEY,
    owner_repo TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
";

/// v15: per-item dismissals for `issues`/`pr_status`. Those tables are fully
/// replaced by every collector run, so a dismissal can't be a column on them the
/// way `dm_status.dismissed_ts` is — it would vanish on reinsert. `kind` is in the
/// key because plain numbers collide across issues and PRs within a repo.
const SCHEMA_ITEM_DISMISSALS_V15: &str = "\
CREATE TABLE IF NOT EXISTS item_dismissals (
    kind TEXT NOT NULL,
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    dismissed_ts INTEGER NOT NULL,
    PRIMARY KEY (kind, repo, number)
);
";

impl Store {
    /// Open (creating if needed) the store at `path`, running migrations.
    pub fn open(path: &Path) -> Result<Store> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        // Several processes hold this file open at once; WAL plus a busy timeout
        // lets their writes interleave instead of failing with SQLITE_BUSY.
        conn.busy_timeout(std::time::Duration::from_millis(5000))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        let store = Store { conn };
        store.migrate()?;
        Ok(store)
    }

    /// Unscoped this is `<data_dir>/towles-tool/tt.db`; in a worktree checkout it
    /// nests under `…/tasks/<scope>/` (see [`tt_config`]).
    pub fn open_default() -> Result<Store> {
        let path = tt_config::store_db_path().map_err(|_| Error::NoDataDir)?;
        Store::open(&path)
    }

    /// Open an ephemeral in-memory store (for tests).
    pub fn open_in_memory() -> Result<Store> {
        let store = Store { conn: Connection::open_in_memory()? };
        store.migrate()?;
        Ok(store)
    }

    /// Create tables and record the schema version. Idempotent.
    fn migrate(&self) -> Result<()> {
        self.check_version_floor()?;
        self.conn.execute_batch(SCHEMA_V1)?;
        self.conn.execute_batch(SCHEMA_TASK_LINKS_V7)?;
        // Additive `ADD COLUMN` migrations, oldest first; a new one goes at the end.
        // They cannot fold into SCHEMA_V1: `CREATE TABLE IF NOT EXISTS` is a no-op on
        // an existing db, which would then silently lack the column.
        self.migrate_tasks_goal_v16()?;
        self.migrate_tasks_summary_v17()?;
        self.migrate_tasks_kind_v18()?;
        self.migrate_tasks_pr_probe_v19()?;
        self.conn.execute_batch(SCHEMA_MCP_CALLS_V5)?;
        self.migrate_collect_runs_v6()?;
        self.conn.execute_batch(SCHEMA_REPOS_V12)?;
        self.conn.execute_batch(SCHEMA_ITEM_DISMISSALS_V15)?;
        self.conn.execute(
            "INSERT INTO meta (key, value) VALUES ('schema_version', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![SCHEMA_VERSION.to_string()],
        )?;
        Ok(())
    }

    /// The oldest db this build can open. The rebuild-style migrations that carried
    /// a pre-v16 db forward are gone, so an older file fails here — with the path and
    /// what to do about it — rather than at its first query with `no such column`.
    /// A db with no `meta` table is brand new, not ancient.
    fn check_version_floor(&self) -> Result<()> {
        // Two statements, not one: SQLite resolves table names when it prepares, so a
        // `meta`-less db would fail to prepare a query mentioning `meta` at all.
        let has_meta: Option<i64> = self
            .conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if has_meta.is_none() {
            return Ok(());
        }
        let found: Option<String> = self
            .conn
            .query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |r| r.get(0))
            .optional()?;
        let Some(version) = found.and_then(|v| v.parse::<i64>().ok()) else {
            return Ok(());
        };
        if version < MIN_SUPPORTED_VERSION {
            return Err(Error::SchemaTooOld { found: version, min: MIN_SUPPORTED_VERSION });
        }
        Ok(())
    }

    /// v6: drop `collect_runs` rows for collectors that no longer exist. A `NOT IN`
    /// sweep against the live keys, so any future retirement is cleaned up too.
    fn migrate_collect_runs_v6(&self) -> Result<()> {
        self.conn.execute(
            "DELETE FROM collect_runs
             WHERE collector NOT IN ('claude:calendar', 'issues', 'prs', 'slack:dm')",
            [],
        )?;
        Ok(())
    }

    /// v16: `goal` — the objective a task was created for, distinct from its title.
    fn migrate_tasks_goal_v16(&self) -> Result<()> {
        let mut has_goal = false;
        {
            let mut stmt = self.conn.prepare("PRAGMA table_info(tasks)")?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let name: String = row.get(1)?;
                if name == "goal" {
                    has_goal = true;
                }
            }
        }
        if !has_goal {
            self.conn.execute_batch("ALTER TABLE tasks ADD COLUMN goal TEXT;")?;
        }
        Ok(())
    }

    /// v17: `summary`/`summary_at` — the agent's exit report. Its own column rather
    /// than `notes`, because `notes` is fed *into* a `task_start` prompt: folding
    /// the report in would make the next session read it as instructions.
    fn migrate_tasks_summary_v17(&self) -> Result<()> {
        let mut has_summary = false;
        {
            let mut stmt = self.conn.prepare("PRAGMA table_info(tasks)")?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let name: String = row.get(1)?;
                if name == "summary" {
                    has_summary = true;
                }
            }
        }
        if !has_summary {
            self.conn.execute_batch(
                "ALTER TABLE tasks ADD COLUMN summary TEXT;
                 ALTER TABLE tasks ADD COLUMN summary_at INTEGER;",
            )?;
        }
        Ok(())
    }

    /// v18: `kind` — what the row *is*, now that every worktree on the Agentboard
    /// rail is backed by a task row (see [`crate::TaskKind`]). Defaulted rather
    /// than nullable: every pre-v18 row is the user's work by definition, since
    /// nothing else could have created one.
    fn migrate_tasks_kind_v18(&self) -> Result<()> {
        let mut has_kind = false;
        {
            let mut stmt = self.conn.prepare("PRAGMA table_info(tasks)")?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let name: String = row.get(1)?;
                if name == "kind" {
                    has_kind = true;
                }
            }
        }
        if !has_kind {
            self.conn
                .execute_batch("ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task';")?;
        }
        Ok(())
    }

    /// v19: `pr_probe_ts` — when a worktree task last asked GitHub about its own
    /// branch. The throttle for that probe, so a task that will never have a PR
    /// costs one `gh` call per interval rather than one per collector pass.
    fn migrate_tasks_pr_probe_v19(&self) -> Result<()> {
        let mut has_probe = false;
        {
            let mut stmt = self.conn.prepare("PRAGMA table_info(tasks)")?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let name: String = row.get(1)?;
                if name == "pr_probe_ts" {
                    has_probe = true;
                }
            }
        }
        if !has_probe {
            self.conn.execute_batch("ALTER TABLE tasks ADD COLUMN pr_probe_ts INTEGER;")?;
        }
        Ok(())
    }
}
