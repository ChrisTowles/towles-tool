//! GitHub caches: the issues, PR and CI-run tables (full-swap and scoped
//! writes), the tracked-repo identity cache, and their dismissal-aware reads.

use rusqlite::params;

use crate::model::*;
use crate::{Error, Result, Store};

/// The two issue caches share one row shape: the user's own, and watched-label ones.
#[derive(Clone, Copy)]
enum IssueTable {
    Mine,
    Watched,
}

impl IssueTable {
    fn name(self) -> &'static str {
        match self {
            IssueTable::Mine => "issues",
            IssueTable::Watched => "watched_issues",
        }
    }
}

/// Insert every PR row — identical across all four `replace_*_prs*` paths; only
/// the preceding delete differs. `OR REPLACE` because those deletes don't
/// partition the table: a PR that reopened between sweeps survives both.
/// Delete guard: a merged/closed PR a task links to is terminal and outside every
/// sweep's bounded list, so a sweep must not drop the row a targeted fetch added —
/// `pr_refs_missing_from_cache` would re-run `gh pr view` for it forever.
const KEEP_LINKED_TERMINAL: &str = "NOT (state <> 'open' AND EXISTS (SELECT 1 FROM task_prs tp \
     WHERE tp.repo = pr_status.repo AND tp.number = pr_status.number))";

fn insert_prs(tx: &rusqlite::Transaction<'_>, prs: &[PrInput]) -> Result<()> {
    let mut stmt = tx.prepare(
        "INSERT OR REPLACE INTO pr_status
           (repo, number, title, branch, state, checks, review_state, url, updated_ts, base_branch)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    )?;
    for p in prs {
        stmt.execute(params![
            p.repo,
            p.number,
            p.title,
            p.branch,
            p.state,
            p.checks,
            p.review_state,
            p.url,
            p.updated_ts,
            p.base_branch,
        ])?;
    }
    Ok(())
}

impl Store {
    /// Replace only the named repos' issue rows, leaving other repos' rows
    /// intact. Collectors use this when a sweep partially failed: repos that
    /// errored keep their last-known-good rows instead of being wiped.
    pub fn replace_issues_for_repos(
        &self,
        repos: &[String],
        issues: &[IssueInput],
    ) -> Result<usize> {
        self.write_issue_table(IssueTable::Mine, Some(repos), issues)
    }

    /// Full-snapshot replace of issue rows.
    pub fn replace_issues(&self, issues: &[IssueInput]) -> Result<usize> {
        self.write_issue_table(IssueTable::Mine, None, issues)
    }

    /// [`Self::replace_issues_for_repos`] for the watched-label cache.
    pub fn replace_watched_issues_for_repos(
        &self,
        repos: &[String],
        issues: &[IssueInput],
    ) -> Result<usize> {
        self.write_issue_table(IssueTable::Watched, Some(repos), issues)
    }

    /// [`Self::replace_issues`] for the watched-label cache; empty clears it.
    pub fn replace_watched_issues(&self, issues: &[IssueInput]) -> Result<usize> {
        self.write_issue_table(IssueTable::Watched, None, issues)
    }

    /// `repos: None` wipes the whole table first; `Some` only those repos' rows.
    fn write_issue_table(
        &self,
        table: IssueTable,
        repos: Option<&[String]>,
        issues: &[IssueInput],
    ) -> Result<usize> {
        let name = table.name();
        let tx = self.conn.unchecked_transaction()?;
        {
            match repos {
                None => {
                    tx.execute(&format!("DELETE FROM {name}"), [])?;
                }
                Some(repos) => {
                    let mut del = tx.prepare(&format!("DELETE FROM {name} WHERE repo = ?1"))?;
                    for repo in repos {
                        del.execute(params![repo])?;
                    }
                }
            }
            let mut stmt = tx.prepare(&format!(
                "INSERT OR REPLACE INTO {name}
                   (repo, number, title, labels, assignees, state, url, updated_ts)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
            ))?;
            for i in issues {
                stmt.execute(params![
                    i.repo,
                    i.number,
                    i.title,
                    serde_json::to_string(&i.labels)?,
                    serde_json::to_string(&i.assignees)?,
                    i.state,
                    i.url,
                    i.updated_ts,
                ])?;
            }
        }
        tx.commit()?;
        Ok(issues.len())
    }

