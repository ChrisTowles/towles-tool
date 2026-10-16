//! Persisted folder-rail collapse/expand state, keyed by the frontend's opaque row key
//! (`RepoData.key`, or `"<repoKey>::<folderDir>"` for a sub-folder row).
//!
//! Absence of a key means "expanded": collapsing sets `true`, expanding removes the key,
//! so every mutation is an exact single-key op.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollapsePayload {
    #[serde(default)]
    pub collapsed: BTreeMap<String, bool>,
}

#[derive(Debug, Default)]
pub struct CollapseStore {
    path: Option<PathBuf>,
    payload: CollapsePayload,
    dirty_key: Option<String>,
}

pub fn default_collapse_path() -> PathBuf {
    tt_config::agentboard_dir_lossy().join("collapse.json")
}

impl CollapseStore {
    pub fn new(path: Option<PathBuf>) -> Self {
        let payload = match &path {
            Some(p) => load(p),
            None => CollapsePayload::default(),
        };
        Self { path, payload, dirty_key: None }
    }

    pub fn payload(&self) -> &CollapsePayload {
        &self.payload
    }

    pub fn set(&mut self, key: &str, collapsed: bool) -> bool {
        let current = self.payload.collapsed.get(key).copied().unwrap_or(false);
        if current == collapsed {
            return false;
        }
        if collapsed {
            self.payload.collapsed.insert(key.to_string(), true);
        } else {
            self.payload.collapsed.remove(key);
        }
        self.dirty_key = Some(key.to_string());
        true
    }

    /// Persist the key touched by the last `set`, rereading the file fresh and
    /// overwriting only that key: this file is shared by every Agentboard
    /// window, so a whole-map write from a stale copy would revert another
    /// window's toggle. Same-key races are last-write-wins.
    pub fn save(&mut self) -> std::io::Result<()> {
        let Some(path) = self.path.clone() else {
            return Ok(());
        };
        let Some(key) = self.dirty_key.take() else {
            return Ok(());
        };
        let merged = crate::persist::merge_on_save(&path, load, |on_disk| {
            match self.payload.collapsed.get(&key) {
                Some(value) => {
                    on_disk.collapsed.insert(key, *value);
                }
                None => {
                    on_disk.collapsed.remove(&key);
                }
            }
        })?;
        self.payload = merged;
        Ok(())
    }
}

fn load(path: &Path) -> CollapsePayload {
    let Ok(text) = std::fs::read_to_string(path) else {
        return CollapsePayload::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn set_reports_change_and_defaults_to_expanded() {
        let mut store = CollapseStore::new(None);
        assert!(!store.payload().collapsed.contains_key("repo:a"));
        assert!(store.set("repo:a", true));
        assert!(!store.set("repo:a", true)); // unchanged
        assert_eq!(store.payload().collapsed.get("repo:a"), Some(&true));
    }

    #[test]
    fn expanding_removes_the_key_rather_than_storing_false() {
        let mut store = CollapseStore::new(None);
        store.set("repo:a", true);
        assert!(store.set("repo:a", false));
        assert!(!store.payload().collapsed.contains_key("repo:a"));
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("collapse.json");
        let mut store = CollapseStore::new(Some(path.clone()));
        store.set("repo:a::/repo/a", true);
        store.save().unwrap();

        let reloaded = CollapseStore::new(Some(path));
        assert_eq!(reloaded.payload().collapsed.get("repo:a::/repo/a"), Some(&true));
    }

    #[test]
    fn save_with_no_pending_change_is_a_noop() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("collapse.json");
        let store = CollapseStore::new(Some(path.clone()));
        let mut store = store;
        store.save().unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn concurrent_instances_dont_clobber_each_others_keys() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("collapse.json");

        let mut a = CollapseStore::new(Some(path.clone()));
        let mut b = CollapseStore::new(Some(path.clone()));

        a.set("repo:a", true);
        a.save().unwrap();

        b.set("repo:b", true);
        b.save().unwrap();

        let reloaded = CollapseStore::new(Some(path));
        assert_eq!(reloaded.payload().collapsed.get("repo:a"), Some(&true));
        assert_eq!(reloaded.payload().collapsed.get("repo:b"), Some(&true));
    }

    #[test]
    fn corrupt_file_loads_default() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("collapse.json");
        std::fs::write(&path, "not json").unwrap();
        let store = CollapseStore::new(Some(path));
        assert_eq!(store.payload(), &CollapsePayload::default());
    }
}
