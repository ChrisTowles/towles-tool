//! Detects when a live session's ports have drifted from what its folder's
//! `.env` currently claims. A PTY never reads `.env` itself — it inherits the
//! app's environment at spawn — so anything the user ran inside it (`bun run
//! dev`) cannot notice a later `tt task env` rotating that port out from under
//! it (see `tt_tasks::template::render`'s reuse-vs-rotate logic).
//!
//! Scoped to ports deliberately: they're the one `${tt:...}`-rendered value with
//! a "current" signal readable straight off `.env`, where a change is a genuine
//! conflict-driven rotation. Diffing the whole `.env` would flag unrelated edits
//! (a secret filled in later), which isn't drift, just enrichment.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use crate::persist::FileVersion;

/// One port whose current claim differs from what a session's shell saw at
/// spawn time.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortDrift {
    /// The `.env` key this port is claimed under, e.g. `"UI_PORT"`.
    pub key: String,
    /// What the session's shell saw at spawn time.
    pub spawned_port: u16,
    /// What `.env` claims for this key right now.
    pub current_port: u16,
}

/// This folder's current port claims, read straight off `<dir>/.env`. Empty
/// when the file is missing or unreadable — nothing to compare a spawn
/// snapshot against, so no drift can be reported either way.
pub fn read_current_ports(dir: &Path) -> BTreeMap<String, u16> {
    std::fs::read_to_string(dir.join(".env"))
        .map(|text| tt_tasks::envfile::port_claims_by_key(&text))
        .unwrap_or_default()
}

/// [`read_current_ports`] memoized per directory on `.env`'s [`FileVersion`]:
/// every emit asks, and an unchanged file should cost a stat, not a read.
#[derive(Debug, Default)]
pub struct PortClaimsCache {
    by_dir: HashMap<PathBuf, (FileVersion, BTreeMap<String, u16>)>,
}

impl PortClaimsCache {
    pub fn current_ports(&mut self, dir: &Path) -> BTreeMap<String, u16> {
        let Some(version) = crate::persist::file_version(&dir.join(".env")) else {
            self.by_dir.remove(dir);
            return BTreeMap::new();
        };
        if let Some((seen, ports)) = self.by_dir.get(dir)
            && *seen == version
        {
            return ports.clone();
        }
        let ports = read_current_ports(dir);
        self.by_dir.insert(dir.to_path_buf(), (version, ports.clone()));
        ports
    }
}

/// Diff a session's spawn-time port snapshot against its folder's current
/// claims. Only keys the spawn snapshot already had are checked — a key the
/// template added *after* this pane started isn't drift for a pane that
/// predates it, only a value change under a key the pane already saw is.
pub fn diff(spawned: &BTreeMap<String, u16>, current: &BTreeMap<String, u16>) -> Vec<PortDrift> {
    spawned
        .iter()
        .filter_map(|(key, &spawned_port)| {
            let &current_port = current.get(key)?;
            (current_port != spawned_port).then(|| PortDrift {
                key: key.clone(),
                spawned_port,
                current_port,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, u16)]) -> BTreeMap<String, u16> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    #[test]
    fn diff_reports_only_changed_keys() {
        let spawned = map(&[("UI_PORT", 3001), ("DB_PORT", 5439)]);
        let current = map(&[("UI_PORT", 3007), ("DB_PORT", 5439)]);
        let drift = diff(&spawned, &current);
        assert_eq!(
            drift,
            vec![PortDrift { key: "UI_PORT".into(), spawned_port: 3001, current_port: 3007 }]
        );
    }

    #[test]
    fn diff_empty_when_nothing_changed() {
        let ports = map(&[("UI_PORT", 3001)]);
        assert!(diff(&ports, &ports).is_empty());
    }

    #[test]
    fn diff_ignores_a_key_missing_from_current() {
        // A key the spawn snapshot had that current `.env` no longer has
        // (template changed, key removed) — nothing to compare it against, so
        // it's not reported as drift.
        let spawned = map(&[("UI_PORT", 3001), ("GONE_PORT", 4000)]);
        let current = map(&[("UI_PORT", 3001)]);
        assert!(diff(&spawned, &current).is_empty());
    }

    #[test]
    fn diff_ignores_a_key_only_current_has() {
        // A key added by a later render that this pane never saw at spawn —
        // not drift for a pane that predates it.
        let spawned = map(&[("UI_PORT", 3001)]);
        let current = map(&[("UI_PORT", 3001), ("NEW_PORT", 4001)]);
        assert!(diff(&spawned, &current).is_empty());
    }

    #[test]
    fn read_current_ports_empty_for_missing_file() {
        let root = tempfile::TempDir::new().unwrap();
        assert!(read_current_ports(root.path()).is_empty());
    }

    #[test]
    fn read_current_ports_reads_env_by_key() {
        let root = tempfile::TempDir::new().unwrap();
        std::fs::write(root.path().join(".env"), "UI_PORT=3001\nTASK=3\n").unwrap();
        let ports = read_current_ports(root.path());
        assert_eq!(ports.get("UI_PORT"), Some(&3001));
        assert_eq!(ports.len(), 1);
    }

    #[test]
    fn port_claims_cache_rereads_only_a_changed_env() {
        use std::io::Write;
        let root = tempfile::TempDir::new().unwrap();
        let env = root.path().join(".env");
        std::fs::write(&env, "UI_PORT=3001\n").unwrap();
        let mut cache = PortClaimsCache::default();
        assert_eq!(cache.current_ports(root.path()).get("UI_PORT"), Some(&3001));

        // Same inode, length and mtime: only a re-read could see the new value.
        let mtime = std::fs::metadata(&env).unwrap().modified().unwrap();
        let mut f = std::fs::OpenOptions::new().write(true).open(&env).unwrap();
        f.write_all(b"UI_PORT=3002\n").unwrap();
        f.set_modified(mtime).unwrap();
        assert_eq!(cache.current_ports(root.path()).get("UI_PORT"), Some(&3001));

        std::fs::write(&env, "UI_PORT=30077\n").unwrap();
        assert_eq!(cache.current_ports(root.path()).get("UI_PORT"), Some(&30077));

        std::fs::remove_file(&env).unwrap();
        assert!(cache.current_ports(root.path()).is_empty());
    }
}
