//! The agentboard engine: tracker + git cache + watchers behind one struct,
//! host-agnostic, so every host shares it.
//!
//! The engine is synchronous; hosts own scheduling and transport, and guard it
//! with a `Mutex`. Everything expensive that does NOT need engine state is
//! deliberately outside `impl Engine` — [`collect_agent_snapshot`] and
//! [`crate::git_info::compute_git_info`] run unlocked, their results handed to
//! cheap locked methods.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::bridge::{StatePayload, assemble_state};
use crate::git_info::GitInfoCache;
use crate::procenv::InstanceScope;
use crate::repos::{
    RepoEntry, add_repo_persisted, default_repos_path, load_repos, load_scan_roots,
    remove_repo_persisted, repo_entries, resolve_session_name, save_scan_roots,
    untrack_missing_persisted,
};
use crate::sessions::{SessionRecord, SessionStore, default_sessions_path};
use crate::tracker::{AgentTracker, instance_key};
use crate::types::{AgentEvent, AgentStatus, RowRecord, RowTask};
use crate::watcher::{AgentWatcher, WatcherContext};
use crate::watchers::claude_code::ClaudeCodeAgentWatcher;

/// One rail row. Its `dir` is where the checkout *should* be, not a claim that
/// anything is there.
#[derive(Debug, Clone, PartialEq)]
pub struct RailRow {
    pub dir: String,
    pub repo_root: String,
    pub record: RowRecord,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UnrecordedWorktree {
    pub repo_root: String,
    pub dir: String,
    pub branch: Option<String>,
}

/// Every directory in `<checkout>/.claude/worktrees/`, whatever git makes of it —
/// the one candidate source that survives git forgetting the registration.
fn task_dirs_on_disk(checkout: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(tt_tasks::worktrees_dir(Path::new(checkout))) else {
        return Vec::new();
    };
    entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| e.path().to_string_lossy().into_owned())
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitInvalidation {
    ControlFile,
    TurnEnd,
    FolderFocus,
    BaseBranch,
    WorktreeRemoved,
    WindowFocus,
}

impl GitInvalidation {
    fn as_str(self) -> &'static str {
        match self {
            Self::ControlFile => "control_file",
            Self::TurnEnd => "turn_end",
            Self::FolderFocus => "folder_focus",
            Self::BaseBranch => "base_branch",
            Self::WorktreeRemoved => "worktree_removed",
            Self::WindowFocus => "window_focus",
        }
    }
}

/// Fetch cadence per activity tier, and the windows that sort a repo into one.
/// A repo with a task worktree, or touched within [`ACTIVE_WINDOW_MS`], keeps
/// the cadence every repo used to get; the rest earn theirs back.
const ACTIVE_FETCH_MS: i64 = 3 * 60 * 1000;
const RECENT_FETCH_MS: i64 = 15 * 60 * 1000;
const IDLE_FETCH_MS: i64 = 60 * 60 * 1000;
const ACTIVE_WINDOW_MS: i64 = 60 * 60 * 1000;
const RECENT_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

/// Every tier stretches by this much while the window is in the background —
/// "behind main" has no reader until focus returns.
const UNFOCUSED_FETCH_MULT: i64 = 5;

const STUCK_MS: i64 = 3 * 60 * 1000;
const STALE_MS: i64 = 12 * 60 * 60 * 1000;
const IDLE_MS: i64 = 30 * 1000;

/// How long a [`Engine::git_pending`] claim blocks a second `stale_git_targets`
/// caller — longer than any real compute, so only a dropped result hits it.
const GIT_PENDING_GUARD_MS: i64 = 30_000;

fn persisted<E: std::fmt::Display>(result: std::result::Result<(), E>, what: &str) {
    if let Err(e) = result {
        log::warn!("failed to persist {what}: {e}");
    }
}

pub use tt_config::now_ms;

struct CollectCtx<'a> {
    resolve: &'a dyn Fn(&str) -> Option<String>,
    events: Vec<AgentEvent>,
}

impl WatcherContext for CollectCtx<'_> {
    fn resolve_session(&self, project_dir: &str) -> Option<String> {
        (self.resolve)(project_dir)
    }
    fn emit(&mut self, event: AgentEvent) {
        self.events.push(event);
    }
}

pub struct Engine {
    projects_dir: PathBuf,
    repos_path: PathBuf,
    repo_paths: Vec<String>,
    /// `repos.json`'s version at the last good parse — four `reload_repos` call
    /// sites fire per scan tick, and the answer only changes on an edit.
    repos_stat: Option<crate::persist::FileVersion>,
    tracker: AgentTracker,
    folder_meta: crate::folder_meta::FolderMetaStore,
    repo_meta: crate::repo_meta::RepoMetaStore,
    windows: crate::windows::WindowsStore,
    collapse: crate::collapse::CollapseStore,
    sessions: SessionStore,
    git_cache: GitInfoCache,
    /// Dirs handed out by [`Self::stale_git_targets`] — an in-flight claim, not a
    /// cache field. The 2s scan loop and the 10s stat poll share a TTL, so without
    /// it both race duplicate recomputes. Released by [`Self::store_git_info`].
    git_pending: HashMap<String, i64>,
    /// When each repo was last handed to a `git fetch`, keying the activity
    /// tier in [`Self::fetch_targets`]. Repo roots only, never worktrees: one
    /// fetch serves every worktree sharing the `.git`.
    git_fetched: HashMap<String, i64>,
    watchers: Vec<Box<dyn AgentWatcher + Send>>,
    compact_recommend_percent: u8,
    /// `agentboard.showUnmanagedWorktrees`, off by default — a display filter over
    /// [`RowRecord::Detected`]; the host gates its reconciler on it too.
    show_unmanaged_worktrees: bool,
    /// The rail's worktree rows, pushed in by the host since the engine is
    /// store-free. **Records, not directories**: an entry puts a row on the rail
    /// whether or not anything exists at its `dir`.
    task_worktrees: Vec<tt_store::RailWorktree>,
    seeded_once: bool,
    /// Sticky agent→PTY attribution, kept while the tracker holds the thread, so
    /// an exited agent stays on the pane it ran in rather than drifting.
    thread_sessions: HashMap<String, String>,
    scope: InstanceScope,
}

/// What [`Engine::compute_payload_with`] needs from the system rather than engine
/// state. Collected outside the lock: it spawns a process and reads transcripts.
pub struct AgentSnapshot {
    live_threads: HashSet<String>,
    tt_session_by_thread: HashMap<String, String>,
    session_agents: HashMap<String, AgentEvent>,
}

/// Gather the live-agent inputs for a payload rebuild. Call it WITHOUT the engine
/// lock so a slow claude CLI can't stall `ab_*` commands. `scope` must match the
/// engine's, so attribution and admission agree on what is ours.
pub fn collect_agent_snapshot(now: i64, scope: &InstanceScope) -> AgentSnapshot {
    let cli_agents = crate::claude_cli::fetch_agents_cached(std::time::Duration::from_millis(
        crate::watchers::claude_code::CLI_CACHE_TTL_MS,
    ))
    .agents;
    let live_threads: HashSet<String> = cli_agents.iter().map(|a| a.session_id.clone()).collect();
    // Unmapped falls back to the folder's default session; out of `scope` is
    // dropped entirely.
    let tt_session_by_thread: HashMap<String, String> = cli_agents
        .iter()
        .filter_map(|a| {
            crate::procenv::session_id_in_scope(a.pid, scope).map(|sid| (a.session_id.clone(), sid))
        })
        .collect();
    // Supplement CLI detection with app-spawned sessions it never enumerated, and
    // only where `pick_state` came back empty: enriching an already-accounted one
    // cost two 128 KiB reads per agent per rebuild, then threw it away.
    let cli_covered: HashSet<&String> = tt_session_by_thread.values().collect();
    let mut session_agents: HashMap<String, AgentEvent> = HashMap::new();
    for proc in crate::procenv::scan_session_agents(scope) {
        if session_agents.contains_key(&proc.session_id) || cli_covered.contains(&proc.session_id) {
            continue;
        }
        let (thread_name, status) = match &proc.transcript {
            Some(p) => crate::watchers::claude_code::enrich_from_transcript(p),
            None => (None, AgentStatus::Idle),
        };
        session_agents.insert(
            proc.session_id.clone(),
            AgentEvent {
                agent: "claude-code".to_string(),
                session: String::new(),
                status,
                ts: now,
                thread_id: None,
                thread_name,
                unseen: None,
                details: None,
            },
        );
    }
    AgentSnapshot { live_threads, tt_session_by_thread, session_agents }
}

