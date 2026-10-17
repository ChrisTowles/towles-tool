//! What the app keeps on disk, for the Doctor screen's "State on disk" panel:
//! the size of each top-level entry under the state root, which `tasks/<scope>`
//! dirs belong to no checkout, and how many per-task app-data dirs outlived
//! their task. Read-only — nothing here removes anything; `tt task clean` does.
//!
//! Every root is a parameter. Only [`crate::run_disk_report`] resolves the real
//! ones, so a test can never point this at the user's data.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;

/// A 2 GB tree of small files takes seconds cold; past this the rest is reported
/// as "at least" rather than holding the panel.
pub const SIZING_BUDGET: Duration = Duration::from_secs(8);

/// Entries between clock reads while walking.
const CLOCK_EVERY: u32 = 256;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskEntry {
    pub name: String,
    pub bytes: u64,
    /// The walk ran out of budget, so `bytes` is a floor.
    pub partial: bool,
}

/// One `tasks/<scope>` dir.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeEntry {
    pub name: String,
    pub path: String,
    pub bytes: u64,
    pub partial: bool,
    /// No known checkout maps to this scope, so nothing will read it again.
    pub orphan: bool,
}

/// Per-task app-data (`dev.towles.tool.{task,slot}-*`) whose task is gone.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostResidue {
    pub count: usize,
    pub bytes: u64,
    pub partial: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskReport {
    pub root: String,
    /// Largest first.
    pub entries: Vec<DiskEntry>,
    pub scopes: Vec<ScopeEntry>,
    pub residue: HostResidue,
    pub total_bytes: u64,
    pub partial: bool,
}

pub struct DiskScan<'a> {
    pub state_root: &'a Path,
    /// The user data dir the per-task app identifiers live under; `None` skips residue.
    pub host_data: Option<&'a Path>,
    /// Main checkouts that exist; their tasks are found from them.
    pub checkouts: &'a [PathBuf],
    pub budget: Duration,
}

/// The scopes and task names the known checkouts own. Scopes come from
/// `tt_config::task_scope_from_dir` and tasks from `TaskRoot::tasks`, the same
/// two resolvers the app uses to write and to list them.
fn live_checkouts(checkouts: &[PathBuf]) -> (BTreeSet<String>, BTreeSet<String>) {
    let mut scopes = BTreeSet::new();
    let mut names = BTreeSet::new();
    let mut seen = BTreeSet::new();
    for checkout in checkouts {
        // `discover_root` walks up to any ancestor repo, so a path that is gone
        // must not resolve to whatever contains it.
        if !checkout.is_dir() {
            continue;
        }
        let Ok(root) = tt_tasks::discover_root(Some(checkout)) else {
            continue;
        };
        if !seen.insert(root.checkout.clone()) {
            continue;
        }
        scopes.extend(tt_config::task_scope_from_dir(&root.checkout));
        for (name, dir) in root.tasks() {
            scopes.extend(tt_config::task_scope_from_dir(&dir));
            names.insert(name);
        }
    }
    (scopes, names)
}

pub fn scan(scan: &DiskScan) -> DiskReport {
    let (live_scopes, live_names) = live_checkouts(scan.checkouts);
    let mut sizer = Sizer::new(scan.budget);

    let mut entries = Vec::new();
    let mut scopes = Vec::new();
    for entry in sorted_children(scan.state_root) {
        let name = entry.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        if name == tt_config::SCOPE_DIR && entry.is_dir() {
            let (disk, found) = size_scopes(&entry, &live_scopes, &mut sizer);
            scopes = found;
            entries.push(DiskEntry { name, ..disk });
        } else {
            let (bytes, partial) = sizer.tree(&entry);
            entries.push(DiskEntry { name, bytes, partial });
        }
    }
    entries.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.name.cmp(&b.name)));
    scopes.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.name.cmp(&b.name)));

    let residue = scan.host_data.map(|dir| host_residue(dir, &live_names, &mut sizer));
    DiskReport {
        root: scan.state_root.display().to_string(),
        total_bytes: entries.iter().map(|e| e.bytes).sum(),
        partial: sizer.expired,
        entries,
        scopes,
        residue: residue.unwrap_or_default(),
    }
}

/// `tasks/` is sized per scope so each can be judged; its own row is their sum
/// plus anything loose beside them.
fn size_scopes(
    tasks_dir: &Path,
    live: &BTreeSet<String>,
    sizer: &mut Sizer,
) -> (DiskEntry, Vec<ScopeEntry>) {
    let mut total = DiskEntry { name: String::new(), bytes: 0, partial: false };
    let mut scopes = Vec::new();
    for path in sorted_children(tasks_dir) {
        let (bytes, partial) = sizer.tree(&path);
        total.bytes += bytes;
        total.partial |= partial;
        if !path.is_dir() {
            continue;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        scopes.push(ScopeEntry {
            orphan: !live.contains(&name),
            path: path.display().to_string(),
            name,
            bytes,
            partial,
        });
    }
    (total, scopes)
}

/// The identifiers `tt task clean` would sweep, judged by its own helpers.
fn host_residue(host_data: &Path, live_names: &BTreeSet<String>, sizer: &mut Sizer) -> HostResidue {
    let live: BTreeSet<String> =
        tt_config::live_identifiers(live_names.iter().map(String::as_str)).into_iter().collect();
    let on_disk = tt_config::per_task_identifiers_in(host_data);
    let stale = tt_tasks::clean::stale_host_identifiers(&on_disk, &live);

    let mut residue = HostResidue { count: stale.len(), ..HostResidue::default() };
    for identifier in &stale {
        for path in tt_config::host_paths_in(host_data, identifier).all() {
            let (bytes, partial) = sizer.tree(path);
            residue.bytes += bytes;
            residue.partial |= partial;
        }
    }
    residue
}

fn sorted_children(dir: &Path) -> Vec<PathBuf> {
    let mut children: Vec<PathBuf> =
        fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).collect();
    children.sort();
    children
}

