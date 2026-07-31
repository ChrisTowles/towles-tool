//! The agentboard engine: tracker + git cache + watchers behind one
//! struct, host-agnostic, so every host shares it.
//!
//! The engine is synchronous; hosts own scheduling (tokio tasks, debounces)
//! and transport (Tauri events, MCP responses). Hosts guard it with a `Mutex`,
//! so everything expensive that does NOT need engine state is deliberately
//! outside `impl Engine`: [`collect_agent_snapshot`] (claude CLI + `/proc` +
//! transcript reads) and [`crate::git_info::compute_git_info`] (git
//! subprocesses) run unlocked, and their results are handed to cheap locked
//! methods ([`Engine::compute_payload_with`], [`Engine::store_git_info`]).

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

/// One row of the rail, before sessions and git stats are hung off it: a
/// directory, the checkout it belongs to, and the record that put it there.
///
/// See [`Engine::rail_rows`] for the rule this type exists to enforce — the
/// `dir` is where the checkout *should* be, not a claim that anything is there.
#[derive(Debug, Clone, PartialEq)]
pub struct RailRow {
    pub dir: String,
    pub repo_root: String,
    pub record: RowRecord,
}

/// A linked worktree git reported that no task row claims — see
/// [`Engine::unrecorded_worktrees`].
#[derive(Debug, Clone, PartialEq)]
pub struct UnrecordedWorktree {
    pub repo_root: String,
    pub dir: String,
    pub branch: Option<String>,
}

// Prune schedule constants.
const STUCK_MS: i64 = 3 * 60 * 1000;
const STALE_MS: i64 = 12 * 60 * 60 * 1000;
const IDLE_MS: i64 = 30 * 1000;

/// How long a [`Engine::git_pending`] claim blocks a second
/// `stale_git_targets` caller before it self-expires. Comfortably longer than
/// any real `compute_git_info`, so it only exists so a caller that never
/// stores its result (panic, dropped `spawn_blocking`) can't strand a dir out
/// of rotation forever.
const GIT_PENDING_GUARD_MS: i64 = 30_000;

/// Best-effort persistence: a store write that fails is not worth aborting the
/// caller over, but it is worth a record — a rename that silently didn't reach
/// disk otherwise leaves the user nothing to look at. `what` names the store.
fn persisted<E: std::fmt::Display>(result: std::result::Result<(), E>, what: &str) {
    if let Err(e) = result {
        log::warn!("failed to persist {what}: {e}");
    }
}

/// Wall-clock epoch milliseconds (the hosts' `now`).
pub use tt_config::now_ms;

/// Collects watcher emits during a scan, resolving project dirs (and, in
/// tmux mode, agent pids) to session names through injected resolvers.
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

/// Owns all agentboard engine state. Hosts guard it with a `Mutex`.
pub struct Engine {
    projects_dir: PathBuf,
    repos_path: PathBuf,
    repo_paths: Vec<String>,
    /// [`crate::persist::FileVersion`] of `repos.json` at the last successful
    /// parse — four `reload_repos` call sites fire per scan tick, so without
    /// this the file was read and parsed 4×/2s to answer a question that only
    /// changes when the user edits the repo list.
    repos_stat: Option<crate::persist::FileVersion>,
    tracker: AgentTracker,
    folder_meta: crate::folder_meta::FolderMetaStore,
    repo_meta: crate::repo_meta::RepoMetaStore,
    windows: crate::windows::WindowsStore,
    collapse: crate::collapse::CollapseStore,
    sessions: SessionStore,
    git_cache: GitInfoCache,
    /// Dirs handed out by [`Self::stale_git_targets`], stamped with when — an
    /// in-flight claim, not a cache field. The 2s scan loop and the 10s
    /// git-stat poll both call `stale_git_targets` against the same TTL;
    /// without the claim both can see the same dir stale in the same window
    /// and race duplicate recomputes (measured live). Released by
    /// [`Self::store_git_info`], and self-expiring
    /// ([`GIT_PENDING_GUARD_MS`]) so a panicking caller can't strand a dir.
    git_pending: HashMap<String, i64>,
    watchers: Vec<Box<dyn AgentWatcher + Send>>,
    compact_recommend_percent: u8,
    /// Show rows for worktrees no task claimed
    /// (`agentboard.showUnmanagedWorktrees`, off by default — a worktree the
    /// user never asked for shouldn't populate the rail unprompted). A
    /// display filter over [`RowRecord::Detected`] rows; the host also gates
    /// the detected-record reconciler on it.
    show_unmanaged_worktrees: bool,
    /// The rail's worktree rows, refreshed from the store by the host each scan
    /// tick (`Store::rail_worktrees` → [`Self::set_task_worktrees`]). The engine
    /// is store-free, so these are pushed in rather than queried.
    ///
    /// **These are records, not directories.** An entry here puts a row on the
    /// rail whether or not anything exists at its `dir` — that is the whole
    /// point, and the reason nothing in this file filters rows on `is_dir`.
    task_worktrees: Vec<tt_store::RailWorktree>,
    seeded_once: bool,
    /// Sticky agent→PTY attribution: thread id (CLI sessionId) → the
    /// `TT_SESSION_ID` read from that agent's process env. Refreshed from live
    /// processes each compute and kept while the tracker still holds the
    /// thread, so an agent that exits stays on the pane it ran in instead of
    /// drifting to its folder's default session.
    thread_sessions: HashMap<String, String>,
    /// Which app instances' agents this host reports (see
    /// [`crate::procenv::InstanceScope`]).
    scope: InstanceScope,
}

