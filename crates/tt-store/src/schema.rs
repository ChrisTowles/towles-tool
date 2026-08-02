//! Schema definitions and migrations: the `CREATE TABLE` batches, the on-disk
//! schema version, and the in-place migrations that carry an older database
//! forward. `Store::open`/`open_default`/`open_in_memory` live here too, since
//! opening a store is exactly "connect, then migrate".

use std::path::Path;

use rusqlite::{Connection, params};

use crate::{Error, Result, Store};

/// Current on-disk schema version, stored in the `meta` table.
pub(crate) const SCHEMA_VERSION: i64 = 18;

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
        self.conn.execute_batch(SCHEMA_V1)?;
        self.migrate_tasks_v2()?;
        self.migrate_tasks_notes_v4()?;
        self.conn.execute_batch(SCHEMA_TASK_LINKS_V7)?;
        self.migrate_tasks_v7()?;
        self.migrate_tasks_v8_drop_due()?;
        self.migrate_tasks_v11_worktree_cols()?;
        self.migrate_tasks_v13_outcome()?;
        self.migrate_tasks_v14_drop_next_review()?;
        // Additive `ADD COLUMN` migrations run last, after every rebuild-style one
        // above: a rebuild's fixed `INSERT … SELECT` column list silently drops any
        // column added before it.
        self.migrate_tasks_goal_v16()?;
        self.migrate_tasks_summary_v17()?;
        self.migrate_tasks_kind_v18()?;
        self.migrate_events_v9()?;
        self.migrate_events_v10_iso()?;
        // After v10, never inside SCHEMA_V1: that batch runs before the
        // migrations, so on an upgrading db the column would not exist yet.
        self.conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_events_starts_at_utc ON events(starts_at_utc);",
        )?;
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

    /// `CREATE TABLE IF NOT EXISTS` is a no-op on a pre-kanban `tasks` table, so
    /// rebuild one to the v2 shape. A rebuild, not `ADD COLUMN`: the legacy `source`
    /// column is `NOT NULL` without a default, so left in place it fails every
    /// future insert and SQLite can't drop the constraint in place.
    fn migrate_tasks_v2(&self) -> Result<()> {
        let mut has_source = false;
        {
            let mut stmt = self.conn.prepare("PRAGMA table_info(tasks)")?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let name: String = row.get(1)?;
                if name == "source" {
                    has_source = true;
                }
            }
        }
        if has_source {
            // Legacy rows carry their kanban state in the old `done` flag.
            self.conn.execute_batch(
                "BEGIN;
                 CREATE TABLE tasks_v2 (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    text TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'backlog',
                    position INTEGER NOT NULL DEFAULT 0,
                    due_ts INTEGER,
                    repo TEXT,
                    issue_number INTEGER,
                    issue_url TEXT,
                    created_at INTEGER NOT NULL,
                    completed_at INTEGER
                 );
                 INSERT INTO tasks_v2 (id, text, status, position, due_ts, repo, issue_number,
                                       issue_url, created_at, completed_at)
                   SELECT id, text, CASE WHEN done = 1 THEN 'done' ELSE 'backlog' END, 0,
                          due_ts, NULL, NULL, NULL, created_at, completed_at
                   FROM tasks;
                 DROP TABLE tasks;
                 ALTER TABLE tasks_v2 RENAME TO tasks;
                 COMMIT;",
            )?;
        }
        self.conn.execute_batch("DROP TABLE IF EXISTS emails;")?;
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

    /// v4: free-form `notes` on todos. A nullable ADD COLUMN, idempotent via the
    /// `PRAGMA table_info` check the later ADD-COLUMN migrations copy.
    fn migrate_tasks_notes_v4(&self) -> Result<()> {
        let mut has_notes = false;
        {
            let mut stmt = self.conn.prepare("PRAGMA table_info(tasks)")?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let name: String = row.get(1)?;
                if name == "notes" {
                    has_notes = true;
                }
            }
        }
        if !has_notes {
            self.conn.execute_batch("ALTER TABLE tasks ADD COLUMN notes TEXT;")?;
        }
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

    /// v7: the single issue link generalizes into the `task_issues` link table and
    /// the task gains its `worktree_*` binding. A rebuild, for the same reason as
    /// the v2 repair. Ported links start at state `open`; the next collect pass
    /// refreshes them. Detected by the `repo` column, so fresh dbs skip it.
    fn migrate_tasks_v7(&self) -> Result<()> {
        let mut has_repo = false;
        {
            let mut stmt = self.conn.prepare("PRAGMA table_info(tasks)")?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let name: String = row.get(1)?;
                if name == "repo" {
                    has_repo = true;
                }
            }
        }
        if !has_repo {
            return Ok(());
        }
        self.conn.execute_batch(
            "BEGIN;
             CREATE TABLE tasks_v7 (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                text TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'backlog',
                position INTEGER NOT NULL DEFAULT 0,
                due_ts INTEGER,
                created_at INTEGER NOT NULL,
                completed_at INTEGER,
                notes TEXT,
                worktree_repo_root TEXT,
                worktree_repo TEXT,
                worktree_branch TEXT,
                worktree_dir TEXT
             );
             INSERT INTO tasks_v7 (id, text, status, position, due_ts, created_at, completed_at,
                                   notes)
               SELECT id, text, status, position, due_ts, created_at, completed_at, notes
               FROM tasks;
             INSERT OR IGNORE INTO task_issues (task_id, repo, number, url, state, state_ts)
               SELECT id, repo, issue_number, COALESCE(issue_url, ''), 'open', 0
               FROM tasks
               WHERE repo IS NOT NULL AND issue_number IS NOT NULL;
             DROP TABLE tasks;
             ALTER TABLE tasks_v7 RENAME TO tasks;
             COMMIT;",
        )?;
        Ok(())
    }

    /// v9: events gained a `source` column so two calendars merge into one timeline
    /// without clobbering each other. A rebuild rather than `ADD COLUMN` because the
    /// uniqueness rule changes too, which SQLite can't alter in place.
    ///
    /// **Pre-v9 rows are dropped, not migrated**: there is no honest source to
    /// attribute them to, and a row labelled with a source that never pushes again
    /// is never replaced. Events are a cache, so the cost is one refresh interval.
    fn migrate_events_v9(&self) -> Result<()> {
        let mut has_source = false;
        {
            let mut stmt = self.conn.prepare("PRAGMA table_info(events)")?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let name: String = row.get(1)?;
                if name == "source" {
                    has_source = true;
                }
            }
        }
        if !has_source {
            self.conn.execute_batch(
                "DROP TABLE IF EXISTS events;
                 CREATE TABLE events (
                     id INTEGER PRIMARY KEY,
                     source TEXT NOT NULL,
                     external_id TEXT NOT NULL,
                     title TEXT NOT NULL,
                     start_ts INTEGER NOT NULL,
                     end_ts INTEGER,
                     attendees TEXT NOT NULL DEFAULT '[]',
                     location TEXT,
                     join_url TEXT,
                     updated_at INTEGER NOT NULL,
                     UNIQUE(source, external_id)
                 );",
            )?;
        }
        Ok(())
    }

    /// v10: event times became RFC 3339 text keeping their offset, since an epoch
    /// integer discards that a meeting was booked as 3pm London. A rebuild, because
    /// SQLite cannot `ADD COLUMN` a **STORED** generated column and the sort key
    /// must be stored to be indexable. **Rows are converted, not dropped** — unlike
    /// v9 the instant is known exactly, and `Z` states the unknown offset truthfully.
    fn migrate_events_v10_iso(&self) -> Result<()> {
        let mut has_starts_at = false;
        let mut has_source = false;
        {
            let mut stmt = self.conn.prepare("PRAGMA table_info(events)")?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let name: String = row.get(1)?;
                match name.as_str() {
                    "starts_at" => has_starts_at = true,
                    "source" => has_source = true,
                    _ => {}
                }
            }
        }
        // Either way the epoch columns are what exist, so the conversion is the same.
        let _ = has_source;
        if !has_starts_at {
            self.conn.execute_batch(
                "BEGIN;
                 CREATE TABLE events_v10 (
                     id INTEGER PRIMARY KEY,
                     source TEXT NOT NULL,
                     external_id TEXT NOT NULL,
                     title TEXT NOT NULL,
                     starts_at TEXT NOT NULL,
                     starts_at_utc TEXT GENERATED ALWAYS AS
                         (strftime('%Y-%m-%dT%H:%M:%fZ', starts_at)) STORED,
                     ends_at TEXT,
                     ends_at_utc TEXT GENERATED ALWAYS AS
                         (strftime('%Y-%m-%dT%H:%M:%fZ', ends_at)) STORED,
                     attendees TEXT NOT NULL DEFAULT '[]',
                     location TEXT,
                     join_url TEXT,
                     updated_at INTEGER NOT NULL,
                     UNIQUE(source, external_id)
                 );
                 -- Epoch ms -> RFC 3339 UTC. `Z` is the honest offset for a row
                 -- whose authored zone was never recorded.
                 INSERT INTO events_v10
                     (id, source, external_id, title, starts_at, ends_at,
                      attendees, location, join_url, updated_at)
                 SELECT id, source, external_id, title,
                        strftime('%Y-%m-%dT%H:%M:%fZ', start_ts / 1000.0, 'unixepoch'),
                        CASE WHEN end_ts IS NULL THEN NULL
                             ELSE strftime('%Y-%m-%dT%H:%M:%fZ', end_ts / 1000.0, 'unixepoch')
                        END,
                        attendees, location, join_url, updated_at
                 FROM events;
                 DROP TABLE events;
                 ALTER TABLE events_v10 RENAME TO events;
                 CREATE INDEX IF NOT EXISTS idx_events_starts_at_utc
                     ON events(starts_at_utc);
                 COMMIT;",
            )?;
        }
        Ok(())
    }

    /// v8: due dates are gone from tasks. `due_ts` was nullable and unindexed, so a
    /// plain `DROP COLUMN` is safe; detected by column presence.
    fn migrate_tasks_v8_drop_due(&self) -> Result<()> {
        let mut has_due = false;
        {
            let mut stmt = self.conn.prepare("PRAGMA table_info(tasks)")?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let name: String = row.get(1)?;
                if name == "due_ts" {
                    has_due = true;
                }
            }
        }
        if has_due {
            self.conn.execute("ALTER TABLE tasks DROP COLUMN due_ts", [])?;
        }
        Ok(())
    }

    /// v11: the worktree-"slot" vocabulary rename — `slot_*` columns become
    /// `worktree_*`. `RENAME COLUMN` (SQLite ≥ 3.25) preserves data and is cheaper
    /// than a rebuild; detected by the `slot_repo_root` column.
    fn migrate_tasks_v11_worktree_cols(&self) -> Result<()> {
        let mut has_slot = false;
        {
            let mut stmt = self.conn.prepare("PRAGMA table_info(tasks)")?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let name: String = row.get(1)?;
                if name == "slot_repo_root" {
                    has_slot = true;
                }
            }
        }
        if has_slot {
            self.conn.execute_batch(
                "ALTER TABLE tasks RENAME COLUMN slot_repo_root TO worktree_repo_root;
                 ALTER TABLE tasks RENAME COLUMN slot_repo TO worktree_repo;
                 ALTER TABLE tasks RENAME COLUMN slot_branch TO worktree_branch;
                 ALTER TABLE tasks RENAME COLUMN slot_dir TO worktree_dir;",
            )?;
        }
        Ok(())
    }

    /// v13: closing a task stopped deleting its row. `outcome` records how it ended
    /// and `archived_at` hides it from active views — both `NULL` for every
    /// pre-existing open row.
    fn migrate_tasks_v13_outcome(&self) -> Result<()> {
        let mut has_outcome = false;
        {
            let mut stmt = self.conn.prepare("PRAGMA table_info(tasks)")?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let name: String = row.get(1)?;
                if name == "outcome" {
                    has_outcome = true;
                }
            }
        }
        if !has_outcome {
            self.conn.execute_batch(
                "ALTER TABLE tasks ADD COLUMN outcome TEXT;
                 ALTER TABLE tasks ADD COLUMN archived_at INTEGER;",
            )?;
        }
        Ok(())
    }

    /// v14: the "Up Next" and "In Review" columns are gone. `next` folds back to
    /// `backlog` (never started), `review` forward to `doing` (work had begun). A
    /// plain `UPDATE`, since no column shape changes.
    fn migrate_tasks_v14_drop_next_review(&self) -> Result<()> {
        self.conn.execute_batch(
            "UPDATE tasks SET status = 'backlog' WHERE status = 'next';
             UPDATE tasks SET status = 'doing' WHERE status = 'review';",
        )?;
        Ok(())
    }
}
