//! Kanban tasks and their GitHub links: create/move/close/archive, the
//! issue/PR link tables, and the worktree binding (#339's unit of work).

use std::path::Path;

use rusqlite::params;

use crate::model::*;
use crate::{Error, Result, Store};

impl Store {
    /// Add a task at the end of `status`'s column. Issues, PRs and the worktree
    /// binding are attached separately.
    pub fn add_task(
        &self,
        text: &str,
        status: &str,
        notes: Option<&str>,
        goal: Option<&str>,
        now_ms: i64,
    ) -> Result<TaskItem> {
        if !TASK_STATUSES.contains(&status) {
            return Err(Error::Sqlite(rusqlite::Error::InvalidParameterName(format!(
                "unknown task status: {status}"
            ))));
        }
        let position: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM tasks WHERE status = ?1",
            params![status],
            |r| r.get(0),
        )?;
        let completed_at: Option<i64> = if status == "done" { Some(now_ms) } else { None };
        self.conn.execute(
            "INSERT INTO tasks (text, status, position, notes, goal, created_at, completed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![text, status, position, notes, goal, now_ms, completed_at],
        )?;
        self.task_by_id(self.conn.last_insert_rowid())
    }

    /// Move a todo to the end of a kanban column. Moving to any non-`done` column
    /// also reopens a closed task — `outcome` and `archived_at` clear, since the
    /// card is active again.
    pub fn set_task_status(&self, id: i64, status: &str, now_ms: i64) -> Result<()> {
        if !TASK_STATUSES.contains(&status) {
            return Err(Error::Sqlite(rusqlite::Error::InvalidParameterName(format!(
                "unknown task status: {status}"
            ))));
        }
        let completed_at: Option<i64> = if status == "done" { Some(now_ms) } else { None };
        let tx = self.conn.unchecked_transaction()?;
        let position: i64 = tx.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM tasks WHERE status = ?1 AND id <> ?2",
            params![status, id],
            |r| r.get(0),
        )?;
        tx.execute(
            "UPDATE tasks SET status = ?1, completed_at = ?2, position = ?3,
                    outcome = CASE WHEN ?1 = 'done' THEN outcome ELSE NULL END,
                    archived_at = CASE WHEN ?1 = 'done' THEN archived_at ELSE NULL END
             WHERE id = ?4",
            params![status, completed_at, position, id],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// A full replace of `text` and `notes` — `None` clears the notes, there is no
    /// "leave unchanged" sentinel. Status, position and links are untouched.
    pub fn update_task(&self, id: i64, text: &str, notes: Option<&str>) -> Result<TaskItem> {
        let affected = self.conn.execute(
            "UPDATE tasks SET text = ?1, notes = ?2 WHERE id = ?3",
            params![text, notes, id],
        )?;
        if affected == 0 {
            return Err(Error::TaskNotFound(id));
        }
        self.task_by_id(id)
    }

    /// Record the agent's finishing report. A replace rather than an append so a
    /// retried write leaves one copy, not two; blank input clears it.
    pub fn set_task_summary(&self, id: i64, summary: &str, now_ms: i64) -> Result<TaskItem> {
        let trimmed = summary.trim();
        let (text, at) =
            if trimmed.is_empty() { (None, None) } else { (Some(trimmed), Some(now_ms)) };
        let affected = self.conn.execute(
            "UPDATE tasks SET summary = ?1, summary_at = ?2 WHERE id = ?3",
            params![text, at, id],
        )?;
        if affected == 0 {
            return Err(Error::TaskNotFound(id));
        }
        self.task_by_id(id)
    }

    /// Delete a task permanently, cascading its issue/PR link rows.
    pub fn delete_task(&self, id: i64) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        let affected = tx.execute("DELETE FROM tasks WHERE id = ?1", params![id])?;
        if affected == 0 {
            return Err(Error::TaskNotFound(id));
        }
        tx.execute("DELETE FROM task_issues WHERE task_id = ?1", params![id])?;
        tx.execute("DELETE FROM task_prs WHERE task_id = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    /// Record how a task ended and detach it from its worktree directory — the row
    /// survives as the record, which is what replaced deleting it. `Done` lands the
    /// card at the end of the `done` column; `Abandoned` freezes `status` where the
    /// work stopped. Either way `completed_at` is stamped if unset, which is what
    /// later ages the row into the archive.
    pub fn close_task(&self, id: i64, outcome: TaskOutcome, now_ms: i64) -> Result<TaskItem> {
        let outcome = outcome.as_str();
        let tx = self.conn.unchecked_transaction()?;
        let affected = if outcome == "done" {
            let position: i64 = tx.query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM tasks
                 WHERE status = 'done' AND id <> ?1",
                params![id],
                |r| r.get(0),
            )?;
            tx.execute(
                "UPDATE tasks SET status = 'done', position = ?2,
                        completed_at = COALESCE(completed_at, ?3),
                        outcome = ?4, worktree_dir = NULL
                 WHERE id = ?1",
                params![id, position, now_ms, outcome],
            )?
        } else {
            tx.execute(
                "UPDATE tasks SET completed_at = COALESCE(completed_at, ?2),
                        outcome = ?3, worktree_dir = NULL
                 WHERE id = ?1",
                params![id, now_ms, outcome],
            )?
        };
        if affected == 0 {
            return Err(Error::TaskNotFound(id));
        }
        tx.commit()?;
        self.task_by_id(id)
    }

    /// Bring an archived task back onto the board. `status` and `outcome` are left
    /// as they were, so it reappears in the terminal column; moving it out reopens it.
    pub fn unarchive_task(&self, id: i64) -> Result<()> {
        let affected =
            self.conn.execute("UPDATE tasks SET archived_at = NULL WHERE id = ?1", params![id])?;
        if affected == 0 {
            return Err(Error::TaskNotFound(id));
        }
        Ok(())
    }

    /// Archive closed tasks that finished before `before_ms`, returning the count.
    /// This replaced a hard-delete sweep — history is hidden, never destroyed. A
    /// closed row with a NULL `completed_at` is never swept, its time being unknown.
    pub fn archive_closed_tasks(&self, before_ms: i64, now_ms: i64) -> Result<usize> {
        Ok(self.conn.execute(
            "UPDATE tasks SET archived_at = ?2
             WHERE archived_at IS NULL
               AND (outcome IS NOT NULL OR status = 'done')
               AND completed_at IS NOT NULL AND completed_at < ?1",
            params![before_ms, now_ms],
        )?)
    }

    /// Re-attaching an existing link only refreshes the `url`; the cached `state`
    /// is preserved, since the collector owns it.
    pub fn attach_task_issue(&self, id: i64, repo: &str, number: i64, url: &str) -> Result<()> {
        self.require_task(id)?;
        self.conn.execute(
            "INSERT INTO task_issues (task_id, repo, number, url) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(task_id, repo, number) DO UPDATE SET url = excluded.url",
            params![id, repo, number, url],
        )?;
        Ok(())
    }

    /// Detaching a link that doesn't exist is a no-op.
    pub fn detach_task_issue(&self, id: i64, repo: &str, number: i64) -> Result<()> {
        self.conn.execute(
            "DELETE FROM task_issues WHERE task_id = ?1 AND repo = ?2 AND number = ?3",
            params![id, repo, number],
        )?;
        Ok(())
    }

    /// Re-attaching refreshes only the `url`; state/checks stay collector-owned.
    pub fn attach_task_pr(&self, id: i64, repo: &str, number: i64, url: &str) -> Result<()> {
        self.require_task(id)?;
        self.conn.execute(
            "INSERT INTO task_prs (task_id, repo, number, url) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(task_id, repo, number) DO UPDATE SET url = excluded.url",
            params![id, repo, number, url],
        )?;
        Ok(())
    }

    /// Detaching a link that doesn't exist is a no-op.
    pub fn detach_task_pr(&self, id: i64, repo: &str, number: i64) -> Result<()> {
        self.conn.execute(
            "DELETE FROM task_prs WHERE task_id = ?1 AND repo = ?2 AND number = ?3",
            params![id, repo, number],
        )?;
        Ok(())
    }

    /// Bind a task to its repo, and to the worktree its work happens in once one
    /// exists. Called twice in the new-task flow: at submit with the repo alone,
    /// then again once `task_create` resolves. A "task only" submit stops after the
    /// first. The optional columns are upserts, never clears — a `None` means
    /// "leave as is", so a repo-only rebind can't erase an established branch/dir.
    /// The one legitimate detach is [`Store::close_task`].
    pub fn set_task_worktree(
        &self,
        id: i64,
        repo_root: &str,
        repo: Option<&str>,
        branch: Option<&str>,
        dir: Option<&str>,
    ) -> Result<()> {
        let affected = self.conn.execute(
            "UPDATE tasks SET worktree_repo_root = ?1,
                              worktree_repo = COALESCE(?2, worktree_repo),
                              worktree_branch = COALESCE(?3, worktree_branch),
                              worktree_dir = COALESCE(?4, worktree_dir)
             WHERE id = ?5",
            params![repo_root, repo, branch, dir, id],
        )?;
        if affected == 0 {
            return Err(Error::TaskNotFound(id));
        }
        Ok(())
    }

    /// Open todos in kanban order: not in `done`, not closed with an
    /// `outcome`, not archived. Board rows only — see [`TASK_KIND_FILTER`].
    pub fn open_tasks(&self) -> Result<Vec<TaskItem>> {
        self.query_tasks(
            &format!(
                "SELECT {TASK_COLS} FROM tasks
                 WHERE {TASK_KIND_FILTER}
                   AND status != 'done' AND outcome IS NULL AND archived_at IS NULL {TASK_ORDER}"
            ),
            [],
        )
    }

    /// A single todo by id, if it exists.
    pub fn get_task(&self, id: i64) -> Result<Option<TaskItem>> {
        Ok(self
            .query_tasks(&format!("SELECT {TASK_COLS} FROM tasks WHERE id = ?1"), [id])?
            .into_iter()
            .next())
    }

    /// All tasks in kanban order, links and worktree included. Board rows only —
    /// see [`TASK_KIND_FILTER`].
    pub fn all_tasks(&self) -> Result<Vec<TaskItem>> {
        self.query_tasks(
            &format!("SELECT {TASK_COLS} FROM tasks WHERE {TASK_KIND_FILTER} {TASK_ORDER}"),
            [],
        )
    }

    /// Issue refs cached `open` but missing from the collector's snapshot — the
    /// ambiguous set (closed? reassigned away?) needing a targeted `gh issue view`.
    /// Terminal-state links stand until the ref reappears in the snapshot.
    pub fn open_issue_refs_missing_from_cache(&self) -> Result<Vec<(String, i64)>> {
        self.query_refs(
            "SELECT DISTINCT ti.repo, ti.number FROM task_issues ti
             WHERE ti.state = 'open'
               AND NOT EXISTS (SELECT 1 FROM issues i
                               WHERE i.repo = ti.repo AND i.number = ti.number)
             ORDER BY ti.repo, ti.number",
        )
    }

    /// PR refs cached `open` but missing from the `pr_status` snapshot. See
    /// [`Store::open_issue_refs_missing_from_cache`].
    pub fn open_pr_refs_missing_from_cache(&self) -> Result<Vec<(String, i64)>> {
        self.query_refs(
            "SELECT DISTINCT tp.repo, tp.number FROM task_prs tp
             WHERE tp.state = 'open'
               AND NOT EXISTS (SELECT 1 FROM pr_status p
                               WHERE p.repo = tp.repo AND p.number = tp.number)
             ORDER BY tp.repo, tp.number",
        )
    }

    /// Stamp the observed state onto every link row for one issue ref.
    pub fn set_issue_link_state(
        &self,
        repo: &str,
        number: i64,
        state: &str,
        now_ms: i64,
    ) -> Result<usize> {
        Ok(self.conn.execute(
            "UPDATE task_issues SET state = ?3, state_ts = ?4
             WHERE repo = ?1 AND number = ?2",
            params![repo, number, state, now_ms],
        )?)
    }

    /// Stamp the observed state onto every link row for one PR ref. `None` checks
    /// keeps the cached value — the targeted fetch only learns the state.
    pub fn set_pr_link_state(
        &self,
        repo: &str,
        number: i64,
        state: &str,
        checks: Option<&str>,
        now_ms: i64,
    ) -> Result<usize> {
        Ok(self.conn.execute(
            "UPDATE task_prs SET state = ?3, checks = COALESCE(?4, checks), state_ts = ?5
             WHERE repo = ?1 AND number = ?2",
            params![repo, number, state, checks, now_ms],
        )?)
    }

    /// Copy state (and checks) onto every link row whose ref is in the collector
    /// snapshot. Absent refs are left to the targeted fetch in `tt-collect`.
    pub fn refresh_link_states_from_cache(&self, now_ms: i64) -> Result<usize> {
        let tx = self.conn.unchecked_transaction()?;
        let issues = tx.execute(
            "UPDATE task_issues SET
               state = (SELECT i.state FROM issues i
                        WHERE i.repo = task_issues.repo AND i.number = task_issues.number),
               state_ts = ?1
             WHERE EXISTS (SELECT 1 FROM issues i
                           WHERE i.repo = task_issues.repo AND i.number = task_issues.number)",
            params![now_ms],
        )?;
        let prs = tx.execute(
            "UPDATE task_prs SET
               state = (SELECT p.state FROM pr_status p
                        WHERE p.repo = task_prs.repo AND p.number = task_prs.number),
               checks = (SELECT p.checks FROM pr_status p
                         WHERE p.repo = task_prs.repo AND p.number = task_prs.number),
               state_ts = ?1
             WHERE EXISTS (SELECT 1 FROM pr_status p
                           WHERE p.repo = task_prs.repo AND p.number = task_prs.number)",
            params![now_ms],
        )?;
        tx.commit()?;
        Ok(issues + prs)
    }

    /// Link any `pr_status` row whose `(repo, branch)` matches a task's worktree
    /// binding, with no manual step. Archived tasks are excluded: their kept
    /// `branch` is historical fact, and a reused name must not link a future PR to
    /// a long-dead task. A merely *closed* task still attaches — a PR that merges
    /// as the worktree is deleted completes the record.
    pub fn auto_attach_worktree_prs(&self, now_ms: i64) -> Result<usize> {
        Ok(self.conn.execute(
            "INSERT OR IGNORE INTO task_prs (task_id, repo, number, url, state, checks, state_ts)
             SELECT t.id, p.repo, p.number, p.url, p.state, p.checks, ?1
             FROM tasks t
             JOIN pr_status p ON p.repo = t.worktree_repo AND p.branch = t.worktree_branch
             WHERE t.worktree_repo IS NOT NULL AND t.worktree_branch IS NOT NULL
               AND t.archived_at IS NULL",
            params![now_ms],
        )?)
    }

    /// Every worktree the rail should show, both kinds. A *record* query, not a
    /// filesystem one: a row is here because something wrote it down, so the rail
    /// can show a task before its directory exists and keep showing it while removal
    /// runs. Sorted by `created_at`, the one ordering nothing perturbs — kanban
    /// position moves with a card, and git-derived order reshuffles constantly.
    /// Archived rows are excluded: a re-created worktree is a new row.
    pub fn rail_worktrees(&self) -> Result<Vec<RailWorktree>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, kind, status, worktree_repo_root, worktree_dir, worktree_branch, created_at
             FROM tasks
             WHERE worktree_dir IS NOT NULL AND worktree_dir != ''
               AND worktree_repo_root IS NOT NULL AND worktree_repo_root != ''
               AND archived_at IS NULL
             ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(RailWorktree {
                task_id: r.get(0)?,
                kind: TaskKind::parse(&r.get::<_, String>(1)?),
                status: r.get(2)?,
                repo_root: r.get(3)?,
                dir: r.get(4)?,
                branch: r.get(5)?,
                created_at: r.get(6)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Record a git worktree that exists on disk but has no task, so the rail can
    /// show it as a row like any other. A dir that already has a row of *either*
    /// kind is left alone, which stops the scan re-minting a detected row over an
    /// adopted one every tick. `text` is the branch or directory name, not a goal
    /// anyone typed.
    pub fn record_detected_worktree(
        &self,
        repo_root: &str,
        dir: &str,
        branch: Option<&str>,
        now_ms: i64,
    ) -> Result<()> {
        let text = branch
            .map(str::to_string)
            .or_else(|| Path::new(dir).file_name().map(|n| n.to_string_lossy().to_string()))
            .unwrap_or_else(|| dir.to_string());
        self.conn.execute(
            "INSERT INTO tasks (kind, text, status, position, created_at,
                                worktree_repo_root, worktree_branch, worktree_dir)
             SELECT 'detected', ?1, 'backlog', 0, ?2, ?3, ?4, ?5
             WHERE NOT EXISTS (SELECT 1 FROM tasks
                               WHERE worktree_dir = ?5 AND archived_at IS NULL)",
            params![text, now_ms, repo_root, branch, dir],
        )?;
        Ok(())
    }

    /// Drop the detected row for `dir` — its worktree is gone from disk. Deletes
    /// rather than closes, and refuses anything that isn't [`TaskKind::Detected`]:
    /// a detected row is bookkeeping with no outcome worth recording, while a
    /// *task* whose directory vanished is exactly the row the rail must keep
    /// showing until the user says what happened to it.
    pub fn forget_detected_worktree(&self, dir: &str) -> Result<bool> {
        let tx = self.conn.unchecked_transaction()?;
        let ids: Vec<i64> = {
            let mut stmt =
                tx.prepare("SELECT id FROM tasks WHERE worktree_dir = ?1 AND kind = 'detected'")?;
            let rows = stmt.query_map(params![dir], |r| r.get::<_, i64>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for id in &ids {
            tx.execute("DELETE FROM task_issues WHERE task_id = ?1", params![id])?;
            tx.execute("DELETE FROM task_prs WHERE task_id = ?1", params![id])?;
            tx.execute("DELETE FROM tasks WHERE id = ?1", params![id])?;
        }
        tx.commit()?;
        Ok(!ids.is_empty())
    }

    /// Promote a detected worktree's row to the user's own work. A kind change on
    /// the existing row, deliberately: minting a fresh task and deleting this one
    /// would move the row (a new `created_at` re-sorts it) and lose its id.
    /// Adopting an already-adopted row is a no-op, so a second click can't fail.
    pub fn adopt_detected_worktree(&self, id: i64) -> Result<TaskItem> {
        self.require_task(id)?;
        self.conn.execute(
            "UPDATE tasks SET kind = 'task' WHERE id = ?1 AND kind = 'detected'",
            params![id],
        )?;
        self.task_by_id(id)
    }

    /// The task bound to the worktree at `dir`, if any (a worktree belongs to at
    /// most one task; if data ever disagrees, the oldest task wins).
    pub fn task_for_worktree_dir(&self, dir: &str) -> Result<Option<TaskItem>> {
        Ok(self
            .query_tasks(
                &format!(
                    "SELECT {TASK_COLS} FROM tasks WHERE worktree_dir = ?1
                     ORDER BY created_at ASC LIMIT 1"
                ),
                params![dir],
            )?
            .into_iter()
            .next())
    }

    // Row-mapping helpers

    /// One task by id, with its links and worktree binding.
    pub fn task_by_id(&self, id: i64) -> Result<TaskItem> {
        self.query_tasks(&format!("SELECT {TASK_COLS} FROM tasks WHERE id = ?1"), [id])?
            // `TaskNotFound`, not a fabricated `Sqlite(QueryReturnedNoRows)`: a
            // caller must be able to tell "no such row" from "the db couldn't answer".
            .into_iter()
            .next()
            .ok_or(Error::TaskNotFound(id))
    }

    /// Links are left empty; the caller fills them via `load_task_links`, or doesn't.
    fn map_task_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<TaskItem> {
        let worktree_repo_root: Option<String> = r.get(7)?;
        let worktree_repo: Option<String> = r.get(8)?;
        let worktree_branch: Option<String> = r.get(9)?;
        let worktree_dir: Option<String> = r.get(10)?;
        let outcome: Option<String> = r.get(11)?;
        let archived_at: Option<i64> = r.get(12)?;
        let goal: Option<String> = r.get(13)?;
        let summary: Option<String> = r.get(14)?;
        let summary_at: Option<i64> = r.get(15)?;
        let kind = TaskKind::parse(&r.get::<_, String>(16)?);
        // Keyed on `repo_root` alone: a repo-bound task with no worktree yet still
        // has a binding, and dropping it hides its repo from the Board's swimlanes.
        let worktree = worktree_repo_root.map(|repo_root| TaskWorktree {
            repo_root,
            repo: worktree_repo,
            branch: worktree_branch,
            dir: worktree_dir,
        });
        Ok(TaskItem {
            id: r.get(0)?,
            kind,
            text: r.get(1)?,
            status: r.get(2)?,
            position: r.get(3)?,
            created_at: r.get(4)?,
            completed_at: r.get(5)?,
            notes: r.get(6)?,
            outcome,
            archived_at,
            goal,
            summary,
            summary_at,
            worktree,
            issues: Vec::new(),
            prs: Vec::new(),
            closed: false,
            display_outcome: None,
            has_worktree: false,
        }
        .with_derived_fields())
    }

    fn query_tasks(&self, sql: &str, params: impl rusqlite::Params) -> Result<Vec<TaskItem>> {
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map(params, Self::map_task_row)?;
        let mut tasks = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        self.load_task_links(&mut tasks)?;
        Ok(tasks)
    }

    /// Open, worktree-bound tasks whose status the agentboard may auto-drive. A
    /// narrow twin of [`Store::all_tasks`] for `sync_worktree_task_statuses`, which
    /// runs on the emit path (~every 2s) holding the app's `store` mutex: the
    /// `WHERE` clause mirrors the rows that caller would discard anyway, and links
    /// are deliberately left empty since it reads neither.
    pub fn worktree_bound_open_tasks(&self) -> Result<Vec<TaskItem>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {TASK_COLS} FROM tasks
             WHERE {TASK_KIND_FILTER}
               AND outcome IS NULL AND archived_at IS NULL
               AND status IN ('backlog', 'doing')
               AND worktree_dir IS NOT NULL
             {TASK_ORDER}"
        ))?;
        let rows = stmt.query_map([], Self::map_task_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Loads both link tables whole (they are small) and distributes by `task_id`,
    /// keeping `(repo, number)` order deterministic.
    fn load_task_links(&self, tasks: &mut [TaskItem]) -> Result<()> {
        if tasks.is_empty() {
            return Ok(());
        }
        use std::collections::HashMap;
        let mut issues: HashMap<i64, Vec<TaskIssueLink>> = HashMap::new();
        {
            let mut stmt = self.conn.prepare(
                "SELECT task_id, repo, number, url, state FROM task_issues
                 ORDER BY task_id, repo, number",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    TaskIssueLink {
                        repo: r.get(1)?,
                        number: r.get(2)?,
                        url: r.get(3)?,
                        state: r.get(4)?,
                    },
                ))
            })?;
            for row in rows {
                let (task_id, link) = row?;
                issues.entry(task_id).or_default().push(link);
            }
        }
        let mut prs: HashMap<i64, Vec<TaskPrLink>> = HashMap::new();
        {
            let mut stmt = self.conn.prepare(
                "SELECT task_id, repo, number, url, state, checks FROM task_prs
                 ORDER BY task_id, repo, number",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    TaskPrLink {
                        repo: r.get(1)?,
                        number: r.get(2)?,
                        url: r.get(3)?,
                        state: r.get(4)?,
                        checks: r.get(5)?,
                    },
                ))
            })?;
            for row in rows {
                let (task_id, link) = row?;
                prs.entry(task_id).or_default().push(link);
            }
        }
        for task in tasks.iter_mut() {
            if let Some(links) = issues.remove(&task.id) {
                task.issues = links;
            }
            if let Some(links) = prs.remove(&task.id) {
                task.prs = links;
            }
        }
        Ok(())
    }

    fn query_refs(&self, sql: &str) -> Result<Vec<(String, i64)>> {
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Error with [`Error::TaskNotFound`] unless a task with `id` exists.
    fn require_task(&self, id: i64) -> Result<()> {
        let exists = self.conn.prepare("SELECT 1 FROM tasks WHERE id = ?1")?.exists(params![id])?;
        if exists { Ok(()) } else { Err(Error::TaskNotFound(id)) }
    }
}