impl Engine {
    /// `scope` picks which app instances' agents this host reports.
    pub fn new(scope: InstanceScope) -> Self {
        let projects_dir =
            dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".claude").join("projects");
        let repos_path = default_repos_path();

        let settings = tt_config::load().unwrap_or_default();
        let compact_recommend_percent = settings
            .agentboard
            .compact_recommend_percent
            .unwrap_or(tt_config::DEFAULT_COMPACT_RECOMMEND_PERCENT);
        let show_unmanaged_worktrees = settings
            .agentboard
            .show_unmanaged_worktrees
            .unwrap_or(tt_config::DEFAULT_SHOW_UNMANAGED_WORKTREES);

        Self {
            projects_dir: projects_dir.clone(),
            repo_paths: load_repos(&repos_path),
            // Unset so the first `reload_repos` always reads: only a good parse
            // stamps this, and `load_repos` swallows a corrupt file as empty.
            repos_stat: None,
            repos_path,
            tracker: AgentTracker::new(),
            sessions: SessionStore::new(Some(default_sessions_path())),
            folder_meta: crate::folder_meta::FolderMetaStore::new(Some(
                crate::folder_meta::default_folder_meta_path(),
            )),
            repo_meta: crate::repo_meta::RepoMetaStore::new(Some(
                crate::repo_meta::default_repo_meta_path(),
            )),
            windows: crate::windows::WindowsStore::new(
                Some(crate::windows::default_windows_path()),
            ),
            collapse: crate::collapse::CollapseStore::new(Some(
                crate::collapse::default_collapse_path(),
            )),
            git_cache: GitInfoCache::new(),
            git_pending: HashMap::new(),
            git_fetched: HashMap::new(),
            watchers: vec![Box::new(ClaudeCodeAgentWatcher::with_defaults(
                scope.clone(),
            ))],
            compact_recommend_percent,
            show_unmanaged_worktrees,
            task_worktrees: Vec::new(),
            seeded_once: false,
            thread_sessions: HashMap::new(),
            scope,
        }
    }

    pub fn projects_dir(&self) -> PathBuf {
        self.projects_dir.clone()
    }

    /// Re-read `repos.json` so another writer's changes land without a restart. A
    /// torn read keeps the last known-good list; empty would prune every session.
    fn reload_repos(&mut self) {
        // A missing file has no version and falls through, which `try_load_repos`
        // treats as an empty list — so "the file was deleted" keeps working.
        let stat = crate::persist::file_version(&self.repos_path);
        if stat.is_some() && stat == self.repos_stat {
            return;
        }
        if let Some(paths) = crate::repos::try_load_repos(&self.repos_path) {
            self.repo_paths = paths;
            // Caching a corrupt file's stat would stop the next tick re-reading.
            self.repos_stat = stat;
        }
    }

    pub fn scan_once(&mut self, now: i64) {
        self.reload_repos();
        let all_paths = self.rail_dirs();
        let entries = repo_entries(&all_paths);
        self.scan_once_with_resolver(&|dir| resolve_session_name(dir, &entries), now);
    }

    /// Every row the rail should show, in rail order. **Rows come from records,
    /// never from detection**: each `repos.json` path is a [`RowRecord::Checkout`]
    /// followed by its task rows, existing or not. Order is `repos.json` order then
    /// `created_at` — never name-sort, and callers must not re-sort.
    fn rail_rows(&mut self) -> Vec<RailRow> {
        let show_unmanaged = self.show_unmanaged_worktrees;
        let mut rows: Vec<RailRow> = Vec::with_capacity(self.repo_paths.len());
        let mut seen: HashSet<&str> = HashSet::new();
        for root in &self.repo_paths {
            if !seen.insert(root.as_str()) {
                continue;
            }
            rows.push(RailRow {
                dir: root.clone(),
                repo_root: root.clone(),
                record: RowRecord::Checkout,
            });
            // Already `created_at`-ordered; an index would be rebuilt per push.
            for wt in self.task_worktrees.iter().filter(|w| &w.repo_root == root) {
                if wt.kind == tt_store::TaskKind::Detected && !show_unmanaged {
                    continue;
                }
                if !seen.insert(wt.dir.as_str()) {
                    continue;
                }
                let task = RowTask {
                    id: wt.task_id,
                    status: wt.status.clone(),
                    branch: wt.branch.clone(),
                };
                rows.push(RailRow {
                    dir: wt.dir.clone(),
                    repo_root: root.clone(),
                    record: match wt.kind {
                        tt_store::TaskKind::Task => RowRecord::Task { task },
                        tt_store::TaskKind::Detected => RowRecord::Detected { task },
                    },
                });
            }
        }
        rows
    }

    fn rail_dirs(&mut self) -> Vec<String> {
        self.rail_rows().into_iter().map(|r| r.dir).collect()
    }

    /// Checkouts under a tracked repo that no task row claims; the host mints a
    /// `detected` record for each. **A directory that isn't there is never
    /// offered**: git reports a removed worktree until its registration is pruned,
    /// so offering it would mint a record forgotten next tick — a flap.
    pub fn unrecorded_worktrees(&mut self) -> Vec<UnrecordedWorktree> {
        self.reload_repos();
        let recorded: HashSet<&str> = self.task_worktrees.iter().map(|w| w.dir.as_str()).collect();
        let mut out = Vec::new();
        let mut offered: HashSet<String> = HashSet::new();
        for root in &self.repo_paths {
            let info = self.git_cache.get(root);
            for dir in info.linked_worktree_dirs.into_iter().chain(task_dirs_on_disk(root)) {
                // A tracked worktree is a `Checkout` row; two records otherwise.
                if self.repo_paths.contains(&dir) || recorded.contains(dir.as_str()) {
                    continue;
                }
                // See this method's doc — offering a gone directory flaps the row.
                if !Path::new(&dir).is_dir() {
                    continue;
                }
                if !offered.insert(dir.clone()) {
                    continue;
                }
                let branch = {
                    let wt = self.git_cache.get(&dir);
                    (!wt.branch.is_empty()).then_some(wt.branch)
                };
                out.push(UnrecordedWorktree { repo_root: root.clone(), dir, branch });
            }
        }
        out
    }

    /// `detected` rows whose directory is gone — the host forgets them. Only ever
    /// `detected`: a **task** whose directory vanished is the row that must survive,
    /// rendered detached. The one place the filesystem decides a record's fate.
    pub fn vanished_detected_records(&self) -> Vec<String> {
        self.task_worktrees
            .iter()
            .filter(|w| w.kind == tt_store::TaskKind::Detected)
            .filter(|w| !Path::new(&w.dir).is_dir())
            .map(|w| w.dir.clone())
            .collect()
    }

    /// [`Self::rail_rows`]'s dirs, for scoping the eager-rescan fs watch to the
    /// repos actually being polled rather than every session on the machine.
    pub fn watch_targets(&mut self) -> Vec<String> {
        self.reload_repos();
        self.rail_dirs()
    }

    /// `.git` internal files worth watching, mapped to the checkout each belongs to,
    /// so a commit/fetch/switch invalidates that dir instead of waiting out the TTL.
    pub fn control_watch_files(&mut self) -> std::collections::HashMap<std::path::PathBuf, String> {
        self.reload_repos();
        let dirs = self.rail_dirs();
        let mut out = std::collections::HashMap::new();
        for dir in dirs {
            let info = self.git_cache.get(&dir);
            for file in crate::git_info::control_files_for(&info) {
                out.insert(file, dir.clone());
            }
        }
        out
    }

    /// Mark `dir`'s cache entry stale — the event-driven counterpart to the TTL.
    /// `reason` lands on the `git.invalidated` record.
    pub fn invalidate_git(&mut self, dir: &str, reason: GitInvalidation) {
        self.git_cache.invalidate(Some(dir));
        tracing::debug!(%dir, reason = reason.as_str(), "git.invalidated");
    }

    /// Aim the short git-freshness ceiling at the checkout whose files pane just
    /// mounted, or release it on unmount. A release is ignored unless it still holds
    /// the focus: switching folders mounts the new pane before the old one's cleanup.
    pub fn set_folder_focus(&mut self, dir: &str, focused: bool) -> bool {
        let next = match focused {
            true => Some(dir),
            false if self.git_cache.focused_dir() == Some(dir) => None,
            false => return false,
        };
        let moved = self.git_cache.set_focused(next);
        if focused {
            self.invalidate_git(dir, GitInvalidation::FolderFocus);
        }
        moved
    }

    /// Follow OS window focus, widening the git-freshness ceiling while the app
    /// sits in the background. Coming back invalidates every row rather than
    /// serving one up to five minutes old to someone who just looked at it.
    /// Returns whether focus actually moved.
    pub fn set_window_focused(&mut self, focused: bool) -> bool {
        let moved = self.git_cache.set_window_focused(focused);
        if moved && focused {
            self.git_cache.invalidate(None);
            tracing::debug!(reason = GitInvalidation::WindowFocus.as_str(), "git.invalidated");
        }
        moved
    }

    /// Rail dirs whose git-cache entry is missing or past the TTL. Claims each so
    /// the other poll loop can't retake it.
    pub fn stale_git_targets(
        &mut self,
        now: i64,
    ) -> Vec<(String, Option<String>, crate::git_info::GitInfo)> {
        self.reload_repos();
        let all_paths = self.rail_dirs();
        let pending_guard = |d: &str| {
            self.git_pending
                .get(d)
                .is_some_and(|claimed_at| now - claimed_at < GIT_PENDING_GUARD_MS)
        };
        let stale: Vec<String> = all_paths
            .into_iter()
            .filter(|d| !self.git_cache.is_fresh(d, now) && !pending_guard(d))
            .collect();
        let out = self.targets_for(stale);
        for (d, _, _) in &out {
            self.git_pending.insert(d.clone(), now);
        }
        out
    }

    /// Pair each dir with what a recompute needs: the base-branch override, and the
    /// cached value so an unmoved repo revalidates instead of re-probing.
    fn targets_for(
        &self,
        dirs: Vec<String>,
    ) -> Vec<(String, Option<String>, crate::git_info::GitInfo)> {
        dirs.into_iter()
            .map(|d| {
                let base = self.folder_meta.base_branch_for(&d).map(str::to_string);
                let previous = self.git_cache.get(&d);
                (d, base, previous)
            })
            .collect()
    }

    pub fn warm_git_cache(
        &mut self,
        results: Vec<(String, crate::git_info::GitInfo)>,
        now: i64,
    ) -> bool {
        let mut changed = false;
        for (dir, info) in results {
            changed |= self.store_git_info(&dir, info, now);
        }
        changed
    }

    fn scan_once_with_resolver(&mut self, resolve: &dyn Fn(&str) -> Option<String>, now: i64) {
        let mut ctx = CollectCtx { resolve, events: Vec::new() };
        for watcher in &mut self.watchers {
            watcher.scan(&mut ctx, now);
        }
        let seed = !self.seeded_once;
        for event in ctx.events {
            self.tracker.apply_event(event, seed);
        }
        self.seeded_once = true;
    }

    /// The tracked checkout whose cached `linked_worktree_dirs` lists `dir` — never
    /// itself a `repos.json` entry, so untracking it prunes at the owner.
    pub fn find_worktree_owner(&mut self, dir: &str) -> Option<String> {
        self.reload_repos();
        repo_entries(&self.repo_paths)
            .into_iter()
            .find(|e| self.git_cache.get(&e.dir).linked_worktree_dirs.iter().any(|w| w == dir))
            .map(|e| e.dir)
    }

    pub fn git_targets(&mut self) -> Vec<(String, Option<String>, crate::git_info::GitInfo)> {
        self.reload_repos();
        let dirs = repo_entries(&self.repo_paths).into_iter().map(|e| e.dir).collect();
        self.targets_for(dirs)
    }

    /// The repos due a `git fetch` right now, on a cadence tiered by whether
    /// anyone is actually working in them.
    ///
    /// A flat cadence over every tracked repo is what made fetching the single
    /// most expensive thing the app does: a fork nobody has opened in a month
    /// costs exactly what the repo with a live task in it costs. The tier reads
    /// signals already cached — a rail worktree under the repo, and `GitInfo`'s
    /// two "somebody was here" stamps — so classifying costs no extra probing.
    /// Marks each returned dir fetched, so the caller must actually fetch it.
    pub fn fetch_targets(&mut self, now: i64) -> Vec<String> {
        let unfocused_mult = if self.git_cache.window_focused() { 1 } else { UNFOCUSED_FETCH_MULT };
        let due: Vec<String> = self
            .git_targets()
            .into_iter()
            .filter(|(dir, _, info)| {
                let last = self.git_fetched.get(dir).copied().unwrap_or(0);
                now - last >= self.fetch_cadence_ms(dir, info, now) * unfocused_mult
            })
            .map(|(dir, _, _)| dir)
            .collect();
        for dir in &due {
            self.git_fetched.insert(dir.clone(), now);
        }
        due
    }

    /// How often one repo earns a fetch. "Active" is deliberately generous —
    /// being wrong here costs a stale "behind main" on a repo being worked in.
    fn fetch_cadence_ms(&self, dir: &str, info: &crate::git_info::GitInfo, now: i64) -> i64 {
        // A task under it, or its files pane open: both mean somebody is reading
        // this repo's "behind main" right now, whatever the mtimes say.
        if self.git_cache.focused_dir() == Some(dir)
            || self.task_worktrees.iter().any(|w| w.repo_root == dir)
        {
            return ACTIVE_FETCH_MS;
        }
        // A stamp of 0 means "clean, never read" — `age` then runs to the
        // epoch and lands the repo in the idle tier, which is the right guess.
        let age = now - info.worktree_touched_ms.max(info.head_commit_ms);
        match age {
            a if a < ACTIVE_WINDOW_MS => ACTIVE_FETCH_MS,
            a if a < RECENT_WINDOW_MS => RECENT_FETCH_MS,
            _ => IDLE_FETCH_MS,
        }
    }

    /// Store one repo's git info, returning whether it differs. A compute that
    /// couldn't read the repository keeps the folder's structural identity.
    pub fn store_git_info(
        &mut self,
        dir: &str,
        mut info: crate::git_info::GitInfo,
        now: i64,
    ) -> bool {
        let previous = self.git_cache.get(dir);
        crate::git_info::preserve_identity_on_failed_read(dir, &previous, &mut info);
        let changed = previous != info;
        self.git_cache.insert(dir, info, now);
        self.git_pending.remove(dir);
        changed
    }

    pub fn tracked_repo_origins(&mut self) -> Vec<(String, Option<String>)> {
        self.reload_repos();
        repo_entries(&self.repo_paths)
            .into_iter()
            .map(|e| {
                let origin = self.git_cache.get(&e.dir).origin_url;
                (e.dir, origin)
            })
            .collect()
    }

    /// Full recompute that collects the agent snapshot itself — one-off reads only;
    /// hot loops collect unlocked and call [`Engine::compute_payload_with`].
    fn compute_payload(&mut self, now: i64) -> StatePayload {
        let snapshot = collect_agent_snapshot(now, &self.scope);
        self.compute_payload_with(&snapshot, now)
    }

    pub fn compute_payload_with(&mut self, snapshot: &AgentSnapshot, now: i64) -> StatePayload {
        self.reload_repos();
        let rows = self.rail_rows();
        // NOT name-sorted: `rail_rows` order is the user's drag order.
        let all_paths: Vec<String> = rows.iter().map(|r| r.dir.clone()).collect();
        let entries = repo_entries(&all_paths);
        let rows_by_dir: HashMap<String, RailRow> =
            rows.into_iter().map(|r| (r.dir.clone(), r)).collect();
        let mut seeded = false;
        for entry in &entries {
            if self.sessions.ensure_default(&entry.dir, now) {
                seeded = true;
            }
        }
        if seeded {
            persisted(self.sessions.save(), "sessions");
        }
        let payload = self.compute_payload_for_entries(&entries, &rows_by_dir, snapshot, now);
        // Never on an empty entry set, far likelier a transient glitch than a real
        // config wipe; a genuine remove-all prunes on the next poll.
        if !entries.is_empty() {
            // Keyed on *records*, not rendered rows: pruning by display state
            // would delete a hidden worktree's session history every poll.
            let mut dirs: HashSet<String> = entries.iter().map(|e| e.dir.clone()).collect();
            dirs.extend(self.task_worktrees.iter().map(|w| w.dir.clone()));
            if self.sessions.prune(&dirs) {
                persisted(self.sessions.save(), "sessions");
            }
            if self.folder_meta.prune(&dirs) {
                persisted(self.folder_meta.save(), "folder meta");
            }
            // A hand-picked icon/color has no undo: reaped on removal only.
            let gone = self.windows.prune(&dirs);
            if !gone.is_empty() {
                persisted(self.windows.save(&gone), "windows");
            }
        }
        payload
    }

    pub fn set_repo_meta(&mut self, dir: &str, meta: crate::repo_meta::RepoMeta) -> bool {
        let changed = self.repo_meta.set_meta(dir, meta);
        if changed {
            persisted(self.repo_meta.save(), "repo identity");
        }
        changed
    }

    pub fn set_folder_base_branch(&mut self, dir: &str, base_branch: Option<&str>) -> bool {
        let changed = self.folder_meta.set_base_branch(dir, base_branch);
        if changed {
            persisted(self.folder_meta.save(), "folder metadata");
            // The 2s scan tick recomputes, rather than the 10s stat poll.
            self.invalidate_git(dir, GitInvalidation::BaseBranch);
        }
        changed
    }

    /// Set (or clear) the quiet override on every one of `dirs`, in one save: the
    /// unit the user marks is a *repo*, and half of one still shows on the rail.
    pub fn set_folder_quiet(&mut self, dirs: &[String], quiet: bool) -> bool {
        // `|=`, never `any`: `any` stops at the first change, half-marking.
        let mut changed = false;
        for dir in dirs {
            changed |= self.folder_meta.set_quiet(dir, quiet);
        }
        if changed {
            persisted(self.folder_meta.save(), "folder metadata");
        }
        changed
    }

    fn touch_folder(&mut self, dir: &str, now_ms: i64) {
        if self.folder_meta.touch(dir, now_ms) {
            persisted(self.folder_meta.save(), "folder metadata");
        }
    }

    /// Replace the persisted window layout. `touched` is the folder dirs the
    /// frontend mutated, so one window's whole-blob save can't clobber another's.
    pub fn set_windows(
        &mut self,
        payload: crate::windows::WindowsPayload,
        touched: &[String],
    ) -> bool {
        let changed = self.windows.set(payload);
        if changed {
            persisted(self.windows.save(touched), "windows");
        }
        changed
    }

    pub fn set_collapsed(&mut self, key: &str, collapsed: bool) -> bool {
        let changed = self.collapse.set(key, collapsed);
        if changed {
            persisted(self.collapse.save(), "rail collapse state");
        }
        changed
    }

    pub fn set_compact_recommend_percent(&mut self, percent: u8) -> bool {
        let percent = percent.clamp(1, 100);
        if percent == self.compact_recommend_percent {
            return false;
        }
        self.compact_recommend_percent = percent;
        if let Ok(mut settings) = tt_config::load() {
            settings.agentboard.compact_recommend_percent = Some(percent);
            persisted(tt_config::save_merge(&settings), "settings");
        }
        true
    }

    /// Show (or hide) auto-discovered non-task worktrees; no git recompute.
    pub fn set_show_unmanaged_worktrees(&mut self, show: bool) -> bool {
        if show == self.show_unmanaged_worktrees {
            return false;
        }
        self.show_unmanaged_worktrees = show;
        if let Ok(mut settings) = tt_config::load() {
            settings.agentboard.show_unmanaged_worktrees = Some(show);
            persisted(tt_config::save_merge(&settings), "settings");
        }
        true
    }

    /// The host's reconciler is gated on this too: minting invisible rows would
    /// write to a shared database every tick.
    pub fn show_unmanaged_worktrees(&self) -> bool {
        self.show_unmanaged_worktrees
    }

    /// Replace the rail's worktree rows, returning whether anything changed so the
    /// host can re-emit at task creation rather than the next poll boundary.
    pub fn set_task_worktrees(&mut self, worktrees: Vec<tt_store::RailWorktree>) -> bool {
        if worktrees == self.task_worktrees {
            return false;
        }
        self.task_worktrees = worktrees;
        true
    }

    /// pid-liveness pin → prune schedule → assemble snapshot.
    fn compute_payload_for_entries(
        &mut self,
        entries: &[RepoEntry],
        rows: &HashMap<String, RailRow>,
        snapshot: &AgentSnapshot,
        now: i64,
    ) -> StatePayload {
        // Sticky, and persisted, so a crash doesn't take the pane→agent
        // pairing with it (see [`crate::resume`]).
        let mut link_changed = false;
        for (tid, sid) in &snapshot.tt_session_by_thread {
            self.thread_sessions.insert(tid.clone(), sid.clone());
            link_changed |= self.sessions.note_agent(sid, tid);
        }
        if link_changed && let Err(e) = self.sessions.save() {
            log::warn!("failed to persist agent session links: {e}");
        }
        let mut pinned: HashMap<String, Vec<String>> = HashMap::new();
        let mut tracked_threads: HashSet<String> = HashSet::new();
        for entry in entries {
            for agent in self.tracker.get_agents(&entry.name) {
                let Some(tid) = agent.thread_id.clone() else {
                    continue;
                };
                if snapshot.live_threads.contains(&tid) {
                    pinned
                        .entry(entry.name.clone())
                        .or_default()
                        .push(instance_key(&agent.agent, Some(&tid)));
                }
                tracked_threads.insert(tid);
            }
        }
        self.tracker.set_pinned_instances_multi(&pinned);
        self.thread_sessions
            .retain(|tid, _| snapshot.live_threads.contains(tid) || tracked_threads.contains(tid));

        self.tracker.prune_stuck(STUCK_MS, now);
        self.tracker.prune_terminal(now);
        self.tracker.prune_stale(STALE_MS, now);
        self.tracker.prune_idle(IDLE_MS, now);

        let mut git_infos = HashMap::new();
        for entry in entries {
            git_infos.insert(entry.dir.clone(), self.git_cache.get(&entry.dir));
        }

        // No mapping falls back to the folder's default; a mapping onto a
        // foreign session is dropped downstream.
        let attribute = |event: &AgentEvent| {
            event.thread_id.as_ref().and_then(|tid| self.thread_sessions.get(tid).cloned())
        };
        let mut payload = assemble_state(
            entries,
            rows,
            &git_infos,
            &self.tracker,
            &self.sessions,
            &self.folder_meta,
            &attribute,
            &snapshot.session_agents,
            self.compact_recommend_percent,
            now,
        );

        for repo in &mut payload.repos {
            repo.meta = self.repo_meta.meta_for(&repo.dir).cloned();
        }

        payload.windows = self.windows.payload().clone();
        payload.collapsed = self.collapse.payload().collapsed.clone();
        payload
    }

    /// Mark a folder's agents seen; `unseen` is derived, so this recomputes.
    pub fn mark_seen_patch(&mut self, name: &str) -> Option<StatePayload> {
        if !self.tracker.mark_seen(name) {
            return None;
        }
        Some(self.compute_payload(now_ms()))
    }

    pub fn repo_dirs(&mut self) -> Vec<String> {
        self.reload_repos();
        self.repo_paths.clone()
    }

    /// `scanRoots` from repos.json; the caller defaults when empty.
    pub fn scan_roots(&self) -> Vec<String> {
        load_scan_roots(&self.repos_path)
    }

    pub fn set_scan_roots(&mut self, roots: Vec<String>) {
        persisted(save_scan_roots(&self.repos_path, &roots), "scan roots");
    }

    /// Adds against `repos.json` rather than the possibly-stale `self.repo_paths`.
    pub fn add_repo(&mut self, path: &str) -> bool {
        match add_repo_persisted(&self.repos_path, path) {
            Ok((merged, added)) => {
                self.repo_paths = merged;
                added
            }
            Err(_) => false,
        }
    }

    pub fn remove_repo(&mut self, dir: &str) -> bool {
        match remove_repo_persisted(&self.repos_path, dir) {
            Ok((merged, removed)) => {
                self.repo_paths = merged;
                // The one place identity is reaped.
                if removed && self.repo_meta.forget(dir) {
                    persisted(self.repo_meta.save(), "repo identity");
                }
                removed
            }
            Err(_) => false,
        }
    }

    /// Set the rail's repo order — [`reorder_repos`] holds the stale-input rule.
    pub fn set_repo_order(&mut self, desired: &[String]) -> std::io::Result<()> {
        let merged = crate::repos::reorder_repos_persisted(&self.repos_path, desired)?;
        self.repo_paths = merged;
        Ok(())
    }

    /// Untrack every repo whose directory is gone — the rail's "missing" ghosts.
    pub fn untrack_missing(&mut self) -> Vec<String> {
        match untrack_missing_persisted(&self.repos_path) {
            Ok((merged, removed)) => {
                self.repo_paths = merged;
                removed
            }
            Err(_) => Vec::new(),
        }
    }

    /// Add a PTY session to a folder and persist. Returns the created record.
    pub fn add_session(&mut self, dir: &str, name: Option<&str>, now: i64) -> SessionRecord {
        let record = self.sessions.add(dir, name, now);
        persisted(self.sessions.save(), "sessions");
        self.touch_folder(dir, now);
        record
    }

    /// The folder's first session, seeding a default if it has none.
    pub fn ensure_session(&mut self, dir: &str, now: i64) -> Option<SessionRecord> {
        if self.sessions.ensure_default(dir, now) {
            persisted(self.sessions.save(), "sessions");
            self.touch_folder(dir, now);
        }
        self.sessions.sessions_for(dir).first().cloned()
    }

    pub fn rename_session(&mut self, id: &str, name: &str) -> bool {
        let changed = self.sessions.rename(id, name);
        if changed {
            persisted(self.sessions.save(), "sessions");
        }
        changed
    }

    pub fn set_session_purpose(&mut self, id: &str, purpose: Option<&str>) -> bool {
        let changed = self.sessions.set_purpose(id, purpose);
        if changed {
            persisted(self.sessions.save(), "sessions");
        }
        changed
    }

    pub fn close_session(&mut self, id: &str, now: i64) -> bool {
        let dir = self.folder_dir_of_session(id);
        let removed = self.sessions.remove(id);
        if removed {
            persisted(self.sessions.save(), "sessions");
            if let Some(dir) = dir {
                self.touch_folder(&dir, now);
            }
        }
        removed
    }

    fn folder_dir_of_session(&self, id: &str) -> Option<String> {
        self.sessions
            .iter()
            .find(|(_, records)| records.iter().any(|r| r.id == id))
            .map(|(dir, _)| dir.to_string())
    }

    /// Session ids scoped to `dir`, removing nothing: a task removal kills live
    /// PTYs *before* the fallible worktree removal, and only then drops records.
    pub fn session_ids_for(&self, dir: &str) -> Vec<String> {
        self.sessions.sessions_for(dir).iter().map(|r| r.id.clone()).collect()
    }

    /// Every persisted session record with its folder dir, cloned, so a caller can
    /// snapshot under the lock and then do slow work unblocked.
    pub fn session_records(&self) -> Vec<(String, SessionRecord)> {
        self.sessions
            .iter()
            .flat_map(|(dir, list)| list.iter().map(move |rec| (dir.to_string(), rec.clone())))
            .collect()
    }

    /// Tear a folder's live rail state down ahead of its checkout disappearing.
    /// Returns the removed session ids (each doubles as its `term_id`) so the
    /// caller can kill their PTYs, which ends any Claude Code process inside.
    pub fn close_folder(&mut self, dir: &str) -> Vec<String> {
        let ids: Vec<String> =
            self.sessions.sessions_for(dir).iter().map(|r| r.id.clone()).collect();
        if !ids.is_empty() {
            for id in &ids {
                self.sessions.remove(id);
            }
            persisted(self.sessions.save(), "sessions");
        }
        if self.windows.remove_folder(dir) {
            persisted(self.windows.save(&[dir.to_string()]), "windows");
        }
        ids
    }

    /// Drop a checkout's cached git info and any in-flight claim once the worktree
    /// is off disk. Only the cache — the row outlives the directory by design.
    pub fn drop_git_cache(&mut self, dir: &str) -> bool {
        self.git_pending.remove(dir);
        self.git_cache.forget(dir)
    }
}

