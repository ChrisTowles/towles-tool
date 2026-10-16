//! Branch / worktree / diff-stat computation with a short cache.

use std::collections::HashMap;
use std::collections::HashSet;

use serde::{Deserialize, Serialize};

/// Working-tree/commit stats for a session directory, all measured against the same
/// `compared_base` (see [`resolve_base_ref`]).
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
    /// `"squash-merged"`, `"PR merged"`, `"upstream gone"` — or `None` when it has not
    /// fully landed.
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

const GIT_CACHE_TTL_MS: i64 = 60_000;

const FOCUSED_GIT_CACHE_TTL_MS: i64 = 10_000;

const UNFOCUSED_GIT_CACHE_TTL_MS: i64 = 300_000;

/// TTL-as-backup-ceiling plus stale-serve. The recomputing poll loop is Tauri-side.
#[derive(Debug)]
pub struct GitInfoCache {
    entries: HashMap<String, (GitInfo, i64)>,
    /// The checkout being read right now — see [`FOCUSED_GIT_CACHE_TTL_MS`].
    focused: Option<String>,
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
            let work = tt_tasks::ops::work_state(
                &refs,
                std::path::Path::new(dir),
                "HEAD",
                0,
                0,
                tt_tasks::ops::PrProbe::Gh,
            );
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
    let _ = tt_git::cli::fetch_origin(
        std::path::Path::new(dir),
        false,
        std::time::Duration::from_secs(20),
    );
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

/// gitoxide's worktree API is read-only, so this goes through [`tt_git::cli`].
/// `prune` runs either way: a failed remove leaves a stale entry.
pub fn prune_stale_worktree(owner_dir: &str, worktree_dir: &str) -> bool {
    let owner = std::path::Path::new(owner_dir);
    let timeout = std::time::Duration::from_secs(10);
    let removed =
        tt_git::cli::worktree_remove(owner, worktree_dir, true, timeout).is_ok_and(|out| out.ok());
    let _ = tt_git::cli::worktree_prune(owner, timeout);
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
/// baseline. Priority: `base_branch` (the engine's per-folder override, else its
/// PR's base), the `.tt-task` marker's `base=`, then origin/main-or-master. The winner resolves to
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

/// What a checkout holds that its base doesn't — the delete dialog's last look.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchDiff {
    pub branch: String,
    pub compared_base: String,
    pub commits: Vec<CommitStat>,
    /// Merge-base to working tree, untracked included: everything this branch
    /// changed, committed or not.
    pub files: Vec<BranchDiffFile>,
    /// The untracked walk stopped early, so `files` is a floor.
    pub capped: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchDiffFile {
    pub path: String,
    pub old_path: Option<String>,
    /// git's name-status letter, `?` for untracked.
    pub status: String,
    pub lines_added: i64,
    pub lines_removed: i64,
    pub binary: bool,
    /// Differs from `HEAD` — gone for good once the checkout is deleted.
    pub uncommitted: bool,
}

/// `git diff --stat $(git merge-base <base> HEAD)` plus untracked files, each
/// flagged when its change isn't committed yet. `None` for a non-repo dir.
pub fn branch_diff(dir: &str, base_branch: Option<&str>) -> Option<BranchDiff> {
    if dir.is_empty() {
        return None;
    }
    let repo = open_repo(dir)?;
    let compared_base = resolve_base_ref(&repo, dir, base_branch);
    let boundary = repo
        .merge_base(&compared_base, "HEAD")
        .map(|id| id.to_string())
        .unwrap_or_else(|| compared_base.clone());
    let changes = repo.changes_vs(&boundary).ok()?;
    let uncommitted: HashSet<String> = repo
        .changes_vs("HEAD")
        .map(|c| c.files.into_iter().map(|f| f.path).collect())
        .unwrap_or_default();
    let files = changes
        .files
        .into_iter()
        .map(|f| BranchDiffFile {
            uncommitted: uncommitted.contains(&f.path),
            path: f.path,
            old_path: f.old_path,
            status: f.status.to_string(),
            lines_added: f.lines_added,
            lines_removed: f.lines_removed,
            binary: f.binary,
        })
        .collect();
    Some(BranchDiff {
        branch: repo.head_branch().unwrap_or_default(),
        commits: commit_stats(dir, base_branch),
        compared_base,
        files,
        capped: changes.untracked_cap.is_some(),
    })
}

#[cfg(test)]
mod tests;
