use super::*;

impl Engine {
    /// Add a PTY session to a folder and persist. Returns the created record.
    pub fn add_session(&mut self, dir: &str, name: Option<&str>, now: i64) -> SessionRecord {
        let record = self.sessions.add(dir, name, now);
        persisted(self.sessions.save(), "sessions");
        self.touch_folder(dir, now);
        record
    }

    /// The folder's first session, seeding a default if it has none.
    pub fn ensure_session(&mut self, dir: &str, now: i64) -> Option<SessionRecord> {
        if self.sessions.ensure_default(dir, now) {
            persisted(self.sessions.save(), "sessions");
            self.touch_folder(dir, now);
        }
        self.sessions.sessions_for(dir).first().cloned()
    }

    pub fn rename_session(&mut self, id: &str, name: &str) -> bool {
        let changed = self.sessions.rename(id, name);
        if changed {
            persisted(self.sessions.save(), "sessions");
        }
        changed
    }

    pub fn set_session_purpose(&mut self, id: &str, purpose: Option<&str>) -> bool {
        let changed = self.sessions.set_purpose(id, purpose);
        if changed {
            persisted(self.sessions.save(), "sessions");
        }
        changed
    }

    /// Close every previous-run record except `keep` (the resume candidates),
    /// returning the closed ids. A dead shell is not a state the rail shows, so
    /// only what the picker may still relaunch survives the run that killed it.
    /// Once per run: later calls find nothing left to retire.
    pub fn retire_prior_run(&mut self, keep: &HashSet<String>, now: i64) -> Vec<String> {
        let mut closed: Vec<String> = std::mem::take(&mut self.prior_run)
            .into_iter()
            .filter(|id| !keep.contains(id) && self.close_session(id, now))
            .collect();
        closed.sort();
        closed
    }

    /// The engine can't see PTYs; the host pushes the live ids before each
    /// rebuild so a prune never deletes a running shell's record.
    pub fn set_live_sessions(&mut self, ids: HashSet<String>) {
        self.live_sessions = ids;
    }

    pub fn close_session(&mut self, id: &str, now: i64) -> bool {
        let dir = self.folder_dir_of_session(id);
        let removed = self.sessions.remove(id);
        if removed {
            persisted(self.sessions.save(), "sessions");
            if let Some(dir) = dir {
                self.touch_folder(&dir, now);
            }
        }
        removed
    }

    pub(crate) fn folder_dir_of_session(&self, id: &str) -> Option<String> {
        self.sessions
            .iter()
            .find(|(_, records)| records.iter().any(|r| r.id == id))
            .map(|(dir, _)| dir.to_string())
    }

    /// Session ids scoped to `dir`, removing nothing: a task removal kills live
    /// PTYs *before* the fallible worktree removal, and only then drops records.
    pub fn session_ids_for(&self, dir: &str) -> Vec<String> {
        self.sessions.sessions_for(dir).iter().map(|r| r.id.clone()).collect()
    }

    /// Every persisted session record with its folder dir, cloned, so a caller can
    /// snapshot under the lock and then do slow work unblocked.
    pub fn session_records(&self) -> Vec<(String, SessionRecord)> {
        self.sessions
            .iter()
            .flat_map(|(dir, list)| list.iter().map(move |rec| (dir.to_string(), rec.clone())))
            .collect()
    }

    /// Tear a folder's live rail state down ahead of its checkout disappearing.
    /// Returns the removed session ids (each doubles as its `term_id`) so the
    /// caller can kill their PTYs, which ends any Claude Code process inside.
    pub fn close_folder(&mut self, dir: &str) -> Vec<String> {
        let ids: Vec<String> =
            self.sessions.sessions_for(dir).iter().map(|r| r.id.clone()).collect();
        if !ids.is_empty() {
            for id in &ids {
                self.sessions.remove(id);
            }
            persisted(self.sessions.save(), "sessions");
        }
        if self.windows.remove_folder(dir) {
            persisted(self.windows.save(&[dir.to_string()]), "windows");
        }
        ids
    }
}