#[cfg(test)]
impl Engine {
    /// Every persisted store in-memory **except** `repos.json`, which points at a
    /// tempdir file. No watchers, so a scan is inert.
    fn new_for_test(repos_path: PathBuf) -> Self {
        Self {
            projects_dir: PathBuf::from("/nonexistent/projects"),
            repo_paths: load_repos(&repos_path),
            repos_stat: None,
            repos_path,
            tracker: AgentTracker::new(),
            sessions: SessionStore::new(None),
            folder_meta: crate::folder_meta::FolderMetaStore::new(None),
            repo_meta: crate::repo_meta::RepoMetaStore::new(None),
            windows: crate::windows::WindowsStore::new(None),
            collapse: crate::collapse::CollapseStore::new(None),
            git_cache: GitInfoCache::new(),
            git_pending: HashMap::new(),
            git_fetched: HashMap::new(),
            watchers: vec![],
            compact_recommend_percent: 80,
            show_unmanaged_worktrees: tt_config::DEFAULT_SHOW_UNMANAGED_WORKTREES,
            task_worktrees: Vec::new(),
            seeded_once: false,
            thread_sessions: HashMap::new(),
            scope: InstanceScope::Any,
        }
    }
}

#[cfg(test)]
mod engine_tests {
    use super::*;

