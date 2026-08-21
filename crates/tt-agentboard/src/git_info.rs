//! Branch / worktree / diff-stat computation with a short cache.
//!
//! The git reads and the TTL cache with stale-serve + explicit invalidation.
//! Transport and watcher concerns — the poll, the `.git/HEAD` watch, the event
//! broadcast — belong to the Tauri layer. Time is injected via `now_ms`.

use std::collections::HashMap;
use std::collections::HashSet;

use serde::{Deserialize, Serialize};

/// Working-tree/commit stats for a session directory, all measured against the same
/// `compared_base` (see [`resolve_base_ref`]).
///
/// **The committed and uncommitted diffs are separate quantities and are never
/// summed.** `uncommitted_*` counts staged and unstaged together, which is why
/// `staged_*` (HEAD vs index) exists — that is what lets the diff pane's refresh key
/// see a `git add`. The `#[serde(skip)]` tail is revalidation state: each `*_key`
/// fingerprints what one half of [`compute_git_info`] reads.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct GitInfo {
    pub branch: String,
    pub is_worktree: bool,
    pub committed_files: i64,
    pub committed_added: i64,
    pub committed_removed: i64,
    /// Untracked files count here, with no line counts.
    pub uncommitted_files: i64,
    pub uncommitted_added: i64,
    pub uncommitted_removed: i64,
    /// `uncommitted_files` is a floor — a collapsed untracked directory.
    #[serde(default)]
    pub uncommitted_capped: bool,
    #[serde(default)]
    pub staged_files: i64,
    #[serde(default)]
    pub staged_added: i64,
    #[serde(default)]
    pub staged_removed: i64,
    pub commits_ahead: i64,
    /// Separate from `commits_ahead`, so "3 ahead, 2 behind" isn't a "+1".
    pub commits_behind: i64,
    /// Exactly `uncommitted_files > 0`, so the two can't disagree on screen. Not
    /// `status().is_dirty()`, which reports a reverted edit off a stale stat cache.
    pub dirty: bool,
    /// Of `commits_ahead`, how many hold changes `compared_base` never received, so
    /// this drops to 0 after a rebase *or* squash merge, via [`tt_tasks::landed`].
    pub commits_unlanded: i64,
    /// How this branch's work reached `compared_base` — `"merged"`, `"rebase-merged"`,
    /// `"squash-merged"`, `"upstream gone"` — or `None` when it has not fully landed.
    pub landed: Option<String>,
    /// Display-only — NOT the rail's nesting key; two clones can share an origin.
    pub origin_url: Option<String>,
    /// Canonicalized `--git-common-dir` — what [`crate::bridge::assemble_state`] groups
    /// rail rows by, so only *actual* worktrees nest together.
    pub common_dir: String,
    pub linked_worktree_dirs: Vec<String>,
    /// When these numbers were last *verified*: from the UI a correct, unchanging
    /// number is otherwise indistinguishable from a wedged poll.
    pub computed_at_ms: i64,
    /// Epoch ms of `HEAD`'s commit time, not a `base..HEAD` tip's: a main checkout on
    /// `origin/main` has no commits of its own and would read as never-touched.
    pub head_commit_ms: i64,
    /// Newest mtime among the changed paths; 0 when clean. The half of "somebody is
    /// working here" no `.git` file can answer — an unstaged edit moves no ref.
    pub worktree_touched_ms: i64,
    /// `dir` is gone — otherwise indistinguishable from a present non-git dir.
    pub dir_missing: bool,
    pub task_base_branch: Option<String>,
    /// [`resolve_base_ref`]'s result, so the rail can label its numbers.
    pub compared_base: String,
    /// Derived here so the client gates dev-servers without its own file read.
    pub has_launch_config: bool,
    /// See [`probe_fingerprint`] — lets a poll skip the landing probe.
    #[serde(skip)]
    pub probe_key: String,
    #[serde(skip)]
    pub structural_key: String,
    /// This checkout's own gitdir (see [`resolve_git_dir_fs`]) — where *this*
    /// checkout's `HEAD`/`index` live. `control_watch_files` watches off it.
    #[serde(skip)]
    pub git_dir: String,
    /// See [`revision_fingerprint`] — while it matches, only the worktree is read.
    #[serde(skip)]
    pub revision_key: String,
    /// The ref the diff ran against, so the fast path skips the merge-base.
    #[serde(skip)]
    pub diff_base: String,
}

/// Backup ceiling for an entry the control-file watch never registered or missed an
/// event for. A real change invalidates its dir immediately via
/// [`GitInfoCache::invalidate`]; this is long *because* the normal path is
/// event-driven, not because staleness beyond it is fine.
const GIT_CACHE_TTL_MS: i64 = 60_000;

/// The ceiling for the one checkout whose files pane is open. lazygit re-walks its
/// single repo every 10s with no change detection at all; the fleet can't afford that
/// N checkouts over, but the row actually being read can.
const FOCUSED_GIT_CACHE_TTL_MS: i64 = 10_000;

/// The ceiling while the app window itself is in the background. Nobody is
/// reading any row, so the only job left is to be current again by the time
/// focus returns — and refocus invalidates eagerly rather than waiting this
/// out. Both git poll loops gate on [`GitInfoCache::is_fresh`], so widening it
/// here backs off both at once and keeps them on the one signal they must
/// share.
const UNFOCUSED_GIT_CACHE_TTL_MS: i64 = 300_000;

/// TTL-as-backup-ceiling plus stale-serve. The recomputing poll loop is Tauri-side.
#[derive(Debug)]
pub struct GitInfoCache {
    entries: HashMap<String, (GitInfo, i64)>,
    /// The checkout being read right now — see [`FOCUSED_GIT_CACHE_TTL_MS`].
    focused: Option<String>,
    /// Whether the OS says the app window has focus at all — see
    /// [`UNFOCUSED_GIT_CACHE_TTL_MS`]. Starts true: the window is focused when
    /// it opens, and guessing "background" would stall the first paint.
    window_focused: bool,
}

impl Default for GitInfoCache {
    fn default() -> Self {
        Self { entries: HashMap::new(), focused: None, window_focused: true }
    }
}

impl GitInfoCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, dir: &str, info: GitInfo, now_ms: i64) {
        self.entries.insert(dir.to_string(), (info, now_ms));
    }

    pub fn is_fresh(&self, dir: &str, now_ms: i64) -> bool {
        // The focused row keeps its short ceiling even in the background: it is
        // the one the user lands back on, and it is a single repo.
        let ttl = match (self.focused.as_deref() == Some(dir), self.window_focused) {
            (true, _) => FOCUSED_GIT_CACHE_TTL_MS,
            (false, true) => GIT_CACHE_TTL_MS,
            (false, false) => UNFOCUSED_GIT_CACHE_TTL_MS,
        };
        self.entries.get(dir).is_some_and(|(_, ts)| now_ms - ts < ttl)
    }

    /// Track OS window focus. Returns whether it moved, so the caller can
    /// invalidate on the way back in rather than serving up to
    /// [`UNFOCUSED_GIT_CACHE_TTL_MS`]-old rows to someone who just looked.
    pub fn set_window_focused(&mut self, focused: bool) -> bool {
        let moved = self.window_focused != focused;
        self.window_focused = focused;
        moved
    }

    /// Aim the short ceiling at one checkout. Returns whether the focus moved.
    pub fn set_focused(&mut self, dir: Option<&str>) -> bool {
        let next = dir.map(str::to_string);
        let moved = self.focused != next;
        self.focused = next;
        moved
    }

    pub fn focused_dir(&self) -> Option<&str> {
        self.focused.as_deref()
    }

    pub fn window_focused(&self) -> bool {
        self.window_focused
    }

    /// Cache-only, fresh or stale: recomputing is the poll's job, never a read's.
    pub fn get(&self, dir: &str) -> GitInfo {
        if dir.is_empty() {
            return GitInfo::default();
        }
        self.entries.get(dir).map(|(info, _)| info.clone()).unwrap_or_default()
    }

    /// Stale (ts=0), so the next read still serves them but they aren't fresh.
    pub fn invalidate(&mut self, dir: Option<&str>) {
        match dir {
            Some(dir) => {
                if let Some(entry) = self.entries.get_mut(dir) {
                    entry.1 = 0;
                }
            }
            None => {
                for entry in self.entries.values_mut() {
                    entry.1 = 0;
                }
            }
        }
    }

    /// For a checkout gone for good: unlike [`Self::invalidate`] no recompute
    /// follows, and a later task at the same path must not inherit its stats.
    pub fn forget(&mut self, dir: &str) -> bool {
        self.entries.remove(dir).is_some()
    }
}

fn open_repo(dir: &str) -> Option<tt_git::repo::Repo> {
    tt_git::repo::open(std::path::Path::new(dir)).ok()
}

