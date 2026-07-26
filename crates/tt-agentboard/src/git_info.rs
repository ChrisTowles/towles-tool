//! Branch / worktree / diff-stat computation with a short cache. Ports slot-1
//! `runtime/server/git-info.ts`.
//!
//! What ports here: the git shell-outs, the porcelain/numstat/ahead-behind
//! parsing, and the 5s-TTL cache with stale-serve + explicit invalidation. What
//! does **not** port (transport/watcher concerns, left to the Tauri layer): the
//! `setInterval` git poll (`startGitPoll`/`poll.ts`), the `fs.watch` on
//! `.git/HEAD` (`syncGitWatchers`), and the WS broadcast.
//!
//! Time is injected via `now_ms` instead of a background clock. Cache misses
//! compute synchronously here rather than TS's async background refresh +
//! in-flight de-dup (deviation noted in the port report).

use std::collections::HashMap;
use std::collections::HashSet;

use serde::{Deserialize, Serialize};

/// Working-tree/commit stats for a session directory. Ports `GitInfo`.
///
/// Every stat here measures against the *same* baseline: `compared_base` (see
/// [`resolve_base_ref`]) — a per-folder override, else a worktree's own
/// creation base, else origin/main-or-master. They agree by construction,
/// unlike the old design where the two used different baselines (a branch's
/// own upstream vs. always origin/main) and could silently disagree.
///
/// **The committed and uncommitted diffs are separate quantities and are never
/// summed.** They answer different questions and carry different consequences:
/// `uncommitted_*` is what deleting this checkout destroys, `committed_*` is
/// what survives on the branch. A single blended ± (which is what this struct
/// used to report, and what `changes_vs(merge_base)` still computes for the
/// diff pane) belongs to neither the commit count beside it nor the dirty
/// working tree — reading "15c +679 −22130" it is impossible to tell which of
/// those lines are in the 15 commits.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct GitInfo {
    pub branch: String,
    pub is_worktree: bool,
    /// Files touched by `merge_base(HEAD, compared_base)..HEAD` — committed
    /// work only, the working tree excluded.
    pub committed_files: i64,
    pub committed_added: i64,
    pub committed_removed: i64,
    /// Files touched between `HEAD` and the working tree — staged, unstaged
    /// and untracked alike. Untracked files count here but contribute no line
    /// counts (there is no diff for content that has never been committed),
    /// matching what the diff pane's `?` rows show.
    pub uncommitted_files: i64,
    pub uncommitted_added: i64,
    pub uncommitted_removed: i64,
    /// Commits on HEAD that `compared_base` doesn't have.
    pub commits_ahead: i64,
    /// Commits on `compared_base` that HEAD doesn't have. Kept separate from
    /// `commits_ahead` (not a signed delta) so "3 ahead, 2 behind" doesn't
    /// collapse to a meaningless "+1".
    pub commits_behind: i64,
    /// Whether the working tree holds anything not yet committed — exactly
    /// `uncommitted_files > 0`, so the boolean and the number can never
    /// disagree on screen. Derived from the diff rather than from
    /// `status().is_dirty()` on purpose: the status walk reports a path whose
    /// stat cache is stale even when an edit was saved and reverted back to
    /// identical content, which showed as a dirty badge with nothing to see.
    pub dirty: bool,
    /// Of `commits_ahead`, how many hold changes `compared_base` has never
    /// received. 0 whenever `commits_ahead` is 0, and — unlike `commits_ahead`,
    /// which can never reach 0 once the landed commits carry new SHAs — it
    /// also drops to 0 after a rebase *or squash* merge.
    ///
    /// Squash needs more than the `git cherry` patch-id comparison this used
    /// to be: a squash replaces N commits with one whose diff matches none of
    /// them individually, so `cherry` reported every commit of a merged branch
    /// as outstanding. [`tt_tasks::landed`] combines the signals that actually
    /// cover all three landing shapes; see its module docs.
    pub commits_unlanded: i64,
    /// How this branch's work reached `compared_base` — `"merged"`,
    /// `"rebase-merged"`, `"squash-merged"`, `"upstream gone"` — or `None`
    /// when it has not fully landed. Lets the rail say *why* a branch is
    /// finished instead of inferring it from a GitHub PR state, which is all
    /// it had before and which says nothing about a branch merged locally.
    pub landed: Option<String>,
    /// `git remote get-url origin`, if the checkout has an origin remote.
    /// Display-only (repo name derivation) — NOT the Folder Rail nesting key;
    /// two unrelated clones can share an origin without being linked worktrees
    /// of each other. See [`Self::common_dir`] for that.
    pub origin_url: Option<String>,
    /// Absolute path to `git rev-parse --git-common-dir` (canonicalized), empty
    /// for a non-repo dir or before this folder's git info has ever been
    /// computed. Identical across every linked `git worktree` of one repo
    /// (main + tasks) and nowhere else — this is what
    /// [`crate::bridge::assemble_state`] groups [`crate::types::FolderData`]s
    /// into one [`crate::types::RepoData`] by, regardless of whether each
    /// checkout is separately tracked in `repos.json` or only discovered via
    /// `git worktree list` — so only *actual* worktrees of one repo nest
    /// together, never merely folders that happen to share an origin remote.
    pub common_dir: String,
    /// Absolute paths of this repo's OTHER `git worktree` checkouts (this dir
    /// excluded), from `git worktree list`: the main checkout plus every
    /// linked worktree, managed task or not. Not part of the wire payload —
    /// the engine uses it to auto-discover sibling checkouts that aren't in
    /// `repoPaths` yet, in both directions: a tracked primary pulls in its
    /// tasks, and a tracked task pulls in its primary, so a repo group always
    /// has its main checkout even when only tasks were ever tracked.
    ///
    /// Whether the *unmanaged* ones (see `unmanaged_worktree_dirs`) actually
    /// reach the rail is the engine's call, not this module's — see
    /// [`crate::engine::Engine::expand_with_worktrees`].
    pub worktree_dirs: Vec<String>,
    /// The subset of `worktree_dirs` that is not a `tt task`-managed worktree
    /// ([`tt_tasks::is_managed_task`] says no — one Claude Code created via an
    /// unwired `WorktreeCreate` hook, or added by hand outside the task
    /// convention). The main checkout is never listed here: it carries no
    /// marker, but it's what a repo group nests under. Split out rather than
    /// filtered away so the "show every worktree" setting can be flipped
    /// without invalidating a single cache entry.
    pub unmanaged_worktree_dirs: Vec<String>,
    /// When these numbers were last *verified* against the repository — the
    /// `now_ms` passed to [`compute_git_info`], stamped on every compute
    /// including the ref-unchanged fast path, since that path still re-reads
    /// the working tree and so genuinely re-confirms the answer.
    ///
    /// Exists because "is this number stale or is nothing happening?" is
    /// otherwise unanswerable from the UI: refresh is event-driven off a
    /// handful of `.git` files with a 60s backup poll ([`GIT_CACHE_TTL_MS`]),
    /// and the diff baseline is a merge-base that only moves on fetch — so
    /// long stretches of a correct, unchanging number are normal and look
    /// identical to a wedged poll. 0 when never computed.
    pub computed_at_ms: i64,
    /// True when `dir` doesn't exist on disk (a tracked repo whose checkout was
    /// moved or deleted). Distinguishes a genuinely-missing directory from a
    /// present-but-non-git one — both otherwise yield an empty [`GitInfo`].
    /// [`crate::bridge::build_folder`] copies this onto the wire `FolderData`.
    pub dir_missing: bool,
    /// For a worktree only: the ref it was actually created from, read
    /// from its `.tt-task` marker (see [`tt_tasks::read_task_base`]). `None`
    /// for a non-task checkout. Lets the diff pane (and [`resolve_base_ref`])
    /// know what to auto-compare against without the user typing an override.
    pub task_base_branch: Option<String>,
    /// The ref every stat on this struct (`files_changed`, `commits_ahead`,
    /// …) was actually compared against — [`resolve_base_ref`]'s result, e.g.
    /// `"origin/main"` or `"origin/docs/readme-task-clean"`. Lets the Folder
    /// Rail label its stats with what they mean instead of always implying
    /// "vs main". Empty when `compute_git_info` never ran (default/missing).
    pub compared_base: String,
    /// True when the checkout has a Claude Desktop `.claude/launch.json`
    /// (see [`crate::launch`]) — filesystem-derived here like `dir_missing`,
    /// copied onto the wire `FolderData` so the client can gate its
    /// dev-servers affordance without a per-poll file read of its own.
    pub has_launch_config: bool,
    /// Fingerprint of the git state the landing probe's answer was computed
    /// at (see [`probe_fingerprint`]). Purely an internal revalidation token —
    /// never sent to the client — that lets a poll skip the probe when nothing
    /// it reads has moved. Empty when the probe never ran or the fingerprint
    /// was unreadable.
    #[serde(skip)]
    pub probe_key: String,
    /// Fingerprint of the filesystem facts behind `is_worktree`/`common_dir`/
    /// `worktree_dirs`/`origin_url` at the time they were last computed (see
    /// [`structural_fingerprint`]). Internal revalidation token, like
    /// `probe_key`. Empty when never computed.
    #[serde(skip)]
    pub structural_key: String,
    /// This checkout's own gitdir — resolved from the filesystem (see
    /// [`resolve_git_dir_fs`]), never spawned. For the main worktree this is
    /// `<dir>/.git`; for a linked worktree it's `.git/worktrees/<name>` in
    /// the common dir, which is where *this* checkout's own `HEAD`/`index`
    /// live (they're per-worktree, unlike refs/objects, which are shared via
    /// `common_dir`). Not part of the wire payload — [`crate::engine::Engine::
    /// control_watch_files`] uses it to compute which `.git` internals to
    /// watch for this checkout specifically. Empty when unresolvable.
    #[serde(skip)]
    pub git_dir: String,
    /// Fingerprint of the inputs the *ref-derived* half of this struct
    /// (`branch`/`compared_base`/`commits_ahead`/`commits_behind`/`landed`)
    /// reads, at the time they were last computed (see
    /// [`revision_fingerprint`]). Internal revalidation token like `probe_key`
    /// / `structural_key`: when it still matches, a poll skips the ref-reading
    /// spawns and recomputes only the working-tree half. Empty when never
    /// computed or unreadable.
    #[serde(skip)]
    pub revision_key: String,
    /// The exact ref `diff --numstat` was run against — the merge-base of
    /// `HEAD` and `compared_base` (or `HEAD` when they share no history).
    /// Stored so the ref-unchanged fast path can re-diff the working tree
    /// against the same base without re-spawning `merge-base`. Empty until the
    /// first full compute.
    #[serde(skip)]
    pub diff_base: String,
}

