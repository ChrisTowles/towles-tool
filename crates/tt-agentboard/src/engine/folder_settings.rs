use super::*;

impl Engine {
    pub fn set_repo_meta(&mut self, dir: &str, meta: crate::repo_meta::RepoMeta) -> bool {
        let changed = self.repo_meta.set_meta(dir, meta);
        if changed {
            persisted(self.repo_meta.save(), "repo identity");
        }
        changed
    }

    pub fn set_folder_base_branch(&mut self, dir: &str, base_branch: Option<&str>) -> bool {
        let changed = self.folder_meta.set_base_branch(dir, base_branch);
        if changed {
            persisted(self.folder_meta.save(), "folder metadata");
            // The 2s scan tick recomputes, rather than the 10s stat poll.
            self.invalidate_git(dir, GitInvalidation::BaseBranch);
        }
        changed
    }

    /// Set (or clear) the quiet override on every one of `dirs`, in one save: the
    /// unit the user marks is a *repo*, and half of one still shows on the rail.
    pub fn set_folder_quiet(&mut self, dirs: &[String], quiet: bool) -> bool {
        // `|=`, never `any`: `any` stops at the first change, half-marking.
        let mut changed = false;
        for dir in dirs {
            changed |= self.folder_meta.set_quiet(dir, quiet);
        }
        if changed {
            persisted(self.folder_meta.save(), "folder metadata");
        }
        changed
    }

    pub(crate) fn touch_folder(&mut self, dir: &str, now_ms: i64) {
        if self.folder_meta.touch(dir, now_ms) {
            persisted(self.folder_meta.save(), "folder metadata");
        }
    }

    /// Replace the persisted window layout. `touched` is the folder dirs the
    /// frontend mutated, so one window's whole-blob save can't clobber another's.
    pub fn set_windows(
        &mut self,
        payload: crate::windows::WindowsPayload,
        touched: &[String],
    ) -> bool {
        let changed = self.windows.set(payload);
        if changed {
            persisted(self.windows.save(touched), "windows");
        }
        changed
    }

    pub fn set_collapsed(&mut self, key: &str, collapsed: bool) -> bool {
        let changed = self.collapse.set(key, collapsed);
        if changed {
            persisted(self.collapse.save(), "rail collapse state");
        }
        changed
    }

    pub fn set_compact_recommend_percent(&mut self, percent: u8) -> bool {
        let percent = percent.clamp(1, 100);
        if percent == self.compact_recommend_percent {
            return false;
        }
        self.compact_recommend_percent = percent;
        if let Ok(mut settings) = tt_config::load() {
            settings.agentboard.compact_recommend_percent = Some(percent);
            persisted(tt_config::save_merge(&settings), "settings");
        }
        true
    }

    /// Show (or hide) auto-discovered non-task worktrees; no git recompute.
    pub fn set_show_unmanaged_worktrees(&mut self, show: bool) -> bool {
        if show == self.show_unmanaged_worktrees {
            return false;
        }
        self.show_unmanaged_worktrees = show;
        if let Ok(mut settings) = tt_config::load() {
            settings.agentboard.show_unmanaged_worktrees = Some(show);
            persisted(tt_config::save_merge(&settings), "settings");
        }
        true
    }

    /// The host's reconciler is gated on this too: minting invisible rows would
    /// write to a shared database every tick.
    pub fn show_unmanaged_worktrees(&self) -> bool {
        self.show_unmanaged_worktrees
    }

    /// Replace the rail's worktree rows, returning whether anything changed so the
    /// host can re-emit at task creation rather than the next poll boundary.
    pub fn set_task_worktrees(&mut self, worktrees: Vec<tt_store::RailWorktree>) -> bool {
        if worktrees == self.task_worktrees {
            return false;
        }
        self.task_worktrees = worktrees;
        true
    }

    /// Replace the PR rows, re-probing each folder whose base they move: a merge
    /// into a branch other than the task's own base lands the work right here.
    pub fn set_prs(&mut self, prs: Vec<tt_store::PrItem>) {
        if prs == self.prs {
            return;
        }
        let dirs = self.git_dirs();
        let before: Vec<_> = dirs.iter().map(|d| self.effective_base(d)).collect();
        self.prs = prs;
        for (dir, before) in dirs.iter().zip(before) {
            if self.effective_base(dir) != before {
                self.invalidate_git(dir, GitInvalidation::PrBase);
            }
        }
    }
}
