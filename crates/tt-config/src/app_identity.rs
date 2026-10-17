//! The desktop app's identifier, and the host paths that identifier owns.
//!
//! Each task build patches its Tauri identifier to `<base>.task-<name>`, and on Linux that
//! one string names three things on disk outside any checkout: the WebKit data dir, the
//! launcher entry and its icon. Task teardown can only reclaim them if it can compute the
//! same paths the app wrote, so the derivation lives here, not in `tt-app`.

use std::path::{Path, PathBuf};

use crate::checkout_root_from_dir;
use crate::paths::main_checkout_of;

/// The daily driver's identifier (`tauri.conf.json`), and the base every task's extends.
pub const APP_IDENTIFIER: &str = "dev.towles.tool";

const TASK_SEGMENT: &str = ".task-";
/// The pre-rename spelling of [`TASK_SEGMENT`]; no build writes it any more.
const SLOT_SEGMENT: &str = ".slot-";

/// A task build's manifest dir is `<repo>/.claude/worktrees/<task>/crates-tauri/tt-app`
/// — ancestors 3/4 are the worktrees/.claude segments exactly then.
pub fn is_task_manifest_dir(manifest_dir: &Path) -> bool {
    manifest_dir.ancestors().nth(3).and_then(|p| p.file_name())
        == Some(std::ffi::OsStr::new("worktrees"))
        && manifest_dir.ancestors().nth(4).and_then(|p| p.file_name())
            == Some(std::ffi::OsStr::new(".claude"))
}

/// The repo-root directory name, two ancestors up from the manifest dir.
pub fn label_from_manifest_dir(manifest_dir: &Path) -> String {
    manifest_dir
        .ancestors()
        .nth(2)
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("towles-tool")
        .to_string()
}

/// `base.task-<name>`, folded to lowercase with non-alphanumerics as `-` so it is a
/// legal reverse-DNS segment.
pub fn task_app_identifier(base: &str, task_name: &str) -> String {
    let suffix: String = task_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    format!("{base}{TASK_SEGMENT}{suffix}")
}

/// A task build gets [`task_app_identifier`]; any other build keeps `base`.
pub fn app_identifier_from(manifest_dir: &Path, base: &str) -> String {
    if !is_task_manifest_dir(manifest_dir) {
        return base.to_string();
    }
    task_app_identifier(base, &label_from_manifest_dir(manifest_dir))
}

/// The identifier of the app built from the task worktree `dir`, or `None` when `dir` is
/// not a task of this repo — other repos' tasks never build this app. Probes the disk, so
/// call it before the worktree is removed.
pub fn task_app_identifier_for_dir(dir: &Path) -> Option<String> {
    let root = checkout_root_from_dir(dir)?;
    main_checkout_of(&root)?;
    let name = root.file_name()?.to_str()?;
    Some(task_app_identifier(APP_IDENTIFIER, name))
}

/// What one identifier owns outside any checkout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostPaths {
    /// WebKit's data dir: localStorage, caches, cookies.
    pub webkit_data: PathBuf,
    /// The `.desktop` launcher `tt-app` self-installs.
    pub launcher: PathBuf,
    /// The launcher's 512px icon.
    pub icon: PathBuf,
}

impl HostPaths {
    pub fn all(&self) -> [&Path; 3] {
        [&self.webkit_data, &self.launcher, &self.icon]
    }
}

/// `identifier`'s host paths under the user data dir `data_local` — the layout WebKit and
/// `tt-app`'s `linux_desktop` both write.
pub fn host_paths_in(data_local: &Path, identifier: &str) -> HostPaths {
    HostPaths {
        webkit_data: data_local.join(identifier),
        launcher: data_local.join("applications").join(format!("{identifier}.desktop")),
        icon: data_local.join("icons/hicolor/512x512/apps").join(format!("{identifier}.png")),
    }
}