/// Everything [`Engine::compute_payload_with`] needs that is derived from the
/// system rather than engine state: the claude CLI's live-agent snapshot, the
/// `TT_SESSION_ID` read from each agent's process env, and the app-spawned
/// agents found by scanning `/proc`. Collect it with [`collect_agent_snapshot`]
/// — outside the engine lock, since it spawns a process and reads transcripts.
pub struct AgentSnapshot {
    live_threads: HashSet<String>,
    tt_session_by_thread: HashMap<String, String>,
    session_agents: HashMap<String, AgentEvent>,
}

/// Gather the live-agent inputs for a payload rebuild. Runs the (cached)
/// `claude agents` fetch and the `/proc` scans; call it WITHOUT holding the
/// engine lock so a slow claude CLI can't stall `ab_*` commands. `scope` must
/// match the engine's (see [`Engine::new`]) so snapshot attribution and the
/// watcher's admission agree on which agents are ours.
pub fn collect_agent_snapshot(now: i64, scope: &InstanceScope) -> AgentSnapshot {
    // CLI-derived liveness drives the pruning pins; the claude watcher emits
    // CLI-authoritative statuses directly.
    let cli_agents = crate::claude_cli::fetch_agents_cached(std::time::Duration::from_millis(
        crate::watchers::claude_code::CLI_CACHE_TTL_MS,
    ));
    let live_threads: HashSet<String> = cli_agents.iter().map(|a| a.session_id.clone()).collect();
    // Link each live agent to its PTY session: TT_SESSION_ID from /proc,
    // keyed by thread id. No injected id → unmapped, falls back to the
    // folder's default session; out of `scope` → dropped entirely.
    let tt_session_by_thread: HashMap<String, String> = cli_agents
        .iter()
        .filter_map(|a| {
            crate::procenv::session_id_in_scope(a.pid, scope).map(|sid| (a.session_id.clone(), sid))
        })
        .collect();
    // Supplement CLI detection: app-spawned sessions the CLI snapshot never
    // enumerated, found by scanning /proc for our TT_SESSION_ID. Consumed
    // only where `pick_state` came back empty — enriching an already-
    // accounted session cost two 128 KiB reads + JSON parses per agent per
    // rebuild for a value thrown away on the next line.
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
    /// Build from the real config locations (`~/.claude`, `~/.config/towles-tool`).
    /// `scope` picks which app instances' agents this host reports: the app
    /// passes [`InstanceScope::this_app`] (its own PTYs only — sessions.json is
    /// shared, so another instance's PTY can carry the same session id); the
    /// MCP server passes [`InstanceScope::Any`].
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
            // Left unset so the first `reload_repos` always reads: the
            // `load_repos` above swallows a corrupt file as empty, and this
            // field may only be stamped from a *good* parse.
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

    /// Re-read `repos.json` so changes made by the `tt agentboard` CLI (which
    /// writes the same file) are picked up without restarting the host. A
    /// torn/corrupt read (the file exists but won't parse — most likely racing
    /// another instance's write) keeps the last known-good list rather
    /// than degrading to empty, which would prune every folder's sessions.
    fn reload_repos(&mut self) {
        // Skip the read+parse entirely when the file is byte-for-byte the one
        // we last parsed (see `repos_stat`). A missing file has no version and
        // falls through to `try_load_repos`, which treats absent as an empty
        // list — cheap, and keeps "the file was deleted" working.
        let stat = crate::persist::file_version(&self.repos_path);
        if stat.is_some() && stat == self.repos_stat {
            return;
        }
        if let Some(paths) = crate::repos::try_load_repos(&self.repos_path) {
            self.repo_paths = paths;
            // Only stamp on a good parse: a torn read keeps the last known-good
            // list, and must stay re-readable next tick rather than caching the
            // corrupt file's stat.
            self.repos_stat = stat;
        }
    }

    /// One scan of every watcher with the repos.json-derived resolver
    /// (desktop mode).
    pub fn scan_once(&mut self, now: i64) {
        self.reload_repos();
        let all_paths = self.rail_dirs();
        let entries = repo_entries(&all_paths);
        self.scan_once_with_resolver(&|dir| resolve_session_name(dir, &entries), now);
    }

    /// Every row the rail should show, in rail order. **Rows come from
    /// records, never from detection**: each `repos.json` path is a
    /// [`RowRecord::Checkout`] followed by its task rows — whether or not the
    /// directories exist — so a task has its row from the moment it is
    /// written down and keeps it through a removal. Discovered-but-unrecorded
    /// worktrees are absent here; the host mints `detected` records and they
    /// arrive back as ordinary rows. Order is `repos.json` order, then
    /// `created_at` per checkout — never name-sort; callers must not re-sort.
    /// Cache-only: runs under the engine lock every `ab_*` command shares.
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
            // Already `created_at`-ordered by `Store::rail_worktrees`; the scan
            // is linear per checkout because the list is a handful of rows and
            // an index would have to be rebuilt on every push anyway.
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

    /// The rail's rows as bare dirs, for the callers that only poll paths
    /// (git-staleness, fs watches). Same order and same rule as
    /// [`Self::rail_rows`].
    fn rail_dirs(&mut self) -> Vec<String> {
        self.rail_rows().into_iter().map(|r| r.dir).collect()
    }

    /// Linked worktrees git knows about that no task row claims — the host
    /// mints a `detected` record for each, after which they reach the rail as
    /// ordinary rows. Steady state returns empty, so reconciliation writes
    /// nothing. Cache-only, safe under the lock.
    ///
    /// **A directory that isn't there is never offered** — load-bearing, not
    /// defensive: git keeps reporting a removed worktree until its
    /// registration is pruned, and the memoized cache keeps it longer, so
    /// offering it would mint a record [`Self::vanished_detected_records`]
    /// forgets next tick — a row flapping in and out until the cache
    /// refreshes. Both reconcilers must agree on the same predicate.
    pub fn unrecorded_worktrees(&mut self) -> Vec<UnrecordedWorktree> {
        self.reload_repos();
        let recorded: HashSet<&str> = self.task_worktrees.iter().map(|w| w.dir.as_str()).collect();
        let mut out = Vec::new();
        for root in &self.repo_paths {
            let info = self.git_cache.get(root);
            for dir in info.linked_worktree_dirs {
                // A worktree the user tracks explicitly is a `Checkout` row and
                // needs no task; recording one would give the same directory two
                // records.
                if self.repo_paths.contains(&dir) || recorded.contains(dir.as_str()) {
                    continue;
                }
                // See this method's doc: a registration git still reports for a
                // directory that is gone would mint a record the next tick
                // forgets, and the rail would flap.
                if !Path::new(&dir).is_dir() {
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

    /// `detected` rows whose directory is gone — the host forgets them
    /// (`Store::forget_detected_worktree`).
    ///
    /// Only ever `detected`: a **task** whose directory vanished is precisely
    /// the row that must survive (rendered detached) until the user says what
    /// happened to it. This is the one place the engine looks at the
    /// filesystem to decide a record's fate, and it is bounded to records that
    /// only ever existed because a directory did.
    pub fn vanished_detected_records(&self) -> Vec<String> {
        self.task_worktrees
            .iter()
            .filter(|w| w.kind == tt_store::TaskKind::Detected)
            .filter(|w| !Path::new(&w.dir).is_dir())
            .map(|w| w.dir.clone())
            .collect()
    }

    /// Tracked repos plus their discovered worktrees, as absolute checkout
    /// dirs — [`Self::rail_rows`]'s output under a name a host
    /// outside the engine can call. Meant for scoping the eager-rescan fs
    /// watch ([`crate::fs_notify::ScopedDirNotifier`]) to the repos actually
    /// being polled instead of every Claude Code session on the machine;
    /// reads only the already-cached worktree lists (see
    /// `rail_rows`'s doc for why that matters under the lock).
    pub fn watch_targets(&mut self) -> Vec<String> {
        self.reload_repos();
        self.rail_dirs()
    }

    /// `.git` internal files worth watching, mapped to the checkout dir each
    /// belongs to, so a commit/fetch/switch/`git add` invalidates that dir
    /// immediately instead of waiting out the TTL — see
    /// [`crate::git_info::control_files_for`] for which files and why.
    /// Cache-only, safe under the lock, cheap enough for every poll tick.
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

    /// Mark `dir`'s cache entry stale immediately — the event-driven
    /// counterpart to the TTL, called from the host's control-file watcher
    /// when one of [`Self::control_watch_files`]'s targets fires. The next
    /// `stale_git_targets` call (right away, since the watcher also signals
    /// an eager scan) picks it up regardless of how recently it was computed.
    pub fn invalidate_git(&mut self, dir: &str) {
        self.git_cache.invalidate(Some(dir));
    }

    /// Rail dirs whose git-cache entry is missing or past the TTL, each with
    /// its base-branch override and previously cached value — computed by the
    /// host *outside* the engine lock, handed back via
    /// [`Self::warm_git_cache`]. Claims each returned dir in
    /// [`Self::git_pending`] so the other poll loop can't hand it out again
    /// before the claim releases — see that field's doc.
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

    /// Pair each dir with the two things a recompute needs alongside it: that
    /// folder's base-branch override, and its previously cached value (so an
    /// unmoved repo revalidates cheaply instead of re-running the landing
    /// probe). Shared by [`Self::git_targets`] and [`Self::stale_git_targets`],
    /// which differ only in which dirs they feed it.
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

    /// Store freshly computed git info for dirs the host warmed outside the
    /// lock (see [`Self::stale_git_targets`]). Returns whether any entry's
    /// value actually changed, so the host can skip a no-op re-emit.
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

    /// One scan of every watcher: collect emits through the resolvers and feed
    /// them to the tracker (first scan's emits are seeded → marked unseen).
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

    /// The tracked checkout that owns `dir` as a discovered `git worktree`,
    /// if any — the repo whose cached `linked_worktree_dirs` (from its last
    /// `compute_git_info`) lists `dir`. A rail row for such a `dir` is never
    /// itself a `repos.json` entry (see [`Self::rail_rows`]'s doc), so
    /// untracking it means pruning the worktree registration at the returned
    /// owner dir (`crate::git_info::prune_stale_worktree`), not touching
    /// `repos.json`. Cache-only, safe under the lock — never shells to git.
    pub fn find_worktree_owner(&mut self, dir: &str) -> Option<String> {
        self.reload_repos();
        repo_entries(&self.repo_paths)
            .into_iter()
            .find(|e| self.git_cache.get(&e.dir).linked_worktree_dirs.iter().any(|w| w == dir))
            .map(|e| e.dir)
    }

    /// All watched repos' dirs with their base-branch overrides and cached
    /// values, for an unlocked recompute handed back via
    /// [`Engine::store_git_info`] — same shape as [`Self::stale_git_targets`]
    /// without the staleness filter.
    pub fn git_targets(&mut self) -> Vec<(String, Option<String>, crate::git_info::GitInfo)> {
        self.reload_repos();
        let dirs = repo_entries(&self.repo_paths).into_iter().map(|e| e.dir).collect();
        self.targets_for(dirs)
    }

    /// Store one repo's freshly computed git info. Returns whether it differs
    /// from the cached value, so the host can skip re-emitting an unchanged
    /// snapshot.
    ///
    /// A compute that couldn't read the repository at all keeps the folder's
    /// structural identity rather than blanking it — see
    /// [`crate::git_info::preserve_identity_on_failed_read`] for why that
    /// matters to the rail's row grouping.
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

    /// Every tracked repo's dir with its cached origin URL (`None` until
    /// computed / no remote). Cache-only, safe under the lock. Feeds
    /// `tt_store::Store::reconcile_repos`, keeping `repos.json` the sole
    /// source of truth for which repos are tracked.
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

    /// Full recompute from repos.json (desktop mode). Base order is by name
    /// (createdAt is meaningless for configured repos).
    ///
    /// Collects the agent snapshot itself. Hot loops call
    /// [`collect_agent_snapshot`] unlocked and pass it to
    /// [`Engine::compute_payload_with`]; this is for one-off internal reads.
    fn compute_payload(&mut self, now: i64) -> StatePayload {
        let snapshot = collect_agent_snapshot(now, &self.scope);
        self.compute_payload_with(&snapshot, now)
    }

    /// Full recompute from repos.json using a pre-collected agent snapshot.
    pub fn compute_payload_with(&mut self, snapshot: &AgentSnapshot, now: i64) -> StatePayload {
        self.reload_repos();
        let rows = self.rail_rows();
        // NOT name-sorted: `rail_rows` already returns repos in `repoPaths`
        // order (each followed by its task rows, oldest first), and that order
        // is the user's — what a drag in Settings → Agentboard → Repos
        // persists. Sorting by name here silently discarded that choice.
        let all_paths: Vec<String> = rows.iter().map(|r| r.dir.clone()).collect();
        let entries = repo_entries(&all_paths);
        let rows_by_dir: HashMap<String, RailRow> =
            rows.into_iter().map(|r| (r.dir.clone(), r)).collect();
        // New folders get a default `shell 1` seeded once; a folder whose
        // sessions were all closed stays empty (rendered as "no sessions").
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
        // Drop session records for repos no longer configured.
        // Skipped when the resolved entry set is empty: every configured repo
        // vanishing in one poll is far more likely a transient glitch (torn
        // repos.json read, worktree-list hiccup) than a real config wipe, and
        // pruning on it deletes every folder's session records. Stale
        // records left by a genuine remove-all are pruned on the next
        // non-empty poll.
        if !entries.is_empty() {
            // Keyed on *records*, not rendered rows: a detected worktree hidden
            // by the show-unmanaged toggle is absent from `entries` but still a
            // real record, and pruning by display state would silently delete
            // its session history from the shared sessions.json every poll.
            let mut dirs: HashSet<String> = entries.iter().map(|e| e.dir.clone()).collect();
            dirs.extend(self.task_worktrees.iter().map(|w| w.dir.clone()));
            if self.sessions.prune(&dirs) {
                persisted(self.sessions.save(), "sessions");
            }
            if self.folder_meta.prune(&dirs) {
                persisted(self.folder_meta.save(), "folder meta");
            }
            // Repo identity is deliberately NOT pruned here: a hand-picked
            // icon/color is user-authored with no undo, and this `dirs` set
            // churns spuriously. Reaped on explicit removal only.
            let gone = self.windows.prune(&dirs);
            if !gone.is_empty() {
                persisted(self.windows.save(&gone), "windows");
            }
        }
        payload
    }

    /// Replace a repo's icon/color identity; an all-empty `meta` resets it to
    /// the default. Persists on change.
    pub fn set_repo_meta(&mut self, dir: &str, meta: crate::repo_meta::RepoMeta) -> bool {
        let changed = self.repo_meta.set_meta(dir, meta);
        if changed {
            persisted(self.repo_meta.save(), "repo identity");
        }
        changed
    }

    /// Set (or clear) a folder's base-branch override. Persists on change.
    pub fn set_folder_base_branch(&mut self, dir: &str, base_branch: Option<&str>) -> bool {
        let changed = self.folder_meta.set_base_branch(dir, base_branch);
        if changed {
            persisted(self.folder_meta.save(), "folder metadata");
            // The cached stats were computed against the old baseline —
            // invalidate so the next watcher-scan tick (2s, not the 10s stat
            // poll) recomputes them against the new override right away.
            self.git_cache.invalidate(Some(dir));
        }
        changed
    }

    /// Set (or clear) a folder's quiet override. Persists on change.
    pub fn set_folder_quiet(&mut self, dir: &str, quiet: bool) -> bool {
        let changed = self.folder_meta.set_quiet(dir, quiet);
        if changed {
            persisted(self.folder_meta.save(), "folder metadata");
        }
        changed
    }

    /// Record that a pane was opened or closed on `dir` — the half of "I worked
    /// here recently" that leaves no git trace. Persists on change.
    fn touch_folder(&mut self, dir: &str, now_ms: i64) {
        if self.folder_meta.touch(dir, now_ms) {
            persisted(self.folder_meta.save(), "folder metadata");
        }
    }

    /// Replace the persisted window layout (frontend-owned blob). Persists on
    /// change; returns whether it changed.
    /// `touched` is the set of folder dirs whose windows/active-window the
    /// frontend actually mutated since its last save (see
    /// [`crate::windows::WindowsStore::save`]) — required so a whole-blob save
    /// from one Agentboard window can't clobber another window's folders.
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

    /// Set (or clear) one folder-rail row's collapsed state. Persists on change.
    pub fn set_collapsed(&mut self, key: &str, collapsed: bool) -> bool {
        let changed = self.collapse.set(key, collapsed);
        if changed {
            persisted(self.collapse.save(), "rail collapse state");
        }
        changed
    }

    /// Set the compact-nudge threshold and persist it to the shared settings
    /// file (`agentboard.compactRecommendPercent`). Clamped to 1..=100.
    /// Persists via `save_merge` so keys the TypeScript CLI owns survive.
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

    /// Show (or hide again) auto-discovered non-task worktrees, persisting to
    /// the shared settings file (`agentboard.showUnmanagedWorktrees`) via
    /// `save_merge` so keys the TypeScript CLI owns survive. Returns whether
    /// anything changed; the caller re-emits so the rail repopulates on the
    /// next poll (no git recompute — see [`Self::rail_rows`]).
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

    /// Whether unmanaged (detected) worktree rows are shown. The host's
    /// detected-record reconciler is gated on this too: minting records the
    /// rail filters out anyway would write rows nobody can see to a database
    /// three other processes share, on every scan tick.
    pub fn show_unmanaged_worktrees(&self) -> bool {
        self.show_unmanaged_worktrees
    }

    /// Replace the rail's worktree rows — the host reads them from the store
    /// each scan tick (`Store::rail_worktrees` → [`Self::task_worktrees`]).
    /// Returns whether anything changed, so the host can re-emit the moment a
    /// task is created or closed rather than at the next poll boundary.
    ///
    /// This is the seam that makes the rail record-driven: a task submitted a
    /// millisecond ago arrives here with a `dir` that does not exist yet, and
    /// gets its row anyway.
    pub fn set_task_worktrees(&mut self, worktrees: Vec<tt_store::RailWorktree>) -> bool {
        if worktrees == self.task_worktrees {
            return false;
        }
        self.task_worktrees = worktrees;
        true
    }

    /// Full recompute for the given entries: pid-liveness pin → prune
    /// schedule → assemble snapshot.
    fn compute_payload_for_entries(
        &mut self,
        entries: &[RepoEntry],
        rows: &HashMap<String, RailRow>,
        snapshot: &AgentSnapshot,
        now: i64,
    ) -> StatePayload {
        // Link each live agent to its PTY session (TT_SESSION_ID via /proc,
        // keyed by thread id). Sticky: an exited agent stays on the pane it
        // ran in rather than drifting to the default session; unmapped ones
        // fall back in `assemble_state`. Also persisted, so a crash doesn't
        // take the pane→agent pairing with it (see [`crate::resume`]).
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
        // Drop cached attributions for threads that are neither alive nor
        // still shown by the tracker — the cache stays bounded by the set of
        // agents actually on the board.
        self.thread_sessions
            .retain(|tid, _| snapshot.live_threads.contains(tid) || tracked_threads.contains(tid));

        // Prune schedule — every broadcast.
        self.tracker.prune_stuck(STUCK_MS, now);
        self.tracker.prune_terminal(now);
        self.tracker.prune_stale(STALE_MS, now);
        self.tracker.prune_idle(IDLE_MS, now);

        let mut git_infos = HashMap::new();
        for entry in entries {
            git_infos.insert(entry.dir.clone(), self.git_cache.get(&entry.dir));
        }

        // Attribute each agent event to the PTY session it ran in, joining the
        // event's thread id (== the CLI sessionId) to the `TT_SESSION_ID` read
        // from that agent's process (sticky across process exit, see above).
        // No mapping → folder's default session; a mapping onto a session that
        // isn't one of the folder's records → dropped (see `assemble_state`).
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

        // Repo identity is a pure lookup on the row's anchor dir, so it
        // decorates the assembled payload rather than adding another store to
        // that already-wide signature.
        for repo in &mut payload.repos {
            repo.meta = self.repo_meta.meta_for(&repo.dir).cloned();
        }

        payload.windows = self.windows.payload().clone();
        payload.collapsed = self.collapse.payload().collapsed.clone();
        payload
    }

    /// Mark a folder's agents seen. Returns a fresh payload only if something
    /// changed. `unseen` now lives on individual sessions (derived from their
    /// agent state), so we recompute rather than patch the cached snapshot.
    pub fn mark_seen_patch(&mut self, name: &str) -> Option<StatePayload> {
        if !self.tracker.mark_seen(name) {
            return None;
        }
        Some(self.compute_payload(now_ms()))
    }

    /// Absolute dirs currently on the rail (freshly reloaded), so the add-repo
    /// picker can exclude repos that are already added.
    pub fn repo_dirs(&mut self) -> Vec<String> {
        self.reload_repos();
        self.repo_paths.clone()
    }

    /// Configured scan roots for the add-repo picker (`scanRoots` in repos.json).
    /// Empty when unset — the caller substitutes its own default (`~/code`).
    pub fn scan_roots(&self) -> Vec<String> {
        load_scan_roots(&self.repos_path)
    }

    /// Persist the add-repo picker's scan roots, preserving the repo list.
    pub fn set_scan_roots(&mut self, roots: Vec<String>) {
        persisted(save_scan_roots(&self.repos_path, &roots), "scan roots");
    }

    /// Adds straight against `repos.json` (reread-fresh-then-write; see
    /// [`add_repo_persisted`]) rather than trusting `self.repo_paths`, which
    /// may be stale — another Agentboard window may have added/removed a
    /// different repo since our last reload.
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
                // Explicit removal is the one place identity is reaped — see
                // `RepoMetaStore::forget`.
                if removed && self.repo_meta.forget(dir) {
                    persisted(self.repo_meta.save(), "repo identity");
                }
                removed
            }
            Err(_) => false,
        }
    }

    /// Set the rail's repo order (the user's drag). Persists on change; see
    /// [`reorder_repos`] for why a stale `desired` can't drop a repo.
    pub fn set_repo_order(&mut self, desired: &[String]) -> std::io::Result<()> {
        let merged = crate::repos::reorder_repos_persisted(&self.repos_path, desired)?;
        self.repo_paths = merged;
        Ok(())
    }

    /// Untrack every repo whose directory is gone from disk (the rail's
    /// "missing" ghosts). Returns the dropped dirs; empty on IO failure.
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

    /// The folder's first session, seeding the default one if it has none —
    /// for a caller that wants "the session to type into" without risking a
    /// second row (a surprise split pane) when a default already exists.
    pub fn ensure_session(&mut self, dir: &str, now: i64) -> Option<SessionRecord> {
        if self.sessions.ensure_default(dir, now) {
            persisted(self.sessions.save(), "sessions");
            self.touch_folder(dir, now);
        }
        self.sessions.sessions_for(dir).first().cloned()
    }

    /// Rename a PTY session by id. Returns whether it changed.
    pub fn rename_session(&mut self, id: &str, name: &str) -> bool {
        let changed = self.sessions.rename(id, name);
        if changed {
            persisted(self.sessions.save(), "sessions");
        }
        changed
    }

    /// Set (or clear) a session's user-authored purpose. Persists on change.
    pub fn set_session_purpose(&mut self, id: &str, purpose: Option<&str>) -> bool {
        let changed = self.sessions.set_purpose(id, purpose);
        if changed {
            persisted(self.sessions.save(), "sessions");
        }
        changed
    }

    /// Remove a PTY session by id. Returns whether it was removed. (A folder left
    /// empty is re-seeded with a default shell on the next `compute_payload`.)
    pub fn close_session(&mut self, id: &str, now: i64) -> bool {
        // Resolved before the removal, since afterwards the record is gone.
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

    /// The folder dir a session record belongs to, or `None` when nothing knows
    /// that id.
    fn folder_dir_of_session(&self, id: &str) -> Option<String> {
        self.sessions
            .iter()
            .find(|(_, records)| records.iter().any(|r| r.id == id))
            .map(|(dir, _)| dir.to_string())
    }

    /// Session ids scoped to `dir`, without removing anything — a task
    /// removal must kill live PTYs *before* attempting the (fallible)
    /// worktree removal, but must not drop the records until removal has
    /// actually succeeded (see [`Self::close_folder`]).
    pub fn session_ids_for(&self, dir: &str) -> Vec<String> {
        self.sessions.sessions_for(dir).iter().map(|r| r.id.clone()).collect()
    }

    /// Every persisted session record with its folder dir, cloned.
    ///
    /// Exists so a caller can take this snapshot under the engine lock and then
    /// do slow work (the resume picker's transcript scan) with the lock
    /// released — holding it across disk I/O would block every `ab_*` command
    /// and the state poll behind it.
    pub fn session_records(&self) -> Vec<(String, SessionRecord)> {
        self.sessions
            .iter()
            .flat_map(|(dir, list)| list.iter().map(move |rec| (dir.to_string(), rec.clone())))
            .collect()
    }

    /// Tear a folder's live rail state down immediately, ahead of its
    /// checkout disappearing (a task removal): drop every session record and
    /// every window/pane scoped to it, persisting both right away instead of
    /// waiting for the next poll's repo-keyed prune in
    /// [`Self::compute_payload_with`]. Returns the removed session ids so the
    /// caller can kill their live PTYs (a session id doubles as its `term_id`)
    /// — killing them first is what actually ends any Claude Code process
    /// running inside, since closing the PTY's controlling terminal signals
    /// its foreground job.
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

    /// Drop a checkout's cached git info and any in-flight compute claim —
    /// called from the removal sequence once the worktree is off disk. Only
    /// the cache: the row is the task record's business and outlives the
    /// directory by design. A stale claim would hold the path out of the poll
    /// rotation, and a new task at the same path must not inherit dead stats.
    pub fn drop_git_cache(&mut self, dir: &str) -> bool {
        self.git_pending.remove(dir);
        self.git_cache.forget(dir)
    }
}

#[cfg(test)]
impl Engine {
    /// A fully isolated engine for tests: every persisted store is in-memory
    /// (`None` path, so its `save()` is a no-op) **except** `repos.json`, which
    /// points at `repos_path` (a tempdir file) so repo add/remove/reorder
    /// persistence can be asserted without ever touching the real config dir.
    /// No watchers, so a scan is inert. `InstanceScope::Any` so nothing depends
    /// on this process's instance id.
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

    // session lifecycle

    #[test]
    fn add_session_then_close_session_round_trips_by_folder() {
        let (_tmp, mut e) = engine();
        let a = e.add_session("/repo/x", Some("one"), 1000);
        let b = e.add_session("/repo/x", Some("two"), 1001);
        // Both land under the same folder; a different folder stays empty.
        let ids = e.session_ids_for("/repo/x");
        assert!(ids.contains(&a.id) && ids.contains(&b.id));
        assert!(e.session_ids_for("/repo/other").is_empty());

        // Closing one leaves the other; closing an unknown id is a no-op.
        assert!(e.close_session(&a.id, 1002));
        assert!(!e.close_session("nope", 1003));
        assert_eq!(e.session_ids_for("/repo/x"), vec![b.id]);

        // Opening and closing a pane both count as working in the folder.
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

        // A folder with no sessions closes to an empty list, not an error.
        assert!(e.close_folder("/repo/never").is_empty());
    }

    #[test]
    fn rename_and_purpose_report_whether_they_changed() {
        let (_tmp, mut e) = engine();
        let rec = e.add_session("/repo/x", Some("orig"), 1000);
        assert!(e.rename_session(&rec.id, "renamed"));
        // Renaming to the same name is not a change.
        assert!(!e.rename_session(&rec.id, "renamed"));
        assert!(!e.rename_session("unknown-id", "x"));

        assert!(e.set_session_purpose(&rec.id, Some("ship it")));
        assert!(!e.set_session_purpose(&rec.id, Some("ship it")));
        assert!(e.set_session_purpose(&rec.id, None));
    }

    // repo tracking (persisted to the temp repos.json)

    #[test]
    fn add_repo_is_idempotent_and_remove_reports_removal() {
        let (_tmp, mut e) = engine();
        assert!(e.add_repo("/repo/a"));
        // Re-adding the same repo is not a new add.
        assert!(!e.add_repo("/repo/a"));
        assert!(e.add_repo("/repo/b"));
        assert!(e.repo_dirs().contains(&"/repo/a".to_string()));
        assert!(e.repo_dirs().contains(&"/repo/b".to_string()));

        assert!(e.remove_repo("/repo/a"));
        // Removing something not tracked reports no removal.
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
        // A fresh engine over the same repos.json sees the tracked repo — proof
        // the add wrote through, not just mutated memory.
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

        // A dir that's a discovered worktree of a tracked repo resolves to
        // that repo — this is never itself a `repos.json` entry (see
        // [`Engine::rail_rows`]'s doc), which is exactly why plain
        // `remove_repo` can't untrack it.
        assert_eq!(
            e.find_worktree_owner("/repo/main/.claude/worktrees/thing"),
            Some("/repo/main".to_string())
        );
        assert!(!e.remove_repo("/repo/main/.claude/worktrees/thing"));

        // An unrelated dir has no owner.
        assert_eq!(e.find_worktree_owner("/repo/elsewhere"), None);
    }

    /// Why removal invalidates the *owner* too: the registration is gone on
    /// disk but the owner's cached `linked_worktree_dirs` still names the
    /// deleted path until the TTL lets a recompute through — invalidating
    /// drops the dead entry in seconds rather than a minute.
    #[test]
    fn invalidating_the_owner_requeues_its_stale_worktree_list() {
        let (_tmp, mut e) = engine();
        // Real epoch-ms timestamps, not the small fixture numbers used
        // elsewhere: `invalidate` marks an entry stale by stamping it `0`, so
        // freshness only reads as expired when `now` is genuinely far from the
        // epoch. A `now` of 1_002 would call a zero-stamped entry fresh.
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

        // Freshly computed, so without the invalidate the owner is not due for
        // a recompute and that stale list stands for the whole TTL.
        assert!(e.stale_git_targets(now + 1).is_empty());

        // The removal step resolves the owner from precisely that staleness —
        // the directory is gone, so only the cache can still answer…
        assert_eq!(e.find_worktree_owner(wt), Some("/repo/main".to_string()));

        // …and invalidating it requeues the recompute that drops the entry.
        e.invalidate_git("/repo/main");
        assert!(
            e.stale_git_targets(now + 2).iter().any(|(dir, _, _)| dir == "/repo/main"),
            "the owner must be due for a recompute immediately, not in 60s"
        );
    }

    /// One `RailWorktree` record, the shape the host pushes in from the store.
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

    /// The refactor's central claim: a row is on the rail because a record says
    /// so. Detection can neither put one there nor take one away.
    #[test]
    fn a_task_row_exists_on_its_record_alone() {
        let (_tmp, mut e) = engine();
        let wt = "/repo/main/.claude/worktrees/feat-thing";
        assert!(e.add_repo("/repo/main"));

        // Git has never heard of this directory and it isn't on disk — the row
        // is there anyway. This is a task mid-`worktree add`.
        assert!(e.set_task_worktrees(vec![record("/repo/main", wt, tt_store::TaskKind::Task)]));
        assert!(e.watch_targets().contains(&wt.to_string()));
        assert!(!e.set_task_worktrees(vec![record("/repo/main", wt, tt_store::TaskKind::Task)]));

        // And when the record goes — the task closed at the end of removal —
        // the row goes with it, even though the parent still lists the worktree
        // (removing one moves no ref, so nothing invalidates that entry).
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

    /// The other direction, and the reason removal no longer needs to out-race
    /// discovery: a worktree deleted from under the app keeps its row, because
    /// the record outlives the directory. The rail renders it `Detached`.
    #[test]
    fn a_task_row_survives_its_directory_vanishing() {
        let (_tmp, mut e) = engine();
        let wt = "/repo/main/.claude/worktrees/feat-gone";
        assert!(e.add_repo("/repo/main"));
        e.set_task_worktrees(vec![record("/repo/main", wt, tt_store::TaskKind::Task)]);
        // Nothing exists at that path — `engine()` works under a tempdir — and
        // git reports the checkout missing.
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

    /// Detected rows are records too, so the setting is a display filter over an
    /// already-ordered set rather than a switch that starts a discovery.
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

        // Set directly rather than through the setter, which writes the real
        // settings file.
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

    /// What the host reconciles into `detected` records: linked worktrees git
    /// reports that nothing has written down yet. Empty once recorded, so the
    /// steady state costs no store writes.
    #[test]
    fn unrecorded_worktrees_are_offered_once_and_then_stay_quiet() {
        let (tmp, mut e) = engine();
        // A real directory: `unrecorded_worktrees` only offers worktrees that
        // are actually on disk (see `a_vanished_worktree_is_never_offered`).
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

    /// The deleted-task flap: git keeps reporting a linked worktree until its
    /// registration is pruned, so right after a removal the cached list still
    /// names a directory that is gone. Offering it would mint a `detected`
    /// record, `vanished_detected_records` would forget it next tick, and the
    /// tick after would mint it again — the row blinking in and out on the
    /// rail. The two reconcilers have to agree, so this one never offers what
    /// the other would immediately retire.
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

        // Only the directory that exists is offered…
        let found = e.unrecorded_worktrees();
        assert_eq!(found.iter().map(|w| w.dir.as_str()).collect::<Vec<_>>(), vec![live_s.as_str()]);

        // …and the cycle is closed: had it been offered, recording it would put
        // it straight onto the forget list, and forgetting it would offer it
        // again on the next tick.
        e.set_task_worktrees(vec![record("/repo/main", gone, tt_store::TaskKind::Detected)]);
        assert_eq!(e.vanished_detected_records(), vec![gone.to_string()]);
        e.set_task_worktrees(vec![]);
        assert!(
            !e.unrecorded_worktrees().iter().any(|w| w.dir == gone),
            "forgetting a vanished record must not re-offer it — that is the flap"
        );
    }

    /// A worktree the user tracks explicitly is a `Checkout` row and needs no
    /// task; recording one would give the same directory two records.
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
        // …and it appears exactly once in the rail, not twice.
        assert_eq!(e.watch_targets(), vec!["/repo/main".to_string(), wt.to_string()]);
    }

    /// A detected record whose directory is gone is the host's cue to forget it
    /// — the one case where the filesystem retires a record, and only ever for
    /// rows that existed because of the filesystem in the first place.
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

    // git-cache change detection

    #[test]
    fn store_git_info_reports_change_only_on_a_real_difference() {
        let (_tmp, mut e) = engine();
        // First store of a non-default value is a change (cache miss → default).
        assert!(e.store_git_info("/repo/x", git_info("main"), 1000));
        // Storing an identical value again is not a change.
        assert!(!e.store_git_info("/repo/x", git_info("main"), 1100));
        // A different value is a change.
        assert!(e.store_git_info("/repo/x", git_info("feat"), 1200));
    }

    #[test]
    fn warm_git_cache_is_true_iff_any_entry_changed() {
        let (_tmp, mut e) = engine();
        // Seed one dir.
        e.store_git_info("/repo/x", git_info("main"), 1000);

        // A batch where one entry is unchanged and one is new → changed.
        let changed = e.warm_git_cache(
            vec![
                ("/repo/x".to_string(), git_info("main")), // unchanged
                ("/repo/y".to_string(), git_info("main")), // new dir → changed
            ],
            1100,
        );
        assert!(changed);
    }

    // stale_git_targets in-flight dedup

    /// The scan loop and the git-stat poll both call `stale_git_targets`
    /// against the same repo set. Without the in-flight claim, both would
    /// hand back the same stale dir before either stored a fresh value,
    /// doubling every `git` chain — this is the dedup that stops that.
    #[test]
    fn stale_git_targets_does_not_hand_out_a_dir_twice_before_it_is_stored() {
        let (_tmp, mut e) = engine();
        e.add_repo("/repo/x");

        let first = e.stale_git_targets(1000);
        assert_eq!(first.len(), 1, "the only tracked dir is stale on first check");

        // A second caller in the same window (e.g. the other poll loop) must
        // not be handed the dir again — it's already claimed.
        let second = e.stale_git_targets(1010);
        assert!(second.is_empty(), "a claimed dir is withheld from a concurrent caller");

        // Once the first caller stores its result, the dir is fresh (within
        // the TTL) and still correctly withheld — but for the ordinary reason.
        e.store_git_info("/repo/x", git_info("main"), 1010);
        assert!(e.stale_git_targets(1020).is_empty());
    }

    /// A claim must not survive forever if the caller that took it never
    /// calls `store_git_info` back (a panicked `spawn_blocking`, a dropped
    /// future) — otherwise that dir silently drops out of the poll rotation.
    #[test]
    fn a_claim_no_one_released_self_expires_past_the_guard_window() {
        let (_tmp, mut e) = engine();
        e.add_repo("/repo/x");

        let first = e.stale_git_targets(1000);
        assert_eq!(first.len(), 1);
        // Never call store_git_info — simulate a caller that dropped the result.

        assert!(
            e.stale_git_targets(1000 + GIT_PENDING_GUARD_MS - 1).is_empty(),
            "still within the guard window"
        );
        let recovered = e.stale_git_targets(1000 + GIT_PENDING_GUARD_MS);
        assert_eq!(recovered.len(), 1, "the claim expired, so the dir is eligible again");
    }

    // folder-meta setters

    #[test]
    fn set_folder_base_branch_change_detects_and_invalidates_git_cache() {
        let (_tmp, mut e) = engine();
        // Prime a cached git value for the folder. `is_fresh` is TTL-relative,
        // and `invalidate` stamps the entry to ts=0, so use a `now` past the
        // TTL — then a freshly cached entry reads fresh but an invalidated
        // (ts=0) one reads stale.
        let now = 10_000_000;
        e.store_git_info("/repo/x", git_info("main"), now);
        assert!(e.git_cache.is_fresh("/repo/x", now));

        // Setting a new base branch is a change and marks the cache entry stale
        // (its stats were computed against the old baseline).
        assert!(e.set_folder_base_branch("/repo/x", Some("develop")));
        assert!(!e.git_cache.is_fresh("/repo/x", now));

        // Setting the same base branch again is not a change.
        assert!(!e.set_folder_base_branch("/repo/x", Some("develop")));
        // Clearing it is a change.
        assert!(e.set_folder_base_branch("/repo/x", None));
    }

    #[test]
    fn set_collapsed_and_set_folder_quiet_report_only_real_changes() {
        let (_tmp, mut e) = engine();
        assert!(e.set_collapsed("row-1", true));
        assert!(!e.set_collapsed("row-1", true));
        assert!(e.set_collapsed("row-1", false));

        assert!(e.set_folder_quiet("/repo/x", true));
        assert!(!e.set_folder_quiet("/repo/x", true));
        assert!(e.set_folder_quiet("/repo/x", false));
    }
}
