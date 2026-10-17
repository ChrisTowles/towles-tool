use super::*;

impl Engine {
    /// Mark `dir`'s cache entry stale — the event-driven counterpart to the TTL.
    /// `reason` lands on the `git.invalidated` record.
    pub fn invalidate_git(&mut self, dir: &str, reason: GitInvalidation) {
        self.git_cache.invalidate(Some(dir));
        tracing::debug!(%dir, reason = reason.as_str(), "git.invalidated");
    }

    /// Aim the short git-freshness ceiling at the checkout whose files pane just
    /// mounted, or release it on unmount. A release is ignored unless it still holds
    /// the focus: switching folders mounts the new pane before the old one's cleanup.
    pub fn set_folder_focus(&mut self, dir: &str, focused: bool) -> bool {
        let next = match focused {
            true => Some(dir),
            false if self.git_cache.focused_dir() == Some(dir) => None,
            false => return false,
        };
        let moved = self.git_cache.set_focused(next);
        if focused {
            self.invalidate_git(dir, GitInvalidation::FolderFocus);
        }
        moved
    }

    /// Follow OS window focus, widening the git-freshness ceiling while the app
    /// sits in the background. Coming back invalidates every row rather than
    /// serving one up to five minutes old to someone who just looked at it.
    /// Returns whether focus actually moved.
    pub fn set_window_focused(&mut self, focused: bool) -> bool {
        let moved = self.git_cache.set_window_focused(focused);
        if moved && focused {
            self.git_cache.invalidate(None);
            tracing::debug!(reason = GitInvalidation::WindowFocus.as_str(), "git.invalidated");
        }
        moved
    }

    /// Rail dirs whose git-cache entry is missing or past the TTL. Claims each so
    /// the other poll loop can't retake it.
    pub fn stale_git_targets(
        &mut self,
        now: i64,
    ) -> Vec<(String, Option<String>, crate::git_info::GitInfo)> {
        self.reload_repos();
        let all_paths = self.git_dirs();
        let pending_guard = |d: &str| {
            self.git_pending
                .get(d)
                .is_some_and(|claimed_at| now - claimed_at < GIT_PENDING_GUARD_MS)
        };
        let stale: Vec<String> = all_paths
            .into_iter()
            .filter(|d| !self.git_cache.is_fresh(d, now) && !pending_guard(d))
            .collect();
        let out = self.targets_for(stale);
        for (d, _, _) in &out {
            self.git_pending.insert(d.clone(), now);
        }
        out
    }

    /// Pair each dir with what a recompute needs: the base-branch override, and the
    /// cached value so an unmoved repo revalidates instead of re-probing.
    pub(crate) fn targets_for(
        &self,
        dirs: Vec<String>,
    ) -> Vec<(String, Option<String>, crate::git_info::GitInfo)> {
        dirs.into_iter()
            .map(|d| {
                let base = self.effective_base(&d);
                let previous = self.git_cache.get(&d);
                (d, base, previous)
            })
            .collect()
    }

    /// The user's per-folder override, else the base of the folder's PR; `None`
    /// leaves [`crate::git_info`] to the `.tt-task` marker, then origin/main.
    pub(crate) fn effective_base(&self, dir: &str) -> Option<String> {
        if let Some(base) = self.folder_meta.base_branch_for(dir) {
            return Some(base.to_string());
        }
        let info = self.git_cache.get(dir);
        crate::pr_base::pr_base_for(&self.prs, info.origin_url.as_deref(), &info.branch)
            .map(str::to_string)
    }

    pub fn warm_git_cache(
        &mut self,
        results: Vec<(String, crate::git_info::GitInfo)>,
        now: i64,
    ) -> bool {
        let mut changed = false;
        for (dir, info) in results {
            changed |= self.store_git_info(&dir, info, now);
        }
        changed
    }