    fn engine() -> (tempfile::TempDir, Engine) {
        let tmp = tempfile::tempdir().unwrap();
        let repos_path = tmp.path().join("repos.json");
        (tmp, Engine::new_for_test(repos_path))
    }

    fn git_info(branch: &str) -> crate::git_info::GitInfo {
        crate::git_info::GitInfo { branch: branch.to_string(), ..Default::default() }
    }

    #[test]
    fn add_session_then_close_session_round_trips_by_folder() {
        let (_tmp, mut e) = engine();
        let a = e.add_session("/repo/x", Some("one"), 1000);
        let b = e.add_session("/repo/x", Some("two"), 1001);
        let ids = e.session_ids_for("/repo/x");
        assert!(ids.contains(&a.id) && ids.contains(&b.id));
        assert!(e.session_ids_for("/repo/other").is_empty());

        assert!(e.close_session(&a.id, 1002));
        assert!(!e.close_session("nope", 1003));
        assert_eq!(e.session_ids_for("/repo/x"), vec![b.id]);

        assert_eq!(e.folder_meta.last_worked_at_for("/repo/x"), Some(1002));
    }

    #[test]
    fn close_folder_returns_the_ids_it_removed_and_empties_the_folder() {
        let (_tmp, mut e) = engine();
        let a = e.add_session("/repo/x", None, 1000);
        let b = e.add_session("/repo/x", None, 1001);

        let mut closed = e.close_folder("/repo/x");
        closed.sort();
        let mut expected = vec![a.id, b.id];
        expected.sort();
        assert_eq!(closed, expected);
        assert!(e.session_ids_for("/repo/x").is_empty());

        assert!(e.close_folder("/repo/never").is_empty());
    }

