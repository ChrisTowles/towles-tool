//! Dropping the code-server builds a bumped pin left behind. Installs are
//! version-scoped ([`crate::install::install_dir`]) so a new pin never lands
//! over a running server, which also means nothing replaces the old tree: each
//! bump would leak ~700 MB for good.

use std::path::{Path, PathBuf};

use crate::install::VERSION;

/// `major.minor.patch` exactly, as a release directory is named.
fn parse_version(name: &str) -> Option<(u64, u64, u64)> {
    let mut parts = name.split('.');
    let mut next = || {
        let part = parts.next()?;
        part.bytes().all(|b| b.is_ascii_digit()).then(|| part.parse().ok())?
    };
    let version = (next()?, next()?, next()?);
    parts.next().is_none().then_some(version)
}

/// Removes the installs under `root` older than [`VERSION`] that no running
/// process was started from, and the scratch of installs that died. Failures
/// are logged and never returned: a stale tree is a cost, not an error.
///
/// Only *older* versions go. Every worktree task runs its own build of the app
/// against this shared `root`, so a newer directory is one a sibling build
/// still pins; deleting it would make that build re-download 230 MB.
pub fn superseded(root: &Path) {
    let Some(listing) = process_args() else {
        tracing::warn!(reason = "ps failed", "code-server.prune.skipped");
        return;
    };
    let roots: Vec<PathBuf> =
        [Some(root.to_path_buf()), root.canonicalize().ok()].into_iter().flatten().collect();
    let in_use = |dir: &Path| {
        let version = dir.file_name().unwrap_or_default();
        roots.iter().any(|r| runs_from(&listing, &r.join(version)))
    };
    superseded_with(root, &in_use);
}

fn superseded_with(root: &Path, in_use: &dyn Fn(&Path) -> bool) {
    let Some(pinned) = parse_version(VERSION) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        // `file_type` doesn't follow links, so a symlink is neither dir nor file.
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let (path, name) = (entry.path(), entry.file_name().to_string_lossy().into_owned());
        if kind.is_dir() && parse_version(&name).is_some_and(|v| v < pinned) {
            if in_use(&path) {
                tracing::info!(version = %name, "code-server.prune.in_use");
                continue;
            }
            // `bin/` first, so a delete cut short can't leave a launchable stub.
            let _ = std::fs::remove_dir_all(path.join("bin"));
            remove(&path, &name, true);
        } else if abandoned_scratch(&name) && (kind.is_dir() || kind.is_file()) {
            remove(&path, &name, kind.is_dir());
        }
    }
}

fn remove(path: &Path, name: &str, is_dir: bool) {
    let bytes_freed = size_of(path);
    let result = if is_dir { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) };
    match result {
        Ok(()) => tracing::info!(entry = name, bytes_freed, "code-server.prune.removed"),
        Err(e) => tracing::warn!(entry = name, error = %e, "code-server.prune.failed"),
    }
}

/// Bytes under `path`, links counted as themselves and never entered.
fn size_of(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return 0;
    };
    if !meta.is_dir() {
        return meta.len();
    }
    std::fs::read_dir(path)
        .map(|entries| entries.flatten().map(|e| size_of(&e.path())).sum())
        .unwrap_or(0)
}

/// `.download-<pid>-<asset>` and `.stage-<pid>` are the installer's own scratch
/// ([`crate::install::ensure`]); one is abandoned when its pid is gone. Another
/// instance's live install is left alone.
fn abandoned_scratch(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(".download-").or_else(|| name.strip_prefix(".stage-"))
    else {
        return false;
    };
    let pid = rest.split('-').next().and_then(|p| p.parse::<u32>().ok());
    pid.is_some_and(|pid| pid != std::process::id() && !pid_alive(pid))
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return true;
    };
    // SAFETY: signal 0 only checks that the pid exists and may be signalled.
    let gone = unsafe { libc::kill(pid, 0) } == -1
        && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
    !gone
}

#[cfg(not(unix))]
fn pid_alive(_pid: u32) -> bool {
    true
}

/// Every process's command line, one per line — the install's launcher `exec`s
/// `<dist>/lib/node <dist>`, so a server shows up under its dist path whichever
/// app instance started it. `None` when `ps` can't say, which stops the prune.
fn process_args() -> Option<String> {
    let out = tt_exec::run("ps", &["-axww", "-o", "args="]).ok().filter(|o| o.ok())?;
    Some(out.stdout)
}