/// Backup ceiling for a git-info entry that the control-file watch
/// ([`crate::engine::Engine::control_watch_files`]) either never registered
/// (a dir with no cached info yet) or missed an event for (a watch
/// registration race, a filesystem that doesn't propagate inotify). A real
/// change — a commit, a fetch, a branch switch, a `git add` — invalidates its
/// specific dir immediately via [`GitInfoCache::invalidate`] and does not wait
/// on this; this is deliberately long precisely because the normal path is
/// event-driven, not because staleness beyond it is fine.
const GIT_CACHE_TTL_MS: i64 = 60_000;

/// Cache of git info per directory, with a TTL-as-backup-ceiling and
/// stale-serve. Ports the module-global `gitInfoCache` as an owned struct.
/// The poll loop that drives `refresh` lives in the Tauri layer, not here.
#[derive(Debug, Default)]
pub struct GitInfoCache {
    entries: HashMap<String, (GitInfo, i64)>,
}

impl GitInfoCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert/replace an entry stamped at `now_ms` (used by tests and `refresh`).
    pub fn insert(&mut self, dir: &str, info: GitInfo, now_ms: i64) {
        self.entries.insert(dir.to_string(), (info, now_ms));
    }

    /// Whether the entry for `dir` exists and is within the TTL.
    pub fn is_fresh(&self, dir: &str, now_ms: i64) -> bool {
        self.entries.get(dir).is_some_and(|(_, ts)| now_ms - ts < GIT_CACHE_TTL_MS)
    }

    /// Synchronous cache-only read: returns the cached info (fresh or stale), or
    /// empty when nothing is cached. Ports `getGitInfo`'s serve-stale behavior
    /// (without the background refresh — that's the poll's job via [`Self::refresh`]).
    pub fn get(&self, dir: &str) -> GitInfo {
        if dir.is_empty() {
            return GitInfo::default();
        }
        self.entries.get(dir).map(|(info, _)| info.clone()).unwrap_or_default()
    }

    /// Mark entries stale (ts=0) so the next read still serves them but they're no
    /// longer fresh. Ports `invalidateGitCache`.
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

    /// Drop `dir`'s entry outright, for a checkout that is gone for good (a
    /// removed worktree task). Distinct from [`Self::invalidate`], which keeps
    /// serving the stale value until a recompute replaces it — there will be no
    /// recompute here, and a later task created at the same path must not
    /// inherit the dead one's branch and stats. Returns whether an entry went.
    pub fn forget(&mut self, dir: &str) -> bool {
        self.entries.remove(dir).is_some()
    }

    /// Recompute git info for `dir` (shells out), cache it at `now_ms`, and return
    /// it. Ports `refreshGitInfo` (synchronous, no in-flight de-dup). No
    /// per-folder base-branch override — callers that have one (the app's
    /// git-stat poll) call [`compute_git_info`] directly instead.
    pub fn refresh(&mut self, dir: &str, now_ms: i64) -> GitInfo {
        let info = compute_git_info(dir, None, None, now_ms);
        self.insert(dir, info.clone(), now_ms);
        info
    }

    /// Return fresh cached info if available, else recompute. Convenience wrapper.
    pub fn get_or_refresh(&mut self, dir: &str, now_ms: i64) -> GitInfo {
        if self.is_fresh(dir, now_ms) {
            return self.get(dir);
        }
        self.refresh(dir, now_ms)
    }
}

/// This checkout's repository handle, from the process-wide cache
/// ([`tt_git::repo`]). `None` for a directory that is not a repo — the same
/// degradation the old `git_out` had, where a failed spawn returned an empty
/// string and every stat came out zero.
fn open_repo(dir: &str) -> Option<tt_git::repo::Repo> {
    tt_git::repo::open(std::path::Path::new(dir)).ok()
}

