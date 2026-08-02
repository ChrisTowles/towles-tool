//! Branch / worktree / diff-stat computation with a short cache.
//!
//! What lives here: the git reads, the porcelain/numstat/ahead-behind parsing,
//! and the TTL cache with stale-serve + explicit invalidation. Transport and
//! watcher concerns — the git poll, the `.git/HEAD` watch, the event broadcast
//! — belong to the Tauri layer.
//!
//! Time is injected via `now_ms` instead of a background clock, and cache
//! misses compute synchronously.

use std::collections::HashMap;
use std::collections::HashSet;

use serde::{Deserialize, Serialize};

/// Working-tree/commit stats for a session directory, every one measured against the
/// same `compared_base` (see [`resolve_base_ref`]).
///
/// **The committed and uncommitted diffs are separate quantities and are never
/// summed.** `uncommitted_*` is what deleting this checkout destroys, `committed_*` is
/// what survives on the branch.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct GitInfo {
    pub branch: String,
    pub is_worktree: bool,
    /// Files touched by `merge_base(HEAD, compared_base)..HEAD`, working tree excluded.
    pub committed_files: i64,
    pub committed_added: i64,
    pub committed_removed: i64,
    /// Files touched between `HEAD` and the working tree — staged, unstaged and
    /// untracked alike. Untracked ones contribute no line counts.
    pub uncommitted_files: i64,
    pub uncommitted_added: i64,
    pub uncommitted_removed: i64,
    /// `uncommitted_files` is a floor: an untracked directory was too large to list and
    /// stayed collapsed, so the rail renders the number with a `+`.
    #[serde(default)]
    pub uncommitted_capped: bool,
    /// Commits on HEAD that `compared_base` doesn't have.
    pub commits_ahead: i64,
    /// Kept separate from `commits_ahead`, not a signed delta, so "3 ahead, 2 behind"
    /// doesn't collapse to a meaningless "+1".
    pub commits_behind: i64,
    /// Exactly `uncommitted_files > 0`, so the boolean and the number can never
    /// disagree on screen. Not `status().is_dirty()`, which reports a path whose stat
    /// cache is stale even after an edit was reverted to identical content.
    pub dirty: bool,
    /// Of `commits_ahead`, how many hold changes `compared_base` has never received —
    /// so unlike `commits_ahead` it drops to 0 after a rebase *or squash* merge.
    /// [`tt_tasks::landed`] covers all three landing shapes; `git cherry`'s patch-id
    /// comparison reported every commit of a squash-merged branch as outstanding.
    pub commits_unlanded: i64,
    /// How this branch's work reached `compared_base` — `"merged"`, `"rebase-merged"`,
    /// `"squash-merged"`, `"upstream gone"` — or `None` when it has not fully landed.
    /// Lets the rail say *why* a branch is finished rather than infer it from a GitHub
    /// PR state, which says nothing about a branch merged locally.
    pub landed: Option<String>,
    /// Display-only (repo name derivation) — NOT the Folder Rail nesting key; two
    /// unrelated clones can share an origin. See [`Self::common_dir`] for that.
    pub origin_url: Option<String>,
    /// Canonicalized `--git-common-dir`, identical across every linked worktree of one
    /// repo and nowhere else — what [`crate::bridge::assemble_state`] groups rail rows
    /// by, so only *actual* worktrees nest together. Empty for a non-repo dir.
    pub common_dir: String,
    /// This repo's OTHER *linked* worktrees (this dir and the main checkout excluded).
    /// Not on the wire — the detected-record reconciler and removal read it.
    pub linked_worktree_dirs: Vec<String>,
    /// When these numbers were last *verified*, stamped on every compute including the
    /// ref-unchanged fast path, which still re-reads the working tree.
    ///
    /// Exists because "is this stale or is nothing happening?" is otherwise
    /// unanswerable from the UI: long stretches of a correct, unchanging number are
    /// normal and look identical to a wedged poll. 0 when never computed.
    pub computed_at_ms: i64,
    /// Epoch ms of `HEAD`'s commit time. Deliberately HEAD's own time rather than a
    /// `base..HEAD` tip: a main checkout sitting on `origin/main` has no commits of its
    /// own and would read as never-touched, backwards for the worked-recently filter.
    pub head_commit_ms: i64,
    /// Newest mtime among the paths the working tree reports as changed; 0 when clean.
    /// The half of "somebody is working here" no `.git` file can answer, since an
    /// unstaged edit moves neither `HEAD` nor `index` (see [`control_files`]).
    pub worktree_touched_ms: i64,
    /// True when `dir` doesn't exist on disk, distinguishing a moved/deleted checkout
    /// from a present-but-non-git one — both otherwise yield an empty [`GitInfo`].
    pub dir_missing: bool,
    /// For a worktree only: the ref it was created from, per its `.tt-task` marker.
    /// What [`resolve_base_ref`] auto-compares against absent a user override.
    pub task_base_branch: Option<String>,
    /// [`resolve_base_ref`]'s result — what every stat here was compared against, so
    /// the rail can label its numbers instead of always implying "vs main". Empty when
    /// `compute_git_info` never ran.
    pub compared_base: String,
    /// Filesystem-derived here like `dir_missing`, so the client can gate its
    /// dev-servers affordance without a per-poll file read of its own.
    pub has_launch_config: bool,
    /// Revalidation token (see [`probe_fingerprint`]) letting a poll skip the landing
    /// probe when nothing it reads has moved. Never sent to the client.
    #[serde(skip)]
    pub probe_key: String,
    /// Revalidation token for `is_worktree`/`common_dir`/`worktree_dirs`/`origin_url`
    /// (see [`structural_fingerprint`]).
    #[serde(skip)]
    pub structural_key: String,
    /// This checkout's own gitdir, resolved from the filesystem ([`resolve_git_dir_fs`])
    /// — `.git/worktrees/<name>` for a linked worktree, which is where *this* checkout's
    /// `HEAD`/`index` live. Not on the wire; `control_watch_files` watches off it.
    #[serde(skip)]
    pub git_dir: String,
    /// Revalidation token for the ref-derived half (see [`revision_fingerprint`]): while
    /// it matches, a poll recomputes only the working-tree half.
    #[serde(skip)]
    pub revision_key: String,
    /// The exact ref `diff --numstat` ran against, so the fast path can re-diff without
    /// resolving the merge-base again. Empty until the first full compute.
    #[serde(skip)]
    pub diff_base: String,
}