/// The user data dir the host paths hang off. Linux only: macOS keeps WebKit data under
/// `~/Library/WebKit` and has no launcher entries, which nothing here has verified.
pub fn host_data_dir() -> Option<PathBuf> {
    if cfg!(target_os = "linux") { dirs::data_local_dir() } else { None }
}

/// [`host_paths_in`] under [`host_data_dir`].
pub fn host_paths(identifier: &str) -> Option<HostPaths> {
    host_data_dir().map(|dir| host_paths_in(&dir, identifier))
}

/// Whether `identifier` is a per-task one (`<base>.task-<x>` or the pre-rename
/// `<base>.slot-<x>`). The base identifier itself never is.
pub fn is_per_task_identifier(identifier: &str) -> bool {
    [TASK_SEGMENT, SLOT_SEGMENT].iter().any(|segment| {
        identifier
            .strip_prefix(APP_IDENTIFIER)
            .and_then(|rest| rest.strip_prefix(segment))
            .is_some_and(|name| !name.is_empty())
    })
}

/// Every per-task identifier with something under `data_local`, sorted and deduplicated.
pub fn per_task_identifiers_in(data_local: &Path) -> Vec<String> {
    let names = |dir: PathBuf, suffix: &str| -> Vec<String> {
        std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .filter_map(|n| n.strip_suffix(suffix).map(str::to_string))
            .collect()
    };
    let mut found: Vec<String> = [
        names(data_local.to_path_buf(), ""),
        names(data_local.join("applications"), ".desktop"),
        names(data_local.join("icons/hicolor/512x512/apps"), ".png"),
    ]
    .concat();
    found.retain(|id| is_per_task_identifier(id));
    found.sort();
    found.dedup();
    found
}

