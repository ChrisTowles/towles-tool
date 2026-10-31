//! The agentboard engine: tracker + git cache + watcher behind one struct,
//! host-agnostic, so every host shares it.
//!
//! The engine is synchronous; hosts own scheduling and transport, and guard it
//! with a `Mutex`. Everything expensive runs unlocked — the `claude agents`
//! call, [`collect_agent_snapshot`], an [`AgentScanJob`]'s journal reads and
//! [`crate::git_info::compute_git_info`] — their results handed to cheap locked
//! methods.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::bridge::{StatePayload, assemble_state};
use crate::claude_cli::{AgentScan, CliAgent};
use crate::git_info::GitInfoCache;
use crate::procenv::InstanceScope;
use crate::repos::{
    RepoEntry, add_repo_persisted, default_repos_path, load_scan_roots, remove_repo_persisted,
    repo_entries, resolve_session_name, save_scan_roots, untrack_missing_persisted,
};
use crate::sessions::{SessionRecord, SessionStore, default_sessions_path};
use crate::tracker::{AgentTracker, instance_key};
use crate::types::{AgentEvent, RowRecord, RowTask};
use crate::watchers::claude_code::ClaudeCodeAgentWatcher;

mod folder_settings;
mod git_refresh;
mod repo_list;
mod session_ops;

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
    PrBase,
    WorktreeRemoved,
    WorktreeCreated,
    WindowFocus,
}

impl GitInvalidation {
    fn as_str(self) -> &'static str {
        match self {
            Self::ControlFile => "control_file",
            Self::TurnEnd => "turn_end",
            Self::FolderFocus => "folder_focus",
            Self::BaseBranch => "base_branch",
            Self::PrBase => "pr_base",
            Self::WorktreeRemoved => "worktree_removed",
            Self::WorktreeCreated => "worktree_created",
            Self::WindowFocus => "window_focus",
        }
    }
}

/// Fetch cadence per activity tier, and the windows that sort a repo into one.
/// A repo with a task worktree, or touched within [`ACTIVE_WINDOW_MS`], keeps
/// the fastest cadence; the rest earn theirs back.
const ACTIVE_FETCH_MS: i64 = 3 * 60 * 1000;
const RECENT_FETCH_MS: i64 = 15 * 60 * 1000;
const IDLE_FETCH_MS: i64 = 60 * 60 * 1000;
const ACTIVE_WINDOW_MS: i64 = 60 * 60 * 1000;
const RECENT_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

/// Every tier stretches by this much while the window is in the background —
/// "behind main" has no reader until focus returns.
const UNFOCUSED_FETCH_MULT: i64 = 5;

const STALE_MS: i64 = 12 * 60 * 60 * 1000;
const IDLE_MS: i64 = 30 * 1000;

/// How long a [`Engine::git_pending`] claim blocks a second `stale_git_targets`
/// caller — longer than any real compute, so only a dropped result hits it.
const GIT_PENDING_GUARD_MS: i64 = 30_000;

/// How long a folder stays off the rail before a poll reaps its state: a `git
/// checkout` of a repo tracking `repos.json` untracks newer repos for a second.
const UNTRACKED_GRACE_MS: i64 = 10 * 60 * 1000;

fn persisted<E: std::fmt::Display>(result: std::result::Result<(), E>, what: &str) {
    if let Err(e) = result {
        log::warn!("failed to persist {what}: {e}");
    }
}

pub use tt_config::now_ms;

pub struct Engine {
    projects_dir: PathBuf,
    repos_path: PathBuf,
    repo_paths: Vec<String>,
    /// `archivedPaths` from `repos.json`, reloaded with `repo_paths`.
    archived_paths: Vec<String>,
    /// `agentboard.railRepoSort` / `railTaskSort` — see [`crate::rail_sort`].
    repo_sort: tt_config::RailSort,
    task_sort: tt_config::RailSort,
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
    /// In-flight claims from [`Self::stale_git_targets`], released by [`Self::store_git_info`].
    git_pending: HashMap<String, i64>,
    /// When each repo root was last handed to a `git fetch`, for [`Self::fetch_targets`].
    git_fetched: HashMap<String, i64>,
    watcher: Option<ClaudeCodeAgentWatcher>,
    compact_recommend_percent: u8,
    /// `agentboard.showUnmanagedWorktrees`, off by default — a display filter over
    /// [`RowRecord::Detected`]; the host gates its reconciler on it too.
    show_unmanaged_worktrees: bool,
    /// `~`, the rail's one [`RowRecord::Home`] row; `None` when there is no home.
    home_dir: Option<String>,
    /// The rail's worktree rows, pushed in by the host. Records, not directories.
    task_worktrees: Vec<tt_store::RailWorktree>,
    /// The store's PR rows, pushed in by the host like `task_worktrees`, so a
    /// folder compares against where its PR merges — see [`crate::pr_base`].
    prs: Vec<tt_store::PrItem>,
    /// Sticky agent→PTY attribution, kept while the tracker holds the thread, so
    /// an exited agent stays on the pane it ran in rather than drifting.
    thread_sessions: HashMap<String, String>,
    /// The host's last [`collect_agent_snapshot`], so a payload rebuild does no
    /// `/proc` or transcript I/O of its own.
    agent_snapshot: AgentSnapshot,
    /// Session records from the previous run, kept until [`Self::retire_prior_run`].
    prior_run: HashSet<String>,
    /// When each rail folder was last tracked, for [`UNTRACKED_GRACE_MS`].
    last_tracked: HashMap<String, i64>,
    /// The host's live PTY ids, pushed in by [`Self::set_live_sessions`].
    live_sessions: HashSet<String>,
}