/// Backup ceiling for an entry the control-file watch never registered or missed an
/// event for. A real change invalidates its dir immediately via
/// [`GitInfoCache::invalidate`]; this is long *because* the normal path is
/// event-driven, not because staleness beyond it is fine.
const GIT_CACHE_TTL_MS: i64 = 60_000;

/// The ceiling for the one checkout whose diff pane is open. lazygit re-walks its
/// single repo every 10s with no change detection at all, which is what makes an
/// unstaged edit show up promptly; the fleet can't afford that N checkouts over, but
/// the row actually being read can.
const FOCUSED_GIT_CACHE_TTL_MS: i64 = 10_000;

/// TTL-as-backup-ceiling plus stale-serve. The poll loop that recomputes entries lives
/// in the Tauri layer, not here.
#[derive(Debug, Default)]
pub struct GitInfoCache {
    entries: HashMap<String, (GitInfo, i64)>,
    /// The checkout being read right now — see [`FOCUSED_GIT_CACHE_TTL_MS`].
    focused: Option<String>,
}

impl GitInfoCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert/replace an entry stamped at `now_ms`.
    pub fn insert(&mut self, dir: &str, info: GitInfo, now_ms: i64) {
        self.entries.insert(dir.to_string(), (info, now_ms));
    }

    /// Whether the entry for `dir` exists and is within its TTL.
    pub fn is_fresh(&self, dir: &str, now_ms: i64) -> bool {
        let ttl = if self.focused.as_deref() == Some(dir) {
            FOCUSED_GIT_CACHE_TTL_MS
        } else {
            GIT_CACHE_TTL_MS
        };
        self.entries.get(dir).is_some_and(|(_, ts)| now_ms - ts < ttl)
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

    /// Cache-only, fresh or stale: recomputing is the poll's job, never a read's.
    pub fn get(&self, dir: &str) -> GitInfo {
        if dir.is_empty() {
            return GitInfo::default();
        }
        self.entries.get(dir).map(|(info, _)| info.clone()).unwrap_or_default()
    }

    /// Mark entries stale (ts=0) so the next read still serves them but they're no
    /// longer fresh.
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

    /// For a checkout gone for good. Unlike [`Self::invalidate`] there will be no
    /// recompute, and a later task at the same path must not inherit the dead one's
    /// branch and stats. Returns whether an entry went.
    pub fn forget(&mut self, dir: &str) -> bool {
        self.entries.remove(dir).is_some()
    }
}

/// From the process-wide cache. `None` for a directory that is not a repo.
fn open_repo(dir: &str) -> Option<tt_git::repo::Repo> {
    tt_git::repo::open(std::path::Path::new(dir)).ok()
}

/// Every input the landing probe reads: `HEAD`'s sha, the base's sha, and whether the
/// upstream is gone. `work_state` is a pure function of those three, so an unchanged
/// fingerprint means the previous answer is still exact.
///
/// Empty when anything is unreadable — a partial fingerprint must never compare equal
/// to a real one.
fn probe_fingerprint(repo: &tt_git::repo::Repo, branch: &str, compared_base: &str) -> String {
    let (Some(head), Some(base)) = (repo.head_id(), repo.resolve(compared_base)) else {
        return String::new();
    };
    let gone = repo.upstream_gone(&format!("refs/heads/{branch}"));
    format!("{head} {base} {gone}")
}

/// The mtimes of `common_dir`'s `worktrees` subdirectory (any `worktree add`/`remove`)
/// and its `config` (a `remote set-url`). Those facts are structural, not working-tree
/// state, so two `fs::metadata` calls are unconditionally cheaper than the directory
/// walk plus config read they guard.
///
/// Empty only when `common_dir` is empty or unreadable. A missing `worktrees` is a
/// legitimate stable state, so it stamps a sentinel rather than folding into empty.
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
/// repository at all — a failed [`open_repo`] can be transient, and storing the bare
/// default blanks `common_dir`, knocking the checkout out of its repo's rail row for a
/// tick. Stats still go empty; those really are unknown.
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
    // NOT the revalidation tokens: they stand for answers this compute never produced,
    // so leaving them empty forces the next poll into a full recompute.
}