/// Fingerprint of every input the landing probe reads: `HEAD`'s sha, the
/// resolved base's sha, and whether the branch's upstream is gone.
/// `tt_tasks::ops::work_state` is a pure function of those three (its other
/// arguments are constants at this call site), so an unchanged fingerprint
/// means the previous landing answer is still exact.
///
/// This is what keeps the poll's cost proportional to *actual git movement*
/// rather than to elapsed time. It mattered more when the probe cost up to
/// ~192 subprocesses; it still earns its keep, since the probe now walks and
/// diffs trees rather than spawning, and neither is free.
///
/// Returns empty when `HEAD` or the base is unreadable — a partial fingerprint
/// must never compare equal to a real one, so an unreadable repo re-probes
/// instead of trusting a half-formed key.
fn probe_fingerprint(repo: &tt_git::repo::Repo, branch: &str, compared_base: &str) -> String {
    let (Some(head), Some(base)) = (repo.head_id(), repo.resolve(compared_base)) else {
        return String::new();
    };
    let gone = repo.upstream_gone(&format!("refs/heads/{branch}"));
    format!("{head} {base} {gone}")
}

/// Fingerprint of the filesystem facts that govern `is_worktree`/`common_dir`/
/// `worktree_dirs`/`origin_url`: the mtimes of `common_dir`'s `worktrees`
/// subdirectory (touched whenever a `git worktree add`/`remove` changes the
/// sibling set) and its `config` file (touched by `remote set-url`). Those
/// four facts are otherwise re-derived on every single poll (a `worktrees`
/// directory walk plus a config read), even though — unlike
/// `dirty`/`commits_ahead`/etc. — they almost never change poll to poll: a
/// repo's worktree set and remote are structural, not working-tree state.
///
/// Reads only two `fs::metadata` calls — no ref or config parsing at all — so
/// checking this first is unconditionally cheaper than the work it guards.
///
/// Returns empty only when `common_dir` itself is empty or unreadable — an
/// empty fingerprint must never compare equal to a real one, so an
/// unreadable repo re-derives instead of trusting a half-formed key. `config`
/// always exists once a repo is initialized, but `worktrees` does not until
/// the first `git worktree add` — its absence is a legitimate, stable state
/// (most repos never gain one), not a reason to skip memoizing, so it's
/// stamped as a fixed sentinel rather than folded into the empty case.
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

/// Carry a checkout's structural identity across a compute that couldn't read
/// the repository at all.
///
/// [`compute_git_info`] answers with a bare [`GitInfo::default`] when
/// [`open_repo`] fails — and that can be transient rather than true: a
/// concurrent `git worktree remove`/`prune` (the task-removal sequence runs
/// both, in the checkout that owns the worktree being removed) rewrites
/// `.git/worktrees` while a poll may be mid-read. Storing that answer wholesale
/// blanks `common_dir`, and [`crate::bridge::assemble_state`] groups rail rows
/// by exactly that — so an unrelated, still-present checkout would drop out of
/// its repo's row into a top-level one of its own for a tick or two. Keeping
/// the previous identity holds the row together; every *stat* still goes empty,
/// because those really are unknown.
///
/// Deliberately narrow:
/// - only when the incoming answer has no `common_dir` of its own — a real
///   recompute always wins;
/// - never for [`GitInfo::dir_missing`], which is a definite answer (the
///   directory is gone), and whose ghost row is meant to stand alone with its
///   own Untrack;
/// - only when `dir` still exists, so a checkout that vanished between the
///   compute and the store isn't propped up by a stale identity.
pub fn preserve_identity_on_failed_read(dir: &str, previous: &GitInfo, info: &mut GitInfo) {
    if !info.common_dir.is_empty() || info.dir_missing || previous.common_dir.is_empty() {
        return;
    }
    if !std::path::Path::new(dir).is_dir() {
        return;
    }
    info.origin_url = previous.origin_url.clone();
    info.common_dir = previous.common_dir.clone();
    info.worktree_dirs = previous.worktree_dirs.clone();
    info.unmanaged_worktree_dirs = previous.unmanaged_worktree_dirs.clone();
    info.is_worktree = previous.is_worktree;
    info.git_dir = previous.git_dir.clone();
    // NOT `structural_key`/`revision_key`: those are revalidation tokens for
    // answers this compute never produced. Left empty, the next poll does a
    // full recompute instead of trusting carried-over facts.
}

/// What a checkout *is*, independent of where its HEAD points: which
/// repository it belongs to ([`GitInfo::common_dir`], the Folder Rail's
/// nesting key), whether it's a linked worktree, its sibling checkouts, and
/// its remote.
struct Structural {
    origin_url: Option<String>,
    common_dir: String,
    worktree_dirs: Vec<String>,
    unmanaged_worktree_dirs: Vec<String>,
    structural_key: String,
    git_dir: String,
    is_worktree: bool,
}

/// Derive the structural facts, revalidating the previous answer cheaply
/// first: see [`structural_fingerprint`]'s doc — they're filesystem structure,
/// not working-tree state, so two `fs::metadata` calls against the *previous*
/// `common_dir` are worth it before deriving them again.
///
/// `git_dir`/`is_worktree` are never reused: they're resolved from the
/// filesystem rather than the repository (see [`resolve_git_dir_fs`]) and are
/// needed fresh every call for [`crate::engine::Engine::control_watch_files`]'
/// per-checkout `HEAD`/`index` targets.
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
            worktree_dirs: prev.worktree_dirs.clone(),
            unmanaged_worktree_dirs: prev.unmanaged_worktree_dirs.clone(),
            structural_key,
            git_dir,
            is_worktree,
        },
        None => {
            let common_dir = repo.common_dir().to_string_lossy().into_owned();
            let (worktree_dirs, unmanaged_worktree_dirs) = other_worktrees(repo, dir);
            Structural {
                origin_url: repo.origin_url(),
                worktree_dirs,
                unmanaged_worktree_dirs,
                structural_key: structural_fingerprint(&common_dir),
                common_dir,
                git_dir,
                is_worktree,
            }
        }
    }
}

/// A checkout whose HEAD names no branch: the structural facts, every
/// ref-derived and working-tree field left at its default.
///
/// Deliberately not a bare [`GitInfo::default`] — see the call site. The empty
/// `revision_key` is also load-bearing: it keeps the next poll off
/// [`compute_git_info`]'s ref-unchanged fast path, so the moment HEAD lands on
/// a branch again the full answer is recomputed.
fn structural_only(
    dir: &str,
    repo: &tt_git::repo::Repo,
    previous: Option<&GitInfo>,
    now_ms: i64,
) -> GitInfo {
    let s = structural_facts(dir, repo, previous);
    GitInfo {
        computed_at_ms: now_ms,
        origin_url: s.origin_url,
        common_dir: s.common_dir,
        worktree_dirs: s.worktree_dirs,
        unmanaged_worktree_dirs: s.unmanaged_worktree_dirs,
        structural_key: s.structural_key,
        git_dir: s.git_dir,
        is_worktree: s.is_worktree,
        task_base_branch: tt_tasks::read_task_base(std::path::Path::new(dir)),
        has_launch_config: crate::launch::has_launch_file(std::path::Path::new(dir)),
        ..Default::default()
    }
}