/// What a payload rebuild needs from the system rather than engine state.
/// Collected outside the lock: it reads `/proc` and transcripts.
#[derive(Debug, Default)]
pub struct AgentSnapshot {
    live_threads: HashSet<String>,
    tt_session_by_thread: HashMap<String, String>,
    /// Ours but not in `cli` yet; the watcher takes them as listed.
    unlisted: Vec<CliAgent>,
}

/// Gather the live-agent inputs for a payload rebuild from this scan's `cli`
/// answer, once per scan — never per emit, and WITHOUT the engine lock. `None`
/// for a failed `cli`, whose empty list would unpin every live agent: keep the
/// last snapshot. `scope` must match the engine's, so attribution and admission
/// agree on what is ours; `shell_pids` are the host's PTY shells.
pub fn collect_agent_snapshot(
    scope: &InstanceScope,
    shell_pids: &[u32],
    cli: &AgentScan,
) -> Option<AgentSnapshot> {
    if !cli.ok {
        return None;
    }
    let cli_agents = &cli.agents;
    let mut live_threads: HashSet<String> =
        cli_agents.iter().map(|a| a.session_id.clone()).collect();
    // Unmapped falls back to the folder's default session; out of `scope` is
    // dropped entirely.
    let mut tt_session_by_thread: HashMap<String, String> = cli_agents
        .iter()
        .filter_map(|a| {
            crate::procenv::session_id_in_scope(a.pid, scope).map(|sid| (a.session_id.clone(), sid))
        })
        .collect();
    // A session started since the cached CLI call, read from the file the CLI
    // lists it from, so it needn't wait out the cache.
    let sessions_dir = tt_config::claude_dir().join("sessions");
    let mut covered: HashSet<String> = tt_session_by_thread.values().cloned().collect();
    let mut unlisted = Vec::new();
    for proc in crate::procenv::scan_session_agents(shell_pids, scope) {
        if !covered.insert(proc.session_id.clone()) {
            continue;
        }
        let Some(agent) = crate::claude_cli::read_session_file(&sessions_dir, proc.pid) else {
            continue;
        };
        live_threads.insert(agent.session_id.clone());
        tt_session_by_thread.insert(agent.session_id.clone(), proc.session_id);
        unlisted.push(agent);
    }
    Some(AgentSnapshot { live_threads, tt_session_by_thread, unlisted })
}

/// The host's one `claude agents` call per scan, shared by the watcher and
/// [`collect_agent_snapshot`]. Spawns a process: never under the engine lock.
pub fn fetch_agent_scan() -> AgentScan {
    crate::claude_cli::fetch_agents_cached(std::time::Duration::from_millis(
        crate::watchers::claude_code::CLI_CACHE_TTL_MS,
    ))
}

/// The watcher, lent out of the engine by [`Engine::begin_agent_scan`] so its
/// journal reads run unlocked; [`Engine::finish_agent_scan`] takes it back.
pub struct AgentScanJob {
    watcher: Option<ClaudeCodeAgentWatcher>,
    entries: Vec<RepoEntry>,
    unlisted: Vec<CliAgent>,
    events: Vec<AgentEvent>,
}

impl AgentScanJob {
    pub fn run(&mut self, cli: &AgentScan, now: i64) {
        let Some(watcher) = &mut self.watcher else {
            return;
        };
        let entries = &self.entries;
        let resolve = |dir: &str| resolve_session_name(dir, entries);
        self.events = watcher.scan(&resolve, cli, &self.unlisted, now);
    }
}