/// What a checkout *is*, independent of where its HEAD points.
struct Structural {
    origin_url: Option<String>,
    common_dir: String,
    linked_worktree_dirs: Vec<String>,
    structural_key: String,
    git_dir: String,
    is_worktree: bool,
}

/// Derive the structural facts, revalidating the previous answer against
/// [`structural_fingerprint`] first.
///
/// `git_dir`/`is_worktree` are never reused: they're resolved from the filesystem
/// rather than the repository, and `control_watch_files` needs them fresh every call.
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
/// `revision_key` is load-bearing — it keeps the next poll off the ref-unchanged fast
/// path, so the moment HEAD lands on a branch the full answer is recomputed.
fn structural_only(
    dir: &str,
    repo: &tt_git::repo::Repo,
    previous: Option<&GitInfo>,
    now_ms: i64,
) -> GitInfo {
    let s = structural_facts(dir, repo, previous);
    GitInfo {
        computed_at_ms: now_ms,
        // HEAD still points at a commit mid-rebase, and the worked-recently filter
        // would otherwise drop the checkout being rebased.
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
/// file containing `gitdir: <path>` for a linked one — rather than by spawning
/// `rev-parse --git-dir` for what is one `fs::metadata` plus a one-line read.
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
/// only — an unstaged edit touches none, hence the poll backup. Built from the fields
/// as last computed, so it trails a branch switch by a tick and self-corrects.
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

/// [`control_files`] from a cached [`GitInfo`]'s own fields. Empty before the first
/// compute — the backup poll covers that dir until it joins the watched set.
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
/// ref and the [`control_files`] mtimes minus `index`, excluded because `status`/`diff`
/// rewrite its stat cache every poll and would defeat the reuse. Only `fs::metadata`.
/// Empty on any stat error — a partial fingerprint must never equal a real one.
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
    // The structural facts are reused wholesale on the fast path too, yet a
    // `worktree add`/`remote set-url` changes them without touching any ref file — so
    // their fingerprint is folded in here and busts the fast path.
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

/// Compute a folder's git info. `previous` is that folder's last cached value, used to
/// skip repeat work when nothing it depends on has moved — the ref-derived half, the
/// landing probe, the structural facts. Pass `None` to force a full computation.
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

    // Fast path: when nothing the ref-derived half reads has moved, reuse it wholesale
    // and pay only for the working-tree half. That is the sole part no `.git` mtime can
    // stand in for, so it is all a backup-poll tick over an idle repo should cost.
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
            // Everything ref-derived and structural is carried from `prev`; the
            // fingerprint match proves it is still exact.
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
            // Cheap filesystem facts, not repository reads — kept fresh so a
            // launch.json appearing shows up without waiting a whole poll.
            info.task_base_branch = tt_tasks::read_task_base(std::path::Path::new(dir));
            info.has_launch_config = crate::launch::has_launch_file(std::path::Path::new(dir));
            return info;
        }
    }

    // HEAD is detached or unborn. Everything ref-derived is genuinely unknown, but
    // which repository this checkout belongs to doesn't depend on where HEAD points —
    // a bare default here dropped `common_dir`, and a `git rebase` knocked the checkout
    // out of its repo's rail row until HEAD landed on a branch again.
    let Some(branch) = repo.head_branch().filter(|b| !b.is_empty()) else {
        return structural_only(dir, &repo, previous, now_ms);
    };
    let compared_base = resolve_base_ref(&repo, dir, base_branch_override);
    // The diff baseline is the merge-base, not the base tip: a branch's stats
    // must describe what *it* changed, not also what the base gained since.
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
    // Nothing ahead trivially means nothing unlanded.
    if info.commits_ahead > 0 {
        // Through `ops::work_state` rather than the probe directly, so there is one
        // implementation of "has this landed". Reusing the previous answer when nothing
        // the probe reads has moved is exact, not a staleness tradeoff.
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
    // Stamped from the values just computed, so the next poll can take the fast path.
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

/// The two diffs of [`GitInfo`], measured separately and never summed. Untracked files
/// count toward `uncommitted_files` — losing them is exactly what deleting a checkout
/// does — but contribute no line counts. Every other field is filled by the caller.
fn diff_stats(repo: &tt_git::repo::Repo, branch: &str, is_worktree: bool, base: &str) -> GitInfo {
    let uncommitted = repo.changes_vs("HEAD").unwrap_or_default();
    let committed = repo.committed_totals_vs(base).unwrap_or_default();
    // Reuses the paths the diff just produced rather than a second status walk.
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
        dirty: !uncommitted.files.is_empty(),
        worktree_touched_ms: worktree_touched * 1000,
        ..Default::default()
    }
}

