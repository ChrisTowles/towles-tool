use super::*;

impl Engine {
    /// Mark a folder's agents seen; `unseen` is derived, so this recomputes.
    pub fn mark_seen_patch(&mut self, name: &str) -> Option<StatePayload> {
        if !self.tracker.mark_seen(name) {
            return None;
        }
        Some(self.compute_payload(now_ms()))
    }

    pub fn repo_dirs(&mut self) -> Vec<String> {
        self.reload_repos();
        self.repo_paths.clone()
    }

    /// `scanRoots` from repos.json; the caller defaults when empty.
    pub fn scan_roots(&self) -> Vec<String> {
        load_scan_roots(&self.repos_path)
    }

    pub fn set_scan_roots(&mut self, roots: Vec<String>) {
        persisted(save_scan_roots(&self.repos_path, &roots), "scan roots");
    }

    /// Adds against `repos.json` rather than the possibly-stale `self.repo_paths`.
    pub fn add_repo(&mut self, path: &str) -> bool {
        match add_repo_persisted(&self.repos_path, path) {
            Ok((merged, added)) => {
                self.repo_paths = merged;
                added
            }
            Err(_) => false,
        }
    }

    pub fn remove_repo(&mut self, dir: &str) -> bool {
        match remove_repo_persisted(&self.repos_path, dir) {
            Ok((merged, removed)) => {
                self.repo_paths = merged;
                // The one place identity is reaped.
                if removed && self.repo_meta.forget(dir) {
                    persisted(self.repo_meta.save(), "repo identity");
                }
                removed
            }
            Err(_) => false,
        }
    }

    /// Set the rail's repo order — [`reorder_repos`] holds the stale-input rule.
    pub fn set_repo_order(&mut self, desired: &[String]) -> std::io::Result<()> {
        let merged = crate::repos::reorder_repos_persisted(&self.repos_path, desired)?;
        self.repo_paths = merged;
        Ok(())
    }

    /// Untrack every repo whose directory is gone — the rail's "missing" ghosts.
    pub fn untrack_missing(&mut self) -> Vec<String> {
        match untrack_missing_persisted(&self.repos_path) {
            Ok((merged, removed)) => {
                self.repo_paths = merged;
                removed
            }
            Err(_) => Vec::new(),
        }
    }
}
