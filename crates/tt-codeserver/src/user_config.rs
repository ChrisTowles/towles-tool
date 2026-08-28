//! The settings and keybindings every checkout edits, kept in one place.
//!
//! The user data dir is instance-scoped, so without this each checkout has its
//! own `settings.json` and an extension has to be configured once per pane —
//! wrong for an app whose whole claim is one editor across N checkouts. Only
//! the hand-edited files move: `globalStorage`, `workspaceStorage` and the
//! state DB beside them stay per-instance, because two apps run at once and
//! neither VS Code nor SQLite expects a second writer.
//!
//! Symlinks, re-established on every launch. VS Code writes settings
//! atomically — a temp file renamed over the target — which on some paths
//! replaces the link with a regular file, so this converges rather than
//! assuming: whatever is there is adopted, newest wins, and the link is remade.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Config the user hand-edits, in the workbench's own Settings editor or not.
/// Files only — a dangling symlink where a directory belongs fails the `mkdir`
/// that would create it, which would break snippets rather than share them.
const SHARED: [&str; 2] = ["settings.json", "keybindings.json"];

/// Point this instance's `User/` config files at the shared copies. Failures
/// are per-file and logged, never fatal: an editor that opens with unshared
/// settings beats one that does not open.
pub fn share(user_data_dir: &Path, shared_dir: &Path) -> io::Result<()> {
    fs::create_dir_all(shared_dir)?;
    let user = user_data_dir.join("User");
    fs::create_dir_all(&user)?;
    for name in SHARED {
        if let Err(e) = relink(&user.join(name), &shared_dir.join(name)) {
            tracing::warn!(file = name, error = %e, "code-server.user-config.share-failed");
        }
    }
    Ok(())
}

fn relink(link: &Path, target: &Path) -> io::Result<()> {
    match fs::symlink_metadata(link) {
        Ok(meta) if meta.file_type().is_symlink() => {
            if fs::read_link(link).is_ok_and(|dest| dest == target) {
                return Ok(());
            }
            fs::remove_file(link)?;
        }
        Ok(meta) if meta.is_file() => adopt(link, target, &meta)?,
        // A directory where a file belongs is not this function's to move.
        Ok(_) => return Ok(()),
        Err(_) => {}
    }
    std::os::unix::fs::symlink(target, link)
}

/// Fold a real file at `link` into `target`. Newest wins, the only rule that
/// converges: the file is here because VS Code wrote it, either as this
/// instance's unshared history or as a save that broke the link. The loser is
/// deleted only when it says what the winner says — on the first launch after
/// sharing it is a checkout's hand-tuned settings and the only copy of them.
fn adopt(link: &Path, target: &Path, meta: &fs::Metadata) -> io::Result<()> {
    let newer = match fs::metadata(target).and_then(|t| t.modified()) {
        Ok(shared) => meta.modified()? > shared,
        Err(_) => true,
    };
    if newer {
        return fs::rename(link, target);
    }
    if fs::read(link)? == fs::read(target)? {
        return fs::remove_file(link);
    }
    let kept = superseded_name(link);
    tracing::warn!(kept = %kept.display(), "code-server.user-config.older-copy-kept");
    fs::rename(link, kept)
}