/// Every input the landing probe reads: `HEAD`'s sha, the base's sha, and whether the
/// upstream is gone — `work_state` is a pure function of those three. Empty when
/// anything is unreadable; a partial fingerprint must never equal a real one.
fn probe_fingerprint(repo: &tt_git::repo::Repo, branch: &str, compared_base: &str) -> String {
    let (Some(head), Some(base)) = (repo.head_id(), repo.resolve(compared_base)) else {
        return String::new();
    };
    let gone = repo.upstream_gone(&format!("refs/heads/{branch}"));
    format!("{head} {base} {gone}")
}

/// The mtimes of `common_dir`'s `worktrees` (any `worktree add`/`remove`) and `config`
/// (a `remote set-url`) — two `fs::metadata` calls against the walk they guard. A
/// missing `worktrees` stamps a sentinel rather than folding into empty.
fn structural_fingerprint(common_dir: &str) -> String {
    if common_dir.is_empty() {
        return String::new();
    }
    let stamp = |path: std::path::PathBuf| -> Option<String> {
        match std::fs::metadata(&path).and_then(|m| m.modified()) {
            Ok(modified) => {
                let dur = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
                Some(dur.as_nanos().to_string())
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some("absent".to_string()),
            Err(_) => None,
        }
    };
    let base = std::path::Path::new(common_dir);
    match (stamp(base.join("worktrees")), stamp(base.join("config"))) {
        (Some(w), Some(c)) => format!("{w} {c}"),
        _ => String::new(),
    }
}

/// Carry a checkout's structural identity across a compute that couldn't read the
/// repository: a bare default blanks `common_dir`, dropping the row out of its
/// repo's rail group for a tick.
pub fn preserve_identity_on_failed_read(dir: &str, previous: &GitInfo, info: &mut GitInfo) {
    if !info.common_dir.is_empty() || info.dir_missing || previous.common_dir.is_empty() {
        return;
    }
    if !std::path::Path::new(dir).is_dir() {
        return;
    }
    info.origin_url = previous.origin_url.clone();
    info.common_dir = previous.common_dir.clone();
    info.linked_worktree_dirs = previous.linked_worktree_dirs.clone();
    info.is_worktree = previous.is_worktree;
    info.git_dir = previous.git_dir.clone();
    // Not the revalidation tokens: empty forces the next poll to recompute.
}

struct Structural {
    origin_url: Option<String>,
    common_dir: String,
    linked_worktree_dirs: Vec<String>,
    structural_key: String,
    git_dir: String,
    is_worktree: bool,
}

/// The structural facts, revalidated against [`structural_fingerprint`] first.
/// `git_dir`/`is_worktree` are never reused: `control_watch_files` needs them fresh.
fn structural_facts(
    dir: &str,
    repo: &tt_git::repo::Repo,
    previous: Option<&GitInfo>,
) -> Structural {
    let git_dir = resolve_git_dir_fs(std::path::Path::new(dir));
    let is_worktree =
        git_dir.as_deref().is_some_and(|g| g.to_string_lossy().contains("/worktrees/"));
    let git_dir = git_dir.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();

    let reuse = previous.filter(|prev| !prev.common_dir.is_empty()).and_then(|prev| {
        let key = structural_fingerprint(&prev.common_dir);
        (!key.is_empty() && key == prev.structural_key).then_some((prev, key))
    });
    match reuse {
        Some((prev, structural_key)) => Structural {
            origin_url: prev.origin_url.clone(),
            common_dir: prev.common_dir.clone(),
            linked_worktree_dirs: prev.linked_worktree_dirs.clone(),
            structural_key,
            git_dir,
            is_worktree,
        },
        None => {
            let common_dir = repo.common_dir().to_string_lossy().into_owned();
            let linked_worktree_dirs = other_worktrees(repo, dir);
            Structural {
                origin_url: repo.origin_url(),
                linked_worktree_dirs,
                structural_key: structural_fingerprint(&common_dir),
                common_dir,
                git_dir,
                is_worktree,
            }
        }
    }
}

/// A checkout whose HEAD names no branch: structural facts only. The empty
/// `revision_key` keeps the next poll off the fast path.
fn structural_only(
    dir: &str,
    repo: &tt_git::repo::Repo,
    previous: Option<&GitInfo>,
    now_ms: i64,
) -> GitInfo {
    let s = structural_facts(dir, repo, previous);
    GitInfo {
        computed_at_ms: now_ms,
        // Mid-rebase HEAD still points at a commit; without this the
        // worked-recently filter drops the checkout being rebased.
        head_commit_ms: repo.head_commit_unix().unwrap_or(0) * 1000,
        origin_url: s.origin_url,
        common_dir: s.common_dir,
        linked_worktree_dirs: s.linked_worktree_dirs,
        structural_key: s.structural_key,
        git_dir: s.git_dir,
        is_worktree: s.is_worktree,
        task_base_branch: tt_tasks::read_task_base(std::path::Path::new(dir)),
        has_launch_config: crate::launch::has_launch_file(std::path::Path::new(dir)),
        ..Default::default()
    }
}

/// Resolved the way `git` itself does — `.git` is a directory for the main worktree, a
/// file containing `gitdir: <path>` for a linked one.
fn resolve_git_dir_fs(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let dot_git = dir.join(".git");
    let meta = std::fs::symlink_metadata(&dot_git).ok()?;
    if meta.is_dir() {
        return Some(dot_git);
    }
    let contents = std::fs::read_to_string(&dot_git).ok()?;
    let raw = contents.strip_prefix("gitdir:")?.trim();
    let path = std::path::PathBuf::from(raw);
    Some(if path.is_absolute() { path } else { dir.join(path) })
}

/// The `.git` files whose change invalidates ahead/behind/landed and *staged* dirty
/// only — an unstaged edit touches none, hence the poll backup.
fn control_files(
    git_dir: &std::path::Path,
    common_dir: &str,
    branch: &str,
    compared_base: &str,
) -> Vec<std::path::PathBuf> {
    let common = std::path::Path::new(common_dir);
    let ref_path = |ref_name: &str| -> std::path::PathBuf {
        ref_name.split('/').fold(common.join("refs/heads"), |p, seg| p.join(seg))
    };
    let mut files = vec![
        git_dir.join("HEAD"),
        git_dir.join("index"),
        common.join("packed-refs"),
    ];
    if !branch.is_empty() {
        files.push(ref_path(branch));
    }
    if let Some(name) = compared_base.strip_prefix("origin/") {
        files.push(name.split('/').fold(common.join("refs/remotes/origin"), |p, seg| p.join(seg)));
    } else if !compared_base.is_empty() {
        files.push(ref_path(compared_base));
    }
    files
}

pub fn control_files_for(info: &GitInfo) -> Vec<std::path::PathBuf> {
    if info.git_dir.is_empty() {
        return Vec::new();
    }
    control_files(
        std::path::Path::new(&info.git_dir),
        &info.common_dir,
        &info.branch,
        &info.compared_base,
    )
}

/// Every input the *ref-derived* half of [`compute_git_info`] reads: the picked base
/// ref and the [`control_files`] mtimes minus `index`, whose stat cache `status`/`diff`
/// rewrite every poll.
fn revision_fingerprint(
    dir: &str,
    git_dir: &str,
    common_dir: &str,
    branch: &str,
    compared_base: &str,
    base_branch_override: Option<&str>,
) -> String {
    if git_dir.is_empty() || branch.is_empty() {
        return String::new();
    }
    let stamp = |path: &std::path::Path| -> Option<String> {
        match std::fs::metadata(path).and_then(|m| m.modified()) {
            Ok(modified) => {
                let dur = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
                Some(dur.as_nanos().to_string())
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some("absent".to_string()),
            Err(_) => None,
        }
    };
    // A `worktree add`/`remote set-url` moves no ref file, so its fingerprint is
    // folded in here to bust the fast path.
    let structural = structural_fingerprint(common_dir);
    if structural.is_empty() {
        return String::new();
    }
    let build = || -> Option<String> {
        let mut parts = vec![
            format!("override:{}", base_branch_override.unwrap_or("")),
            format!("struct:{structural}"),
            format!("marker:{}", stamp(&std::path::Path::new(dir).join(".tt-task"))?),
        ];
        for file in control_files(std::path::Path::new(git_dir), common_dir, branch, compared_base)
        {
            // `index` is deliberately not part of the revision fingerprint — see doc.
            if file.file_name().and_then(|n| n.to_str()) == Some("index") {
                continue;
            }
            parts.push(stamp(&file)?);
        }
        Some(parts.join(" "))
    };
    build().unwrap_or_default()
}

/// Compute a folder's git info; `previous` is its last cached value, reused where
/// nothing has moved. `None` forces a full compute.
pub fn compute_git_info(
    dir: &str,
    base_branch_override: Option<&str>,
    previous: Option<&GitInfo>,
    now_ms: i64,
) -> GitInfo {
    if dir.is_empty() {
        return GitInfo::default();
    }
    // Flagged so the rail shows a ghost rather than a silent empty-stats folder.
    if !std::path::Path::new(dir).is_dir() {
        return GitInfo { dir_missing: true, computed_at_ms: now_ms, ..Default::default() };
    }
    let Some(repo) = open_repo(dir) else {
        return GitInfo::default();
    };

    // Reuse the ref-derived half and pay only for the working tree — the sole part
    // no `.git` mtime can stand in for.
    if let Some(prev) = previous.filter(|p| !p.revision_key.is_empty() && !p.git_dir.is_empty()) {
        let key = revision_fingerprint(
            dir,
            &prev.git_dir,
            &prev.common_dir,
            &prev.branch,
            &prev.compared_base,
            base_branch_override,
        );
        if !key.is_empty() && key == prev.revision_key {
            let diff_base =
                if prev.diff_base.is_empty() { "HEAD" } else { prev.diff_base.as_str() };
            let mut info = diff_stats(&repo, &prev.branch, prev.is_worktree, diff_base);
            info.computed_at_ms = now_ms;
            info.head_commit_ms = prev.head_commit_ms;
            info.commits_ahead = prev.commits_ahead;
            info.commits_behind = prev.commits_behind;
            info.commits_unlanded = prev.commits_unlanded;
            info.landed = prev.landed.clone();
            info.origin_url = prev.origin_url.clone();
            info.common_dir = prev.common_dir.clone();
            info.linked_worktree_dirs = prev.linked_worktree_dirs.clone();
            info.structural_key = prev.structural_key.clone();
            info.probe_key = prev.probe_key.clone();
            info.git_dir = prev.git_dir.clone();
            info.compared_base = prev.compared_base.clone();
            info.diff_base = prev.diff_base.clone();
            info.revision_key = key;
            // Kept fresh so a launch.json appearing doesn't wait a whole poll.
            info.task_base_branch = tt_tasks::read_task_base(std::path::Path::new(dir));
            info.has_launch_config = crate::launch::has_launch_file(std::path::Path::new(dir));
            return info;
        }
    }

    // HEAD is detached or unborn: the ref-derived half is unknown, but which repo
    // this checkout belongs to doesn't depend on where HEAD points — a bare default
    // knocked a rebasing checkout out of its rail row.
    let Some(branch) = repo.head_branch().filter(|b| !b.is_empty()) else {
        return structural_only(dir, &repo, previous, now_ms);
    };
    let compared_base = resolve_base_ref(&repo, dir, base_branch_override);
    // The merge-base, not the base tip: a branch's stats describe what *it*
    // changed, not what the base gained since.
    let base = repo
        .merge_base("HEAD", &compared_base)
        .map(|id| id.to_string())
        .unwrap_or_else(|| "HEAD".to_string());

    let Structural {
        origin_url,
        common_dir,
        linked_worktree_dirs,
        structural_key,
        git_dir,
        is_worktree,
    } = structural_facts(dir, &repo, previous);

    let mut info = diff_stats(&repo, &branch, is_worktree, &base);
    info.computed_at_ms = now_ms;
    info.head_commit_ms = repo.head_commit_unix().unwrap_or(0) * 1000;
    let (ahead, behind) = repo.ahead_behind(&compared_base, "HEAD");
    info.commits_ahead = ahead;
    info.commits_behind = behind;
    info.origin_url = origin_url;
    info.common_dir = common_dir;
    info.linked_worktree_dirs = linked_worktree_dirs;
    info.structural_key = structural_key;
    info.git_dir = git_dir;
    info.task_base_branch = tt_tasks::read_task_base(std::path::Path::new(dir));
    info.has_launch_config = crate::launch::has_launch_file(std::path::Path::new(dir));
    if info.commits_ahead > 0 {
        // Through `ops::work_state`: one implementation of "has this landed".
        let fingerprint = probe_fingerprint(&repo, &branch, &compared_base);
        let reusable = previous
            .filter(|prev| !fingerprint.is_empty() && prev.probe_key == fingerprint)
            .cloned();
        if let Some(prev) = reusable {
            info.commits_unlanded = prev.commits_unlanded;
            info.landed = prev.landed;
        } else {
            let refs = tt_tasks::ops::BaseRefs {
                base: compared_base.clone(),
                local: compared_base.clone(),
                remote: None,
            };
            let work = tt_tasks::ops::work_state(&refs, std::path::Path::new(dir), "HEAD", 0, 0);
            info.commits_unlanded = work.unlanded as i64;
            info.landed = work.landed.map(|via| via.label().to_string());
        }
        info.probe_key = fingerprint;
    } else {
        info.commits_unlanded = 0;
    }
    info.diff_base = base;
    info.revision_key = revision_fingerprint(
        dir,
        &info.git_dir,
        &info.common_dir,
        &branch,
        &compared_base,
        base_branch_override,
    );
    info.compared_base = compared_base;
    info
}

/// The two diffs of [`GitInfo`], never summed; the caller fills the rest.
fn diff_stats(repo: &tt_git::repo::Repo, branch: &str, is_worktree: bool, base: &str) -> GitInfo {
    let uncommitted = repo.changes_vs("HEAD").unwrap_or_default();
    let committed = repo.committed_totals_vs(base).unwrap_or_default();
    let staged = repo.staged_changes().unwrap_or_default();
    let worktree_touched =
        repo.newest_mtime_unix(uncommitted.files.iter().map(|c| c.path.as_str())).unwrap_or(0);
    GitInfo {
        branch: branch.to_string(),
        is_worktree,
        committed_files: committed.files_changed,
        committed_added: committed.lines_added,
        committed_removed: committed.lines_removed,
        uncommitted_files: uncommitted.file_count(),
        uncommitted_added: uncommitted.files.iter().map(|c| c.lines_added).sum(),
        uncommitted_removed: uncommitted.files.iter().map(|c| c.lines_removed).sum(),
        uncommitted_capped: uncommitted.untracked_cap.is_some(),
        staged_files: staged.files.len() as i64,
        staged_added: staged.files.iter().map(|c| c.lines_added).sum(),
        staged_removed: staged.files.iter().map(|c| c.lines_removed).sum(),
        dirty: !uncommitted.files.is_empty(),
        worktree_touched_ms: worktree_touched * 1000,
        ..Default::default()
    }
}

/// Deduped by common git dir, so N worktrees of one repo trigger one network call.
/// Failures are swallowed — this only refreshes the ref [`compute_git_info`] reads.
pub fn fetch_all(dirs: &[String]) {
    let mut seen = HashSet::new();
    for dir in dirs {
        let key = git_common_dir(dir);
        if key.is_empty() || !seen.insert(key) {
            continue;
        }
        fetch_origin(dir);
    }
}

fn fetch_origin(dir: &str) {
    let full = ["-C", dir, "fetch", "--quiet", "origin"];
    let _ = tt_exec::run_with_timeout("git", &full, std::time::Duration::from_secs(20));
}

/// The repo's shared `.git` dir, used to dedup fetches. Empty for a non-repo dir.
fn git_common_dir(dir: &str) -> String {
    open_repo(dir).map(|repo| repo.common_dir().to_string_lossy().into_owned()).unwrap_or_default()
}

/// This repo's other linked worktrees, `dir` itself and the main checkout excluded.
/// `dir` is compared canonically, so a symlinked checkout drops out of its own list.
fn other_worktrees(repo: &tt_git::repo::Repo, dir: &str) -> Vec<String> {
    let self_dir = std::fs::canonicalize(dir).unwrap_or_else(|_| std::path::PathBuf::from(dir));
    repo.worktrees()
        .into_iter()
        .filter(|w| !w.is_main && std::path::Path::new(&w.dir) != self_dir)
        .map(|w| w.dir)
        .collect()
}

/// One of two places this module spawns `git` (gitoxide's worktree API is read-only).
/// `prune` runs either way: a failed remove leaves a stale entry.
pub fn prune_stale_worktree(owner_dir: &str, worktree_dir: &str) -> bool {
    let git = |args: &[&str]| {
        let mut full = vec!["-C", owner_dir];
        full.extend_from_slice(args);
        tt_exec::run_with_timeout_env(
            "git",
            &full,
            tt_exec::GIT_NON_INTERACTIVE_ENV,
            std::time::Duration::from_secs(10),
        )
    };
    let removed = git(&["worktree", "remove", "--force", worktree_dir]).is_ok_and(|out| out.ok());
    let _ = git(&["worktree", "prune"]);
    // The cached handle would hold an object database open against a dead directory.
    tt_git::repo::forget(std::path::Path::new(worktree_dir));
    removed
}

/// origin/main, or origin/master if that's what the remote uses.
fn resolve_origin_main(repo: &tt_git::repo::Repo) -> String {
    if repo.has_rev("origin/main") {
        "origin/main".to_string()
    } else {
        "origin/master".to_string()
    }
}

/// The ref every "vs main" comparison uses: [`compute_git_info`]'s stats and the
/// committed chip's per-commit list, so every number in a rail row shares one
/// baseline. Priority: the per-folder `base_branch` override, the `.tt-task`
/// marker's `base=`, then origin/main-or-master. The winner resolves to
/// `origin/<name>` — the pushed baseline — and to the local branch only when no
/// remote exists.
fn resolve_base_ref(repo: &tt_git::repo::Repo, dir: &str, base_branch: Option<&str>) -> String {
    let candidates = [base_branch.map(str::trim).filter(|n| !n.is_empty()).map(str::to_string)]
        .into_iter()
        .flatten()
        .chain(tt_tasks::read_task_base(std::path::Path::new(dir)));
    for name in candidates {
        let name = name.trim_start_matches("origin/");
        let remote = format!("origin/{name}");
        if repo.has_rev(&remote) {
            return remote;
        }
        if repo.has_rev(name) {
            return name.to_string();
        }
    }
    resolve_origin_main(repo)
}

/// One commit ahead of `compared_base` with its own line-count diff, not the branch's
/// cumulative total. `camelCase` is load-bearing: the frontend reads `linesAdded`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitStat {
    pub sha: String,
    pub subject: String,
    pub lines_added: i64,
    pub lines_removed: i64,
}

pub fn commit_stats(dir: &str, base_branch: Option<&str>) -> Vec<CommitStat> {
    if dir.is_empty() {
        return Vec::new();
    }
    let Some(repo) = open_repo(dir) else {
        return Vec::new();
    };
    let compared_base = resolve_base_ref(&repo, dir, base_branch);
    repo.commit_stats(&compared_base)
        .unwrap_or_default()
        .into_iter()
        .map(|stat| CommitStat {
            sha: stat.sha,
            subject: stat.subject,
            lines_added: stat.lines_added,
            lines_removed: stat.lines_removed,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_700_000_000_000;

    fn git(dir: impl AsRef<std::path::Path>, args: &[&str]) {
        assert!(
            std::process::Command::new("git")
                .arg("-C")
                .arg(dir.as_ref())
                .args(args)
                .status()
                .unwrap()
                .success()
        );
    }

    fn worktree_dirs_of(dir: &str) -> Vec<String> {
        open_repo(dir).map(|repo| other_worktrees(&repo, dir)).unwrap_or_default()
    }

    /// A repo on `main` with one commit of `f.txt`; the diff-counting tests care
    /// what the baseline's last line looks like.
    fn init_repo_with(repo: &std::path::Path, contents: &str) {
        git(repo, &["init", "--quiet", "-b", "main"]);
        git(repo, &["config", "user.email", "test@example.com"]);
        git(repo, &["config", "user.name", "Test"]);
        // A commit hands off to a background `gc --auto`, whose temp files under
        // `objects/` the object-count test would read mid-flight.
        git(repo, &["config", "gc.auto", "0"]);
        git(repo, &["config", "maintenance.auto", "false"]);
        std::fs::write(repo.join("f.txt"), contents).unwrap();
        git(repo, &["add", "f.txt"]);
        git(repo, &["commit", "--quiet", "-m", "init"]);
    }

    fn init_repo(repo: &std::path::Path) {
        init_repo_with(repo, "1");
    }

    /// [`init_repo`] plus a local `origin/main` ref, for the default-base tests.
    fn init_repo_with_origin(repo: &std::path::Path) {
        init_repo(repo);
        git(repo, &["update-ref", "refs/remotes/origin/main", "main"]);
    }

    #[test]
    fn commit_stats_lists_ahead_commits_oldest_first_with_own_line_counts() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path();
        init_repo_with(repo, "1\n");
        git(repo, &["update-ref", "refs/remotes/origin/main", "main"]);

        git(repo, &["checkout", "--quiet", "-b", "feature"]);
        std::fs::write(repo.join("f.txt"), "1\n2\n").unwrap();
        git(repo, &["commit", "--quiet", "-am", "first"]);
        std::fs::write(repo.join("f.txt"), "1\n2\n3\n4\n").unwrap();
        git(repo, &["commit", "--quiet", "-am", "second"]);

        let dir = repo.to_str().unwrap();
        let stats = commit_stats(dir, None);
        assert_eq!(stats.len(), 2);
        assert_eq!(stats[0].subject, "first");
        assert_eq!(stats[0].lines_added, 1);
        assert_eq!(stats[0].lines_removed, 0);
        assert_eq!(stats[1].subject, "second");
        assert_eq!(stats[1].lines_added, 2);
        assert_eq!(stats[1].lines_removed, 0);
        assert_eq!(stats.iter().map(|c| c.lines_added).sum::<i64>(), 3);
    }

    #[test]
    fn commit_stats_empty_for_non_repo_or_blank_dir() {
        let root = tempfile::TempDir::new().unwrap();
        assert!(commit_stats(root.path().to_str().unwrap(), None).is_empty());
        assert!(commit_stats("", None).is_empty());
    }

    #[test]
    fn cache_fresh_stale_and_invalidate() {
        let mut cache = GitInfoCache::new();
        let info = GitInfo { branch: "main".into(), ..Default::default() };
        // Epoch-scale: invalidate() zeroes the stamp, which reads as stale
        // only when `now_ms` is a real epoch (≫ TTL).
        let t0 = 1_700_000_000_000;
        cache.insert("/repo", info.clone(), t0);
        assert!(cache.is_fresh("/repo", t0));
        assert!(cache.is_fresh("/repo", t0 + GIT_CACHE_TTL_MS - 1)); // just under TTL
        assert!(!cache.is_fresh("/repo", t0 + GIT_CACHE_TTL_MS)); // exactly TTL later → stale
        assert_eq!(cache.get("/repo"), info);
        cache.invalidate(Some("/repo"));
        assert!(!cache.is_fresh("/repo", t0));
        assert_eq!(cache.get("/repo"), info); // still served
    }

    /// The focused checkout goes stale at the short ceiling; its neighbours,
    /// same cache and stamp, keep the fleet-wide one.
    #[test]
    fn only_the_focused_dir_gets_the_short_ceiling() {
        let mut cache = GitInfoCache::new();
        let t0 = 1_700_000_000_000;
        let at = t0 + FOCUSED_GIT_CACHE_TTL_MS;
        cache.insert("/repo/looked-at", GitInfo::default(), t0);
        cache.insert("/repo/other", GitInfo::default(), t0);
        assert!(cache.is_fresh("/repo/looked-at", at), "nothing focused yet");

        assert!(cache.set_focused(Some("/repo/looked-at")));
        assert!(!cache.set_focused(Some("/repo/looked-at")), "same dir, no move");
        assert!(!cache.is_fresh("/repo/looked-at", at));
        assert!(cache.is_fresh("/repo/looked-at", at - 1));
        assert!(cache.is_fresh("/repo/other", at), "the fleet keeps the long ceiling");

        assert!(cache.set_focused(None));
        assert!(cache.is_fresh("/repo/looked-at", at));
    }

    #[test]
    fn cache_get_empty_for_unknown_or_blank_dir() {
        let cache = GitInfoCache::new();
        assert_eq!(cache.get("/nope"), GitInfo::default());
        assert_eq!(cache.get(""), GitInfo::default());
    }

    #[test]
    fn git_common_dir_matches_across_worktrees_of_one_repo() {
        let root = tempfile::TempDir::new().unwrap();
        let main = root.path().join("main");
        std::fs::create_dir(&main).unwrap();
        init_repo(&main);
        let linked = root.path().join("linked");
        git(
            &main,
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "feat",
                linked.to_str().unwrap(),
            ],
        );

        let main_key = git_common_dir(main.to_str().unwrap());
        let linked_key = git_common_dir(linked.to_str().unwrap());
        assert!(!main_key.is_empty());
        assert_eq!(main_key, linked_key);
    }

    #[test]
    fn worktree_dirs_separates_linked_worktrees_from_the_main_checkout() {
        let (_guard, root) = temp_root();
        let main = root.join("main");
        std::fs::create_dir(&main).unwrap();
        init_repo(&main);

        let task = main.join(".claude").join("worktrees").join("thing");
        std::fs::create_dir_all(task.parent().unwrap()).unwrap();
        git(
            &main,
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "thing",
                task.to_str().unwrap(),
            ],
        );
        let scratch = root.join("scratch-ext");
        git(
            &main,
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "scratch-ext",
                scratch.to_str().unwrap(),
            ],
        );

        // Nothing on disk says which sibling the user asked for.
        let linked = worktree_dirs_of(main.to_str().unwrap());
        assert_eq!(sorted(linked), sorted(vec![path_s(&task), path_s(&scratch)]));

        // The primary checkout is what a repo group nests under.
        let linked = worktree_dirs_of(task.to_str().unwrap());
        assert_eq!(linked, vec![path_s(&scratch)]);
    }

    #[test]
    fn prune_stale_worktree_clears_a_deleted_but_unpruned_registration() {
        let (_guard, root) = temp_root();
        let main = root.join("main");
        std::fs::create_dir(&main).unwrap();
        init_repo(&main);

        let managed = main.join(".claude").join("worktrees").join("thing");
        std::fs::create_dir_all(managed.parent().unwrap()).unwrap();
        git(
            &main,
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "thing",
                managed.to_str().unwrap(),
            ],
        );
        std::fs::write(
            managed.join(tt_tasks::MARKER_FILE),
            tt_tasks::marker_contents("thing", "main", "main"),
        )
        .unwrap();
        let raw_worktree_dirs = |dir: &str| {
            open_repo(dir)
                .map(|repo| repo.worktrees().into_iter().map(|w| w.dir).collect::<Vec<_>>())
                .unwrap_or_default()
        };
        assert!(raw_worktree_dirs(main.to_str().unwrap()).contains(&path_s(&managed)));

        // A bare `rm -rf` leaves the registration `worktree list` reports.
        std::fs::remove_dir_all(&managed).unwrap();
        assert!(
            raw_worktree_dirs(main.to_str().unwrap()).contains(&path_s(&managed)),
            "a deleted-but-unpruned worktree registration must still be listed by git"
        );

        assert!(prune_stale_worktree(main.to_str().unwrap(), managed.to_str().unwrap()));
        assert!(
            !raw_worktree_dirs(main.to_str().unwrap()).contains(&path_s(&managed)),
            "pruning must clear the stale registration"
        );
    }

    fn sorted(mut v: Vec<String>) -> Vec<String> {
        v.sort();
        v
    }

    fn path_s(p: &std::path::Path) -> String {
        p.to_str().unwrap().to_string()
    }

    /// A tempdir root spelled the way git reports it back: macOS resolves its
    /// `/var` symlink, and any path comparison here must be like for like.
    fn temp_root() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::TempDir::new().unwrap();
        let path = std::fs::canonicalize(dir.path()).unwrap();
        (dir, path)
    }

    #[test]
    fn resolve_base_ref_prefers_a_verified_override_over_the_main_default() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path();
        init_repo(repo);
        git(repo, &["branch", "develop"]);

        let dir = repo.to_str().unwrap();
        assert_eq!(
            resolve_base_ref(&open_repo(dir).expect("repo"), dir, Some("develop")),
            "develop"
        );
        assert_eq!(
            resolve_base_ref(&open_repo(dir).expect("repo"), dir, Some("origin/develop")),
            "develop"
        );
        assert_eq!(
            resolve_base_ref(&open_repo(dir).expect("repo"), dir, Some("no-such-branch")),
            resolve_origin_main(&open_repo(dir).expect("repo"))
        );
        assert_eq!(
            resolve_base_ref(&open_repo(dir).expect("repo"), dir, None),
            resolve_origin_main(&open_repo(dir).expect("repo"))
        );
    }

    #[test]
    fn resolve_base_ref_uses_the_tasks_own_creation_base_over_main() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path();
        init_repo(repo);
        git(repo, &["branch", "develop"]);
        git(repo, &["update-ref", "refs/remotes/origin/develop", "develop"]);
        git(repo, &["update-ref", "refs/remotes/origin/main", "main"]);

        std::fs::write(
            repo.join(tt_tasks::MARKER_FILE),
            tt_tasks::marker_contents("task-name", "develop", "main"),
        )
        .unwrap();

        let dir = repo.to_str().unwrap();
        assert_eq!(resolve_base_ref(&open_repo(dir).expect("repo"), dir, None), "origin/develop");
        git(repo, &["branch", "release"]);
        git(repo, &["update-ref", "refs/remotes/origin/release", "release"]);
        assert_eq!(
            resolve_base_ref(&open_repo(dir).expect("repo"), dir, Some("release")),
            "origin/release"
        );
    }

    #[test]
    fn git_common_dir_empty_for_non_repo() {
        let root = tempfile::TempDir::new().unwrap();
        assert_eq!(git_common_dir(root.path().to_str().unwrap()), "");
    }

    #[test]
    fn compute_flags_a_missing_dir() {
        let root = tempfile::TempDir::new().unwrap();
        let gone = root.path().join("moved-away");
        let info = compute_git_info(gone.to_str().unwrap(), None, None, NOW);
        assert!(info.dir_missing);
        assert!(info.branch.is_empty());
    }

    #[test]
    fn compute_does_not_flag_an_existing_dir() {
        let root = tempfile::TempDir::new().unwrap();
        let info = compute_git_info(root.path().to_str().unwrap(), None, None, NOW);
        assert!(!info.dir_missing);
    }

    /// A `node_modules` no `.gitignore` covers: the count is a floor, not a total.
    #[test]
    fn an_unignored_dependency_tree_is_capped_and_flagged() {
        let root = tempfile::TempDir::new().unwrap();
        init_repo_with_origin(root.path());
        let dir = root.path().to_str().unwrap();
        for i in 0..1_100 {
            let pkg = root.path().join(format!("node_modules/pkg{}", i % 20));
            std::fs::create_dir_all(&pkg).unwrap();
            std::fs::write(pkg.join(format!("f{i}.js")), "x\n").unwrap();
        }

        let info = compute_git_info(dir, None, None, NOW);
        assert!(info.dirty);
        assert!(info.uncommitted_capped, "a truncated count must not read as a total");
        assert!(info.uncommitted_files > 0);
    }

    #[test]
    fn dirty_and_uncommitted_counts_track_the_working_tree() {
        let root = tempfile::TempDir::new().unwrap();
        init_repo(root.path());
        let dir = root.path().to_str().unwrap();

        let clean = compute_git_info(dir, None, None, NOW);
        assert!(!clean.dirty, "a freshly committed tree is not dirty");
        assert_eq!(clean.uncommitted_files, 0);
        assert_eq!(clean.computed_at_ms, NOW, "every compute stamps its clock");

        // Invisible to `.git` mtimes — why the poll still reads the worktree.
        std::fs::write(root.path().join("f.txt"), "1\n2\n").unwrap();
        let edited = compute_git_info(dir, None, None, NOW);
        assert!(edited.dirty);
        assert_eq!(edited.uncommitted_files, 1);
        assert_eq!((edited.uncommitted_added, edited.uncommitted_removed), (2, 1));

        std::fs::write(root.path().join("new.txt"), "fresh\n").unwrap();
        let untracked = compute_git_info(dir, None, None, NOW);
        assert!(untracked.dirty);
        assert_eq!(untracked.uncommitted_files, 2);
        assert_eq!(
            (untracked.uncommitted_added, untracked.uncommitted_removed),
            (edited.uncommitted_added, edited.uncommitted_removed),
            "an untracked file contributes no line counts"
        );
    }

    /// The worked-recently filter's two signals: `head_commit_ms` answers even on
    /// the base branch, `worktree_touched_ms` covers the unstaged edit.
    #[test]
    fn worked_recently_signals_track_commits_and_unstaged_edits() {
        let root = tempfile::TempDir::new().unwrap();
        init_repo(root.path());
        let dir = root.path().to_str().unwrap();

        let clean = compute_git_info(dir, None, None, NOW);
        let head_commit: i64 = String::from_utf8(
            std::process::Command::new("git")
                .args(["-C", dir, "log", "-1", "--format=%ct", "HEAD"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .parse()
        .unwrap();
        assert_eq!(clean.head_commit_ms, head_commit * 1000, "the base branch still has a commit");
        assert_eq!(clean.worktree_touched_ms, 0, "a clean tree was touched by nobody");

        std::fs::write(root.path().join("f.txt"), "1\n2\n").unwrap();
        let edited = compute_git_info(dir, None, None, NOW);
        assert_eq!(edited.head_commit_ms, clean.head_commit_ms, "no new commit");
        assert!(edited.worktree_touched_ms > 0, "an unstaged edit is a touch");
    }

    /// Two disjoint quantities: the old single ± measured the working tree against
    /// the merge-base, folding an uncommitted edit into the commit count's ±.
    #[test]
    fn committed_and_uncommitted_diffs_are_disjoint() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path();
        let dir = repo.to_str().unwrap();

        // A trailing newline, so the numbers below are what `git diff` prints.
        init_repo_with(repo, "1\n");
        git(repo, &["update-ref", "refs/remotes/origin/main", "main"]);

        git(repo, &["checkout", "--quiet", "-b", "feature"]);
        std::fs::write(repo.join("f.txt"), "1\n2\n3\n").unwrap();
        git(repo, &["commit", "--quiet", "-am", "add two lines"]);

        let committed_only = compute_git_info(dir, None, None, NOW);
        assert_eq!(committed_only.commits_ahead, 1);
        assert_eq!(committed_only.committed_files, 1);
        assert_eq!((committed_only.committed_added, committed_only.committed_removed), (2, 0));
        assert!(!committed_only.dirty);
        assert_eq!(committed_only.uncommitted_files, 0);
        assert_eq!((committed_only.uncommitted_added, committed_only.uncommitted_removed), (0, 0));

        std::fs::write(repo.join("f.txt"), "1\n2\n3\n4\n5\n").unwrap();
        let both = compute_git_info(dir, None, None, NOW);
        assert_eq!(
            (both.committed_added, both.committed_removed),
            (committed_only.committed_added, committed_only.committed_removed),
            "an uncommitted edit must not change what the commits contain"
        );
        assert_eq!(both.commits_ahead, 1);
        assert!(both.dirty);
        assert_eq!(both.uncommitted_files, 1);
        assert_eq!((both.uncommitted_added, both.uncommitted_removed), (2, 0));
    }

    #[test]
    fn compute_reads_task_base_branch_from_marker() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path();
        init_repo(repo);

        let info = compute_git_info(repo.to_str().unwrap(), None, None, NOW);
        assert_eq!(info.task_base_branch, None);

        std::fs::write(
            repo.join(tt_tasks::MARKER_FILE),
            tt_tasks::marker_contents("s", "develop", "main"),
        )
        .unwrap();
        let info = compute_git_info(repo.to_str().unwrap(), None, None, NOW);
        assert_eq!(info.task_base_branch, Some("develop".to_string()));
    }

    /// Stats and the diff pane must come from the same `resolve_base_ref`
    /// baseline; this module used to measure everything against origin/main.
    #[test]
    fn compute_measures_stats_against_the_resolved_base_not_always_main() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path();
        init_repo(repo);

        git(repo, &["checkout", "--quiet", "-b", "develop"]);
        std::fs::write(repo.join("f.txt"), "2").unwrap();
        git(repo, &["commit", "--quiet", "-am", "on develop"]);

        git(repo, &["checkout", "--quiet", "-b", "feature"]);
        std::fs::write(repo.join("f.txt"), "3").unwrap();
        git(repo, &["commit", "--quiet", "-am", "on feature"]);

        git(repo, &["update-ref", "refs/remotes/origin/main", "main"]);
        git(repo, &["update-ref", "refs/remotes/origin/develop", "develop"]);

        let dir = repo.to_str().unwrap();

        let vs_main = compute_git_info(dir, None, None, NOW);
        assert_eq!(vs_main.compared_base, "origin/main");
        assert_eq!(vs_main.commits_ahead, 2);

        let vs_develop = compute_git_info(dir, Some("develop"), None, NOW);
        assert_eq!(vs_develop.compared_base, "origin/develop");
        assert_eq!(vs_develop.commits_ahead, 1);
    }

    /// A rebase merge replays commits under new SHAs, so `commits_ahead` never
    /// reaches 0 though the content landed. `commits_unlanded` must.
    #[test]
    fn commits_unlanded_reaches_zero_after_a_rebase_style_landing_even_though_ahead_does_not() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path();
        init_repo(repo);

        git(repo, &["checkout", "--quiet", "-b", "feature"]);
        std::fs::write(repo.join("f.txt"), "2").unwrap();
        git(repo, &["commit", "--quiet", "-am", "on feature"]);
        let feature_commit = std::process::Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap()
            .stdout;
        let feature_commit = String::from_utf8(feature_commit).unwrap().trim().to_string();

        git(repo, &["checkout", "--quiet", "main"]);
        std::fs::write(repo.join("other.txt"), "unrelated").unwrap();
        git(repo, &["add", "other.txt"]);
        git(repo, &["commit", "--quiet", "-m", "unrelated on main"]);
        git(repo, &["cherry-pick", "--quiet", &feature_commit]);
        git(repo, &["update-ref", "refs/remotes/origin/main", "main"]);
        git(repo, &["checkout", "--quiet", "feature"]);

        let dir = repo.to_str().unwrap();
        let info = compute_git_info(dir, None, None, NOW);
        assert_eq!(info.commits_ahead, 1);
        assert_eq!(info.commits_unlanded, 0);
    }

    #[test]
    fn commits_unlanded_counts_a_commit_whose_content_never_landed() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path();
        init_repo_with_origin(repo);

        git(repo, &["checkout", "--quiet", "-b", "feature"]);
        std::fs::write(repo.join("f.txt"), "2").unwrap();
        git(repo, &["commit", "--quiet", "-am", "on feature, never merged"]);

        let dir = repo.to_str().unwrap();
        let info = compute_git_info(dir, None, None, NOW);
        assert_eq!(info.commits_ahead, 1);
        assert_eq!(info.commits_unlanded, 1);
        assert_eq!(info.landed, None, "nothing landed, so the rail must not claim otherwise");
    }

    /// An entry stamped with a `now` from *before* a slow batch is born past the
    /// TTL, so the next poll recomputes at once — a loop that once cost ~20 git
    /// subprocesses/sec. Stamp when the batch *finished*.
    #[test]
    fn cache_entry_stamped_before_a_slow_batch_is_born_stale() {
        let mut cache = GitInfoCache::new();
        let batch_started = 1_000_000;
        let batch_finished = batch_started + GIT_CACHE_TTL_MS * 2;

        cache.insert("/repo", GitInfo::default(), batch_started);
        assert!(
            !cache.is_fresh("/repo", batch_finished),
            "a pre-batch stamp is already expired by the time the batch lands"
        );

        cache.insert("/repo", GitInfo::default(), batch_finished);
        assert!(
            cache.is_fresh("/repo", batch_finished),
            "stamping with the batch's completion time is what makes the TTL mean anything"
        );
    }

    /// The structural guard against that storm: an unmoved probe answer is reused.
    /// The previous answer is poisoned — if it survives, the probe did not run.
    #[test]
    fn unchanged_revision_reuses_the_landing_answer_and_a_moved_head_invalidates_it() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path();
        init_repo_with_origin(repo);
        git(repo, &["checkout", "--quiet", "-b", "feature"]);
        std::fs::write(repo.join("f.txt"), "2").unwrap();
        git(repo, &["commit", "--quiet", "-am", "unlanded work"]);

        let dir = repo.to_str().unwrap();
        let first = compute_git_info(dir, None, None, NOW);
        assert_eq!(first.commits_unlanded, 1);
        assert!(!first.probe_key.is_empty(), "a probed repo must carry a fingerprint to reuse");

        let mut poisoned = first.clone();
        poisoned.landed = Some("sentinel".to_string());
        poisoned.commits_unlanded = 99;

        let reused = compute_git_info(dir, None, Some(&poisoned), NOW);
        assert_eq!(
            reused.landed.as_deref(),
            Some("sentinel"),
            "nothing moved, so the cached answer must be carried over, not recomputed"
        );
        assert_eq!(reused.commits_unlanded, 99);
        assert_eq!(reused.probe_key, first.probe_key);

        std::fs::write(repo.join("f.txt"), "3").unwrap();
        git(repo, &["commit", "--quiet", "-am", "more unlanded work"]);

        let reprobed = compute_git_info(dir, None, Some(&poisoned), NOW);
        assert_ne!(reprobed.probe_key, first.probe_key, "a moved HEAD must invalidate the memo");
        assert_eq!(reprobed.landed, None);
        assert_eq!(reprobed.commits_unlanded, 2);
    }

    #[test]
    fn resolve_git_dir_fs_reads_a_plain_checkouts_dot_git_directory() {
        let root = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(root.path().join(".git")).unwrap();
        assert_eq!(
            resolve_git_dir_fs(root.path()),
            Some(root.path().join(".git")),
            "a plain checkout's gitdir is just its .git directory — no spawn needed"
        );
    }

    #[test]
    fn resolve_git_dir_fs_follows_the_gitdir_file_for_a_real_worktree() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path().join("main");
        let worktree = root.path().join("task");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        git(&repo, &["worktree", "add", "-b", "task", worktree.to_str().unwrap()]);

        let resolved = resolve_git_dir_fs(&worktree).expect("real worktree must resolve");
        // What `rev-parse --git-dir` answers, reached with zero spawns.
        let spawned = std::process::Command::new("git")
            .arg("-C")
            .arg(&worktree)
            .args(["rev-parse", "--git-dir"])
            .output()
            .expect("git runs");
        let spawned = String::from_utf8_lossy(&spawned.stdout).trim().to_string();
        assert_eq!(resolved, std::path::PathBuf::from(spawned));
        assert!(resolved.to_string_lossy().contains("/worktrees/task"));
        assert!(resolved.join("HEAD").is_file(), "the resolved gitdir must have its own HEAD");
    }

    #[test]
    fn resolve_git_dir_fs_is_none_for_a_non_repo_directory() {
        let root = tempfile::TempDir::new().unwrap();
        assert_eq!(resolve_git_dir_fs(root.path()), None);
    }

    #[test]
    fn control_files_covers_head_index_packed_refs_branch_and_origin_base() {
        let git_dir = std::path::Path::new("/repo/.git/worktrees/task");
        let files = control_files(git_dir, "/repo/.git", "feature/x", "origin/main");
        assert_eq!(
            files,
            vec![
                std::path::PathBuf::from("/repo/.git/worktrees/task/HEAD"),
                std::path::PathBuf::from("/repo/.git/worktrees/task/index"),
                std::path::PathBuf::from("/repo/.git/packed-refs"),
                std::path::PathBuf::from("/repo/.git/refs/heads/feature/x"),
                std::path::PathBuf::from("/repo/.git/refs/remotes/origin/main"),
            ]
        );
    }

    #[test]
    fn control_files_uses_refs_heads_for_a_base_with_no_origin() {
        let git_dir = std::path::Path::new("/repo/.git");
        let files = control_files(git_dir, "/repo/.git", "main", "develop");
        assert!(files.contains(&std::path::PathBuf::from("/repo/.git/refs/heads/develop")));
        assert!(
            !files.iter().any(|f| f.to_string_lossy().contains("refs/remotes")),
            "a base with no origin/ prefix must never resolve into refs/remotes"
        );
    }

    #[test]
    fn control_files_for_is_empty_until_the_first_compute() {
        assert_eq!(
            control_files_for(&GitInfo::default()),
            Vec::<std::path::PathBuf>::new(),
            "an unresolved git_dir means nothing to watch yet — the poll covers it"
        );
    }

    /// `git_dir` — and so the watch set — comes purely from the filesystem.
    #[test]
    fn compute_git_info_resolves_git_dir_from_the_filesystem_for_worktrees_too() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path().join("main");
        let worktree = root.path().join("task");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        git(&repo, &["worktree", "add", "-b", "task", worktree.to_str().unwrap()]);

        let main_info = compute_git_info(repo.to_str().unwrap(), None, None, NOW);
        assert!(!main_info.is_worktree);
        assert_eq!(main_info.git_dir, repo.join(".git").to_string_lossy());

        let task_info = compute_git_info(worktree.to_str().unwrap(), None, None, NOW);
        assert!(task_info.is_worktree);
        assert!(task_info.git_dir.contains("/worktrees/task"));
        assert!(
            !control_files_for(&task_info).is_empty(),
            "a resolved checkout has files to watch"
        );
    }

    /// Why this can't be one path prefix: a linked worktree's `HEAD`/`index` live in
    /// its own gitdir while every ref it compares against lives in the common dir.
    #[test]
    fn control_files_split_across_the_worktree_gitdir_and_the_shared_common_dir() {
        let (_guard, root) = temp_root();
        let repo = root.join("main");
        let worktree = root.join("task");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        git(&repo, &["update-ref", "refs/remotes/origin/main", "main"]);
        git(
            &repo,
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "task",
                worktree.to_str().unwrap(),
            ],
        );

        let common = repo.join(".git");
        let main_info = compute_git_info(repo.to_str().unwrap(), None, None, NOW);
        assert_eq!(
            control_files_for(&main_info),
            vec![
                common.join("HEAD"),
                common.join("index"),
                common.join("packed-refs"),
                common.join("refs/heads/main"),
                common.join("refs/remotes/origin/main"),
            ],
            "a plain checkout watches its own .git for everything"
        );

        let task_info = compute_git_info(worktree.to_str().unwrap(), None, None, NOW);
        let task_git = common.join("worktrees/task");
        assert_eq!(
            control_files_for(&task_info),
            vec![
                task_git.join("HEAD"),
                task_git.join("index"),
                common.join("packed-refs"),
                common.join("refs/heads/task"),
                common.join("refs/remotes/origin/main"),
            ],
            "a linked worktree watches its own HEAD/index but the shared refs"
        );
    }

    /// Registered the way the host's scan loop does it, a `git checkout -b`
    /// surfaces within a debounce window rather than on the TTL.
    #[test]
    fn a_branch_switch_fires_the_control_watch_far_sooner_than_the_backup_poll() {
        let (_guard, root) = temp_root();
        let repo = root.as_path();
        init_repo(repo);
        let dir = repo.to_str().unwrap();
        let before = compute_git_info(dir, None, None, NOW);
        assert_eq!(before.branch, "main");

        let (fired_tx, fired_rx) = std::sync::mpsc::channel::<Vec<std::path::PathBuf>>();
        let mut notifier = crate::fs_notify::MultiFileNotifier::new(move |batch| {
            let _ = fired_tx.send(batch);
        })
        .unwrap();
        // Same tolerance as the host: a parentless control file is skipped.
        for file in control_files_for(&before) {
            let _ = notifier.add(&file);
        }

        let started = std::time::Instant::now();
        git(repo, &["checkout", "--quiet", "-b", "feature"]);
        let batch = fired_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("a branch switch must fire the control-file watch");
        let latency = started.elapsed();
        assert!(batch.contains(&repo.join(".git/HEAD")), "HEAD is the path that moved: {batch:?}");
        assert!(
            latency < std::time::Duration::from_millis(GIT_CACHE_TTL_MS as u64),
            "the accelerant must beat the backup poll's ceiling, took {latency:?}"
        );

        let after = compute_git_info(dir, None, None, NOW);
        assert_eq!(after.branch, "feature", "the recompute the signal triggers sees the switch");
    }

    /// The same idea for the structural facts: two `fs::metadata` calls instead of
    /// four git spawns on every poll of an unchanged repo.
    #[test]
    fn unmoved_worktrees_and_config_reuse_structural_facts_and_a_new_worktree_invalidates_it() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path();
        init_repo(repo);

        let dir = repo.to_str().unwrap();
        let first = compute_git_info(dir, None, None, NOW);
        assert!(!first.common_dir.is_empty());
        assert!(
            !first.structural_key.is_empty(),
            "a resolved repo must carry a fingerprint to reuse"
        );

        // A value `compute_git_info` could never produce: if it survives, the
        // structural spawns did not run.
        let mut poisoned = first.clone();
        poisoned.origin_url = Some("sentinel".to_string());

        let reused = compute_git_info(dir, None, Some(&poisoned), NOW);
        assert_eq!(
            reused.origin_url.as_deref(),
            Some("sentinel"),
            "nothing structural moved, so the cached facts must be carried over"
        );
        assert_eq!(reused.structural_key, first.structural_key);

        let sibling = root.path().join("sibling");
        git(
            repo,
            &[
                "worktree",
                "add",
                "-b",
                "feature",
                sibling.to_str().unwrap(),
            ],
        );

        let reprobed = compute_git_info(dir, None, Some(&poisoned), NOW);
        assert_ne!(
            reprobed.structural_key, first.structural_key,
            "a new worktree must invalidate the structural memo"
        );
        assert_ne!(reprobed.origin_url.as_deref(), Some("sentinel"));
        let sibling_dir = path_s(&std::fs::canonicalize(&sibling).unwrap());
        assert!(reprobed.linked_worktree_dirs.contains(&sibling_dir));
    }

    /// With no ref moved, an idle tick pays for two of the nine reads. Proven by
    /// poisoning ref-derived fields and watching them survive a worktree change.
    #[test]
    fn unchanged_refs_reuse_the_ref_derived_half_but_still_refresh_the_working_tree() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path();
        init_repo(repo);
        let dir = repo.to_str().unwrap();

        let first = compute_git_info(dir, None, None, NOW);
        assert!(!first.revision_key.is_empty(), "a resolved repo carries a revision fingerprint");
        assert!(!first.dirty, "the tree is clean after the initial commit");

        // The fingerprint is keyed off the ref *files*, so it still matches and
        // the fast path must carry the poison over.
        let mut poisoned = first.clone();
        poisoned.commits_ahead = 999;
        poisoned.landed = Some("SENTINEL".to_string());

        std::fs::write(repo.join("untracked.txt"), "x").unwrap();

        let reused = compute_git_info(dir, None, Some(&poisoned), NOW);
        assert_eq!(reused.commits_ahead, 999, "ref-derived half reused, not recomputed");
        assert_eq!(reused.landed.as_deref(), Some("SENTINEL"), "landing answer reused");
        assert_eq!(reused.revision_key, first.revision_key, "fingerprint stable while refs idle");
        assert!(reused.dirty, "status/diff still ran, so the new untracked file shows");
    }

    #[test]
    fn a_new_commit_moves_head_and_forces_a_full_recompute() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path();
        init_repo(repo);
        let dir = repo.to_str().unwrap();

        let first = compute_git_info(dir, None, None, NOW);
        let mut poisoned = first.clone();
        poisoned.landed = Some("SENTINEL".to_string());

        std::fs::write(repo.join("f.txt"), "2").unwrap();
        git(repo, &["commit", "--quiet", "-am", "second"]);

        let reprobed = compute_git_info(dir, None, Some(&poisoned), NOW);
        assert_ne!(reprobed.revision_key, first.revision_key, "a moved HEAD invalidates the memo");
        assert_ne!(reprobed.landed.as_deref(), Some("SENTINEL"), "a full recompute ran");
    }

    #[test]
    fn a_changed_base_override_forces_a_full_recompute() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path();
        init_repo(repo);
        let dir = repo.to_str().unwrap();
        std::process::Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["branch", "develop"])
            .status()
            .unwrap();

        let first = compute_git_info(dir, None, None, NOW);
        let mut poisoned = first.clone();
        poisoned.landed = Some("SENTINEL".to_string());

        // The fingerprint folds the base override in, so a different one
        // re-resolves rather than serving the stale half.
        let reprobed = compute_git_info(dir, Some("develop"), Some(&poisoned), NOW);
        assert_ne!(reprobed.revision_key, first.revision_key, "override change busts the memo");
        assert_ne!(reprobed.landed.as_deref(), Some("SENTINEL"), "a full recompute ran");
    }

    /// The rail's headline false alarm: a squash merge's one new commit matches
    /// none of the branch's individually, so the `git cherry` patch-id check this
    /// relied on reported *every* commit as outstanding.
    #[test]
    fn commits_unlanded_reaches_zero_after_a_squash_merge() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path();
        init_repo(repo);

        git(repo, &["checkout", "--quiet", "-b", "feature"]);
        std::fs::write(repo.join("a.txt"), "a").unwrap();
        git(repo, &["add", "a.txt"]);
        git(repo, &["commit", "--quiet", "-m", "a"]);
        std::fs::write(repo.join("b.txt"), "b").unwrap();
        git(repo, &["add", "b.txt"]);
        git(repo, &["commit", "--quiet", "-m", "b"]);

        git(repo, &["checkout", "--quiet", "main"]);
        git(repo, &["merge", "--squash", "feature"]);
        git(repo, &["commit", "--quiet", "-m", "squashed feature (#1)"]);
        git(repo, &["update-ref", "refs/remotes/origin/main", "main"]);
        git(repo, &["checkout", "--quiet", "feature"]);

        let dir = repo.to_str().unwrap();
        let info = compute_git_info(dir, None, None, NOW);
        assert_eq!(info.commits_ahead, 2);
        assert_eq!(info.commits_unlanded, 0, "a squash-merged branch holds no outstanding work");
        assert_eq!(info.landed.as_deref(), Some("squash-merged"), "and the rail can say why");
    }

    /// The landing probe synthesises commit objects for their patch-ids; in the
    /// repo's own object store they would accumulate on every poll, so
    /// `ops::work_state` redirects them to scratch storage.
    #[test]
    fn computing_git_info_leaves_no_objects_behind_in_the_repo() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path();
        init_repo_with_origin(repo);
        // An unlanded branch probes every commit — the worst litterer.
        git(repo, &["checkout", "--quiet", "-b", "feature"]);
        for n in ["a", "b", "c"] {
            std::fs::write(repo.join(format!("{n}.txt")), n).unwrap();
            git(repo, &["add", "-A"]);
            git(repo, &["commit", "--quiet", "-m", n]);
        }

        let count_objects =
            || walkdir(&repo.join(".git").join("objects")).filter(|p| is_loose_object(p)).count();
        let before = count_objects();
        let info = compute_git_info(repo.to_str().unwrap(), None, None, NOW);
        assert_eq!(info.commits_unlanded, 3, "the probe actually ran");
        assert_eq!(
            count_objects(),
            before,
            "the landing probe must not leave synthetic commits in the object store"
        );
    }

    /// `objects/ab/cdef…` alone: a commit-graph or a temp file is not an object
    /// the probe leaked. Either hash length — the machine's git picks one.
    fn is_loose_object(path: &std::path::Path) -> bool {
        let hex = |s: &str, n: usize| s.len() == n && s.bytes().all(|b| b.is_ascii_hexdigit());
        let name = path.file_name().and_then(|n| n.to_str());
        let dir = path.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str());
        path.is_file()
            && name.is_some_and(|n| hex(n, 38) || hex(n, 62))
            && dir.is_some_and(|d| hex(d, 2))
    }

    /// Recursive, so the count covers the `xx/` fan-out of loose objects.
    fn walkdir(dir: &std::path::Path) -> impl Iterator<Item = std::path::PathBuf> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&d) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    out.push(path);
                }
            }
        }
        out.into_iter()
    }

    /// Committing again after the merge must NOT read as clean, and must count
    /// the one new commit rather than all three.
    #[test]
    fn work_committed_after_a_squash_merge_counts_only_the_new_commit() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path();
        init_repo(repo);

        git(repo, &["checkout", "--quiet", "-b", "feature"]);
        std::fs::write(repo.join("a.txt"), "a").unwrap();
        git(repo, &["add", "a.txt"]);
        git(repo, &["commit", "--quiet", "-m", "a"]);
        std::fs::write(repo.join("b.txt"), "b").unwrap();
        git(repo, &["add", "b.txt"]);
        git(repo, &["commit", "--quiet", "-m", "b"]);

        git(repo, &["checkout", "--quiet", "main"]);
        git(repo, &["merge", "--squash", "feature"]);
        git(repo, &["commit", "--quiet", "-m", "squashed feature (#1)"]);
        git(repo, &["update-ref", "refs/remotes/origin/main", "main"]);

        git(repo, &["checkout", "--quiet", "feature"]);
        std::fs::write(repo.join("c.txt"), "c").unwrap();
        git(repo, &["add", "c.txt"]);
        git(repo, &["commit", "--quiet", "-m", "c, after the merge"]);

        let dir = repo.to_str().unwrap();
        let info = compute_git_info(dir, None, None, NOW);
        assert_eq!(info.commits_ahead, 3);
        assert_eq!(info.commits_unlanded, 1, "only the post-merge commit is outstanding");
        assert_eq!(info.landed, None, "a branch with new work has not fully landed");
    }

    /// A detached HEAD has no branch and no stats, but is still a checkout *of
    /// this repository*. `common_dir` is the rail's row-grouping key, so a bare
    /// default knocked the folder out of its repo's row.
    #[test]
    fn a_detached_head_keeps_its_repository_identity() {
        let root = tempfile::TempDir::new().unwrap();
        init_repo(root.path());
        let dir = root.path().to_str().unwrap();
        let attached = compute_git_info(dir, None, None, NOW);
        assert!(!attached.common_dir.is_empty());

        assert!(
            std::process::Command::new("git")
                .arg("-C")
                .arg(root.path())
                .args(["checkout", "--quiet", "--detach", "HEAD"])
                .status()
                .unwrap()
                .success()
        );

        let info = compute_git_info(dir, None, None, NOW);
        assert!(info.branch.is_empty(), "no branch to report");
        assert_eq!(info.common_dir, attached.common_dir, "…but it's still the same repo");
        assert!(!info.dir_missing);
        assert!(
            info.revision_key.is_empty(),
            "the next poll must fully recompute once HEAD is back on a branch"
        );
    }

    /// A failed open is not proof the checkout stopped being one: a concurrent
    /// `git worktree remove` can fail a read mid-flight. The identity survives.
    #[test]
    fn a_failed_read_keeps_the_identity_but_not_the_stats() {
        let root = tempfile::TempDir::new().unwrap();
        init_repo(root.path());
        let dir = root.path().to_str().unwrap();
        let good = compute_git_info(dir, None, None, NOW);
        assert!(!good.common_dir.is_empty() && !good.branch.is_empty());

        let mut failed = GitInfo::default();
        preserve_identity_on_failed_read(dir, &good, &mut failed);
        assert_eq!(failed.common_dir, good.common_dir);
        assert_eq!(failed.origin_url, good.origin_url);
        assert!(failed.branch.is_empty(), "stats are genuinely unknown");
        assert!(failed.structural_key.is_empty(), "no revalidation token for an answer we lack");
    }

    /// A real answer always wins, a gone directory is a definite answer, and one
    /// that vanished before the store isn't propped up by a stale identity.
    #[test]
    fn preserving_identity_never_overrides_a_real_answer() {
        let root = tempfile::TempDir::new().unwrap();
        init_repo(root.path());
        let dir = root.path().to_str().unwrap();
        let good = compute_git_info(dir, None, None, NOW);

        let mut fresh = GitInfo { common_dir: "/other/.git".to_string(), ..Default::default() };
        preserve_identity_on_failed_read(dir, &good, &mut fresh);
        assert_eq!(fresh.common_dir, "/other/.git");

        let mut missing = GitInfo { dir_missing: true, ..Default::default() };
        preserve_identity_on_failed_read(dir, &good, &mut missing);
        assert!(missing.common_dir.is_empty(), "a ghost row keeps its own top-level row");

        let gone = root.path().join("never-existed");
        let mut failed = GitInfo::default();
        preserve_identity_on_failed_read(gone.to_str().unwrap(), &good, &mut failed);
        assert!(failed.common_dir.is_empty());
    }
}