/// Deduped by common git dir, so N worktrees of one repo trigger one network call.
/// Failures (offline, no origin, auth prompt) are swallowed — this only refreshes the
/// `origin/main` ref [`compute_git_info`] reads.
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

/// Best-effort refresh of the local `origin/main` remote-tracking ref.
fn fetch_origin(dir: &str) {
    let full = ["-C", dir, "fetch", "--quiet", "origin"];
    let _ = tt_exec::run_with_timeout("git", &full, std::time::Duration::from_secs(20));
}

/// The repo's shared `.git` dir, used to dedup fetches. Empty for a non-repo dir.
fn git_common_dir(dir: &str) -> String {
    open_repo(dir).map(|repo| repo.common_dir().to_string_lossy().into_owned()).unwrap_or_default()
}

/// This repo's other linked worktrees, `dir` itself and the main checkout excluded.
/// `dir` is compared canonically: `Repo::worktrees` reports resolved paths, and a
/// checkout reached through a symlink must still drop out of its own sibling list.
fn other_worktrees(repo: &tt_git::repo::Repo, dir: &str) -> Vec<String> {
    let self_dir = std::fs::canonicalize(dir).unwrap_or_else(|_| std::path::PathBuf::from(dir));
    repo.worktrees()
        .into_iter()
        .filter(|w| !w.is_main && std::path::Path::new(&w.dir) != self_dir)
        .map(|w| w.dir)
        .collect()
}

/// One of the two places this module still spawns `git` (gitoxide's worktree API is
/// read-only). `--force` because the directory is already gone; `prune` runs either
/// way, since a failed remove can leave a stale entry only `prune` clears.
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
    // The cached handle would otherwise hold an open object database against a
    // directory that no longer exists.
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

/// The ref every "vs main" comparison uses — the diff pane's `DiffMode::Main` *and*
/// [`compute_git_info`]'s stats, so the rail's numbers match the pane. Priority: the
/// per-folder `base_branch` override, then the `.tt-task` marker's `base=`, then the
/// origin/main-or-master auto-detect.
///
/// Whichever wins resolves to `origin/<name>`, never the local branch: both may have
/// moved, and the pane wants the pushed baseline. Local only when no remote exists.
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

/// What baseline the diff pane compares the working tree against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffMode {
    /// Everything on this branch vs where it forked from origin/main (merge-base).
    Main,
    /// Only what isn't committed yet: staged + unstaged, vs HEAD.
    Uncommitted,
}

/// `status` is git's name-status letter (or `?` for untracked); `old_path` is set on
/// renames/copies, where the content at the base lives.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub lines_added: i64,
    pub lines_removed: i64,
    /// Nonzero on a `?` row that is a whole untracked directory left collapsed at a
    /// cap, so the pane can say "1000+ files" instead of one unopenable row.
    pub untracked_files: i64,
}

/// The diff pane's file list, and whether producing it was cut short.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFiles {
    pub files: Vec<DiffFile>,
    /// The untracked directory whose expansion stopped at the cap, if any.
    pub untracked_cap: Option<UntrackedCapInfo>,
}

/// What the pane's banner needs to name the directory almost certainly missing from
/// `.gitignore`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UntrackedCapInfo {
    pub dir: String,
    pub files: i64,
    /// The whole diff's budget ran out, so other untracked directories are missing
    /// entirely — not just this one's contents.
    pub total: bool,
}

/// Merge-base with the resolved base ref for `Main`, HEAD for `Uncommitted`.
fn resolve_diff_base(
    repo: &tt_git::repo::Repo,
    dir: &str,
    mode: DiffMode,
    base_branch: Option<&str>,
) -> String {
    match mode {
        DiffMode::Main => {
            let base_ref = resolve_base_ref(repo, dir, base_branch);
            repo.merge_base("HEAD", &base_ref)
                .map(|id| id.to_string())
                .unwrap_or_else(|| "HEAD".to_string())
        }
        DiffMode::Uncommitted => "HEAD".to_string(),
    }
}

/// Rename-aware, baseline picked by `mode`. Untracked files appear with status `?` and
/// no line counts. Empty when `dir` isn't a repo or nothing changed.
pub fn diff_files(dir: &str, mode: DiffMode, base_branch: Option<&str>) -> DiffFiles {
    if dir.is_empty() {
        return DiffFiles::default();
    }
    let Some(repo) = open_repo(dir) else {
        return DiffFiles::default();
    };
    let base = resolve_diff_base(&repo, dir, mode, base_branch);
    let changes = repo.changes_vs(&base).unwrap_or_default();
    let mut files: Vec<DiffFile> = changes
        .files
        .into_iter()
        .map(|change| DiffFile {
            path: change.path,
            old_path: change.old_path,
            status: change.status.to_string(),
            lines_added: change.lines_added,
            lines_removed: change.lines_removed,
            untracked_files: change.untracked_files,
        })
        .collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let untracked_cap = changes.untracked_cap.map(|cap| UntrackedCapInfo {
        dir: cap.dir,
        files: cap.files,
        total: cap.total,
    });
    DiffFiles { files, untracked_cap }
}