/// Whether any line of `listing` names `dir` as a whole path component, so
/// `…/4.13.0` does not match a server running from `…/4.13.0-rc/`.
fn runs_from(listing: &str, dir: &Path) -> bool {
    let dir = dir.to_string_lossy();
    listing.match_indices(dir.as_ref()).any(|(at, hit)| {
        listing[at + hit.len()..].chars().next().is_none_or(|c| c == '/' || c.is_whitespace())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(root: &Path, rel: &str) -> PathBuf {
        let bin = root.join(rel).join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("code-server"), "#!/bin/sh\n").unwrap();
        root.join(rel)
    }

    fn never(_: &Path) -> bool {
        false
    }

    #[test]
    fn only_three_numeric_parts_parse_as_a_version() {
        assert_eq!(parse_version("4.133.0"), Some((4, 133, 0)));
        for name in [
            "4.133",
            "4.133.0.1",
            "v4.133.0",
            "4.133.0-rc1",
            "4..0",
            "4.x.0",
            "",
            "+4.1.0",
        ] {
            assert_eq!(parse_version(name), None, "{name}");
        }
    }

    #[test]
    fn an_older_install_goes_and_the_pin_stays() {
        let root = tempfile::tempdir().unwrap();
        let old = tree(root.path(), "4.133.0");
        let pinned = tree(root.path(), VERSION);
        superseded_with(root.path(), &never);
        assert!(!old.exists());
        assert!(pinned.join("bin").join("code-server").is_file());
    }

    #[test]
    fn a_newer_install_is_a_sibling_builds_pin_and_stays() {
        let root = tempfile::tempdir().unwrap();
        let newer = tree(root.path(), "99.0.0");
        superseded_with(root.path(), &never);
        assert!(newer.exists());
    }

    #[test]
    fn entries_that_are_not_a_version_directory_are_untouched() {
        let root = tempfile::tempdir().unwrap();
        let dirs = [
            "notes",
            "4.100",
            "4.100.0.bak",
            "v4.100.0",
            ".stage-notapid",
        ];
        for d in dirs {
            tree(root.path(), d);
        }
        let file = root.path().join("4.100.1");
        std::fs::write(&file, "not a directory").unwrap();
        superseded_with(root.path(), &never);
        for d in dirs {
            assert!(root.path().join(d).is_dir(), "{d}");
        }
        assert!(file.is_file());
    }

    #[test]
    fn a_symlink_named_like_an_old_version_is_not_followed() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let precious = outside.path().join("precious");
        std::fs::write(&precious, "keep").unwrap();
        let link = root.path().join("4.100.0");
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();

        // And one inside a tree that does get removed.
        let old = tree(root.path(), "4.133.0");
        std::os::unix::fs::symlink(outside.path(), old.join("lib")).unwrap();

        superseded_with(root.path(), &never);
        assert!(precious.is_file());
        assert!(link.symlink_metadata().unwrap().is_symlink());
        assert!(!old.exists());
    }

    #[test]
    fn an_install_a_process_is_running_from_is_skipped() {
        let root = tempfile::tempdir().unwrap();
        let busy = tree(root.path(), "4.133.0");
        let idle = tree(root.path(), "4.100.0");
        superseded_with(root.path(), &|dir| dir == busy);
        assert!(busy.join("bin").join("code-server").is_file());
        assert!(!idle.exists());
    }

    #[test]
    fn a_dist_path_matches_only_on_a_component_boundary() {
        let dir = Path::new("/d/4.13.0");
        assert!(runs_from("/d/4.13.0/lib/node /d/4.13.0 --bind-addr x", dir));
        assert!(runs_from("node /d/4.13.0", dir));
        assert!(!runs_from("node /d/4.13.0-rc/lib/node", dir));
        assert!(!runs_from("node /d/4.13.01/lib/node", dir));
        assert!(!runs_from("node /e/4.13.0/lib/node", dir));
    }

    #[test]
    fn scratch_is_removed_only_once_its_installer_is_gone() {
        let root = tempfile::tempdir().unwrap();
        let mut dead = std::process::Command::new("true").spawn().unwrap();
        dead.wait().unwrap();
        let (own, parent) = (std::process::id(), std::os::unix::process::parent_id());

        let gone_stage = tree(root.path(), &format!(".stage-{}", dead.id()));
        let gone_download = root.path().join(format!(".download-{}-code-server.tar.gz", dead.id()));
        std::fs::write(&gone_download, "partial").unwrap();
        let own_stage = tree(root.path(), &format!(".stage-{own}"));
        let live_download = root.path().join(format!(".download-{parent}-code-server.tar.gz"));
        std::fs::write(&live_download, "partial").unwrap();

        superseded_with(root.path(), &never);
        assert!(!gone_stage.exists());
        assert!(!gone_download.exists());
        assert!(own_stage.exists());
        assert!(live_download.exists());
    }

    /// The real `ps`: the test binary running right now must show up under its own path.
    #[test]
    fn the_process_listing_sees_a_running_binary() {
        let listing = process_args().expect("ps unavailable");
        assert!(runs_from(&listing, &std::env::current_exe().unwrap()));
    }

    #[test]
    fn a_root_that_does_not_exist_is_not_an_error() {
        let root = tempfile::tempdir().unwrap();
        superseded_with(&root.path().join("never-created"), &never);
    }

    #[test]
    fn size_counts_files_and_leaves_links_alone() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("big"), vec![0u8; 4096]).unwrap();
        let dir = root.path().join("tree");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a"), vec![0u8; 10]).unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.join("link")).unwrap();
        assert!(size_of(&dir) < 4096);
        assert!(size_of(&dir) >= 10);
    }
}
