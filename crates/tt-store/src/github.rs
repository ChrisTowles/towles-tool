//! GitHub caches: the issues and PR tables (full-swap and state-scoped
//! writes), the tracked-repo identity cache, and their dismissal-aware reads.

use rusqlite::params;

use crate::model::*;
use crate::{Error, Result, Store};

/// Insert every PR row. The insert half is identical across all four
/// `replace_*_prs*` paths; only the preceding delete differs.
fn insert_prs(tx: &rusqlite::Transaction<'_>, prs: &[PrInput]) -> Result<()> {
    let mut stmt = tx.prepare(
        "INSERT INTO pr_status
           (repo, number, title, branch, state, checks, review_state, url, updated_ts)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
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
        let tx = self.conn.unchecked_transaction()?;
        {
            let mut del = tx.prepare("DELETE FROM issues WHERE repo = ?1")?;
            for repo in repos {
                del.execute(params![repo])?;
            }
            let mut stmt = tx.prepare(
                "INSERT INTO issues (repo, number, title, labels, state, url, updated_ts)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for i in issues {
                stmt.execute(params![
                    i.repo,
                    i.number,
                    i.title,
                    serde_json::to_string(&i.labels)?,
                    i.state,
                    i.url,
                    i.updated_ts,
                ])?;
            }
        }
        tx.commit()?;
        Ok(issues.len())
    }

    /// Full-snapshot replace of issue rows.
    pub fn replace_issues(&self, issues: &[IssueInput]) -> Result<usize> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM issues", [])?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO issues (repo, number, title, labels, state, url, updated_ts)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for i in issues {
                stmt.execute(params![
                    i.repo,
                    i.number,
                    i.title,
                    serde_json::to_string(&i.labels)?,
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
    /// (`repo_root` -> `owner_repo` pairs): upsert each pair, then delete any
    /// existing row whose `repo_root` isn't in the set. The Agentboard poll
    /// loop calls this every cycle with the currently tracked repos and their
    /// freshly-derived git origin, so untracking a repo (or its origin
    /// becoming unparseable) drops its row on the next poll with no separate
    /// untrack step — `repos.json` stays the one source of truth for which
    /// repos exist, and this table can never drift into holding a stale one.
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

    /// The tracked repo root for a given `owner/repo` slug, if the identity
    /// cache currently knows it. `task_create` validates its `repo` argument
    /// against this instead of matching a dir/basename.
    ///
    /// Prefer [`Store::tracked_repo_for_owner_repo`], which also hands back the
    /// stored slug so a caller can persist the canonical spelling rather than
    /// whatever casing it was passed.
    pub fn repo_root_for_owner_repo(&self, owner_repo: &str) -> Result<Option<String>> {
        Ok(self.tracked_repo_for_owner_repo(owner_repo)?.map(|(root, _)| root))
    }

    /// The tracked `(repo_root, owner_repo)` for a given slug, matched
    /// **case-insensitively** and returning the identity cache's own spelling.
    ///
    /// Both halves exist for the same reason. GitHub slugs are case-preserving
    /// but not case-sensitive, and this repo has more than one source for them:
    /// `gh` reports `ChrisTowles/towles-tool` on issue and PR rows, while the
    /// origin-derived cache historically stored a folded copy. An exact-match
    /// lookup therefore rejected the *correct* casing and accepted only the
    /// folded one, and callers then persisted the folded string — which the
    /// Board treats as a different repo, splitting one repo's cards across two
    /// identically-labelled swimlanes. Matching loosely and writing back the
    /// stored spelling keeps every new row on one identity.
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

    /// Replace only the non-merged PR rows for `repos`, leaving each repo's
    /// merged rows and every other repo's rows intact. Used by the fast,
    /// frequent open-PR sweep so it never has to re-fetch (and thus never
    /// clobbers) the separately-cadenced merged-PR rows — see
    /// [`Store::replace_merged_prs_for_repos`].
    pub fn replace_open_prs_for_repos(&self, repos: &[String], prs: &[PrInput]) -> Result<usize> {
        self.replace_prs_for_repos_where(repos, prs, Some("state != 'merged'"))
    }

    /// Full-snapshot replace of the non-merged PR rows, preserving merged rows.
    pub fn replace_open_prs(&self, prs: &[PrInput]) -> Result<usize> {
        self.replace_prs_where(prs, Some("state != 'merged'"))
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
            let mut del = tx.prepare(&format!("DELETE FROM pr_status WHERE repo = ?1{and}"))?;
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
        let where_ = state_predicate.map(|p| format!(" WHERE {p}")).unwrap_or_default();
        tx.execute(&format!("DELETE FROM pr_status{where_}"), [])?;
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
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (repo, number, title, labels_json, state, url, updated_ts, dismissed_ts) = row?;
            let labels: Vec<String> = serde_json::from_str(&labels_json)?;
            out.push(IssueItem {
                repo,
                number,
                title,
                labels,
                state,
                url,
                updated_ts,
                dismissed_ts,
            });
        }
        Ok(out)
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
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}