    #[test]
    fn rename_and_purpose_report_whether_they_changed() {
        let (_tmp, mut e) = engine();
        let rec = e.add_session("/repo/x", Some("orig"), 1000);
        assert!(e.rename_session(&rec.id, "renamed"));
        assert!(!e.rename_session(&rec.id, "renamed"));
        assert!(!e.rename_session("unknown-id", "x"));

        assert!(e.set_session_purpose(&rec.id, Some("ship it")));
        assert!(!e.set_session_purpose(&rec.id, Some("ship it")));
        assert!(e.set_session_purpose(&rec.id, None));
    }

    #[test]
    fn add_repo_is_idempotent_and_remove_reports_removal() {
        let (_tmp, mut e) = engine();
        assert!(e.add_repo("/repo/a"));
        assert!(!e.add_repo("/repo/a"));
        assert!(e.add_repo("/repo/b"));
        assert!(e.repo_dirs().contains(&"/repo/a".to_string()));
        assert!(e.repo_dirs().contains(&"/repo/b".to_string()));

        assert!(e.remove_repo("/repo/a"));
        assert!(!e.remove_repo("/repo/a"));
        assert!(!e.repo_dirs().contains(&"/repo/a".to_string()));
        assert!(e.repo_dirs().contains(&"/repo/b".to_string()));
    }