/// This checkout's own gitdir, resolved the same way `git` itself does —
/// `.git` is a directory for the main worktree, or a file containing
/// `gitdir: <path>` for a linked worktree (verified against a real
/// `.claude/worktrees/*` checkout in this repo) — never by spawning
/// `rev-parse --git-dir`. A plain `fs::metadata` + optional one-line read,
/// so there's no reason to pay a subprocess for this at all, memoized or not.
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

/// The `.git` internal files whose change is what actually invalidates
/// `commits_ahead`/`commits_behind`/`landed`, and (partially) `dirty` —
/// **not** every dirty edit, only a staged one, since an unstaged file
/// change never touches any of these:
///
/// - `git_dir/HEAD` — commit, branch switch, detached checkout
/// - `git_dir/index` — `git add`/`git commit`/`git reset` (staged changes;
///   an unstaged edit is invisible here, which is why the poll backup still
///   matters for `dirty`/`files_changed`/the diff stats)
/// - `common_dir/packed-refs` — `git gc` packing loose refs; always watched,
///   cheap, and covers the case below when a ref has been packed
/// - `common_dir/refs/heads/<branch>` — a commit landing on this branch from
///   elsewhere (another worktree, a rebase)
/// - `common_dir/refs/remotes/origin/<name>` (or `refs/heads/<name>` for a
///   base with no origin) — `git fetch` moving the comparison baseline
///
/// Built from `git_dir`/`branch`/`compared_base` as they were last computed
/// (usually a poll-tick behind a branch switch, self-correcting on the very
/// next recompute that switch triggers via its own `HEAD` watch firing).
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

/// Public entry point for [`crate::engine::Engine::control_watch_files`]:
/// [`control_files`] from a cached [`GitInfo`]'s own fields. Empty when
/// `info` has never been computed (`git_dir` empty) — nothing to watch yet,
/// the poll (backup ceiling) covers that dir until its first compute fills
/// these in and it joins the watched set on the following tick.
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

/// Fingerprint of every input the *ref-derived* half of [`compute_git_info`]
/// reads — `branch`, `compared_base`, `commits_ahead`/`commits_behind`, and the
/// landing answer. Two kinds of input:
///
/// - **which base ref is chosen** ([`resolve_base_ref`]): the caller's
///   `base_branch_override` and the `.tt-task` marker (folded in as its mtime),
///   the only two resolution inputs besides `origin/main` — whose ref file is
///   already stamped below.
/// - **what the refs point at**: the mtimes of the control files whose movement
///   changes any of the above — `HEAD`, `packed-refs`, the branch ref, the base
///   ref — i.e. [`control_files`] minus `index`.
///
/// `index` is excluded on purpose: `git status`/`git diff` (which the fast path
/// still runs every poll) can themselves rewrite the index's stat cache, so
/// folding it in would make this differ on every tick and defeat the reuse.
/// The staged/unstaged state `index` reflects is re-read every poll by those two
/// commands anyway, so nothing is lost.
///
/// Reads no refs or objects — only `fs::metadata`. When this equals a cached
/// [`GitInfo`]'s `revision_key`, the poll skips the HEAD read, the base
/// resolve, the merge-base and ahead/behind graph walks, and the landing probe
/// — the bulk of a sweep's git work — running only the working-tree
/// status/diff that no `.git` mtime can stand in for.
///
/// Returns empty when the git dir or branch is unknown, or a required stat hard-
/// errors — a partial fingerprint must never compare equal to a real one.
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
    // The structural facts (`origin_url`/`common_dir`/`worktree_dirs`/
    // `is_worktree`) are reused wholesale on the fast path too, yet a
    // `git worktree add`/`remote set-url` changes them without touching any ref
    // file — so their own fingerprint is folded in here, and any structural
    // change busts the fast path into a full recompute that re-derives them.
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

