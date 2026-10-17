//! Decisions the diagnostics hub makes about its checker subprocesses, kept
//! pure so they test without spawning anything: which `tsc` to run, and
//! whether a finished run failed without telling anyone.

use std::path::{Path, PathBuf};

/// The project's own `tsc`: `node_modules/.bin/tsc` in `project` or the nearest
/// ancestor up to and including `stop_root` (a monorepo hoists it to the
/// workspace root). `None` when there isn't one — the caller must not fall back
/// to `npx tsc`, which fetches the unrelated `tsc` npm package ("This is not the
/// tsc command you are looking for") and checks nothing.
pub fn resolve_tsc(project: &Path, stop_root: &Path) -> Option<PathBuf> {
    for dir in project.ancestors() {
        let candidate = dir.join("node_modules/.bin/tsc");
        if candidate.is_file() {
            return Some(candidate);
        }
        if dir == stop_root {
            break;
        }
    }
    None
}

/// A checker that exited non-zero yet produced no diagnostics failed for a
/// reason the wire can't show (stale build cache, broken toolchain) — as opposed
/// to a non-zero exit *with* diagnostics, which is just the code having errors.
pub fn is_silent_failure(exit_code: i32, diagnostic_count: usize) -> bool {
    exit_code != 0 && diagnostic_count == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch_tsc(dir: &Path) -> PathBuf {
        let bin = dir.join("node_modules/.bin");
        std::fs::create_dir_all(&bin).unwrap();
        let tsc = bin.join("tsc");
        std::fs::write(&tsc, "").unwrap();
        tsc
    }

    #[test]
    fn finds_a_local_install() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("apps/client");
        let tsc = touch_tsc(&project);
        assert_eq!(resolve_tsc(&project, tmp.path()), Some(tsc));
    }

    #[test]
    fn finds_an_install_hoisted_to_the_folder_root() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("packages/web");
        std::fs::create_dir_all(&project).unwrap();
        let tsc = touch_tsc(tmp.path());
        assert_eq!(resolve_tsc(&project, tmp.path()), Some(tsc));
    }

    #[test]
    fn nearest_install_wins() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("web");
        touch_tsc(tmp.path());
        let local = touch_tsc(&project);
        assert_eq!(resolve_tsc(&project, tmp.path()), Some(local));
    }

    #[test]
    fn none_when_absent() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(resolve_tsc(tmp.path(), tmp.path()), None);
    }

    #[test]
    fn does_not_walk_above_the_folder_root() {
        let tmp = tempfile::tempdir().unwrap();
        touch_tsc(tmp.path());
        let root = tmp.path().join("repo");
        let project = root.join("app");
        std::fs::create_dir_all(&project).unwrap();
        assert_eq!(resolve_tsc(&project, &root), None);
    }

    #[test]
    fn a_failed_run_with_nothing_to_show_is_silent() {
        assert!(is_silent_failure(101, 0));
        assert!(is_silent_failure(-1, 0));
        assert!(!is_silent_failure(1, 3), "errors in the code are the checker working");
        assert!(!is_silent_failure(0, 0));
    }
}