impl Engine {
    /// `scope` picks which app instances' agents this host reports.
    pub fn new(scope: InstanceScope) -> Self {
        let projects_dir = tt_config::claude_dir().join("projects");
        let repos_path = default_repos_path();
        let tracked = crate::repos::load_tracked(&repos_path);

        let settings = tt_config::load().unwrap_or_default();
        let compact_recommend_percent = settings
            .agentboard
            .compact_recommend_percent
            .unwrap_or(tt_config::DEFAULT_COMPACT_RECOMMEND_PERCENT);
        let show_unmanaged_worktrees = settings
            .agentboard
            .show_unmanaged_worktrees
            .unwrap_or(tt_config::DEFAULT_SHOW_UNMANAGED_WORKTREES);

        let repo_sort = settings.agentboard.rail_repo_sort.unwrap_or(tt_config::DEFAULT_RAIL_SORT);
        let task_sort = settings.agentboard.rail_task_sort.unwrap_or(tt_config::DEFAULT_RAIL_SORT);

        let mut sessions = SessionStore::new(Some(default_sessions_path()));
        if sessions.drop_never_used() {
            persisted(sessions.save(), "sessions");
        }
        let prior_run =
            sessions.iter().flat_map(|(_, list)| list.iter().map(|r| r.id.clone())).collect();

        Self {
            projects_dir: projects_dir.clone(),
            repo_paths: tracked.paths,
            archived_paths: tracked.archived,
            repo_sort,
            task_sort,
            // Unset so the first `reload_repos` always reads: only a good parse
            // stamps this, and `load_tracked` swallows a corrupt file as empty.
            repos_stat: None,
            repos_path,
            tracker: AgentTracker::new(),
            sessions,
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
            watcher: Some(ClaudeCodeAgentWatcher::with_defaults(scope.clone())),
            compact_recommend_percent,
            show_unmanaged_worktrees,
            home_dir: dirs::home_dir().map(|h| h.to_string_lossy().into_owned()),
            task_worktrees: Vec::new(),
            prs: Vec::new(),
            thread_sessions: HashMap::new(),
            agent_snapshot: AgentSnapshot::default(),
            prior_run,
            last_tracked: HashMap::new(),
            live_sessions: HashSet::new(),
        }
    }

    pub fn projects_dir(&self) -> PathBuf {
        self.projects_dir.clone()
    }

    /// Re-read `repos.json` so another writer's changes land without a restart. A
    /// torn read keeps the last known-good list; empty would prune every session.
    fn reload_repos(&mut self) {
        // A missing file has no version and falls through, which `try_load_tracked`
        // treats as an empty list — so "the file was deleted" keeps working.
        let stat = crate::persist::file_version(&self.repos_path);
        if stat.is_some() && stat == self.repos_stat {
            return;
        }
        if let Some(tracked) = crate::repos::try_load_tracked(&self.repos_path) {
            self.repo_paths = tracked.paths;
            self.archived_paths = tracked.archived;
            // Caching a corrupt file's stat would stop the next tick re-reading.
            self.repos_stat = stat;
        }
    }

    pub fn begin_agent_scan(&mut self) -> AgentScanJob {
        self.reload_repos();
        let all_paths = self.rail_dirs();
        AgentScanJob {
            watcher: self.watcher.take(),
            entries: repo_entries(&all_paths),
            unlisted: self.agent_snapshot.unlisted.clone(),
            events: Vec::new(),
        }
    }

    pub fn finish_agent_scan(&mut self, job: AgentScanJob) {
        self.watcher = job.watcher;
        for event in job.events {
            self.tracker.apply_event(event);
        }
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
        // Last, so the colors dealt in rail order stay where they were;
        // `compute_payload` lifts it to the top. Tracking `~` as a repo wins.
        if let Some(home) = &self.home_dir
            && seen.insert(home.as_str())
        {
            rows.push(RailRow {
                dir: home.clone(),
                repo_root: home.clone(),
                record: RowRecord::Home,
            });
        }
        rows
    }

    fn rail_dirs(&mut self) -> Vec<String> {
        self.rail_rows().into_iter().map(|r| r.dir).collect()
    }

    /// [`Self::rail_dirs`] minus the home row: `~` is no repo, and one that is
    /// (a dotfiles checkout) would cost a status walk over the whole home dir.
    fn git_dirs(&mut self) -> Vec<String> {
        self.rail_rows()
            .into_iter()
            .filter(|r| r.record != RowRecord::Home)
            .map(|r| r.dir)
            .collect()
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
        let dirs = self.git_dirs();
        let mut out = std::collections::HashMap::new();
        for dir in dirs {
            let info = self.git_cache.get(&dir);
            for file in crate::git_info::control_files_for(&info) {
                out.insert(file, dir.clone());
            }
        }
        out
    }