    #[test]
    fn add_repo_persists_across_a_reconstructed_engine() {
        let tmp = tempfile::tempdir().unwrap();
        let repos_path = tmp.path().join("repos.json");
        {
            let mut e = Engine::new_for_test(repos_path.clone());
            assert!(e.add_repo("/repo/persisted"));
        }
        let e2 = Engine::new_for_test(repos_path);
        assert!(e2.repo_paths.contains(&"/repo/persisted".to_string()));
    }

    #[test]
    fn find_worktree_owner_resolves_a_missing_dir_to_its_tracked_owner() {
        let (_tmp, mut e) = engine();
        assert!(e.add_repo("/repo/main"));
        e.store_git_info(
            "/repo/main",
            crate::git_info::GitInfo {
                linked_worktree_dirs: vec!["/repo/main/.claude/worktrees/thing".to_string()],
                ..Default::default()
            },
            1000,
        );

        // A discovered worktree is no `repos.json` entry, so `remove_repo` can't.
        assert_eq!(
            e.find_worktree_owner("/repo/main/.claude/worktrees/thing"),
            Some("/repo/main".to_string())
        );
        assert!(!e.remove_repo("/repo/main/.claude/worktrees/thing"));

        assert_eq!(e.find_worktree_owner("/repo/elsewhere"), None);
    }

    /// Removal invalidates the *owner* too: its cached `linked_worktree_dirs`
    /// still names the deleted path until a recompute gets through.
    #[test]
    fn invalidating_the_owner_requeues_its_stale_worktree_list() {
        let (_tmp, mut e) = engine();
        // Real epoch-ms: `invalidate` stamps `0`, stale only far from the epoch.
        let now = 1_700_000_000_000;
        let wt = "/repo/main/.claude/worktrees/feat-deleted";
        assert!(e.add_repo("/repo/main"));
        e.store_git_info(
            "/repo/main",
            crate::git_info::GitInfo {
                linked_worktree_dirs: vec![wt.to_string()],
                ..Default::default()
            },
            now,
        );

        assert!(e.stale_git_targets(now + 1).is_empty());

        assert_eq!(e.find_worktree_owner(wt), Some("/repo/main".to_string()));

        e.invalidate_git("/repo/main", GitInvalidation::ControlFile);
        assert!(
            e.stale_git_targets(now + 2).iter().any(|(dir, _, _)| dir == "/repo/main"),
            "the owner must be due for a recompute immediately, not in 60s"
        );
    }

    fn record(repo_root: &str, dir: &str, kind: tt_store::TaskKind) -> tt_store::RailWorktree {
        tt_store::RailWorktree {
            task_id: 1,
            kind,
            status: "doing".to_string(),
            repo_root: repo_root.to_string(),
            dir: dir.to_string(),
            branch: Some("feat/thing".to_string()),
            created_at: 1000,
        }
    }

    /// A row is on the rail because a record says so; detection can't move one.
    #[test]
    fn a_task_row_exists_on_its_record_alone() {
        let (_tmp, mut e) = engine();
        let wt = "/repo/main/.claude/worktrees/feat-thing";
        assert!(e.add_repo("/repo/main"));

        assert!(e.set_task_worktrees(vec![record("/repo/main", wt, tt_store::TaskKind::Task)]));
        assert!(e.watch_targets().contains(&wt.to_string()));
        assert!(!e.set_task_worktrees(vec![record("/repo/main", wt, tt_store::TaskKind::Task)]));

        // The row goes with the record, though the parent still lists it.
        e.store_git_info(
            "/repo/main",
            crate::git_info::GitInfo {
                linked_worktree_dirs: vec![wt.to_string()],
                ..Default::default()
            },
            2000,
        );
        assert!(e.set_task_worktrees(vec![]));
        assert!(!e.watch_targets().contains(&wt.to_string()));
    }

    /// Removal needn't out-race discovery: a deleted worktree keeps its row.
    #[test]
    fn a_task_row_survives_its_directory_vanishing() {
        let (_tmp, mut e) = engine();
        let wt = "/repo/main/.claude/worktrees/feat-gone";
        assert!(e.add_repo("/repo/main"));
        e.set_task_worktrees(vec![record("/repo/main", wt, tt_store::TaskKind::Task)]);
        e.store_git_info(
            wt,
            crate::git_info::GitInfo { dir_missing: true, ..Default::default() },
            1000,
        );

        assert!(e.watch_targets().contains(&wt.to_string()));
        assert!(
            e.vanished_detected_records().is_empty(),
            "a task's record is never retired by its directory going away"
        );
    }

    /// Detected rows are records too: the setting filters, never discovers.
    #[test]
    fn detected_rows_are_hidden_by_the_setting_not_by_discovery() {
        let (_tmp, mut e) = engine();
        let task = "/repo/main/.claude/worktrees/feat-thing";
        let agent = "/repo/main/.claude/worktrees/agent-a12d791a14a404064";
        assert!(e.add_repo("/repo/main"));
        e.set_task_worktrees(vec![
            record("/repo/main", task, tt_store::TaskKind::Task),
            record("/repo/main", agent, tt_store::TaskKind::Detected),
        ]);

        assert_eq!(e.watch_targets(), vec!["/repo/main".to_string(), task.to_string()]);

        e.show_unmanaged_worktrees = true;
        assert_eq!(
            e.watch_targets(),
            vec![
                "/repo/main".to_string(),
                task.to_string(),
                agent.to_string()
            ]
        );
    }