/// `settings.json` → `settings.json.superseded`, then `.superseded.1` and on:
/// never over a backup already there, because two losses in a row are two
/// different files.
fn superseded_name(link: &Path) -> PathBuf {
    let name = link.file_name().unwrap_or_default().to_string_lossy().into_owned();
    (0..)
        .map(|n| match n {
            0 => link.with_file_name(format!("{name}.superseded")),
            n => link.with_file_name(format!("{name}.superseded.{n}")),
        })
        .find(|p| !p.exists())
        .expect("the range is unbounded")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    fn touch(path: &Path, body: &str, age: Duration) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
        let file = fs::File::options().write(true).open(path).unwrap();
        file.set_modified(SystemTime::now() - age).unwrap();
    }

    #[test]
    fn a_fresh_instance_links_straight_at_the_shared_copy() {
        let dir = tempfile::tempdir().unwrap();
        let (udd, shared) = (dir.path().join("inst"), dir.path().join("shared"));
        share(&udd, &shared).unwrap();
        for name in SHARED {
            let link = udd.join("User").join(name);
            assert_eq!(fs::read_link(&link).unwrap(), shared.join(name));
        }
    }

    /// A dangling link is the expected state on a fresh machine: the seed (and
    /// VS Code) create the shared file *through* it.
    #[test]
    fn writing_through_a_dangling_link_lands_in_the_shared_file() {
        let dir = tempfile::tempdir().unwrap();
        let (udd, shared) = (dir.path().join("inst"), dir.path().join("shared"));
        share(&udd, &shared).unwrap();
        fs::write(udd.join("User").join("settings.json"), "{}").unwrap();
        assert_eq!(fs::read_to_string(shared.join("settings.json")).unwrap(), "{}");
    }

    #[test]
    fn an_instances_own_settings_seed_the_shared_copy() {
        let dir = tempfile::tempdir().unwrap();
        let (udd, shared) = (dir.path().join("inst"), dir.path().join("shared"));
        touch(&udd.join("User").join("settings.json"), r#"{"mine":1}"#, Duration::ZERO);

        share(&udd, &shared).unwrap();

        assert_eq!(fs::read_to_string(shared.join("settings.json")).unwrap(), r#"{"mine":1}"#);
        assert!(
            fs::symlink_metadata(udd.join("User").join("settings.json"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    /// The case an atomic save leaves behind: a real file over a link that was
    /// working. The newer of the two is the one the user just wrote.
    #[test]
    fn a_save_that_broke_the_link_wins_and_is_relinked() {
        let dir = tempfile::tempdir().unwrap();
        let (udd, shared) = (dir.path().join("inst"), dir.path().join("shared"));
        touch(&shared.join("settings.json"), r#"{"old":1}"#, Duration::from_secs(60));
        touch(&udd.join("User").join("settings.json"), r#"{"new":1}"#, Duration::ZERO);

        share(&udd, &shared).unwrap();

        assert_eq!(fs::read_to_string(shared.join("settings.json")).unwrap(), r#"{"new":1}"#);
        assert_eq!(
            fs::read_link(udd.join("User").join("settings.json")).unwrap(),
            shared.join("settings.json")
        );
    }

    /// The loser is this checkout's only copy of whatever it says, so it is kept
    /// beside the link rather than deleted.
    #[test]
    fn a_stale_instance_copy_gives_way_to_the_shared_one_and_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let (udd, shared) = (dir.path().join("inst"), dir.path().join("shared"));
        touch(&shared.join("settings.json"), r#"{"shared":1}"#, Duration::ZERO);
        touch(&udd.join("User").join("settings.json"), r#"{"stale":1}"#, Duration::from_secs(60));

        share(&udd, &shared).unwrap();

        assert_eq!(fs::read_to_string(shared.join("settings.json")).unwrap(), r#"{"shared":1}"#);
        assert_eq!(
            fs::read_to_string(udd.join("User").join("settings.json")).unwrap(),
            r#"{"shared":1}"#
        );
        assert_eq!(
            fs::read_to_string(udd.join("User").join("settings.json.superseded")).unwrap(),
            r#"{"stale":1}"#
        );
    }

    /// Nothing is lost by dropping a copy that says what the shared file says,
    /// and a `User/` full of backups is its own kind of mess.
    #[test]
    fn a_stale_copy_of_the_same_settings_is_just_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let (udd, shared) = (dir.path().join("inst"), dir.path().join("shared"));
        touch(&shared.join("settings.json"), r#"{"same":1}"#, Duration::ZERO);
        touch(&udd.join("User").join("settings.json"), r#"{"same":1}"#, Duration::from_secs(60));

        share(&udd, &shared).unwrap();

        assert!(!udd.join("User").join("settings.json.superseded").exists());
    }

    /// A second broken save must not land on the first one's backup.
    #[test]
    fn a_second_kept_copy_lands_beside_the_first() {
        let dir = tempfile::tempdir().unwrap();
        let (udd, shared) = (dir.path().join("inst"), dir.path().join("shared"));
        let link = udd.join("User").join("settings.json");
        for body in [r#"{"first":1}"#, r#"{"second":1}"#] {
            touch(&shared.join("settings.json"), r#"{"shared":1}"#, Duration::ZERO);
            let _ = fs::remove_file(&link);
            touch(&link, body, Duration::from_secs(60));
            share(&udd, &shared).unwrap();
        }

        let user = udd.join("User");
        assert_eq!(
            fs::read_to_string(user.join("settings.json.superseded")).unwrap(),
            r#"{"first":1}"#
        );
        assert_eq!(
            fs::read_to_string(user.join("settings.json.superseded.1")).unwrap(),
            r#"{"second":1}"#
        );
    }

    #[test]
    fn sharing_twice_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let (udd, shared) = (dir.path().join("inst"), dir.path().join("shared"));
        share(&udd, &shared).unwrap();
        fs::write(udd.join("User").join("settings.json"), r#"{"a":1}"#).unwrap();
        share(&udd, &shared).unwrap();
        assert_eq!(fs::read_to_string(shared.join("settings.json")).unwrap(), r#"{"a":1}"#);
    }
}