/// Sizes trees against one shared deadline. Symlinks count as themselves and are
/// never followed; a file with several hard links counts once across the whole
/// scan, as `du` does, since WebKit data dirs share most of theirs.
struct Sizer {
    deadline: Instant,
    seen_links: BTreeSet<(u64, u64)>,
    expired: bool,
}

impl Sizer {
    fn new(budget: Duration) -> Self {
        Self { deadline: Instant::now() + budget, seen_links: BTreeSet::new(), expired: false }
    }

    /// `(bytes, partial)`; unreadable entries count as zero. Once the budget is
    /// spent every later tree comes back `(0, true)` without a read.
    fn tree(&mut self, root: &Path) -> (u64, bool) {
        if self.expired {
            return (0, true);
        }
        let mut bytes = 0;
        let mut stack = vec![root.to_path_buf()];
        let mut ticks = 0u32;
        while let Some(path) = stack.pop() {
            ticks += 1;
            if ticks.is_multiple_of(CLOCK_EVERY) && Instant::now() >= self.deadline {
                self.expired = true;
                return (bytes, true);
            }
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.is_dir() {
                stack.extend(fs::read_dir(&path).into_iter().flatten().flatten().map(|e| e.path()));
            } else if self.first_sight(&meta) {
                bytes += meta.len();
            }
        }
        (bytes, false)
    }

    #[cfg(unix)]
    fn first_sight(&mut self, meta: &fs::Metadata) -> bool {
        use std::os::unix::fs::MetadataExt as _;
        meta.nlink() <= 1 || self.seen_links.insert((meta.dev(), meta.ino()))
    }