    /// What the host reconciles into `detected` records; empty once recorded.
    #[test]
    fn unrecorded_worktrees_are_offered_once_and_then_stay_quiet() {
        let (tmp, mut e) = engine();
        let wt_path = tmp.path().join("agent-8f21");
        std::fs::create_dir(&wt_path).unwrap();
        let wt = wt_path.to_string_lossy().to_string();
        assert!(e.add_repo("/repo/main"));
        e.store_git_info(
            "/repo/main",
            crate::git_info::GitInfo {
                linked_worktree_dirs: vec![wt.clone()],
                ..Default::default()
            },
            1000,
        );
        e.store_git_info(&wt, git_info("agent/8f21"), 1000);

        let found = e.unrecorded_worktrees();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].dir, wt);
        assert_eq!(found[0].repo_root, "/repo/main");
        assert_eq!(found[0].branch.as_deref(), Some("agent/8f21"));

        e.set_task_worktrees(vec![record("/repo/main", &wt, tt_store::TaskKind::Detected)]);
        assert!(e.unrecorded_worktrees().is_empty(), "already recorded — nothing to write");
    }

    /// The gap the second candidate source closes: git prunes a registration, the
    /// directory stays, and a git-only list can never offer that checkout again.
    #[test]
    fn a_checkout_git_has_forgotten_is_still_offered() {
        let (tmp, mut e) = engine();
        let root = tmp.path().join("repo");
        let wt = tt_tasks::worktrees_dir(&root).join("feat-orphan");
        std::fs::create_dir_all(&wt).unwrap();
        let root_s = root.to_string_lossy().to_string();
        assert!(e.add_repo(&root_s));

        let found = e.unrecorded_worktrees();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].dir, wt.to_string_lossy());
        assert_eq!(found[0].repo_root, root_s);
        assert_eq!(found[0].branch, None, "nothing can name a branch git forgot");
    }

    /// Both sources report every *healthy* worktree, so dedup is the common path.
    #[test]
    fn a_worktree_both_sources_report_is_offered_once() {
        let (tmp, mut e) = engine();
        let root = tmp.path().join("repo");
        let wt = tt_tasks::worktrees_dir(&root).join("feat-thing");
        std::fs::create_dir_all(&wt).unwrap();
        let (root_s, wt_s) = (root.to_string_lossy().to_string(), wt.to_string_lossy().to_string());
        assert!(e.add_repo(&root_s));
        e.store_git_info(
            &root_s,
            crate::git_info::GitInfo {
                linked_worktree_dirs: vec![wt_s.clone()],
                ..Default::default()
            },
            1000,
        );
        e.store_git_info(&wt_s, git_info("feat/thing"), 1000);

        let found = e.unrecorded_worktrees();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].branch.as_deref(), Some("feat/thing"));
    }

    /// The deleted-task flap: offering a gone directory mints a record,
    /// `vanished_detected_records` forgets it next tick, and it mints again.
    #[test]
    fn a_vanished_worktree_is_never_offered_as_unrecorded() {
        let (tmp, mut e) = engine();
        let live = tmp.path().join("still-here");
        std::fs::create_dir(&live).unwrap();
        let live_s = live.to_string_lossy().to_string();
        let gone = "/repo/main/.claude/worktrees/feat-deleted";
        assert!(e.add_repo("/repo/main"));
        e.store_git_info(
            "/repo/main",
            crate::git_info::GitInfo {
                linked_worktree_dirs: vec![gone.to_string(), live_s.clone()],
                ..Default::default()
            },
            1000,
        );

        let found = e.unrecorded_worktrees();
        assert_eq!(found.iter().map(|w| w.dir.as_str()).collect::<Vec<_>>(), vec![live_s.as_str()]);

        e.set_task_worktrees(vec![record("/repo/main", gone, tt_store::TaskKind::Detected)]);
        assert_eq!(e.vanished_detected_records(), vec![gone.to_string()]);
        e.set_task_worktrees(vec![]);
        assert!(
            !e.unrecorded_worktrees().iter().any(|w| w.dir == gone),
            "forgetting a vanished record must not re-offer it — that is the flap"
        );
    }

    /// A tracked worktree is a `Checkout` row; recording it gives two records.
    #[test]
    fn a_tracked_worktree_is_never_offered_as_unrecorded() {
        let (_tmp, mut e) = engine();
        let wt = "/repo/main/.claude/worktrees/tracked";
        assert!(e.add_repo("/repo/main"));
        assert!(e.add_repo(wt));
        e.store_git_info(
            "/repo/main",
            crate::git_info::GitInfo {
                linked_worktree_dirs: vec![wt.to_string()],
                ..Default::default()
            },
            1000,
        );
        assert!(e.unrecorded_worktrees().is_empty());
        assert_eq!(e.watch_targets(), vec!["/repo/main".to_string(), wt.to_string()]);
    }

    /// The one case where the filesystem retires a record.
    #[test]
    fn vanished_detected_records_are_reported_for_cleanup() {
        let (tmp, mut e) = engine();
        let live = tmp.path().join("live-worktree");
        let live_s = live.to_string_lossy().to_string();
        std::fs::create_dir(&live).unwrap();
        let gone = "/repo/main/.claude/worktrees/agent-gone";
        assert!(e.add_repo("/repo/main"));
        e.set_task_worktrees(vec![
            record("/repo/main", &live_s, tt_store::TaskKind::Detected),
            record("/repo/main", gone, tt_store::TaskKind::Detected),
        ]);

        assert_eq!(e.vanished_detected_records(), vec![gone.to_string()]);
    }

    #[test]
    fn store_git_info_reports_change_only_on_a_real_difference() {
        let (_tmp, mut e) = engine();
        assert!(e.store_git_info("/repo/x", git_info("main"), 1000));
        assert!(!e.store_git_info("/repo/x", git_info("main"), 1100));
        assert!(e.store_git_info("/repo/x", git_info("feat"), 1200));
    }

    #[test]
    fn warm_git_cache_is_true_iff_any_entry_changed() {
        let (_tmp, mut e) = engine();
        e.store_git_info("/repo/x", git_info("main"), 1000);

        let changed = e.warm_git_cache(
            vec![
                ("/repo/x".to_string(), git_info("main")), // unchanged
                ("/repo/y".to_string(), git_info("main")), // new dir → changed
            ],
            1100,
        );
        assert!(changed);
    }

    /// Both poll loops call `stale_git_targets` against the same repo set; without
    /// the claim they hand back the same dir, doubling every `git` chain.
    #[test]
    fn stale_git_targets_does_not_hand_out_a_dir_twice_before_it_is_stored() {
        let (_tmp, mut e) = engine();
        e.add_repo("/repo/x");

        let first = e.stale_git_targets(1000);
        assert_eq!(first.len(), 1, "the only tracked dir is stale on first check");

        let second = e.stale_git_targets(1010);
        assert!(second.is_empty(), "a claimed dir is withheld from a concurrent caller");

        e.store_git_info("/repo/x", git_info("main"), 1010);
        assert!(e.stale_git_targets(1020).is_empty());
    }

    /// A caller that never stores back must not drop its dir from the rotation.
    #[test]
    fn a_claim_no_one_released_self_expires_past_the_guard_window() {
        let (_tmp, mut e) = engine();
        e.add_repo("/repo/x");

        let first = e.stale_git_targets(1000);
        assert_eq!(first.len(), 1);
        assert!(
            e.stale_git_targets(1000 + GIT_PENDING_GUARD_MS - 1).is_empty(),
            "still within the guard window"
        );
        let recovered = e.stale_git_targets(1000 + GIT_PENDING_GUARD_MS);
        assert_eq!(recovered.len(), 1, "the claim expired, so the dir is eligible again");
    }

    /// The fleet's whole fetch bill was one flat cadence over every tracked
    /// repo. A fork nobody has opened must not cost what a live task costs.
    #[test]
    fn fetch_tiers_by_activity_so_an_idle_repo_stops_costing_a_live_one() {
        let (_tmp, mut e) = engine();
        let now = 10_000_000_000;
        let touched =
            |ms: i64| crate::git_info::GitInfo { worktree_touched_ms: ms, ..Default::default() };
        for dir in ["/repo/live", "/repo/warm", "/repo/cold"] {
            e.add_repo(dir);
        }
        e.store_git_info("/repo/live", touched(now - 60_000), now);
        e.store_git_info("/repo/warm", touched(now - 6 * 60 * 60 * 1000), now);
        e.store_git_info("/repo/cold", touched(now - 40 * 24 * 60 * 60 * 1000), now);

        assert_eq!(e.fetch_targets(now).len(), 3, "everything is due on the first pass");

        // Three minutes on: only the active repo has earned another fetch.
        assert_eq!(e.fetch_targets(now + ACTIVE_FETCH_MS), vec!["/repo/live".to_string()]);
        // A quarter hour on: the recently-worked one joins it.
        let due = e.fetch_targets(now + RECENT_FETCH_MS);
        assert!(due.contains(&"/repo/live".to_string()) && due.contains(&"/repo/warm".to_string()));
        assert!(!due.contains(&"/repo/cold".to_string()), "40 days idle is not a 15-minute repo");
        // An hour on, the idle one finally comes round.
        assert!(e.fetch_targets(now + IDLE_FETCH_MS).contains(&"/repo/cold".to_string()));
    }

    /// An untouched checkout with a task open in it is the case the mtime
    /// signal misses — the work is happening in the worktree, not the root.
    #[test]
    fn a_repo_with_a_task_worktree_keeps_the_active_cadence() {
        let (_tmp, mut e) = engine();
        let now = 10_000_000_000;
        e.add_repo("/repo/hosting");
        e.store_git_info("/repo/hosting", crate::git_info::GitInfo::default(), now);
        e.set_task_worktrees(vec![tt_store::RailWorktree {
            task_id: 1,
            kind: tt_store::TaskKind::Task,
            status: "running".into(),
            repo_root: "/repo/hosting".into(),
            dir: "/repo/hosting/.claude/worktrees/feat-x".into(),
            branch: Some("feat-x".into()),
            created_at: now,
        }]);

        assert_eq!(e.fetch_targets(now).len(), 1);
        assert_eq!(e.fetch_targets(now + ACTIVE_FETCH_MS), vec!["/repo/hosting".to_string()]);
    }

    /// The files pane is a live reader of exactly this number, so the repo it
    /// is open on keeps the fast cadence however stale its mtimes look.
    #[test]
    fn the_repo_whose_files_pane_is_open_stays_on_the_active_cadence() {
        let (_tmp, mut e) = engine();
        let now = 10_000_000_000;
        e.add_repo("/repo/reading");
        e.store_git_info("/repo/reading", crate::git_info::GitInfo::default(), now);
        assert_eq!(e.fetch_targets(now).len(), 1);
        assert!(e.fetch_targets(now + ACTIVE_FETCH_MS).is_empty(), "idle without the pane");

        e.set_folder_focus("/repo/reading", true);
        assert_eq!(e.fetch_targets(now + ACTIVE_FETCH_MS), vec!["/repo/reading".to_string()]);
    }

    /// Nobody is reading "behind main" while the window is in the background.
    #[test]
    fn an_unfocused_window_stretches_every_fetch_tier() {
        let (_tmp, mut e) = engine();
        let now = 10_000_000_000;
        e.add_repo("/repo/live");
        e.store_git_info(
            "/repo/live",
            crate::git_info::GitInfo { worktree_touched_ms: now, ..Default::default() },
            now,
        );
        assert_eq!(e.fetch_targets(now).len(), 1);

        e.set_window_focused(false);
        assert!(e.fetch_targets(now + ACTIVE_FETCH_MS).is_empty(), "backgrounded, so not yet");
        assert_eq!(e.fetch_targets(now + ACTIVE_FETCH_MS * UNFOCUSED_FETCH_MULT).len(), 1);
    }

    /// Coming back to the window must not serve rows up to five minutes old.
    #[test]
    fn refocusing_invalidates_rather_than_serving_a_background_ttl() {
        let (_tmp, mut e) = engine();
        let now = 10_000_000_000;
        e.store_git_info("/repo/a", git_info("main"), now);
        assert!(e.set_window_focused(false));
        assert!(e.git_cache.is_fresh("/repo/a", now + 90_000), "background widens the ceiling");

        assert!(e.set_window_focused(true));
        assert!(!e.git_cache.is_fresh("/repo/a", now + 90_000), "refocus invalidates");
        assert!(!e.set_window_focused(true), "no move, no second invalidation");
    }

    /// Switching folders mounts the new pane before the old one's cleanup; that
    /// late release must not take the new pane's ceiling.
    #[test]
    fn releasing_folder_focus_late_does_not_steal_the_new_panes_ceiling() {
        let (_tmp, mut e) = engine();
        let now = 10_000_000;
        e.store_git_info("/repo/a", git_info("main"), now);
        e.store_git_info("/repo/b", git_info("main"), now);

        assert!(e.set_folder_focus("/repo/a", true));
        assert!(e.set_folder_focus("/repo/b", true), "the replacement claims it");
        assert!(!e.set_folder_focus("/repo/a", false), "the departing pane's late cleanup");
        assert_eq!(e.git_cache.focused_dir(), Some("/repo/b"));

        assert!(e.set_folder_focus("/repo/b", false));
        assert_eq!(e.git_cache.focused_dir(), None);
    }

    /// Opening a pane is somebody reading the row: the counts must be fresh.
    #[test]
    fn claiming_folder_focus_invalidates_so_the_next_tick_recomputes() {
        let (_tmp, mut e) = engine();
        let now = 10_000_000;
        e.store_git_info("/repo/x", git_info("main"), now);
        assert!(e.git_cache.is_fresh("/repo/x", now));

        e.set_folder_focus("/repo/x", true);
        assert!(!e.git_cache.is_fresh("/repo/x", now));
    }

    #[test]
    fn set_folder_base_branch_change_detects_and_invalidates_git_cache() {
        let (_tmp, mut e) = engine();
        // A `now` past the TTL: `invalidate` stamps ts=0, stale only from there.
        let now = 10_000_000;
        e.store_git_info("/repo/x", git_info("main"), now);
        assert!(e.git_cache.is_fresh("/repo/x", now));

        // A new base branch marks the old baseline's stats stale.
        assert!(e.set_folder_base_branch("/repo/x", Some("develop")));
        assert!(!e.git_cache.is_fresh("/repo/x", now));

        assert!(!e.set_folder_base_branch("/repo/x", Some("develop")));
        assert!(e.set_folder_base_branch("/repo/x", None));
    }

    #[test]
    fn set_collapsed_and_set_folder_quiet_report_only_real_changes() {
        let (_tmp, mut e) = engine();
        assert!(e.set_collapsed("row-1", true));
        assert!(!e.set_collapsed("row-1", true));
        assert!(e.set_collapsed("row-1", false));

        let one = [String::from("/repo/x")];
        assert!(e.set_folder_quiet(&one, true));
        assert!(!e.set_folder_quiet(&one, true));
        assert!(e.set_folder_quiet(&one, false));
    }

    /// Marking a repo means the root checkout *and* its worktrees: changed if any
    /// member is, so a half-marked repo still reports and persists the rest.
    #[test]
    fn set_folder_quiet_marks_every_dir_it_is_given() {
        let (_tmp, mut e) = engine();
        let root = String::from("/repo");
        let worktree = String::from("/repo/.claude/worktrees/task");

        assert!(e.set_folder_quiet(std::slice::from_ref(&root), true));
        assert!(e.set_folder_quiet(&[root.clone(), worktree.clone()], true));
        assert!(e.folder_meta.quiet_for(&root));
        assert!(e.folder_meta.quiet_for(&worktree));

        assert!(e.set_folder_quiet(&[root.clone(), worktree.clone()], false));
        assert!(!e.folder_meta.quiet_for(&root));
        assert!(!e.folder_meta.quiet_for(&worktree));
    }
}