    /// Reconcile the tracked-repo identity cache to exactly `repos`
    /// (`repo_root` -> `owner_repo` pairs). The Agentboard poll loop calls this
    /// every cycle, so untracking a repo drops its row on the next poll with no
    /// separate untrack step — `repos.json` stays the one source of truth.
    pub fn reconcile_repos(&self, repos: &[(String, String)], now_ms: i64) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        {
            let mut upsert = tx.prepare(
                "INSERT INTO repos (repo_root, owner_repo, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(repo_root) DO UPDATE SET owner_repo = excluded.owner_repo,
                                                       updated_at = excluded.updated_at",
            )?;
            for (repo_root, owner_repo) in repos {
                upsert.execute(params![repo_root, owner_repo, now_ms])?;
            }
            if repos.is_empty() {
                tx.execute("DELETE FROM repos", [])?;
            } else {
                let placeholders = repos.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
                let mut del = tx.prepare(&format!(
                    "DELETE FROM repos WHERE repo_root NOT IN ({placeholders})"
                ))?;
                let roots: Vec<&String> = repos.iter().map(|(root, _)| root).collect();
                del.execute(rusqlite::params_from_iter(roots))?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// The tracked `(repo_root, owner_repo)` for a given slug, matched
    /// **case-insensitively** and returning the identity cache's own spelling.
    ///
    /// GitHub slugs are case-preserving but not case-sensitive, and this repo has
    /// more than one source for them — an exact-match lookup rejected the correct
    /// casing, and callers persisted the folded string, splitting one repo's cards
    /// across two identically-labelled Board swimlanes.
    pub fn tracked_repo_for_owner_repo(
        &self,
        owner_repo: &str,
    ) -> Result<Option<(String, String)>> {
        use rusqlite::OptionalExtension;
        self.conn
            .query_row(
                "SELECT repo_root, owner_repo FROM repos WHERE owner_repo = ?1 COLLATE NOCASE",
                params![owner_repo],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(Error::from)
    }

    /// The tracked `(repo_root, owner_repo)` whose root holds `dir`; the deepest wins. A task
    /// worktree sits inside its checkout, so it resolves to that checkout's repo.
    pub fn tracked_repo_for_dir(&self, dir: &str) -> Result<Option<(String, String)>> {
        let mut stmt = self.conn.prepare("SELECT repo_root, owner_repo FROM repos")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        let holds = |root: &str| dir == root || dir.starts_with(&format!("{root}/"));
        Ok(rows
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .filter(|(root, _)| holds(root))
            .max_by_key(|(root, _)| root.len()))
    }

    /// Every tracked repo's `owner/repo` slug, sorted for a stable error
    /// message when `task_create` rejects an unknown `repo` argument.
    pub fn repo_slugs(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT owner_repo FROM repos ORDER BY owner_repo")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<String>>>()?)
    }

    /// Replace only the named repos' PR rows, leaving other repos' rows intact.
    /// See [`Store::replace_issues_for_repos`] for the failure-containment
    /// rationale.
    pub fn replace_prs_for_repos(&self, repos: &[String], prs: &[PrInput]) -> Result<usize> {
        self.replace_prs_for_repos_where(repos, prs, None)
    }

    /// Full-snapshot replace of PR status rows.
    pub fn replace_prs(&self, prs: &[PrInput]) -> Result<usize> {
        self.replace_prs_where(prs, None)
    }

    /// Replace only the *open* rows for `repos` — the frequent open-PR sweep never
    /// re-fetches, so must never clobber, the rows it didn't ask about: the
    /// separately-cadenced merged ones, and the one row a closed PR ever gets.
    pub fn replace_open_prs_for_repos(&self, repos: &[String], prs: &[PrInput]) -> Result<usize> {
        self.replace_prs_for_repos_where(repos, prs, Some("state = 'open'"))
    }

    /// Full-snapshot replace of the open PR rows, preserving settled rows.
    pub fn replace_open_prs(&self, prs: &[PrInput]) -> Result<usize> {
        self.replace_prs_where(prs, Some("state = 'open'"))
    }

    /// Replace only the merged PR rows for `repos`, leaving each repo's open
    /// rows intact. See [`Store::replace_open_prs_for_repos`].
    pub fn replace_merged_prs_for_repos(&self, repos: &[String], prs: &[PrInput]) -> Result<usize> {
        self.replace_prs_for_repos_where(repos, prs, Some("state = 'merged'"))
    }

    /// Full-snapshot replace of the merged PR rows, preserving open rows.
    pub fn replace_merged_prs(&self, prs: &[PrInput]) -> Result<usize> {
        self.replace_prs_where(prs, Some("state = 'merged'"))
    }

    /// Insert PR rows outside any sweep — for the targeted lookups, whose whole
    /// point is a PR the sweeps' bounded lists never carried.
    pub fn upsert_prs(&self, prs: &[PrInput]) -> Result<usize> {
        let tx = self.conn.unchecked_transaction()?;
        insert_prs(&tx, prs)?;
        tx.commit()?;
        Ok(prs.len())
    }

    /// Delete-then-insert for the named repos. `state_predicate` narrows the
    /// delete to a subset of each repo's rows; `None` replaces all of them.
    fn replace_prs_for_repos_where(
        &self,
        repos: &[String],
        prs: &[PrInput],
        state_predicate: Option<&str>,
    ) -> Result<usize> {
        let tx = self.conn.unchecked_transaction()?;
        {
            let and = state_predicate.map(|p| format!(" AND {p}")).unwrap_or_default();
            let mut del = tx.prepare(&format!(
                "DELETE FROM pr_status WHERE repo = ?1{and} AND {KEEP_LINKED_TERMINAL}"
            ))?;
            for repo in repos {
                del.execute(params![repo])?;
            }
            insert_prs(&tx, prs)?;
        }
        tx.commit()?;
        Ok(prs.len())
    }

    /// Full-snapshot variant of [`Store::replace_prs_for_repos_where`].
    fn replace_prs_where(&self, prs: &[PrInput], state_predicate: Option<&str>) -> Result<usize> {
        let tx = self.conn.unchecked_transaction()?;
        let and = state_predicate.map(|p| format!(" AND {p}")).unwrap_or_default();
        tx.execute(&format!("DELETE FROM pr_status WHERE {KEEP_LINKED_TERMINAL}{and}"), [])?;
        insert_prs(&tx, prs)?;
        tx.commit()?;
        Ok(prs.len())
    }

    /// All issue rows, newest update first.
    pub fn issues(&self) -> Result<Vec<IssueItem>> {
        self.query_issues(
            &format!(
                "SELECT {ISSUE_COLS} FROM issues i \
                 LEFT JOIN item_dismissals d \
                   ON d.kind = 'issue' AND d.repo = i.repo AND d.number = i.number \
                 ORDER BY i.updated_ts DESC"
            ),
            [],
        )
    }

    /// Watched-label issue rows, newest update first. Dismissals share the `issue`
    /// kind, so hiding one hides it on both surfaces.
    pub fn watched_issues(&self) -> Result<Vec<IssueItem>> {
        self.query_issues(
            &format!(
                "SELECT {ISSUE_COLS} FROM watched_issues i \
                 LEFT JOIN item_dismissals d \
                   ON d.kind = 'issue' AND d.repo = i.repo AND d.number = i.number \
                 ORDER BY i.updated_ts DESC"
            ),
            [],
        )
    }

    /// A single cached issue row by `(repo, number)`, if the collector has seen it.
    pub fn get_issue(&self, repo: &str, number: i64) -> Result<Option<IssueItem>> {
        Ok(self
            .query_issues(
                &format!(
                    "SELECT {ISSUE_COLS} FROM issues i \
                     LEFT JOIN item_dismissals d \
                       ON d.kind = 'issue' AND d.repo = i.repo AND d.number = i.number \
                     WHERE i.repo = ?1 AND i.number = ?2"
                ),
                params![repo, number],
            )?
            .into_iter()
            .next())
    }

    /// All PR status rows, newest update first.
    pub fn prs(&self) -> Result<Vec<PrItem>> {
        self.query_prs(
            &format!(
                "SELECT {PR_COLS} FROM pr_status p \
                 LEFT JOIN item_dismissals d \
                   ON d.kind = 'pr' AND d.repo = p.repo AND d.number = p.number \
                 ORDER BY p.updated_ts DESC"
            ),
            [],
        )
    }

    fn query_issues(&self, sql: &str, params: impl rusqlite::Params) -> Result<Vec<IssueItem>> {
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map(params, |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, i64>(6)?,
                r.get::<_, i64>(7)?,
                r.get::<_, String>(8)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (repo, number, title, labels_json, state, url, updated_ts, dismissed_ts, assignees) =
                row?;
            let labels: Vec<String> = serde_json::from_str(&labels_json)?;
            let assignees: Vec<String> = serde_json::from_str(&assignees)?;
            out.push(IssueItem {
                repo,
                number,
                title,
                labels,
                assignees,
                state,
                url,
                updated_ts,
                dismissed_ts,
            });
        }
        Ok(out)
    }

    /// Upsert by `(repo, workflow)`: a fetched run lands only when it is at least as
    /// new as the stored one, so a stale page never rolls a row back and a workflow
    /// missing from a page keeps its last known run. Returns the rows written.
    pub fn upsert_ci_runs(&self, runs: &[CiRun]) -> Result<usize> {
        let tx = self.conn.unchecked_transaction()?;
        let mut written = 0;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO ci_runs
                   (repo, workflow, status, conclusion, created_ms, updated_ms, url, head_sha, event,
                    branch)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(repo, workflow) DO UPDATE SET
                   status = excluded.status,
                   conclusion = excluded.conclusion,
                   created_ms = excluded.created_ms,
                   updated_ms = excluded.updated_ms,
                   url = excluded.url,
                   head_sha = excluded.head_sha,
                   event = excluded.event,
                   branch = excluded.branch
                 WHERE excluded.created_ms >= ci_runs.created_ms",
            )?;
            for r in runs {
                written += stmt.execute(params![
                    r.repo,
                    r.workflow,
                    r.status,
                    r.conclusion,
                    r.created_ms,
                    r.updated_ms,
                    r.url,
                    r.head_sha,
                    r.event,
                    r.branch,
                ])?;
            }
        }
        tx.commit()?;
        Ok(written)
    }

    /// After a successful fetch of `repo`: drop its workflows missing from `present`
    /// whose last run predates `stale_before_ms`, so a deleted or renamed workflow
    /// ages out while a rarely-run one keeps its row for a while.
    pub fn prune_absent_ci_workflows(
        &self,
        repo: &str,
        present: &[&str],
        stale_before_ms: i64,
    ) -> Result<usize> {
        let present = serde_json::to_string(present)?;
        Ok(self.conn.execute(
            "DELETE FROM ci_runs WHERE repo = ?1 AND created_ms < ?2
               AND workflow NOT IN (SELECT value FROM json_each(?3))",
            params![repo, stale_before_ms, present],
        )?)
    }

    /// Drop the rows of every repo not in `tracked`— only after a sweep that reached
    /// every tracked repo, since a repo that merely errored must keep its rows.
    pub fn prune_ci_runs_except(&self, tracked: &[String]) -> Result<usize> {
        if tracked.is_empty() {
            return Ok(self.conn.execute("DELETE FROM ci_runs", [])?);
        }
        let placeholders = vec!["?"; tracked.len()].join(", ");
        let mut del = self
            .conn
            .prepare(&format!("DELETE FROM ci_runs WHERE repo NOT IN ({placeholders})"))?;
        Ok(del.execute(rusqlite::params_from_iter(tracked))?)
    }

    /// Every workflow's latest default-branch run, by repo then workflow.
    pub fn ci_runs(&self) -> Result<Vec<CiRun>> {
        let mut stmt = self.conn.prepare(
            "SELECT repo, workflow, status, conclusion, created_ms, updated_ms, url, head_sha, event,
                    branch
             FROM ci_runs ORDER BY repo, workflow",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(CiRun {
                repo: r.get(0)?,
                workflow: r.get(1)?,
                status: r.get(2)?,
                conclusion: r.get(3)?,
                created_ms: r.get(4)?,
                updated_ms: r.get(5)?,
                url: r.get(6)?,
                head_sha: r.get(7)?,
                event: r.get(8)?,
                branch: r.get(9)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    fn query_prs(&self, sql: &str, params: impl rusqlite::Params) -> Result<Vec<PrItem>> {
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map(params, |r| {
            Ok(PrItem {
                repo: r.get(0)?,
                number: r.get(1)?,
                title: r.get(2)?,
                branch: r.get(3)?,
                state: r.get(4)?,
                checks: r.get(5)?,
                review_state: r.get(6)?,
                url: r.get(7)?,
                updated_ts: r.get(8)?,
                dismissed_ts: r.get(9)?,
                base_branch: r.get(10)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}