/// Compute a folder's git info. `previous` is that folder's last cached value,
/// used to skip repeat work when nothing it depends on has moved: the whole
/// ref-derived half when the refs haven't moved (see [`revision_fingerprint`]),
/// and, within a full recompute, the landing probe (see [`probe_fingerprint`])
/// and the four structural facts (see [`structural_fingerprint`]). Pass `None`
/// to force a full computation.
pub fn compute_git_info(
    dir: &str,
    base_branch_override: Option<&str>,
    previous: Option<&GitInfo>,
    now_ms: i64,
) -> GitInfo {
    if dir.is_empty() {
        return GitInfo::default();
    }
    // A tracked checkout that was moved or deleted: flag it so the rail can show
    // it as a ghost rather than a silent empty-stats folder.
    if !std::path::Path::new(dir).is_dir() {
        return GitInfo { dir_missing: true, computed_at_ms: now_ms, ..Default::default() };
    }
    let Some(repo) = open_repo(dir) else {
        return GitInfo::default();
    };

    // Fast path: when nothing the ref-derived half reads has moved since the
    // last compute (HEAD/refs unchanged and the base still resolves the same
    // way — see `revision_fingerprint`), reuse `branch`/`compared_base`/ahead/
    // behind/landing wholesale and pay only for the working-tree half (status
    // + diff). That is the sole part no `.git` mtime can stand in for, so it
    // is the only thing a backup-poll tick over an idle repo should cost.
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
            // Only the working-tree fields are recomputed; every ref-derived
            // and structural field is carried from `prev` (the fingerprint
            // match proves they're still exact).
            let mut info = diff_stats(&repo, &prev.branch, prev.is_worktree, diff_base);
            info.computed_at_ms = now_ms;
            info.commits_ahead = prev.commits_ahead;
            info.commits_behind = prev.commits_behind;
            info.commits_unlanded = prev.commits_unlanded;
            info.landed = prev.landed.clone();
            info.origin_url = prev.origin_url.clone();
            info.common_dir = prev.common_dir.clone();
            info.worktree_dirs = prev.worktree_dirs.clone();
            info.structural_key = prev.structural_key.clone();
            info.probe_key = prev.probe_key.clone();
            info.git_dir = prev.git_dir.clone();
            info.compared_base = prev.compared_base.clone();
            info.diff_base = prev.diff_base.clone();
            info.revision_key = key;
            // Cheap filesystem facts, not repository reads — kept fresh so a
            // launch.json appearing (not covered by the fingerprint) or a
            // marker change (which already busted the fingerprint above, so
            // this tick is a full recompute anyway) shows up without waiting a
            // whole poll.
            info.task_base_branch = tt_tasks::read_task_base(std::path::Path::new(dir));
            info.has_launch_config = crate::launch::has_launch_file(std::path::Path::new(dir));
            return info;
        }
    }

    // No branch to report — HEAD is detached (a rebase, a bisect, a checked-out
    // tag) or unborn. Everything ref-derived is genuinely unknown, but the
    // *structural* facts are not: which repository this checkout belongs to
    // doesn't depend on where HEAD points. Returning a bare default here
    // dropped `common_dir`, and `assemble_state` groups rail rows by exactly
    // that — so a `git rebase` used to knock a checkout out of its repo's row
    // and into a top-level one of its own until HEAD landed on a branch again.
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
        worktree_dirs,
        unmanaged_worktree_dirs,
        structural_key,
        git_dir,
        is_worktree,
    } = structural_facts(dir, &repo, previous);

    let mut info = diff_stats(&repo, &branch, is_worktree, &base);
    info.computed_at_ms = now_ms;
    let (ahead, behind) = repo.ahead_behind(&compared_base, "HEAD");
    info.commits_ahead = ahead;
    info.commits_behind = behind;
    info.origin_url = origin_url;
    info.common_dir = common_dir;
    info.worktree_dirs = worktree_dirs;
    info.unmanaged_worktree_dirs = unmanaged_worktree_dirs;
    info.structural_key = structural_key;
    info.git_dir = git_dir;
    info.task_base_branch = tt_tasks::read_task_base(std::path::Path::new(dir));
    info.has_launch_config = crate::launch::has_launch_file(std::path::Path::new(dir));
    // Only worth probing once there's something to check — nothing ahead
    // trivially means nothing unlanded.
    if info.commits_ahead > 0 {
        // Goes through `ops::work_state` rather than the probe directly, so
        // there is one implementation of "has this landed" rather than two.
        //
        // `compared_base` is already the resolved ref (see `resolve_base_ref`,
        // which prefers `origin/<name>`), so there is no local-then-remote
        // retry to do here: `remote: None` makes the single pass the whole
        // story. The uncommitted and orphaned axes are passed as 0 because
        // this struct reports the first as `dirty` and does not carry the
        // second; only the landing half of `WorkState` is read below.
        //
        // Before paying for it, check whether anything the probe reads has
        // actually moved. When it hasn't, the previous answer is not merely a
        // good guess — it is the same computation over the same inputs — so
        // reusing it is exact, not a staleness tradeoff. This is what stops a
        // hot poll loop from re-probing an idle repo.
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
    // The base the diff ran against, so the ref-unchanged fast path can
    // re-diff against the same base without resolving the merge-base again.
    info.diff_base = base;
    // Stamp the revision fingerprint from the values just computed, so the next
    // poll can take the fast path above when nothing ref-derived has moved.
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

/// The two diffs of [`GitInfo`], measured separately and never summed:
/// `base..HEAD` (committed) and `HEAD`..working tree (uncommitted). Every
/// other field is filled by the caller.
///
/// Untracked files count toward `uncommitted_files` — they are changes the
/// user can see, and losing them is exactly what deleting a checkout does —
/// but contribute no line counts, since there is no diff for content that has
/// never been committed.
///
/// Cost is unchanged from the single blended diff this replaced: one status
/// walk (inside `changes_vs("HEAD")`, the only part that must touch the
/// working tree) plus one tree-to-tree walk, versus the one call that did both
/// at once.
fn diff_stats(repo: &tt_git::repo::Repo, branch: &str, is_worktree: bool, base: &str) -> GitInfo {
    let uncommitted = repo.changes_vs("HEAD").unwrap_or_default();
    let committed = repo.committed_totals_vs(base).unwrap_or_default();
    GitInfo {
        branch: branch.to_string(),
        is_worktree,
        committed_files: committed.files_changed,
        committed_added: committed.lines_added,
        committed_removed: committed.lines_removed,
        uncommitted_files: uncommitted.len() as i64,
        uncommitted_added: uncommitted.iter().map(|c| c.lines_added).sum(),
        uncommitted_removed: uncommitted.iter().map(|c| c.lines_removed).sum(),
        dirty: !uncommitted.is_empty(),
        ..Default::default()
    }
}

/// Fetch `origin` for each distinct repo among `dirs`, deduped by common git
/// dir so N worktrees of the same repo (the common task pattern) trigger one
/// network call, not N. Network I/O, so a 20s timeout rather than the 10s the
/// module's other subprocess ([`prune_stale_worktree`]) gets; failures
/// (offline, no origin, auth prompt) are swallowed the same
/// way — this only refreshes the `origin/main` ref that [`compute_git_info`]
/// reads, it never surfaces errors to the user.
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

/// `git fetch --quiet origin`, ignoring the outcome — best-effort refresh of
/// the local `origin/main` remote-tracking ref.
fn fetch_origin(dir: &str) {
    let full = ["-C", dir, "fetch", "--quiet", "origin"];
    let _ = tt_exec::run_with_timeout("git", &full, std::time::Duration::from_secs(20));
}

/// Absolute path to the repo's shared `.git` dir (same for every worktree of
/// one repo), used to dedup fetches. Empty for a non-repo dir.
fn git_common_dir(dir: &str) -> String {
    open_repo(dir).map(|repo| repo.common_dir().to_string_lossy().into_owned()).unwrap_or_default()
}

/// This repo's other checkouts (`dir` itself excluded), and which of them are
/// unmanaged — returned as `(all, unmanaged)`, the second a subset of the
/// first.
///
/// `all` is every sibling `git worktree list` reports: the main checkout — no
/// managed task, but kept so a tracked task pulls its primary into the rail
/// even when the primary was never tracked — plus every linked worktree.
/// `unmanaged` names the linked ones that aren't `tt task` worktrees
/// ([`tt_tasks::is_managed_task`]); by default those don't auto-populate the
/// Folder Rail, and the `agentboard.showUnmanagedWorktrees` setting is what
/// lets them ([`crate::engine::Engine::expand_with_worktrees`] applies it —
/// classifying, not filtering, here is what keeps that toggle from having to
/// invalidate the git cache). This is the only place auto-discovered worktree
/// paths enter the engine's discovery pipeline, so classifying here is
/// sufficient. A directory the user explicitly tracks (in `repos.json`) is
/// unaffected either way: this fn only describes the auto-discovery candidate
/// list, never the user's own configured paths. Both empty for a plain clone
/// (no linked worktrees) or a non-repo dir.
///
/// `dir` is compared canonically: [`tt_git::repo::Repo::worktrees`] reports
/// resolved paths, and a checkout reached through a symlink must still
/// recognize itself and drop out of its own sibling list.
fn other_worktrees(repo: &tt_git::repo::Repo, dir: &str) -> (Vec<String>, Vec<String>) {
    let self_dir = std::fs::canonicalize(dir).unwrap_or_else(|_| std::path::PathBuf::from(dir));
    let mut all = Vec::new();
    let mut unmanaged = Vec::new();
    for w in repo.worktrees() {
        if std::path::Path::new(&w.dir) == self_dir {
            continue;
        }
        if !w.is_main && !tt_tasks::is_managed_task(std::path::Path::new(&w.dir)) {
            unmanaged.push(w.dir.clone());
        }
        all.push(w.dir);
    }
    (all, unmanaged)
}

/// Force-remove `worktree_dir`'s registration from the repo checked out at
/// `owner_dir`, then prune.
///
/// One of the two places this module still spawns `git` (the other is
/// [`fetch_origin`]): gitoxide's worktree API is read-only, with no
/// linked-worktree removal — see [`tt_git::repo`].
///
/// A worktree dir deleted outside `git worktree remove`/`tt task rm` (a bare
/// `rm -rf`, or the folder moved) is never a `repos.json` entry (see
/// `merge_worktree_dirs`'s doc — it only ever enters the rail via
/// [`other_worktrees`]' live discovery), so there is nothing for the rail's
/// "Untrack" action to remove there; the registration in `owner_dir`'s
/// `.git/worktrees/<name>` is the only place it's actually recorded, and git
/// keeps reporting it — `prunable` or not — until that registration is
/// cleared. `--force` is required since the directory itself is already gone,
/// which a plain `git worktree remove` refuses. `prune` runs regardless of
/// whether `remove` succeeded, since a failed remove (e.g. already-pruned) can
/// still leave a stale entry only `prune` clears. Returns whether `remove`
/// reported success.
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
    // The removed checkout's cached handle would otherwise hold an open object
    // database against a directory that no longer exists.
    tt_git::repo::forget(std::path::Path::new(worktree_dir));
    removed
}