    pub fn set_agent_snapshot(&mut self, snapshot: AgentSnapshot) {
        self.agent_snapshot = snapshot;
    }

    pub fn compute_payload(&mut self, now: i64) -> StatePayload {
        self.reload_repos();
        let rows = self.rail_rows();
        // NOT name-sorted: `rail_rows` order is the user's drag order.
        let all_paths: Vec<String> = rows.iter().map(|r| r.dir.clone()).collect();
        let entries = repo_entries(&all_paths);
        let rows_by_dir: HashMap<String, RailRow> =
            rows.into_iter().map(|r| (r.dir.clone(), r)).collect();
        let snapshot = std::mem::take(&mut self.agent_snapshot);
        let payload = self.compute_payload_for_entries(&entries, &rows_by_dir, &snapshot, now);
        self.agent_snapshot = snapshot;
        // Never on an empty entry set, far likelier a transient glitch than a real
        // config wipe; a genuine remove-all prunes on the next poll.
        if !entries.is_empty() {
            // Keyed on *records*, not rendered rows: pruning by display state
            // would delete a hidden worktree's session history every poll.
            let mut dirs: HashSet<String> = entries.iter().map(|e| e.dir.clone()).collect();
            dirs.extend(self.task_worktrees.iter().map(|w| w.dir.clone()));
            let dirs = self.not_yet_reapable(dirs, now);
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

    /// `tracked` plus folders tracked within [`UNTRACKED_GRACE_MS`] or holding a
    /// live PTY's record — the rail's only way back to a running shell.
    fn not_yet_reapable(&mut self, mut tracked: HashSet<String>, now: i64) -> HashSet<String> {
        for dir in &tracked {
            self.last_tracked.insert(dir.clone(), now);
        }
        self.last_tracked.retain(|_, seen| now - *seen < UNTRACKED_GRACE_MS);
        tracked.extend(self.last_tracked.keys().cloned());
        for (dir, records) in self.sessions.iter() {
            if records.iter().any(|r| self.live_sessions.contains(&r.id)) {
                tracked.insert(dir.to_string());
            }
        }
        tracked
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
            for agent in self.tracker.agents(&entry.name) {
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
            self.compact_recommend_percent,
            now,
        );

        for repo in &mut payload.repos {
            repo.meta = self.repo_meta.meta_for(&repo.dir).cloned();
            for folder in &mut repo.folders {
                folder.pr_base_branch = crate::pr_base::pr_base_for(
                    &self.prs,
                    repo.origin_url.as_deref(),
                    &folder.branch,
                )
                .map(str::to_string);
            }
        }
        let pins: Vec<_> =
            payload.repos.iter().map(|r| r.meta.as_ref().and_then(|m| m.color.as_ref())).collect();
        let colors = crate::repo_meta::resolve_colors(&pins);
        for (repo, color) in payload.repos.iter_mut().zip(colors) {
            repo.color = color;
            repo.archived = self.archived_paths.contains(&repo.dir);
            crate::rail_sort::sort_folders(&mut repo.folders, self.task_sort);
        }
        // After the colors are dealt, which follow the manual order so a re-sort
        // never repaints a repo.
        crate::rail_sort::sort_repos(&mut payload.repos, self.repo_sort);
        if let Some(i) =
            payload.repos.iter().position(|r| r.folders.iter().any(|f| f.record == RowRecord::Home))
        {
            let home = payload.repos.remove(i);
            payload.repos.insert(0, home);
        }

        payload.windows = self.windows.payload().clone();
        payload.collapsed = self.collapse.payload().collapsed.clone();
        payload
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
    /// tempdir file. No watcher, so a scan is inert.
    fn new_for_test(repos_path: PathBuf) -> Self {
        let tracked = crate::repos::load_tracked(&repos_path);
        Self {
            projects_dir: PathBuf::from("/nonexistent/projects"),
            repo_paths: tracked.paths,
            archived_paths: tracked.archived,
            repo_sort: tt_config::DEFAULT_RAIL_SORT,
            task_sort: tt_config::DEFAULT_RAIL_SORT,
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
            watcher: None,
            compact_recommend_percent: 80,
            show_unmanaged_worktrees: tt_config::DEFAULT_SHOW_UNMANAGED_WORKTREES,
            home_dir: None,
            task_worktrees: Vec::new(),
            prs: Vec::new(),
            thread_sessions: HashMap::new(),
            agent_snapshot: AgentSnapshot::default(),
            prior_run: HashSet::new(),
            last_tracked: HashMap::new(),
            live_sessions: HashSet::new(),
        }
    }
}

#[cfg(test)]
mod engine_tests;
