//! Atomic file persistence for the shared agentboard config files.
//!
//! Every Agentboard instance (`tt task` runs one per checkout) reads
//! and writes the same `~/.config/towles-tool/agentboard/*.json` files. A plain
//! `std::fs::write` truncates then streams, so a concurrent reader can observe
//! an empty or half-written file — which is how a torn `repos.json` read made
//! one instance's engine poll see zero repos and prune every folder's session
//! records (#75). Writing to a temp file in the same directory and `rename`ing
//! over the target makes the swap atomic on POSIX: readers see either the old
//! or the new content, never a fragment.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

/// Write `contents` to `path` atomically: create parent dirs, write a sibling
/// temp file, then rename it over the target. The temp name embeds the pid and
/// a process-wide counter so concurrent writers (other instances, or two
/// threads in this one) never collide on the temp file itself.
pub fn write_atomic(path: &Path, contents: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let file_name = path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default();
    let tmp = path.with_file_name(format!(".{file_name}.tmp-{}-{seq}", std::process::id()));
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// A cheap "is this the same file contents I last read?" key, from one `stat`.
///
/// Exact for every file [`write_atomic`] produces, and that is the whole point
/// of pairing the two: an atomic write renames a *fresh* temp file over the
/// target, so every write mints a new inode. A change that leaves `(mtime, len)`
/// untouched — a same-length rewrite landing inside one mtime granule, which is
/// exactly what a `repos.json` drag-to-reorder is — still moves the inode. A
/// memo keyed on mtime and length alone could miss it; this can't.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileVersion {
    id: (u64, u64),
    modified: std::time::SystemTime,
    len: u64,
}

/// [`FileVersion`] for `path`, or `None` when it is absent, unreadable, or on a
/// platform with no mtime — all of which mean "no memo", never "unchanged".
pub fn file_version(path: &Path) -> Option<FileVersion> {
    let meta = std::fs::metadata(path).ok()?;
    Some(FileVersion { id: file_id(&meta), modified: meta.modified().ok()?, len: meta.len() })
}

#[cfg(unix)]
fn file_id(meta: &std::fs::Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (meta.dev(), meta.ino())
}

#[cfg(not(unix))]
fn file_id(_meta: &std::fs::Metadata) -> (u64, u64) {
    (0, 0)
}

/// Read the current on-disk value, let `merge` fold this instance's locally
/// touched keys into it, then atomically write the merged value back and hand
/// it to the caller to adopt as its new in-memory state.
///
/// The one home of the merge-on-save clobber-safety property every shared
/// agentboard JSON file depends on (#75, #315): each is written by every open
/// instance, so a save must never write this instance's *whole* view — it would
/// clobber keys another window touched that this copy hasn't heard about yet (the
/// #75 bug: one poll saw zero repos and pruned every folder's records). Callers
/// own the path/dirty guards and the merge; this owns the read → write →
/// return-merged sequence so the four `save()` sites can't drift apart.
pub fn merge_on_save<T: serde::Serialize>(
    path: &Path,
    load: impl FnOnce(&Path) -> T,
    merge: impl FnOnce(&mut T),
) -> std::io::Result<T> {
    let mut on_disk = load(path);
    merge(&mut on_disk);
    let json = serde_json::to_string_pretty(&on_disk).unwrap_or_else(|_| "{}".to_string());
    write_atomic(path, &format!("{json}\n"))?;
    Ok(on_disk)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn writes_content_and_creates_parents() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nested").join("file.json");
        write_atomic(&path, "{}\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}\n");
    }

    #[test]
    fn merge_on_save_preserves_keys_this_instance_never_touched() {
        use std::collections::BTreeMap;
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("shared.json");

        // Another instance already wrote two folders' records.
        let load = |p: &Path| -> BTreeMap<String, i32> {
            std::fs::read_to_string(p)
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or_default()
        };
        write_atomic(&path, "{\"a\":1,\"b\":2}\n").unwrap();

        // This instance only knows about — and only touches — key "b".
        let merged = merge_on_save(&path, load, |m: &mut BTreeMap<String, i32>| {
            m.insert("b".to_string(), 20);
        })
        .unwrap();

        // "a" (never touched here) survives; "b" is updated. The merged value is
        // handed back for the caller to adopt as its own in-memory state.
        assert_eq!(merged.get("a"), Some(&1));
        assert_eq!(merged.get("b"), Some(&20));
        let on_disk = load(&path);
        assert_eq!(on_disk, merged);
    }

    #[test]
    fn merge_on_save_can_remove_a_key_and_starts_from_empty_when_missing() {
        use std::collections::BTreeMap;
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("shared.json");
        let load = |p: &Path| -> BTreeMap<String, i32> {
            std::fs::read_to_string(p)
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or_default()
        };

        // Missing file → the merge starts from an empty value, no error.
        let merged = merge_on_save(&path, load, |m: &mut BTreeMap<String, i32>| {
            m.insert("x".to_string(), 9);
        })
        .unwrap();
        assert_eq!(merged.get("x"), Some(&9));

        // A merge that removes the key writes it back out gone.
        let merged = merge_on_save(&path, load, |m: &mut BTreeMap<String, i32>| {
            m.remove("x");
        })
        .unwrap();
        assert!(merged.is_empty());
        assert!(load(&path).is_empty());
    }

    #[test]
    fn file_version_changes_even_when_content_length_and_mtime_do_not() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("repos.json");
        assert_eq!(file_version(&path), None, "absent file has no version");

        write_atomic(&path, "{\"repoPaths\":[\"/a\",\"/b\"]}\n").unwrap();
        let before = file_version(&path).expect("version");

        // A reorder: same byte length, and back-to-back enough that the two
        // writes can share an mtime granule. The rename behind `write_atomic`
        // gives the second one a new inode regardless.
        write_atomic(&path, "{\"repoPaths\":[\"/b\",\"/a\"]}\n").unwrap();
        let after = file_version(&path).expect("version");
        assert_eq!(before.len, after.len, "the reorder is length-preserving");
        assert_ne!(before, after, "the memo key must still see the change");
    }

    #[test]
    fn overwrites_existing_and_leaves_no_temp_files() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("file.json");
        write_atomic(&path, "old").unwrap();
        write_atomic(&path, "new").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(entries, vec!["file.json"]);
    }
}