/// origin/main, or origin/master if that's what the remote uses. Ports `resolveOriginMain`.
fn resolve_origin_main(repo: &tt_git::repo::Repo) -> String {
    if repo.has_rev("origin/main") {
        "origin/main".to_string()
    } else {
        "origin/master".to_string()
    }
}

/// The ref every "vs main" comparison compares against — the diff pane's
/// `DiffMode::Main` *and* [`compute_git_info`]'s `files_changed`/
/// `commits_ahead`/etc. stats, so the Folder Rail's numbers always match what
/// the diff pane actually shows. Highest priority first:
///
/// 1. `base_branch` — a per-folder override for a long-running branch that
///    didn't fork from main, set via
///    [`crate::folder_meta::FolderMetaStore::set_base_branch`].
/// 2. The worktree's own `.tt-task` marker `base=` field (see
///    [`tt_tasks::read_task_base`]) — the ref the task was actually created
///    from, which may not be main. Not present for a non-task checkout.
/// 3. The origin/main-or-master auto-detect.
///
/// Whichever name wins resolves to `origin/<name>`, never the local branch:
/// both the local ref and its origin remote-tracking ref may have moved since
/// the task was created, and the diff pane wants the current pushed baseline,
/// matching [`resolve_origin_main`]. Falls back to the local branch only when
/// no `origin/<name>` ref exists at all (e.g. a base branch never pushed).
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
    /// Everything on this branch vs where it forked from origin/main
    /// (merge-base) — committed and uncommitted work alike.
    Main,
    /// Only what isn't committed yet: staged + unstaged, vs HEAD.
    Uncommitted,
}

/// One changed file in the diff pane's file list. `status` is git's
/// name-status letter (`M`/`A`/`D`/`R`/`C`/`T`, or `?` for untracked);
/// `old_path` is set on renames/copies (content at the base lives there).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub lines_added: i64,
    pub lines_removed: i64,
}

/// The commit the diff pane compares against: merge-base with the resolved
/// base ref for [`DiffMode::Main`], HEAD for [`DiffMode::Uncommitted`].
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

/// The diff pane's changed-file list, rename-aware, baseline picked by `mode`.
/// Untracked files appear with status `?` and no line counts — they have no
/// diff yet. Empty when `dir` isn't a repo or nothing changed.
pub fn diff_files(dir: &str, mode: DiffMode, base_branch: Option<&str>) -> Vec<DiffFile> {
    if dir.is_empty() {
        return Vec::new();
    }
    let Some(repo) = open_repo(dir) else {
        return Vec::new();
    };
    let base = resolve_diff_base(&repo, dir, mode, base_branch);
    let mut files: Vec<DiffFile> = repo
        .changes_vs(&base)
        .unwrap_or_default()
        .into_iter()
        .map(|change| DiffFile {
            path: change.path,
            old_path: change.old_path,
            status: change.status.to_string(),
            lines_added: change.lines_added,
            lines_removed: change.lines_removed,
        })
        .collect();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files
}

/// A file's content at the diff baseline, for the original side of the diff
/// editor. `None` when the file doesn't exist there (added/untracked), when
/// `dir` isn't a repo, or when the content isn't valid UTF-8 — the editor has
/// nothing to show for a binary blob either way.
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

/// One commit ahead of `compared_base`, with its own line-count diff — not
/// the branch's cumulative total ([`GitInfo::committed_added`]/
/// `committed_removed` for that). Powers the `CommittedChip` hover's
/// per-commit breakdown, oldest first, so a many-commit branch's ± tally
/// isn't one anonymous blob.
///
/// `camelCase` like [`DiffFile`] beside it, and not decorative: the frontend
/// reads `linesAdded`/`linesRemoved`, so without the rename every commit row
/// rendered a bare `+` and `−` with no number (`undefined` stringifies to
/// nothing). It went unnoticed because the card's *total* row reads the
/// folder's own stats, which were correct.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitStat {
    pub sha: String,
    pub subject: String,
    pub lines_added: i64,
    pub lines_removed: i64,
}

/// Commits on HEAD that `compared_base` doesn't have, oldest first, each with
/// its own line-count diff. `base_branch` is the same per-folder override
/// [`compute_git_info`] takes. Empty when `dir` isn't a repo or nothing is
/// ahead.
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