    #[cfg(not(unix))]
    fn first_sight(&mut self, _meta: &fs::Metadata) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, bytes: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, vec![b'x'; bytes]).unwrap();
    }

    /// A checkout of this repo: a `.git` dir and the `crates/tt-config` marker that
    /// makes `tt_config` hand it a scope.
    fn checkout(dir: &Path) {
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::create_dir_all(dir.join("crates/tt-config")).unwrap();
    }

    struct Fixture {
        _tmp: tempfile::TempDir,
        state: PathBuf,
        host: PathBuf,
        main: PathBuf,
    }

    /// `towles-tool` with one live task; state holds its two scopes, two orphans and a
    /// non-task entry; host data holds the base, a live and two dead identifiers.
    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("towles-tool");
        checkout(&main);
        checkout(&main.join(".claude/worktrees/feat-live"));
        fs::write(main.join(".claude/worktrees/feat-live/.git"), "gitdir: nowhere").ok();

        let state = tmp.path().join("share/towles-tool");
        write(&state.join("chrome-profile/Default/Cookies"), 1000);
        write(&state.join("tasks/towles-tool/tt.db"), 300);
        write(&state.join("tasks/towles-tool-feat-live/tt.db"), 200);
        write(&state.join("tasks/smoke/tt.db"), 40);
        write(&state.join("tasks/towles-tool-feat-gone/a/b/tt.db"), 60);
        write(&state.join("tasks/stray.txt"), 5);

        let host = tmp.path().join("share");
        write(&host.join("dev.towles.tool/cache"), 7);
        write(&host.join("dev.towles.tool.task-feat-live/cache"), 11);
        write(&host.join("dev.towles.tool.task-feat-gone/cache"), 13);
        write(&host.join("dev.towles.tool.slot-old/cache"), 17);
        write(&host.join("applications/dev.towles.tool.task-feat-gone.desktop"), 19);
        Fixture { _tmp: tmp, state, host, main }
    }

    fn run(f: &Fixture, budget: Duration) -> DiskReport {
        scan(&DiskScan {
            state_root: &f.state,
            host_data: Some(&f.host),
            checkouts: std::slice::from_ref(&f.main),
            budget,
        })
    }

    fn tree_listing(dir: &Path) -> Vec<String> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(path) = stack.pop() {
            out.push(path.display().to_string());
            if path.is_dir() {
                stack.extend(sorted_children(&path));
            }
        }
        out.sort();
        out
    }

    #[test]
    fn sizes_each_top_level_entry_largest_first() {
        let f = fixture();
        let report = run(&f, SIZING_BUDGET);
        let rows: Vec<_> = report.entries.iter().map(|e| (e.name.as_str(), e.bytes)).collect();
        assert_eq!(rows, vec![("chrome-profile", 1000), ("tasks", 605)]);
        assert_eq!(report.total_bytes, 1605);
        assert!(!report.partial);
    }

    #[test]
    fn a_scope_is_orphan_when_no_known_checkout_maps_to_it() {
        let f = fixture();
        let report = run(&f, SIZING_BUDGET);
        let orphans: Vec<_> =
            report.scopes.iter().filter(|s| s.orphan).map(|s| s.name.as_str()).collect();
        let live: Vec<_> =
            report.scopes.iter().filter(|s| !s.orphan).map(|s| s.name.as_str()).collect();
        assert_eq!(orphans, vec!["towles-tool-feat-gone", "smoke"]);
        assert_eq!(live, vec!["towles-tool", "towles-tool-feat-live"]);
        let gone = report.scopes.iter().find(|s| s.name == "towles-tool-feat-gone").unwrap();
        assert_eq!(gone.bytes, 60);
        assert!(gone.path.ends_with("tasks/towles-tool-feat-gone"));
    }

    #[test]
    fn counts_app_data_whose_task_is_gone_but_not_the_base_or_live_ones() {
        let f = fixture();
        let residue = run(&f, SIZING_BUDGET).residue;
        assert_eq!(residue.count, 2);
        assert_eq!(residue.bytes, 13 + 17 + 19);
    }

    #[test]
    fn no_host_data_dir_means_no_residue() {
        let f = fixture();
        let report = scan(&DiskScan {
            state_root: &f.state,
            host_data: None,
            checkouts: std::slice::from_ref(&f.main),
            budget: SIZING_BUDGET,
        });
        assert_eq!(report.residue.count, 0);
    }

    #[test]
    fn with_no_known_checkout_every_scope_is_an_orphan() {
        let f = fixture();
        let report = scan(&DiskScan {
            state_root: &f.state,
            host_data: None,
            checkouts: &[],
            budget: SIZING_BUDGET,
        });
        assert!(report.scopes.iter().all(|s| s.orphan));
    }

    #[test]
    fn a_checkout_that_is_gone_is_skipped() {
        let f = fixture();
        let missing = f.main.join("nope");
        let report = scan(&DiskScan {
            state_root: &f.state,
            host_data: None,
            checkouts: &[missing],
            budget: SIZING_BUDGET,
        });
        assert!(report.scopes.iter().all(|s| s.orphan));
    }

    #[test]
    fn scanning_deletes_nothing() {
        let f = fixture();
        let before = (tree_listing(&f.state), tree_listing(&f.host));
        run(&f, SIZING_BUDGET);
        assert_eq!(before, (tree_listing(&f.state), tree_listing(&f.host)));
    }

    #[test]
    fn a_spent_budget_marks_a_big_tree_partial() {
        let f = fixture();
        let big = f.state.join("chrome-profile/many");
        for i in 0..(CLOCK_EVERY as usize * 3) {
            write(&big.join(format!("f{i}")), 1);
        }
        let report = run(&f, Duration::ZERO);
        assert!(report.partial);
        assert!(report.entries.iter().any(|e| e.partial));
    }

    #[test]
    fn a_tree_too_small_to_reach_the_clock_is_never_partial() {
        let f = fixture();
        assert!(!run(&f, Duration::ZERO).partial);
    }

    #[test]
    fn a_missing_state_root_is_an_empty_report() {
        let f = fixture();
        let report = scan(&DiskScan {
            state_root: &f.state.join("absent"),
            host_data: None,
            checkouts: &[],
            budget: SIZING_BUDGET,
        });
        assert!(report.entries.is_empty() && report.scopes.is_empty());
        assert_eq!(report.total_bytes, 0);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_count_as_themselves_and_hard_links_once() {
        let f = fixture();
        let outside = f._tmp.path().join("outside");
        write(&outside.join("big"), 5000);
        std::os::unix::fs::symlink(&outside, f.state.join("chrome-profile/link")).unwrap();
        fs::hard_link(
            f.state.join("chrome-profile/Default/Cookies"),
            f.state.join("chrome-profile/Cookies2"),
        )
        .unwrap();
        let report = run(&f, SIZING_BUDGET);
        let chrome = report.entries.iter().find(|e| e.name == "chrome-profile").unwrap();
        let link_len = fs::symlink_metadata(f.state.join("chrome-profile/link")).unwrap().len();
        assert_eq!(chrome.bytes, 1000 + link_len);
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_dir_is_skipped_not_fatal() {
        use std::os::unix::fs::PermissionsExt as _;
        let f = fixture();
        let locked = f.state.join("chrome-profile/locked");
        write(&locked.join("secret"), 500);
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        let report = run(&f, SIZING_BUDGET);
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        let chrome = report.entries.iter().find(|e| e.name == "chrome-profile").unwrap();
        // 1000 readable bytes, plus the 500 only when running as a user the mode doesn't bind.
        assert!(chrome.bytes == 1000 || chrome.bytes == 1500);
    }
}