/// The identifiers the live task names must keep: both spellings, so a leftover
/// `slot-` entry of a worktree that still exists is never mistaken for an orphan.
pub fn live_identifiers<'a>(names: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    names
        .into_iter()
        .flat_map(|name| {
            let task = task_app_identifier(APP_IDENTIFIER, name);
            let slot = task.replacen(TASK_SEGMENT, SLOT_SEGMENT, 1);
            [task, slot]
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TASK_MANIFEST: &str = "/home/u/repo/.claude/worktrees/feat-thing/crates-tauri/tt-app";

    #[test]
    fn label_is_the_repo_root_two_ancestors_up() {
        assert_eq!(
            label_from_manifest_dir(Path::new("/home/u/code/primary/crates-tauri/tt-app")),
            "primary"
        );
        assert_eq!(label_from_manifest_dir(Path::new(TASK_MANIFEST)), "feat-thing");
    }

    #[test]
    fn label_falls_back_when_the_path_is_too_shallow() {
        assert_eq!(label_from_manifest_dir(Path::new("/tt-app")), "towles-tool");
    }

    #[test]
    fn task_detection_requires_the_claude_worktrees_nesting() {
        assert!(is_task_manifest_dir(Path::new(TASK_MANIFEST)));
        assert!(!is_task_manifest_dir(Path::new("/home/u/code/primary/crates-tauri/tt-app")));
        assert!(!is_task_manifest_dir(Path::new(
            "/home/u/repo/worktrees/feat-thing/crates-tauri/tt-app"
        )));
    }

    #[test]
    fn identifier_stays_unscoped_for_a_main_checkout() {
        let dir = Path::new("/home/u/code/primary/crates-tauri/tt-app");
        assert_eq!(app_identifier_from(dir, APP_IDENTIFIER), APP_IDENTIFIER);
    }

    #[test]
    fn identifier_is_task_scoped_and_sanitized_under_worktrees() {
        assert_eq!(
            app_identifier_from(Path::new(TASK_MANIFEST), APP_IDENTIFIER),
            "dev.towles.tool.task-feat-thing"
        );
        assert_eq!(
            app_identifier_from(
                Path::new("/home/u/repo/.claude/worktrees/Chore_Repo.Audit/crates-tauri/tt-app"),
                APP_IDENTIFIER
            ),
            "dev.towles.tool.task-chore-repo-audit"
        );
    }

    #[test]
    fn task_identifier_matches_the_manifest_derivation() {
        assert_eq!(
            task_app_identifier(APP_IDENTIFIER, "Chore_Repo.Audit"),
            app_identifier_from(
                Path::new("/r/.claude/worktrees/Chore_Repo.Audit/crates-tauri/tt-app"),
                APP_IDENTIFIER
            )
        );
    }

    #[test]
    fn base_identifier_matches_tauri_conf() {
        let conf = include_str!("../../../crates-tauri/tt-app/tauri.conf.json");
        let conf: serde_json::Value = serde_json::from_str(conf).unwrap();
        assert_eq!(conf["identifier"], APP_IDENTIFIER);
    }

    #[test]
    fn dir_identifier_needs_a_task_of_this_repo() {
        let tmp = tempfile::tempdir().unwrap();
        let task = tmp.path().join("repo/.claude/worktrees/Feat_X");
        std::fs::create_dir_all(task.join("crates/tt-config")).unwrap();
        assert_eq!(
            task_app_identifier_for_dir(&task).as_deref(),
            Some("dev.towles.tool.task-feat-x")
        );

        let other = tmp.path().join("other/.claude/worktrees/feat-y");
        std::fs::create_dir_all(&other).unwrap();
        assert_eq!(task_app_identifier_for_dir(&other), None, "another repo's task");

        let main = tmp.path().join("repo2");
        std::fs::create_dir_all(main.join("crates/tt-config")).unwrap();
        assert_eq!(task_app_identifier_for_dir(&main), None, "the main checkout is the base");
    }

    #[test]
    fn host_paths_follow_webkit_and_linux_desktop_layout() {
        let paths = host_paths_in(Path::new("/d"), "dev.towles.tool.task-x");
        assert_eq!(paths.webkit_data, Path::new("/d/dev.towles.tool.task-x"));
        assert_eq!(paths.launcher, Path::new("/d/applications/dev.towles.tool.task-x.desktop"));
        assert_eq!(
            paths.icon,
            Path::new("/d/icons/hicolor/512x512/apps/dev.towles.tool.task-x.png")
        );
    }

    #[test]
    fn per_task_identifiers_exclude_the_base_and_strangers() {
        assert!(is_per_task_identifier("dev.towles.tool.task-a"));
        assert!(is_per_task_identifier("dev.towles.tool.slot-a"));
        assert!(!is_per_task_identifier(APP_IDENTIFIER));
        assert!(!is_per_task_identifier("dev.towles.tool.task-"));
        assert!(!is_per_task_identifier("dev.towles.toolbox.task-a"));
        assert!(!is_per_task_identifier("dev.other.tool.task-a"));
    }

    #[test]
    fn listing_unions_all_three_locations() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path();
        for id in [
            "dev.towles.tool",
            "dev.towles.tool.task-a",
            "dev.towles.tool.slot-b",
        ] {
            std::fs::create_dir_all(data.join(id)).unwrap();
        }
        let write = |path: PathBuf| {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "x").unwrap();
        };
        write(host_paths_in(data, "dev.towles.tool.task-c").launcher);
        write(host_paths_in(data, "dev.towles.tool.task-d").icon);
        write(host_paths_in(data, "dev.towles.tool").launcher);
        write(data.join("applications/unrelated.desktop"));

        assert_eq!(
            per_task_identifiers_in(data),
            [
                "dev.towles.tool.slot-b",
                "dev.towles.tool.task-a",
                "dev.towles.tool.task-c",
                "dev.towles.tool.task-d",
            ]
        );
    }

    #[test]
    fn live_identifiers_cover_both_spellings() {
        assert_eq!(
            live_identifiers(["Feat_X"]),
            ["dev.towles.tool.task-feat-x", "dev.towles.tool.slot-feat-x"]
        );
    }
}