/// Every file in the checkout worth telling a Claude session about: tracked
/// plus untracked-but-not-ignored, repo-relative, sorted, deduped, capped at
/// `cap` (a runaway vendored tree must not ship megabytes to the webview).
/// Empty when `dir` isn't a git repo — same degradation as the rest of this
/// module.
pub fn list_files(dir: &str, cap: usize) -> Vec<String> {
    open_repo(dir).and_then(|repo| repo.list_files(cap).ok()).unwrap_or_default()
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

    /// [`other_worktrees`]' `(all, unmanaged)` by directory.
    fn worktree_dirs_of(dir: &str) -> (Vec<String>, Vec<String>) {
        open_repo(dir).map(|repo| other_worktrees(&repo, dir)).unwrap_or_default()
    }

    #[test]
    fn commit_stats_lists_ahead_commits_oldest_first_with_own_line_counts() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path();
        git(repo, &["init", "--quiet", "-b", "main"]);
        git(repo, &["config", "user.email", "test@example.com"]);
        git(repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("f.txt"), "1\n").unwrap();
        git(repo, &["add", "f.txt"]);
        git(repo, &["commit", "--quiet", "-m", "init"]);
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

    #[test]
    fn cache_get_empty_for_unknown_or_blank_dir() {
        let cache = GitInfoCache::new();
        assert_eq!(cache.get("/nope"), GitInfo::default());
        assert_eq!(cache.get(""), GitInfo::default());
    }

    #[test]
    fn get_or_refresh_returns_fresh_without_recompute() {
        let mut cache = GitInfoCache::new();
        let info = GitInfo { branch: "cached".into(), ..Default::default() };
        cache.insert("/repo", info.clone(), 1000);
        // Fresh → returns cached value without shelling out to git.
        assert_eq!(cache.get_or_refresh("/repo", 2000), info);
    }

    #[test]
    fn git_common_dir_matches_across_worktrees_of_one_repo() {
        let root = tempfile::TempDir::new().unwrap();
        let main = root.path().join("main");
        std::fs::create_dir(&main).unwrap();
        git(&main, &["init", "--quiet", "-b", "main"]);
        git(&main, &["config", "user.email", "test@example.com"]);
        git(&main, &["config", "user.name", "Test"]);
        std::fs::write(main.join("f.txt"), "1").unwrap();
        git(&main, &["add", "f.txt"]);
        git(&main, &["commit", "--quiet", "-m", "init"]);
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
    fn worktree_dirs_classifies_unmanaged_worktrees() {
        let root = tempfile::TempDir::new().unwrap();
        let main = root.path().join("main");
        std::fs::create_dir(&main).unwrap();
        git(&main, &["init", "--quiet", "-b", "main"]);
        git(&main, &["config", "user.email", "test@example.com"]);
        git(&main, &["config", "user.name", "Test"]);
        std::fs::write(main.join("f.txt"), "1").unwrap();
        git(&main, &["add", "f.txt"]);
        git(&main, &["commit", "--quiet", "-m", "init"]);

        // A managed task: at `.claude/worktrees/<name>` with a `.tt-task` marker.
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

        // An unmanaged worktree: a plain sibling dir, no marker at all —
        // e.g. `claude --worktree` in a repo whose hooks aren't wired, or a
        // worktree someone added by hand.
        let unmanaged_dir = root.path().join("scratch-ext");
        git(
            &main,
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "scratch-ext",
                unmanaged_dir.to_str().unwrap(),
            ],
        );

        // Both siblings are discovered; only the marker-less linked one is
        // reported as unmanaged, which is what the rail's visibility toggle
        // switches on.
        let (mut all, unmanaged) = worktree_dirs_of(main.to_str().unwrap());
        all.sort();
        assert_eq!(all, sorted(vec![path_s(&managed), path_s(&unmanaged_dir)]));
        assert_eq!(unmanaged, vec![path_s(&unmanaged_dir)]);

        // From the task's perspective the primary checkout is discovered too —
        // it has no `.tt-task` marker, but it's the main worktree, not an
        // unmanaged linked one. This is what keeps a repo group's main
        // checkout in the rail when only tasks were ever tracked in
        // repos.json.
        let (mut all, unmanaged) = worktree_dirs_of(managed.to_str().unwrap());
        all.sort();
        assert_eq!(all, sorted(vec![path_s(&main), path_s(&unmanaged_dir)]));
        assert_eq!(unmanaged, vec![path_s(&unmanaged_dir)]);
    }

    #[test]
    fn prune_stale_worktree_clears_a_deleted_but_unpruned_registration() {
        let root = tempfile::TempDir::new().unwrap();
        let main = root.path().join("main");
        std::fs::create_dir(&main).unwrap();
        git(&main, &["init", "--quiet", "-b", "main"]);
        git(&main, &["config", "user.email", "test@example.com"]);
        git(&main, &["config", "user.name", "Test"]);
        std::fs::write(main.join("f.txt"), "1").unwrap();
        git(&main, &["add", "f.txt"]);
        git(&main, &["commit", "--quiet", "-m", "init"]);

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

        // Simulate the directory being deleted outside `git worktree remove`/
        // `tt task rm` (a bare `rm -rf`): git's `.git/worktrees/thing`
        // registration survives, so `git worktree list` keeps reporting it —
        // this is the raw git-level fact `prune_stale_worktree` targets,
        // independent of `is_managed_task`'s own separate on-disk check.
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
        git(repo, &["init", "--quiet", "-b", "main"]);
        git(repo, &["config", "user.email", "test@example.com"]);
        git(repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("f.txt"), "1").unwrap();
        git(repo, &["add", "f.txt"]);
        git(repo, &["commit", "--quiet", "-m", "init"]);
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
        git(repo, &["init", "--quiet", "-b", "main"]);
        git(repo, &["config", "user.email", "test@example.com"]);
        git(repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("f.txt"), "1").unwrap();
        git(repo, &["add", "f.txt"]);
        git(repo, &["commit", "--quiet", "-m", "init"]);
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

    /// `dirty` and the uncommitted counts against a real working tree.
    ///
    /// These used to be asserted by parsing fixture `--porcelain`/`--numstat`
    /// strings. There is no such text now, and a fixture would only prove that
    /// this module can read its own invention — so the assertions moved onto a
    /// real repository, where they can catch a genuine disagreement about what
    /// counts as a change.
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

    /// The whole point of the split: committed work and uncommitted work are
    /// reported as two disjoint quantities, so neither number can be read as
    /// belonging to the other. The old single ± measured the working tree
    /// against the merge-base, which silently folded an uncommitted edit into
    /// the figure sitting beside the commit count.
    #[test]
    fn committed_and_uncommitted_diffs_are_disjoint() {
        let root = tempfile::TempDir::new().unwrap();
        init_repo(root.path());
        let repo = root.path();
        let dir = repo.to_str().unwrap();

        // `init_repo`'s file has no trailing newline and no origin ref; give
        // the base both, so the numbers below are the ones `git diff` prints.
        std::fs::write(repo.join("f.txt"), "1\n").unwrap();
        git(repo, &["commit", "--quiet", "-am", "normalize"]);
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
        git(repo, &["init", "--quiet", "-b", "main"]);
        git(repo, &["config", "user.email", "test@example.com"]);
        git(repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("f.txt"), "1").unwrap();
        git(repo, &["add", "f.txt"]);
        git(repo, &["commit", "--quiet", "-m", "init"]);

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

    /// The bug this module used to have: `commits_ahead`/`files_changed` were
    /// always measured against origin/main, even for a folder whose diff pane
    /// compares against something else — so the Folder Rail's numbers
    /// disagreed with what the diff pane actually showed. Both must now come
    /// from the same `resolve_base_ref` baseline.
    #[test]
    fn compute_measures_stats_against_the_resolved_base_not_always_main() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path();
        git(repo, &["init", "--quiet", "-b", "main"]);
        git(repo, &["config", "user.email", "test@example.com"]);
        git(repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("f.txt"), "1").unwrap();
        git(repo, &["add", "f.txt"]);
        git(repo, &["commit", "--quiet", "-m", "init"]);

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

    /// The scenario this field exists for: this repo's convention only allows
    /// rebase merges (see root CLAUDE.md), which replay a branch's commits
    /// onto main under brand-new SHAs. `commits_ahead` (SHA reachability)
    /// then never reaches 0 for that branch's own checkout, forever — even
    /// though its content landed. `commits_unlanded` (patch-id equivalence
    /// via `git cherry`) must reach 0 anyway, since that's the only way a
    /// "safe to delete" signal can ever fire on this repo's workflow.
    #[test]
    fn commits_unlanded_reaches_zero_after_a_rebase_style_landing_even_though_ahead_does_not() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path();
        git(repo, &["init", "--quiet", "-b", "main"]);
        git(repo, &["config", "user.email", "test@example.com"]);
        git(repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("f.txt"), "1").unwrap();
        git(repo, &["add", "f.txt"]);
        git(repo, &["commit", "--quiet", "-m", "init"]);

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

        // Simulate what a rebase-merged PR leaves behind: the same change,
        // landed on main as a brand-new commit (different SHA — main moves on
        // with an unrelated commit first, same as real life, so the
        // cherry-picked commit gets a different parent) via cherry-pick
        // rather than a fast-forward/true-merge.
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
        git(repo, &["init", "--quiet", "-b", "main"]);
        git(repo, &["config", "user.email", "test@example.com"]);
        git(repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("f.txt"), "1").unwrap();
        git(repo, &["add", "f.txt"]);
        git(repo, &["commit", "--quiet", "-m", "init"]);
        git(repo, &["update-ref", "refs/remotes/origin/main", "main"]);

        git(repo, &["checkout", "--quiet", "-b", "feature"]);
        std::fs::write(repo.join("f.txt"), "2").unwrap();
        git(repo, &["commit", "--quiet", "-am", "on feature, never merged"]);

        let dir = repo.to_str().unwrap();
        let info = compute_git_info(dir, None, None, NOW);
        assert_eq!(info.commits_ahead, 1);
        assert_eq!(info.commits_unlanded, 1);
        assert_eq!(info.landed, None, "nothing landed, so the rail must not claim otherwise");
    }

    /// An entry stamped with a timestamp captured *before* a slow batch is born
    /// already past the TTL, so the very next poll finds it stale and recomputes
    /// immediately — a loop with no upper bound. This is the arithmetic behind a
    /// real incident: the agentboard's git warm loop reused its pre-batch `now`,
    /// and once the landing probe pushed a batch past `GIT_CACHE_TTL_MS` it
    /// spawned ~20 git subprocesses/sec around the clock. Stamp with the time the
    /// batch *finished*.
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

    /// The structural guard against that same storm: when nothing the landing
    /// probe reads has moved, its answer is reused rather than recomputed, so a
    /// hot poll costs three cheap reads instead of up to ~192 subprocesses. The
    /// previous answer is poisoned with a value the probe could never produce —
    /// if it survives, the probe genuinely did not run.
    #[test]
    fn unchanged_revision_reuses_the_landing_answer_and_a_moved_head_invalidates_it() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path();
        git(repo, &["init", "--quiet", "-b", "main"]);
        git(repo, &["config", "user.email", "test@example.com"]);
        git(repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("f.txt"), "1").unwrap();
        git(repo, &["add", "f.txt"]);
        git(repo, &["commit", "--quiet", "-m", "init"]);
        git(repo, &["update-ref", "refs/remotes/origin/main", "main"]);
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
        git(&repo, &["init", "--quiet", "-b", "main"]);
        git(&repo, &["config", "user.email", "test@example.com"]);
        git(&repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("f.txt"), "1").unwrap();
        git(&repo, &["add", "f.txt"]);
        git(&repo, &["commit", "--quiet", "-m", "init"]);
        git(&repo, &["worktree", "add", "-b", "task", worktree.to_str().unwrap()]);

        let resolved = resolve_git_dir_fs(&worktree).expect("real worktree must resolve");
        // The real git-maintained pointer is the ground truth here, not a
        // guess — this is exactly what `rev-parse --git-dir` would answer,
        // reached with zero subprocess spawns instead. The test spawns it
        // precisely because that is the thing being agreed with.
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

    /// End-to-end proof that `compute_git_info` populates `git_dir` (and
    /// therefore what `control_files_for` will later watch) without ever
    /// spawning `rev-parse --git-dir` — it's resolved purely from the
    /// filesystem now, for both a plain checkout and a linked worktree.
    #[test]
    fn compute_git_info_resolves_git_dir_from_the_filesystem_for_worktrees_too() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path().join("main");
        let worktree = root.path().join("task");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "--quiet", "-b", "main"]);
        git(&repo, &["config", "user.email", "test@example.com"]);
        git(&repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("f.txt"), "1").unwrap();
        git(&repo, &["add", "f.txt"]);
        git(&repo, &["commit", "--quiet", "-m", "init"]);
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

    /// The watch set itself, pinned against a *real* repository for both
    /// shapes a tracked checkout can take. The split is the whole reason this
    /// can't be one path prefix: a linked worktree's `HEAD`/`index` live in
    /// its own per-worktree gitdir under `<common>/worktrees/<name>/`, while
    /// every ref it compares against — `packed-refs`, `refs/heads/*`,
    /// `refs/remotes/origin/*` — lives in the shared common dir. Watching
    /// only one of the two would miss either the worktree's own branch
    /// switches or a commit landing on its base from a sibling checkout.
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

    /// End-to-end proof that the watch set is *actionable*, not just correct:
    /// register [`control_files_for`]'s paths the way the host's scan loop
    /// does and a `git checkout -b` must surface within a debounce window,
    /// not on the poll's [`GIT_CACHE_TTL_MS`] backup ceiling. This is the
    /// latency claim the accelerant exists to make, so it is asserted rather
    /// than assumed — and the recompute afterwards proves the fired path was
    /// the one carrying the new branch.
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
        git(repo, &["init", "--quiet", "-b", "main"]);
        git(repo, &["config", "user.email", "test@example.com"]);
        git(repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("f.txt"), "1").unwrap();
        git(repo, &["add", "f.txt"]);
        git(repo, &["commit", "--quiet", "-m", "init"]);

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
        // Proves a real re-derive ran rather than returning the poisoned
        // value — `worktree_dirs` itself stays empty because this sibling is
        // unmanaged and `list_other_worktrees` filters those out by design.
        assert_ne!(reprobed.origin_url.as_deref(), Some("sentinel"));
    }

    /// Sets up a committed repo and returns its dir helper. Shared by the
    /// revision-fast-path tests below.
    fn init_repo(repo: &std::path::Path) {
        git(repo, &["init", "--quiet", "-b", "main"]);
        git(repo, &["config", "user.email", "test@example.com"]);
        git(repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("f.txt"), "1").unwrap();
        git(repo, &["add", "f.txt"]);
        git(repo, &["commit", "--quiet", "-m", "init"]);
    }

    /// The big win for #329: when no ref has moved since the last compute, the
    /// ref-derived half (branch/ahead/behind/landing) is reused wholesale and
    /// only the working-tree half (status/diff) is recomputed — so a
    /// backup-poll tick over an idle repo pays for two of the nine reads, not
    /// all nine. Proven by
    /// poisoning ref-derived fields that the real repo could never produce and
    /// watching them survive, while a working-tree change made after the first
    /// compute is still picked up.
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
        git(repo, &["init", "--quiet", "-b", "main"]);
        git(repo, &["config", "user.email", "test@example.com"]);
        git(repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("f.txt"), "1").unwrap();
        git(repo, &["add", "f.txt"]);
        git(repo, &["commit", "--quiet", "-m", "init"]);

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

    /// The landing probe synthesises commit objects to get a patch-id to
    /// compare. This runs on the Agentboard's poll, so if those land in the
    /// repo's own object store they accumulate indefinitely — nothing here
    /// triggers auto-gc, and `git gc` keeps unreachable objects for two weeks
    /// even when it does run. `ops::work_state` redirects them to scratch
    /// storage; nothing else in the test suite would notice if that stopped
    /// working.
    #[test]
    fn computing_git_info_leaves_no_objects_behind_in_the_repo() {
        let root = tempfile::TempDir::new().unwrap();
        let repo = root.path();
        git(repo, &["init", "--quiet", "-b", "main"]);
        git(repo, &["config", "user.email", "test@example.com"]);
        git(repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("f.txt"), "1").unwrap();
        git(repo, &["add", "f.txt"]);
        git(repo, &["commit", "--quiet", "-m", "init"]);
        git(repo, &["update-ref", "refs/remotes/origin/main", "main"]);
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
        git(repo, &["init", "--quiet", "-b", "main"]);
        git(repo, &["config", "user.email", "test@example.com"]);
        git(repo, &["config", "user.name", "Test"]);
        std::fs::write(repo.join("f.txt"), "1").unwrap();
        git(repo, &["add", "f.txt"]);
        git(repo, &["commit", "--quiet", "-m", "init"]);

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
