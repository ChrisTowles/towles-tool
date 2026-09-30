//! Kanban tasks and their GitHub links: create/move/close/archive, the
//! issue/PR link tables, and the worktree binding (#339's unit of work).

use std::path::Path;

use rusqlite::{OptionalExtension, params};

use crate::model::*;
use crate::{Error, Result, Store};

impl Store {
    /// Add a task at the end of `status`'s column.
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

    /// Move a todo to the end of a kanban column; any non-`done` column also
    /// reopens a closed task.
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

    /// Replace, not append, so a retried write leaves one copy; blank clears it.
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
        if delete_tasks_where(&tx, "id = ?1", params![id])? == 0 {
            return Err(Error::TaskNotFound(id));
        }
        tx.commit()?;
        Ok(())
    }

    /// Record how a task ended and detach it from its worktree directory; the row
    /// survives as the record. `Abandoned` freezes `status` where the work stopped.
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
    /// A NULL `completed_at` is never swept, its time being unknown.
    pub fn archive_closed_tasks(&self, before_ms: i64, now_ms: i64) -> Result<usize> {
        Ok(self.conn.execute(
            "UPDATE tasks SET archived_at = ?2
             WHERE archived_at IS NULL
               AND (outcome IS NOT NULL OR status = 'done')
               AND completed_at IS NOT NULL AND completed_at < ?1",
            params![before_ms, now_ms],
        )?)
    }

    /// Re-attaching refreshes only the `url`; state stays collector-owned.
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

    /// Bind a task to its repo, then to its worktree once `task_create` resolves.
    /// A `None` column means "leave as is"; the one detach is [`Store::close_task`].
    /// Binding a dir retires any detected row the rail's scan minted for it first,
    /// or removal closes that.
    pub fn set_task_worktree(
        &self,
        id: i64,
        repo_root: &str,
        repo: Option<&str>,
        branch: Option<&str>,
        dir: Option<&str>,
    ) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        let affected = tx.execute(
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
        if let Some(dir) = dir {
            delete_detected_rows(&tx, dir, Some(id))?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Record `branch` as the one task `id`'s worktree is on, replacing whatever was
    /// recorded — the resync after a `git switch` inside the task. Old PR links stay:
    /// they are work this task did. A change re-arms the PR probe for the new branch.
    pub fn resync_task_branch(&self, id: i64, branch: &str) -> Result<BranchResync> {
        let tx = self.conn.unchecked_transaction()?;
        let (repo_root, previous): (Option<String>, Option<String>) = tx
            .query_row(
                "SELECT worktree_repo_root, worktree_branch FROM tasks WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or(Error::TaskNotFound(id))?;
        let changed = previous.as_deref() != Some(branch);
        let resync = BranchResync { previous, current: branch.to_string(), changed };
        if !changed {
            return Ok(resync);
        }
        // Two open tasks on one branch would both auto-attach its PR.
        let other: Option<i64> = tx
            .query_row(
                &format!(
                    "SELECT id FROM tasks
                     WHERE {TASK_KIND_FILTER} AND id != ?1 AND worktree_branch = ?2
                       AND worktree_repo_root IS ?3
                       AND outcome IS NULL AND archived_at IS NULL
                     ORDER BY id LIMIT 1"
                ),
                params![id, branch, repo_root],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(other_task_id) = other {
            return Err(Error::BranchTaken { branch: branch.to_string(), other_task_id });
        }
        tx.execute(
            "UPDATE tasks SET worktree_branch = ?1, pr_probe_ts = NULL WHERE id = ?2",
            params![branch, id],
        )?;
        tx.commit()?;
        Ok(resync)
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

    pub fn get_task(&self, id: i64) -> Result<Option<TaskItem>> {
        Ok(self
            .query_tasks(&format!("SELECT {TASK_COLS} FROM tasks WHERE id = ?1"), [id])?
            .into_iter()
            .next())
    }

    /// All tasks in kanban order. Board rows only — see [`TASK_KIND_FILTER`].
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

    /// PR refs missing from the `pr_status` snapshot, whatever the link says —
    /// unlike [`Store::open_issue_refs_missing_from_cache`], a terminal link counts
    /// too, since the rail's badge needs the row a closed PR's sweep never carries.
    pub fn pr_refs_missing_from_cache(&self) -> Result<Vec<(String, i64)>> {
        self.query_refs(
            "SELECT DISTINCT tp.repo, tp.number FROM task_prs tp
             WHERE NOT EXISTS (SELECT 1 FROM pr_status p
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
    /// binding. Archived tasks are excluded so a reused branch name can't link a
    /// future PR to a long-dead task; a merely *closed* one still attaches.
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

    /// Worktree tasks with no PR linked, oldest probe first, for `tt-collect`'s
    /// targeted `gh` lookup. `limit` spreads many unlinked tasks over several passes.
    pub fn unlinked_worktrees(
        &self,
        probe_before_ms: i64,
        limit: usize,
    ) -> Result<Vec<UnlinkedWorktree>> {
        let mut stmt = self.conn.prepare(
            "SELECT t.id, t.worktree_repo, t.worktree_branch FROM tasks t
             WHERE t.worktree_repo IS NOT NULL AND t.worktree_repo != ''
               AND t.worktree_branch IS NOT NULL AND t.worktree_branch != ''
               AND t.archived_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM task_prs tp WHERE tp.task_id = t.id)
               AND COALESCE(t.pr_probe_ts, 0) <= ?1
             ORDER BY COALESCE(t.pr_probe_ts, 0) ASC, t.id ASC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![probe_before_ms, limit as i64], |r| {
            Ok(UnlinkedWorktree { task_id: r.get(0)?, repo: r.get(1)?, branch: r.get(2)? })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Stamp the probe clock, whatever the answer was: "GitHub has no PR for
    /// this branch" has to throttle exactly like a hit, or an unpushed task
    /// re-asks on every pass forever.
    pub fn mark_pr_probe(&self, task_ids: &[i64], now_ms: i64) -> Result<usize> {
        let tx = self.conn.unchecked_transaction()?;
        let mut updated = 0;
        {
            let mut stmt = tx.prepare("UPDATE tasks SET pr_probe_ts = ?1 WHERE id = ?2")?;
            for id in task_ids {
                updated += stmt.execute(params![now_ms, id])?;
            }
        }
        tx.commit()?;
        Ok(updated)
    }

    /// Every worktree the rail should show, both kinds. A *record* query, not a
    /// filesystem one, so the rail shows a task before its dir exists and while
    /// removal runs. Sorted by `created_at`, the one ordering nothing perturbs.
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

    /// Record a git worktree on disk that has no task, so the rail shows it. A dir
    /// with a row of *either* kind is left alone, or every scan tick re-mints one.
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

    /// Drop the detected row for `dir`, whose worktree is gone. Never a *task*'s:
    /// that row stays on the rail until the user says what happened to it.
    pub fn forget_detected_worktree(&self, dir: &str) -> Result<bool> {
        let tx = self.conn.unchecked_transaction()?;
        let deleted = delete_detected_rows(&tx, dir, None)?;
        tx.commit()?;
        Ok(deleted)
    }

    /// Promote a detected row to the user's own work, in place so its id and rail
    /// position survive. Idempotent.
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

/// Delete the detected rows bound to `dir`, sparing `except`, inside the
/// caller's transaction. Whether any went.
fn delete_detected_rows(
    tx: &rusqlite::Transaction<'_>,
    dir: &str,
    except: Option<i64>,
) -> Result<bool> {
    let pred = "worktree_dir = ?1 AND kind = 'detected' AND id IS NOT ?2";
    Ok(delete_tasks_where(tx, pred, params![dir, except])? > 0)
}

/// Delete the tasks matching `pred` along with their issue/PR link rows — the
/// one place that knows which tables hang off a task. The count of tasks deleted.
fn delete_tasks_where(
    tx: &rusqlite::Transaction<'_>,
    pred: &str,
    args: &[&dyn rusqlite::ToSql],
) -> Result<usize> {
    for links in ["task_issues", "task_prs"] {
        tx.execute(
            &format!("DELETE FROM {links} WHERE task_id IN (SELECT id FROM tasks WHERE {pred})"),
            args,
        )?;
    }
    Ok(tx.execute(&format!("DELETE FROM tasks WHERE {pred}"), args)?)
}