    /// The tracked checkout whose cached `linked_worktree_dirs` lists `dir` — never
    /// itself a `repos.json` entry, so untracking it prunes at the owner.
    pub fn find_worktree_owner(&mut self, dir: &str) -> Option<String> {
        self.reload_repos();
        repo_entries(&self.repo_paths)
            .into_iter()
            .find(|e| self.git_cache.get(&e.dir).linked_worktree_dirs.iter().any(|w| w == dir))
            .map(|e| e.dir)
    }

    pub fn git_targets(&mut self) -> Vec<(String, Option<String>, crate::git_info::GitInfo)> {
        self.reload_repos();
        let dirs = repo_entries(&self.repo_paths).into_iter().map(|e| e.dir).collect();
        self.targets_for(dirs)
    }

    /// The repos due a `git fetch` right now, on a cadence tiered by whether
    /// anyone is actually working in them.
    ///
    /// A flat cadence over every tracked repo is what made fetching the single
    /// most expensive thing the app does: a fork nobody has opened in a month
    /// costs exactly what the repo with a live task in it costs. The tier reads
    /// signals already cached — a rail worktree under the repo, and `GitInfo`'s
    /// two "somebody was here" stamps — so classifying costs no extra probing.
    /// Marks each returned dir fetched, so the caller must actually fetch it.
    pub fn fetch_targets(&mut self, now: i64) -> Vec<String> {
        let unfocused_mult = if self.git_cache.window_focused() { 1 } else { UNFOCUSED_FETCH_MULT };
        let due: Vec<String> = self
            .git_targets()
            .into_iter()
            .filter(|(dir, _, info)| {
                let last = self.git_fetched.get(dir).copied().unwrap_or(0);
                now - last >= self.fetch_cadence_ms(dir, info, now) * unfocused_mult
            })
            .map(|(dir, _, _)| dir)
            .collect();
        for dir in &due {
            self.git_fetched.insert(dir.clone(), now);
        }
        due
    }

    /// How often one repo earns a fetch. "Active" is deliberately generous —
    /// being wrong here costs a stale "behind main" on a repo being worked in.
    pub(crate) fn fetch_cadence_ms(
        &self,
        dir: &str,
        info: &crate::git_info::GitInfo,
        now: i64,
    ) -> i64 {
        // A task under it, or its files pane open: both mean somebody is reading
        // this repo's "behind main" right now, whatever the mtimes say.
        if self.git_cache.focused_dir() == Some(dir)
            || self.task_worktrees.iter().any(|w| w.repo_root == dir)
        {
            return ACTIVE_FETCH_MS;
        }
        // A stamp of 0 means "clean, never read" — `age` then runs to the
        // epoch and lands the repo in the idle tier, which is the right guess.
        let age = now - info.worktree_touched_ms.max(info.head_commit_ms);
        match age {
            a if a < ACTIVE_WINDOW_MS => ACTIVE_FETCH_MS,
            a if a < RECENT_WINDOW_MS => RECENT_FETCH_MS,
            _ => IDLE_FETCH_MS,
        }
    }

    /// Store one repo's git info, returning whether it differs. A compute that
    /// couldn't read the repository keeps the folder's structural identity.
    pub fn store_git_info(
        &mut self,
        dir: &str,
        mut info: crate::git_info::GitInfo,
        now: i64,
    ) -> bool {
        let previous = self.git_cache.get(dir);
        crate::git_info::preserve_identity_on_failed_read(dir, &previous, &mut info);
        let changed = previous != info;
        self.git_cache.insert(dir, info, now);
        self.git_pending.remove(dir);
        changed
    }

    pub fn tracked_repo_origins(&mut self) -> Vec<(String, Option<String>)> {
        self.reload_repos();
        repo_entries(&self.repo_paths)
            .into_iter()
            .map(|e| {
                let origin = self.git_cache.get(&e.dir).origin_url;
                (e.dir, origin)
            })
            .collect()
    }
}