/// The original side of the diff editor. `None` when the file doesn't exist at the
/// baseline, `dir` isn't a repo, or the content isn't UTF-8.
pub fn base_file_content(
    dir: &str,
    mode: DiffMode,
    base_branch: Option<&str>,
    path: &str,
) -> Option<String> {
    if dir.is_empty() || path.is_empty() {
        return None;
    }
    let repo = open_repo(dir)?;
    let base = resolve_diff_base(&repo, dir, mode, base_branch);
    let content = repo.file_at(&base, path)?;
    String::from_utf8(content).ok()
}

/// One commit ahead of `compared_base` with its own line-count diff, not the branch's
/// cumulative total. Powers the `CommittedChip` hover's per-commit breakdown.
///
/// `camelCase` is load-bearing: the frontend reads `linesAdded`/`linesRemoved`, and
/// without the rename every commit row rendered a bare `+`/`−` with no number.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitStat {
    pub sha: String,
    pub subject: String,
    pub lines_added: i64,
    pub lines_removed: i64,
}

/// Commits on HEAD that `compared_base` doesn't have, oldest first. Empty when `dir`
/// isn't a repo or nothing is ahead.
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

    /// Fixed clock for `compute_git_info`'s `now_ms` — nothing under test reads
    /// it back except `computed_at_ms`.
    const NOW: i64 = 1_700_000_000_000;

    /// `git -C <dir> <args>`, asserting success. The fixture builder for every
    /// test here that needs a real repository on disk.
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

    /// [`other_worktrees`]' linked siblings by directory.
    fn worktree_dirs_of(dir: &str) -> Vec<String> {
        open_repo(dir).map(|repo| other_worktrees(&repo, dir)).unwrap_or_default()
    }

    /// A repo on `main` with one commit of `f.txt` holding `contents`. The
    /// content is a parameter because the diff-counting tests care what the
    /// baseline commit's last line looks like.
    fn init_repo_with(repo: &std::path::Path, contents: &str) {
        git(repo, &["init", "--quiet", "-b", "main"]);
        git(repo, &["config", "user.email", "test@example.com"]);
        git(repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("f.txt"), contents).unwrap();
        git(repo, &["add", "f.txt"]);
        git(repo, &["commit", "--quiet", "-m", "init"]);
    }

    /// The common case: one commit, `f.txt` = `"1"`.
    fn init_repo(repo: &std::path::Path) {
        init_repo_with(repo, "1");
    }

    /// [`init_repo`] plus a local `origin/main` remote-tracking ref, for the
    /// tests whose stats are measured against the default base.
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
        // Use epoch-scale timestamps: invalidate() zeroes the stamp, which only
        // reads as stale when `now_ms` is a real epoch (≫ TTL), matching TS.
        let t0 = 1_700_000_000_000;
        cache.insert("/repo", info.clone(), t0);
        assert!(cache.is_fresh("/repo", t0));
        assert!(cache.is_fresh("/repo", t0 + GIT_CACHE_TTL_MS - 1)); // just under TTL
        assert!(!cache.is_fresh("/repo", t0 + GIT_CACHE_TTL_MS)); // exactly TTL later → stale
        // Stale entries still serve.
        assert_eq!(cache.get("/repo"), info);
        // Invalidate forces stale immediately (stamp → 0).
        cache.invalidate(Some("/repo"));
        assert!(!cache.is_fresh("/repo", t0));
        assert_eq!(cache.get("/repo"), info); // still served
    }

    /// The focused checkout goes stale at the short ceiling while its
    /// neighbours — same cache, same stamp — keep the fleet-wide one.
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

        // Releasing restores it — a closed pane must not leave one row polling.
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
        let root = tempfile::TempDir::new().unwrap();
        let main = root.path().join("main");
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
        let scratch = root.path().join("scratch-ext");
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

        // Both linked siblings are discovered; nothing on disk says which the
        // user asked for, so the engine decides that from the board.
        let linked = worktree_dirs_of(main.to_str().unwrap());
        assert_eq!(sorted(linked), sorted(vec![path_s(&task), path_s(&scratch)]));

        // From a task's perspective the primary checkout is never listed —
        // it's what a repo group nests under, not a discovery candidate.
        let linked = worktree_dirs_of(task.to_str().unwrap());
        assert_eq!(linked, vec![path_s(&scratch)]);
    }

    #[test]
    fn prune_stale_worktree_clears_a_deleted_but_unpruned_registration() {
        let root = tempfile::TempDir::new().unwrap();
        let main = root.path().join("main");
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

        // A bare `rm -rf` leaves git's `.git/worktrees/thing` registration behind, so
        // `worktree list` keeps reporting it — the fact `prune_stale_worktree` targets.
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

    #[test]
    fn resolve_base_ref_prefers_a_verified_override_over_the_main_default() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path();
        init_repo(repo);
        git(repo, &["branch", "develop"]);

        let dir = repo.to_str().unwrap();
        // A local branch with no matching remote ref: the override resolves
        // directly to the local branch name.
        assert_eq!(
            resolve_base_ref(&open_repo(dir).expect("repo"), dir, Some("develop")),
            "develop"
        );
        // A leading "origin/" on the override is stripped before re-adding it,
        // so passing either form of the same branch resolves identically.
        assert_eq!(
            resolve_base_ref(&open_repo(dir).expect("repo"), dir, Some("origin/develop")),
            "develop"
        );
        // An override that resolves to nothing (no such branch, no remote)
        // falls back to the origin/main-or-master auto-detect.
        assert_eq!(
            resolve_base_ref(&open_repo(dir).expect("repo"), dir, Some("no-such-branch")),
            resolve_origin_main(&open_repo(dir).expect("repo"))
        );
        // No override at all: same auto-detect.
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
        // A local "origin/develop" remote-tracking ref so resolve_base_ref
        // has something to prefer over the local "develop" branch.
        git(repo, &["branch", "develop"]);
        git(repo, &["update-ref", "refs/remotes/origin/develop", "develop"]);
        git(repo, &["update-ref", "refs/remotes/origin/main", "main"]);

        std::fs::write(
            repo.join(tt_tasks::MARKER_FILE),
            tt_tasks::marker_contents("task-name", "develop", "main"),
        )
        .unwrap();

        let dir = repo.to_str().unwrap();
        // No explicit override: the task's own marker base wins over the
        // origin/main auto-detect, and resolves to the origin remote copy.
        assert_eq!(resolve_base_ref(&open_repo(dir).expect("repo"), dir, None), "origin/develop");
        // An explicit per-folder override still takes priority over the
        // task's recorded creation base.
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
        // Present but not a git repo: still not "missing".
        let info = compute_git_info(root.path().to_str().unwrap(), None, None, NOW);
        assert!(!info.dir_missing);
    }

    /// A `node_modules` no `.gitignore` covers: the rail must report a floor and say
    /// so, and the pane must name the directory rather than list a million rows.
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

        let listed = diff_files(dir, DiffMode::Uncommitted, None);
        assert_eq!(listed.files.len(), 1, "the directory stays one row: {:?}", listed.files);
        assert_eq!(listed.files[0].status, "?");
        assert!(listed.files[0].untracked_files > 0);
        let cap = listed.untracked_cap.expect("the pane can name the directory");
        assert_eq!(cap.dir, "node_modules");
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

        // A tracked file edited but not staged: invisible to `.git` mtimes,
        // which is exactly why the poll still reads the working tree.
        std::fs::write(root.path().join("f.txt"), "1\n2\n").unwrap();
        let edited = compute_git_info(dir, None, None, NOW);
        assert!(edited.dirty);
        assert_eq!(edited.uncommitted_files, 1);
        assert_eq!((edited.uncommitted_added, edited.uncommitted_removed), (2, 1));

        // Untracked files have no diff, but they are still changes the user
        // can see, so they count toward `uncommitted_files` with no line counts.
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

    /// The two signals behind the rail's worked-recently filter. `head_commit_ms`
    /// answers even on the base branch (where `last_own_commit_unix` is `None`),
    /// and `worktree_touched_ms` covers the unstaged edit no `.git` mtime sees.
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

    /// The whole point of the split: two disjoint quantities, so neither number can be
    /// read as belonging to the other. The old single ± measured the working tree
    /// against the merge-base, folding an uncommitted edit into the commit count's ±.
    #[test]
    fn committed_and_uncommitted_diffs_are_disjoint() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path();
        let dir = repo.to_str().unwrap();

        // A trailing newline on the base file, so the numbers below are the
        // ones `git diff` prints.
        init_repo_with(repo, "1\n");
        git(repo, &["update-ref", "refs/remotes/origin/main", "main"]);

        // One commit ahead of the base: +2 committed.
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

        // Now an uncommitted edit on top. The committed half must not move —
        // it is a property of the commits, not of the working tree.
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

        // A non-task checkout has no marker: no task base surfaced.
        let info = compute_git_info(repo.to_str().unwrap(), None, None, NOW);
        assert_eq!(info.task_base_branch, None);

        // Writing the `.tt-task` marker surfaces its `base=` field, so the
        // diff pane can show what a task auto-compares against.
        std::fs::write(
            repo.join(tt_tasks::MARKER_FILE),
            tt_tasks::marker_contents("s", "develop", "main"),
        )
        .unwrap();
        let info = compute_git_info(repo.to_str().unwrap(), None, None, NOW);
        assert_eq!(info.task_base_branch, Some("develop".to_string()));
    }

    /// The bug this module used to have: stats always measured against origin/main,
    /// even for a folder whose diff pane compares against something else. Both must
    /// come from the same `resolve_base_ref` baseline.
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

        // Fake remote-tracking refs (no real remote needed for this test).
        git(repo, &["update-ref", "refs/remotes/origin/main", "main"]);
        git(repo, &["update-ref", "refs/remotes/origin/develop", "develop"]);

        let dir = repo.to_str().unwrap();

        // vs origin/main (auto-detect, no override): both commits count.
        let vs_main = compute_git_info(dir, None, None, NOW);
        assert_eq!(vs_main.compared_base, "origin/main");
        assert_eq!(vs_main.commits_ahead, 2);

        // vs an explicit "develop" override: only feature's own commit counts.
        let vs_develop = compute_git_info(dir, Some("develop"), None, NOW);
        assert_eq!(vs_develop.compared_base, "origin/develop");
        assert_eq!(vs_develop.commits_ahead, 1);
    }

    /// The scenario this field exists for: a rebase merge replays a branch's commits
    /// onto main under new SHAs, so `commits_ahead` never reaches 0 for that branch's
    /// checkout even though its content landed. `commits_unlanded` must reach 0 anyway,
    /// or "safe to delete" can never fire on this repo's workflow.
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

        // What a rebase-merged PR leaves behind: the same change landed on main under
        // a new SHA, main having moved on with an unrelated commit first.
        git(repo, &["checkout", "--quiet", "main"]);
        std::fs::write(repo.join("other.txt"), "unrelated").unwrap();
        git(repo, &["add", "other.txt"]);
        git(repo, &["commit", "--quiet", "-m", "unrelated on main"]);
        git(repo, &["cherry-pick", "--quiet", &feature_commit]);
        git(repo, &["update-ref", "refs/remotes/origin/main", "main"]);
        git(repo, &["checkout", "--quiet", "feature"]);

        let dir = repo.to_str().unwrap();
        let info = compute_git_info(dir, None, None, NOW);
        // Still "ahead" by SHA reachability — feature's own commit is a
        // different object than the one cherry-picked onto main.
        assert_eq!(info.commits_ahead, 1);
        // But fully landed by content — nothing to unland.
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

    /// An entry stamped with a `now` captured *before* a slow batch is born already
    /// past the TTL, so the next poll recomputes immediately — an unbounded loop. The
    /// arithmetic behind a real incident: ~20 git subprocesses/sec around the clock.
    /// Stamp with the time the batch *finished*.
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

    /// The structural guard against that same storm: an unmoved probe answer is reused,
    /// so a hot poll costs three cheap reads instead of ~192 subprocesses. The previous
    /// answer is poisoned — if it survives, the probe genuinely did not run.
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

        // Moving HEAD changes the fingerprint, which must force a real probe and
        // discard the poisoned answer.
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
        // Exactly what `rev-parse --git-dir` answers, reached with zero spawns. The
        // test spawns it precisely because that is the thing being agreed with.
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

    /// `compute_git_info` populates `git_dir` — and so what `control_files_for` watches
    /// — purely from the filesystem, for a plain checkout and a linked worktree alike.
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
    /// its own gitdir under `<common>/worktrees/<name>/`, while every ref it compares
    /// against lives in the shared common dir. Watching one of the two would miss
    /// either the worktree's branch switches or a commit landing on its base.
    #[test]
    fn control_files_split_across_the_worktree_gitdir_and_the_shared_common_dir() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path().join("main");
        let worktree = root.path().join("task");
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

    /// The watch set is *actionable*, not just correct: registered the way the host's
    /// scan loop does it, a `git checkout -b` must surface within a debounce window
    /// rather than on the [`GIT_CACHE_TTL_MS`] backup ceiling.
    #[test]
    fn a_branch_switch_fires_the_control_watch_far_sooner_than_the_backup_poll() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path();
        init_repo(repo);
        let dir = repo.to_str().unwrap();
        let before = compute_git_info(dir, None, None, NOW);
        assert_eq!(before.branch, "main");

        let (fired_tx, fired_rx) = std::sync::mpsc::channel::<Vec<std::path::PathBuf>>();
        let mut notifier = crate::fs_notify::MultiFileNotifier::new(move |batch| {
            let _ = fired_tx.send(batch);
        })
        .unwrap();
        // Same tolerance as the host's registration diff: a control file whose
        // parent doesn't exist yet (no `refs/remotes/origin` in a repo with no
        // remote) is skipped, never fatal.
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

    /// The other half of the same idea, applied to `is_worktree`/`common_dir`/
    /// `worktree_dirs`/`origin_url` — structural facts, not working-tree state,
    /// so they're worth revalidating from two `fs::metadata` calls instead of
    /// re-deriving via four more git spawns on every poll of an unchanged repo.
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

        // Poisoned with a value `compute_git_info` could never itself produce —
        // if it survives, the four structural spawns genuinely did not run.
        let mut poisoned = first.clone();
        poisoned.origin_url = Some("sentinel".to_string());

        let reused = compute_git_info(dir, None, Some(&poisoned), NOW);
        assert_eq!(
            reused.origin_url.as_deref(),
            Some("sentinel"),
            "nothing structural moved, so the cached facts must be carried over"
        );
        assert_eq!(reused.structural_key, first.structural_key);

        // `git worktree add` touches common_dir/worktrees's mtime, which must
        // invalidate the memo and force a real re-derive.
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
        // Proves a real re-derive ran rather than returning the poisoned value.
        assert_ne!(reprobed.origin_url.as_deref(), Some("sentinel"));
        let sibling_dir = path_s(&std::fs::canonicalize(&sibling).unwrap());
        assert!(reprobed.linked_worktree_dirs.contains(&sibling_dir));
    }

    /// When no ref has moved, the ref-derived half is reused wholesale and only the
    /// working-tree half is recomputed, so a backup-poll tick over an idle repo pays
    /// for two of the nine reads. Proven by poisoning ref-derived fields the real repo
    /// could never produce and watching them survive a working-tree change.
    #[test]
    fn unchanged_refs_reuse_the_ref_derived_half_but_still_refresh_the_working_tree() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path();
        init_repo(repo);
        let dir = repo.to_str().unwrap();

        let first = compute_git_info(dir, None, None, NOW);
        assert!(!first.revision_key.is_empty(), "a resolved repo carries a revision fingerprint");
        assert!(!first.dirty, "the tree is clean after the initial commit");

        // Poison ref-derived fields with values a real compute could never
        // produce here; the fingerprint is keyed off the ref *files*, not these
        // values, so it still matches and the fast path must carry them over.
        let mut poisoned = first.clone();
        poisoned.commits_ahead = 999;
        poisoned.landed = Some("SENTINEL".to_string());

        // Dirty the working tree *after* the first compute.
        std::fs::write(repo.join("untracked.txt"), "x").unwrap();

        let reused = compute_git_info(dir, None, Some(&poisoned), NOW);
        assert_eq!(reused.commits_ahead, 999, "ref-derived half reused, not recomputed");
        assert_eq!(reused.landed.as_deref(), Some("SENTINEL"), "landing answer reused");
        assert_eq!(reused.revision_key, first.revision_key, "fingerprint stable while refs idle");
        // …but the working-tree half was genuinely re-read.
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

        // A commit moves HEAD (and refs/heads/main) → the fingerprint must change
        // and the ref-derived half must be recomputed, clearing the sentinel.
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

        // Same refs, but a different base override: the fingerprint folds the
        // override in, so it changes and the base is re-resolved rather than the
        // stale ref-derived half being served.
        let reprobed = compute_git_info(dir, Some("develop"), Some(&poisoned), NOW);
        assert_ne!(reprobed.revision_key, first.revision_key, "override change busts the memo");
        assert_ne!(reprobed.landed.as_deref(), Some("SENTINEL"), "a full recompute ran");
    }

    /// The rail's headline false alarm. A squash merge collapses the branch's
    /// commits into one new commit whose diff matches none of them
    /// individually, so the `git cherry` patch-id check this used to rely on
    /// reported *every* commit as outstanding — a merged task looked like it
    /// still held work, and "safe to delete" could never fire.
    #[test]
    fn commits_unlanded_reaches_zero_after_a_squash_merge() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path();
        init_repo(repo);

        // Two commits, so the squash genuinely collapses several into one.
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
        // Still ahead by SHA reachability — the squash commit is a new object.
        assert_eq!(info.commits_ahead, 2);
        assert_eq!(info.commits_unlanded, 0, "a squash-merged branch holds no outstanding work");
        assert_eq!(info.landed.as_deref(), Some("squash-merged"), "and the rail can say why");
    }

    /// The landing probe synthesises commit objects for their patch-ids. Landing those
    /// in the repo's own object store would accumulate them indefinitely on every poll,
    /// so `ops::work_state` redirects them to scratch storage — and nothing else in the
    /// suite would notice if that stopped working.
    #[test]
    fn computing_git_info_leaves_no_objects_behind_in_the_repo() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path();
        init_repo_with_origin(repo);
        // An unlanded branch: the path that probes every commit, so the one
        // that would litter the most.
        git(repo, &["checkout", "--quiet", "-b", "feature"]);
        for n in ["a", "b", "c"] {
            std::fs::write(repo.join(format!("{n}.txt")), n).unwrap();
            git(repo, &["add", "-A"]);
            git(repo, &["commit", "--quiet", "-m", n]);
        }

        let count_objects =
            || walkdir(&repo.join(".git").join("objects")).filter(|p| p.is_file()).count();
        let before = count_objects();
        let info = compute_git_info(repo.to_str().unwrap(), None, None, NOW);
        assert_eq!(info.commits_unlanded, 3, "the probe actually ran");
        assert_eq!(
            count_objects(),
            before,
            "the landing probe must not leave synthetic commits in the object store"
        );
    }

    /// Recursive file listing, so the object-store count covers the `xx/`
    /// fan-out directories loose objects live in.
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

    /// Committing again after the merge is the case that must NOT read as
    /// clean — and the count has to be the one new commit, not all three.
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

    /// A detached HEAD (mid-rebase, mid-bisect, a checked-out tag) has no
    /// branch and no stats — but it is still a checkout *of this repository*.
    /// `common_dir` is the rail's row-grouping key, so answering with a bare
    /// default used to knock the folder out of its repo's row until HEAD
    /// landed on a branch again.
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

    /// A compute that couldn't open the repository at all is not proof the
    /// checkout stopped being one — a concurrent `git worktree remove`/`prune`
    /// (which the task-removal sequence runs) can make a read fail mid-flight.
    /// The identity survives so the row stays grouped; the stats don't.
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

    /// The narrow cases: a real answer always wins, a gone directory is a
    /// definite answer (its ghost row stands alone), and a directory that
    /// vanished before the store isn't propped up by a stale identity.
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
