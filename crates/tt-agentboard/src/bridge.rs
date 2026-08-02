//! Pure state-snapshot assembly for the Tauri bridge (Folder Rail): the
//! three-level **Repo → Folder → Session** snapshot the React client renders. No
//! tmux, no tauri, no I/O — the host gathers the inputs and wires its runtime
//! around [`assemble_state`].
//!
//! - A [`FolderData`] is one checkout on disk (a `RepoEntry`), carrying its git
//!   stats and its 1..N PTY [`SessionData`]s.
//! - Folders group into one [`RepoData`] row by [`GitInfo::common_dir`], which
//!   every linked worktree reports identically — a structural git fact, not a
//!   function of whether the checkout was tracked or discovered. Empty gets its
//!   own row. The row's non-worktree checkout leads its folder list and owns the
//!   `key`, so a worktree that merely sorted first never keys the row.
//! - An attributed agent event renders only on that exact session (a foreign id
//!   is dropped, never guessed). An unattributed one goes to the pane that
//!   recorded running its thread, and only failing that to the default.

use std::collections::HashMap;

use serde::Serialize;

use crate::engine::RailRow;
use crate::folder_meta::FolderMetaStore;
use crate::git_info::GitInfo;
use crate::repos::RepoEntry;
use crate::sessions::{SessionRecord, SessionStore};
use crate::tracker::AgentTracker;
use crate::types::{
    AgentEvent, AgentStatus, FolderData, NeedsYouReason, RepoData, RowRecord, SessionData,
};

/// The state snapshot emitted to the client: repos, each nesting its
/// worktree-sibling folders, each holding its PTY sessions.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatePayload {
    pub repos: Vec<RepoData>,
    /// Context-% at/above which a cold session shows the "compact" nudge
    /// (settings `agentboard.compactRecommendPercent`, default 30).
    pub compact_recommend_percent: u8,
    /// Persisted window layout (frontend-owned; attached by the engine).
    pub windows: crate::windows::WindowsPayload,
    /// Persisted folder-rail collapse/expand state, keyed by row key (attached
    /// by the engine). Absent key ⇒ expanded.
    pub collapsed: std::collections::BTreeMap<String, bool>,
    pub ts: i64,
}

/// Assemble the [`StatePayload`] from the current inputs. Pure. Maps each repo entry to
/// a [`FolderData`], then groups [`RepoData`] rows by [`GitInfo::common_dir`] — see the
/// module docs for the grouping rule.
///
/// `attribute` maps an agent event to the PTY session id it was detected in; an id
/// matching none of the folder's records drops the event, and `None` falls back to the
/// pane that remembers the thread, then to the default.
#[allow(clippy::too_many_arguments)]
pub fn assemble_state(
    entries: &[RepoEntry],
    rows: &HashMap<String, RailRow>,
    git_infos: &HashMap<String, GitInfo>,
    tracker: &AgentTracker,
    sessions: &SessionStore,
    folder_meta: &FolderMetaStore,
    attribute: &dyn Fn(&AgentEvent) -> Option<String>,
    session_agents: &HashMap<String, AgentEvent>,
    compact_recommend_percent: u8,
    ts: i64,
) -> StatePayload {
    let mut repos: Vec<RepoData> = Vec::new();
    let mut group_index: HashMap<String, usize> = HashMap::new(); // common_dir -> repos index
    // Every placed folder's dir -> its repo row, so a row git can't speak for
    // can still find its group. See the `repo_root` fallback below.
    let mut dir_index: HashMap<String, usize> = HashMap::new();

    for entry in entries {
        let git = git_infos.get(&entry.dir).cloned().unwrap_or_default();
        let row = rows.get(&entry.dir);
        let folder = build_folder(
            entry,
            row,
            &git,
            tracker,
            sessions,
            folder_meta,
            attribute,
            session_agents,
        );
        let needs = folder.needs;

        let group_key = (!git.common_dir.is_empty()).then(|| git.common_dir.clone());
        // `common_dir` is the structural git fact every linked worktree reports
        // identically — but git needs the directory to *be* there, and a task's
        // row exists before its worktree does. Falling back to `repo_root` keeps
        // a creating task under its own repo instead of stranding it top-level.
        // Safe because `rail_rows` emits each checkout ahead of its bound rows.
        let existing = group_key
            .as_ref()
            .and_then(|k| group_index.get(k).copied())
            .or_else(|| row.and_then(|r| dir_index.get(&r.repo_root).copied()));
        // Which folder leads its repo row is a question about the *record*, not
        // about git: a task row whose worktree doesn't exist yet reports
        // `is_worktree = false` from a default `GitInfo`, and letting that
        // re-anchor the row would key the whole group to a directory that isn't
        // there. Only a tracked checkout leads. (Falling back to the git fact
        // covers callers that pass no rows at all.)
        let leads = match row {
            Some(r) => matches!(r.record, RowRecord::Checkout),
            None => !git.is_worktree,
        };
        match existing {
            Some(i) => {
                if !leads {
                    repos[i].folders.push(folder);
                } else {
                    // The primary checkout leads its group whenever it is
                    // seen, re-anchoring the row's identity to itself.
                    // Otherwise a worktree that merely sorted first would
                    // key the row to a folder a later poll can rename or
                    // remove, destabilizing rail position and collapse-state
                    // persistence (both keyed on `repo.key`).
                    repos[i].key = format!("path:{}", entry.dir);
                    repos[i].dir = entry.dir.clone();
                    if repos[i].origin_url.is_none() {
                        repos[i].name = git
                            .origin_url
                            .as_deref()
                            .and_then(repo_name_from_origin)
                            .unwrap_or_else(|| entry.name.clone());
                        repos[i].origin_url = git.origin_url.clone();
                    }
                    repos[i].folders.insert(0, folder);
                }
                repos[i].needs += needs;
                dir_index.insert(entry.dir.clone(), i);
            }
            None => {
                if let Some(key) = group_key {
                    group_index.insert(key, repos.len());
                }
                dir_index.insert(entry.dir.clone(), repos.len());
                repos.push(new_repo_row(entry, &git, folder));
            }
        }
    }

    StatePayload {
        repos,
        compact_recommend_percent,
        windows: crate::windows::WindowsPayload::default(), // engine attaches
        collapsed: std::collections::BTreeMap::new(),       // engine attaches
        ts,
    }
}

/// Build one folder: git stats + its persisted sessions with agents distributed
/// by `attribute` (attributed → that exact session or dropped; no attribution →
/// the remembering pane, else default), plus a placeholder `needs` count (always 0 here — see
/// [`session_needs`] — the app recomputes it after stamping shell liveness via
/// [`recompute_needs`]).
#[allow(clippy::too_many_arguments)]
fn build_folder(
    entry: &RepoEntry,
    row: Option<&RailRow>,
    git: &GitInfo,
    tracker: &AgentTracker,
    sessions: &SessionStore,
    folder_meta: &FolderMetaStore,
    attribute: &dyn Fn(&AgentEvent) -> Option<String>,
    session_agents: &HashMap<String, AgentEvent>,
) -> FolderData {
    let records = sessions.sessions_for(&entry.dir);
    let folder_agents = tracker.get_agents(&entry.name);
    let default_id = records.first().map(|r| r.id.clone());

    // Bucket each agent onto the session it ran in. An id that isn't one of
    // this folder's records means the agent runs in another app instance's
    // session (sessions.json is shared), and dropping it beats pinning
    // someone else's agent onto an unrelated pane.
    let mut by_session: HashMap<String, Vec<AgentEvent>> = HashMap::new();
    for agent in folder_agents {
        let sid = match attribute(&agent) {
            Some(id) => records.iter().any(|r| r.id == id).then_some(id),
            // A live link is readable only while the process is, so an agent
            // whose pid went unreadable — it exited, or the cached CLI
            // snapshot outran it — would otherwise jump to pane 1 and take
            // its needs-you signal along. `note_agent`'s record outlives the
            // process. A thread another folder's pane remembers isn't ours to
            // default either: the tracker buckets by folder *name*, so
            // same-basename checkouts see each other's agents here.
            None => match remembering_record(records, &agent) {
                Some(id) => Some(id),
                None if remembered_elsewhere(sessions, records, &agent) => None,
                None => default_id.clone(),
            },
        };
        if let Some(sid) = sid {
            by_session.entry(sid).or_default().push(agent);
        }
    }

    let session_data: Vec<SessionData> = records
        .iter()
        .map(|r| {
            let agents = by_session.remove(&r.id).unwrap_or_default();
            let agent_state = pick_state(&agents);
            // Supplement: an app-spawned Claude we found by scanning /proc for
            // this session's TT_SESSION_ID, when the CLI snapshot never reported
            // it (so the tracker has nothing). Only fills an otherwise-idle row.
            let agent_state = agent_state.or_else(|| session_agents.get(&r.id).cloned());
            let unseen = agent_state.as_ref().and_then(|e| e.unseen).unwrap_or(false);
            SessionData {
                id: r.id.clone(),
                name: r.name.clone(),
                created_at: r.created_at,
                live: false,      // stamped by the app from its PTY registry
                shell_kind: None, // stamped by the app from its PTY registry
                unseen,
                needs_since_ms: None, // stamped app-side by `recompute_needs`
                agent_state,
                agents,
                purpose: r.purpose.clone(),
                port_drift: Vec::new(), // stamped by the app from its terminal registry
            }
        })
        .collect();

    let needs = session_data.iter().filter(|s| session_needs(s)).count() as i64;

    let record = row.map(|r| r.record.clone()).unwrap_or_default();
    // Identity comes from the record when git can't answer yet — a task row
    // renders under its own title with its recorded branch from the first
    // paint, instead of masquerading as "Root" until the cold git cache warms
    // (or forever, for a detached task whose directory is gone).
    let is_worktree = git.is_worktree || record.task().is_some();
    let branch = if git.branch.is_empty() {
        record.task().and_then(|t| t.branch.clone()).unwrap_or_default()
    } else {
        git.branch.clone()
    };

    FolderData {
        name: entry.name.clone(),
        dir: entry.dir.clone(),
        repo_root: row.map(|r| r.repo_root.clone()).unwrap_or_else(|| entry.dir.clone()),
        record,
        // Filled in by the app's `stamp_pty_state`; the engine can't know.
        phase: None,
        dir_missing: git.dir_missing,
        branch,
        is_worktree,
        committed_files: git.committed_files,
        committed_added: git.committed_added,
        committed_removed: git.committed_removed,
        uncommitted_files: git.uncommitted_files,
        uncommitted_added: git.uncommitted_added,
        uncommitted_removed: git.uncommitted_removed,
        uncommitted_capped: git.uncommitted_capped,
        computed_at_ms: git.computed_at_ms,
        worked_at_ms: git
            .head_commit_ms
            .max(git.worktree_touched_ms)
            .max(folder_meta.last_worked_at_for(&entry.dir).unwrap_or(0)),
        worktree_touched_ms: git.worktree_touched_ms,
        commits_ahead: git.commits_ahead,
        commits_behind: git.commits_behind,
        dirty: git.dirty,
        commits_unlanded: git.commits_unlanded,
        landed: git.landed.clone(),
        sessions: session_data,
        needs,
        base_branch: folder_meta.base_branch_for(&entry.dir).map(str::to_string),
        task_base_branch: git.task_base_branch.clone(),
        compared_base: git.compared_base.clone(),
        has_port_drift: false, // stamped by the app from its terminal registry
        has_launch_config: git.has_launch_config,
        quiet: folder_meta.quiet_for(&entry.dir),
    }
}

/// The folder's session record that last ran this agent's thread, if any.
fn remembering_record(records: &[SessionRecord], agent: &AgentEvent) -> Option<String> {
    let tid = agent.thread_id.as_deref()?;
    records.iter().find(|r| r.last_claude_session_id.as_deref() == Some(tid)).map(|r| r.id.clone())
}

/// Whether a pane in some *other* folder recorded running this agent's thread.
fn remembered_elsewhere(
    sessions: &SessionStore,
    records: &[SessionRecord],
    agent: &AgentEvent,
) -> bool {
    let Some(tid) = agent.thread_id.as_deref() else {
        return false;
    };
    let ours: Vec<&str> = records.iter().map(|r| r.id.as_str()).collect();
    sessions.iter().any(|(_, list)| {
        list.iter().any(|r| {
            r.last_claude_session_id.as_deref() == Some(tid) && !ours.contains(&r.id.as_str())
        })
    })
}

/// Whether a session "needs you". Only a session with a shell (`live`) counts,
/// or a stale agent status would cry wolf about a shell that's gone. Given one,
/// it needs you when its agent is blocked or broke, or when its turn just ended
/// and the user hasn't looked yet (`unseen`, cleared by `ab_mark_seen`).
///
/// `live` is stamped app-side, so at engine assemble time this is always
/// `false` — assemble-time `needs` is a placeholder the app overwrites.
pub fn session_needs(s: &SessionData) -> bool {
    needs_reason(s).is_some()
}

/// Why a session needs you, or `None` if it doesn't. The single source of truth
/// [`session_needs`] delegates to, so the boolean and the [`NeedsYouReason`]
/// notifications show can never disagree about which status counts.
pub fn needs_reason(s: &SessionData) -> Option<NeedsYouReason> {
    if !s.live {
        return None;
    }
    match s.agent_state.as_ref().map(|e| e.status) {
        Some(AgentStatus::Waiting) => Some(NeedsYouReason::WaitingForInput),
        Some(AgentStatus::Error) => Some(NeedsYouReason::Errored),
        Some(AgentStatus::Complete) | Some(AgentStatus::Interrupted) if s.unseen => {
            Some(NeedsYouReason::Finished)
        }
        _ => None,
    }
}

/// Remembers when each session FIRST entered "needs you", so re-stamping the
/// payload doesn't reset the clock on a long-waiting block — the attention feed
/// orders oldest-first. Dropped the moment a session stops needing you, so a
/// later re-entry stamps fresh. Held app-side and threaded into
/// [`recompute_needs`]; the epoch-ms clock is passed in, never read here.
#[derive(Debug, Default)]
pub struct NeedsSince {
    stamps: HashMap<String, i64>,
}

impl NeedsSince {
    pub fn new() -> Self {
        Self::default()
    }

    /// When this session first entered needs-you, if it's currently needing.
    pub fn get(&self, session_id: &str) -> Option<i64> {
        self.stamps.get(session_id).copied()
    }
}

/// Recompute every folder's and repo's `needs` with [`session_needs`], and
/// stamp each session's `needs_since_ms`. The engine assembles `needs` before
/// `live` is stamped, so the app calls this afterwards for truthful counts.
///
/// `since` carries the first-entered timestamp forward, so a waiting-age only
/// grows; a session that stops needing you is forgotten and re-stamps fresh.
pub fn recompute_needs(payload: &mut StatePayload, since: &mut NeedsSince, now_ms: i64) {
    let mut next: HashMap<String, i64> = HashMap::new();
    for repo in &mut payload.repos {
        let mut repo_needs = 0;
        for folder in &mut repo.folders {
            let mut folder_needs = 0;
            for s in &mut folder.sessions {
                if session_needs(s) {
                    let stamp = since.stamps.get(&s.id).copied().unwrap_or(now_ms);
                    s.needs_since_ms = Some(stamp);
                    next.insert(s.id.clone(), stamp);
                    folder_needs += 1;
                } else {
                    s.needs_since_ms = None;
                }
            }
            folder.needs = folder_needs;
            repo_needs += folder_needs;
        }
        repo.needs = repo_needs;
    }
    since.stamps = next;
}

/// Priority ordering for picking a session's headline agent state: attention
/// (waiting/error) first, then working, then terminal states, then idle;
/// ties broken by recency.
fn pick_state(agents: &[AgentEvent]) -> Option<AgentEvent> {
    agents.iter().max_by_key(|e| (status_rank(e.status), e.ts)).cloned()
}

fn status_rank(s: AgentStatus) -> u8 {
    match s {
        AgentStatus::Waiting => 5,
        AgentStatus::Error => 4,
        AgentStatus::Busy => 3,
        AgentStatus::Interrupted => 2,
        AgentStatus::Complete => 1,
        AgentStatus::Idle => 0,
    }
}

/// Start a new top-level [`RepoData`] row for `entry` holding just `folder` —
/// the first entry [`assemble_state`] sees for a given `common_dir` group (or
/// any entry with no `common_dir` at all, which never groups with anything).
fn new_repo_row(entry: &RepoEntry, git: &GitInfo, folder: FolderData) -> RepoData {
    let name = git
        .origin_url
        .as_deref()
        .and_then(repo_name_from_origin)
        .unwrap_or_else(|| entry.name.clone());
    let needs = folder.needs;
    RepoData {
        key: format!("path:{}", entry.dir),
        dir: entry.dir.clone(),
        name,
        origin_url: git.origin_url.clone(),
        folders: vec![folder],
        needs,
        // Filled in by the engine after assembly — a pure lookup on `key`.
        meta: None,
    }
}

/// The repo segment of an origin URL: strips a trailing `.git` / `/` and takes
/// the last path segment. Handles both `https://host/owner/repo.git` and
/// scp-style `git@host:owner/repo.git`.
fn repo_name_from_origin(url: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches('/');
    let trimmed = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    let seg = trimmed.rsplit(['/', ':']).next()?;
    (!seg.is_empty()).then(|| seg.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AgentStatus, RowTask};

    fn ev(session: &str, status: AgentStatus, thread: &str) -> AgentEvent {
        AgentEvent {
            agent: "claude-code".into(),
            session: session.into(),
            status,
            ts: 1,
            thread_id: Some(thread.into()),
            thread_name: None,
            unseen: None,
            details: None,
        }
    }

    fn entries() -> Vec<RepoEntry> {
        vec![
            RepoEntry { name: "alpha".into(), dir: "/r/alpha".into() },
            RepoEntry { name: "beta".into(), dir: "/r/beta".into() },
        ]
    }

    fn no_attr(_: &AgentEvent) -> Option<String> {
        None
    }

    /// Every entry as its own tracked checkout — the shape these tests always
    /// meant, now that a row carries the record that put it there. Tests about
    /// task rows build their map explicitly.
    fn rows_for(entries: &[RepoEntry]) -> HashMap<String, RailRow> {
        entries
            .iter()
            .map(|e| {
                (
                    e.dir.clone(),
                    RailRow {
                        dir: e.dir.clone(),
                        repo_root: e.dir.clone(),
                        record: RowRecord::Checkout,
                    },
                )
            })
            .collect()
    }

    /// [`assemble_state`] with the arguments no test below varies: an empty
    /// folder-meta store and the fixed compact/ts tail. Only the stores a test
    /// actually exercises stay in the call.
    fn assemble_with(
        entries: &[RepoEntry],
        git: &HashMap<String, GitInfo>,
        tracker: &AgentTracker,
        sessions: &SessionStore,
        attribute: &dyn Fn(&AgentEvent) -> Option<String>,
        session_agents: &HashMap<String, AgentEvent>,
    ) -> StatePayload {
        assemble_state(
            entries,
            &rows_for(entries),
            git,
            tracker,
            sessions,
            &FolderMetaStore::default(),
            attribute,
            session_agents,
            30,
            0,
        )
    }

    /// [`assemble_with`] with no supplemental per-session agents.
    fn assemble(
        entries: &[RepoEntry],
        git: &HashMap<String, GitInfo>,
        tracker: &AgentTracker,
        sessions: &SessionStore,
        attribute: &dyn Fn(&AgentEvent) -> Option<String>,
    ) -> StatePayload {
        assemble_with(entries, git, tracker, sessions, attribute, &HashMap::new())
    }

    #[test]
    fn folders_map_fields_and_seed_sessions() {
        let mut tracker = AgentTracker::new();
        tracker.apply_event(ev("alpha", AgentStatus::Busy, "ta"), false);
        let mut store = SessionStore::new(None);
        store.ensure_default("/r/alpha", 1);
        store.ensure_default("/r/beta", 1);
        let mut git = HashMap::new();
        git.insert(
            "/r/alpha".to_string(),
            GitInfo {
                branch: "main".into(),
                committed_files: 3,
                committed_added: 10,
                committed_removed: 2,
                commits_ahead: 1,
                origin_url: Some("git@github.com:me/alpha.git".into()),
                ..Default::default()
            },
        );
        let payload = assemble_state(
            &entries(),
            &rows_for(&entries()),
            &git,
            &tracker,
            &store,
            &FolderMetaStore::default(),
            &no_attr,
            &HashMap::new(),
            30,
            999,
        );
        assert_eq!(payload.ts, 999);
        // Neither folder shares a `common_dir` with the other (no git info
        // on beta) → each is its own top-level row → two repos.
        assert_eq!(payload.repos.len(), 2);
        let alpha = &payload.repos[0];
        assert_eq!(alpha.name, "alpha"); // derived from origin repo segment
        assert_eq!(alpha.folders[0].branch, "main");
        assert_eq!(alpha.folders[0].committed_files, 3);
        assert_eq!(alpha.folders[0].sessions.len(), 1);
        // The folder's busy agent lands on its one session.
        assert_eq!(
            alpha.folders[0].sessions[0].agent_state.as_ref().unwrap().status,
            AgentStatus::Busy
        );
        // beta has no git info → standalone path-keyed repo, name = folder basename.
        assert!(payload.repos[1].key.starts_with("path:"));
        assert_eq!(payload.repos[1].name, "beta");
    }

    /// `worked_at_ms` maxes in a pane open, so it can move without the files
    /// under review moving. The diff pane's refetch key needs the pure signal,
    /// which is why `worktree_touched_ms` rides across on its own rather than
    /// being folded into the max above.
    #[test]
    fn worktree_touched_ms_reaches_the_folder_separately_from_worked_at_ms() {
        let mut git = HashMap::new();
        git.insert(
            "/r/alpha".to_string(),
            GitInfo {
                branch: "main".into(),
                head_commit_ms: 5_000,
                worktree_touched_ms: 9_000,
                ..Default::default()
            },
        );
        let payload = assemble_state(
            &entries(),
            &rows_for(&entries()),
            &git,
            &AgentTracker::new(),
            &SessionStore::new(None),
            &FolderMetaStore::default(),
            &no_attr,
            &HashMap::new(),
            30,
            999,
        );
        let alpha = &payload.repos[0].folders[0];
        assert_eq!(alpha.worktree_touched_ms, 9_000);
        assert_eq!(alpha.worked_at_ms, 9_000, "the max still wins for worked_at_ms");
    }

    #[test]
    fn missing_dir_flag_propagates_from_git_info_to_folder() {
        let tracker = AgentTracker::new();
        let mut store = SessionStore::new(None);
        store.ensure_default("/r/alpha", 1);
        store.ensure_default("/r/beta", 1);
        // alpha's checkout is gone; beta's is present.
        let mut git = HashMap::new();
        git.insert("/r/alpha".to_string(), GitInfo { dir_missing: true, ..Default::default() });
        git.insert("/r/beta".to_string(), GitInfo { branch: "main".into(), ..Default::default() });
        let payload = assemble(&entries(), &git, &tracker, &store, &no_attr);
        let alpha = payload.repos.iter().flat_map(|r| &r.folders).find(|f| f.dir == "/r/alpha");
        let beta = payload.repos.iter().flat_map(|r| &r.folders).find(|f| f.dir == "/r/beta");
        assert!(alpha.unwrap().dir_missing);
        assert!(!beta.unwrap().dir_missing);
    }

    /// A task whose worktree doesn't exist yet — mid-`worktree add`, or
    /// detached after one was deleted — has no `common_dir`, because git can
    /// only report that for a directory that is there. It must still nest under
    /// its own repo, on the `repo_root` its record carries: stranding it as its
    /// own top-level row and then snapping it into place a poll later is
    /// exactly the jumping the record model exists to stop.
    #[test]
    fn a_task_row_with_no_directory_yet_nests_under_its_repo_root() {
        let tracker = AgentTracker::new();
        let store = SessionStore::new(None);
        let pending = "/r/demo/.claude/worktrees/feat-new";
        let mut git = HashMap::new();
        git.insert(
            "/r/demo".to_string(),
            GitInfo { common_dir: "/r/demo/.git".into(), is_worktree: false, ..Default::default() },
        );
        // Deliberately no git entry for `pending` — nothing is on disk to read.
        let entries = vec![
            RepoEntry { name: "demo".into(), dir: "/r/demo".into() },
            RepoEntry { name: "feat-new".into(), dir: pending.into() },
        ];
        let rows = HashMap::from([
            (
                "/r/demo".to_string(),
                RailRow {
                    dir: "/r/demo".into(),
                    repo_root: "/r/demo".into(),
                    record: RowRecord::Checkout,
                },
            ),
            (
                pending.to_string(),
                RailRow {
                    dir: pending.into(),
                    repo_root: "/r/demo".into(),
                    record: RowRecord::Task {
                        task: RowTask {
                            id: 7,
                            status: "doing".into(),
                            branch: Some("feat/new".into()),
                        },
                    },
                },
            ),
        ]);
        let payload = assemble_state(
            &entries,
            &rows,
            &git,
            &tracker,
            &store,
            &FolderMetaStore::default(),
            &no_attr,
            &HashMap::new(),
            30,
            0,
        );
        assert_eq!(payload.repos.len(), 1, "the pending task nests, it doesn't strand");
        let dirs: Vec<&str> = payload.repos[0].folders.iter().map(|f| f.dir.as_str()).collect();
        assert_eq!(dirs, vec!["/r/demo", pending]);
        assert_eq!(payload.repos[0].key, "path:/r/demo", "the checkout still anchors the row");
        let row = &payload.repos[0].folders[1];
        assert_eq!(row.record.task().map(|t| t.id), Some(7));
        assert_eq!(row.repo_root, "/r/demo");
        // Identity comes from the record while git has nothing: this is a
        // worktree row on its recorded branch, never a bare "Root".
        assert!(row.is_worktree);
        assert_eq!(row.branch, "feat/new");
    }

    /// The branch is known from the record before git can answer, so the row
    /// isn't nameless while it's being created — and a task whose directory is
    /// gone still has a row rather than vanishing.
    ///
    /// "Detached" itself is derived on the client from the three facts asserted
    /// here (a task record, a missing dir, no operation running), not carried
    /// as its own state — see `RowPhase`.
    #[test]
    fn a_task_row_survives_its_directory_going_missing() {
        let tracker = AgentTracker::new();
        let store = SessionStore::new(None);
        let dir = "/r/demo/.claude/worktrees/feat-gone";
        let mut git = HashMap::new();
        git.insert(dir.to_string(), GitInfo { dir_missing: true, ..Default::default() });
        let entries = vec![RepoEntry { name: "feat-gone".into(), dir: dir.into() }];
        let rows = HashMap::from([(
            dir.to_string(),
            RailRow {
                dir: dir.into(),
                repo_root: "/r/demo".into(),
                record: RowRecord::Task {
                    task: RowTask {
                        id: 9,
                        status: "doing".into(),
                        branch: Some("feat/gone".into()),
                    },
                },
            },
        )]);
        let payload = assemble_state(
            &entries,
            &rows,
            &git,
            &tracker,
            &store,
            &FolderMetaStore::default(),
            &no_attr,
            &HashMap::new(),
            30,
            0,
        );
        let folder = &payload.repos[0].folders[0];
        // The row is still here, and carries what "detached" is read from.
        assert!(folder.dir_missing);
        assert!(folder.record.task().is_some());
        assert_eq!(folder.phase, None, "the engine never claims an operation is running");
        assert_eq!(folder.record.task().and_then(|t| t.branch.as_deref()), Some("feat/gone"));
        // A gone directory means git reports nothing, forever — the record
        // keeps the row a named worktree instead of a permanent "Root".
        assert!(folder.is_worktree);
        assert_eq!(folder.branch, "feat/gone");

        // A tracked checkout that's missing is a ghost, not a detached task —
        // its remedy is Untrack, which `dir_missing` already drives.
        let rows = HashMap::from([(
            dir.to_string(),
            RailRow { dir: dir.into(), repo_root: dir.into(), record: RowRecord::Checkout },
        )]);
        let payload = assemble_state(
            &entries,
            &rows,
            &git,
            &tracker,
            &store,
            &FolderMetaStore::default(),
            &no_attr,
            &HashMap::new(),
            30,
            0,
        );
        let ghost = &payload.repos[0].folders[0];
        assert!(ghost.dir_missing);
        assert!(ghost.record.task().is_none(), "a checkout row has no task, so it can't detach");
    }

    #[test]
    fn worktree_siblings_nest_by_common_dir_with_primary_leading() {
        let tracker = AgentTracker::new();
        let mut store = SessionStore::new(None);
        store.ensure_default("/r/demo", 1);
        store.ensure_default("/r/demo/.claude/worktrees/apple", 1);
        let mut git = HashMap::new();
        git.insert(
            "/r/demo".to_string(),
            GitInfo { common_dir: "/r/demo/.git".into(), is_worktree: false, ..Default::default() },
        );
        git.insert(
            "/r/demo/.claude/worktrees/apple".to_string(),
            GitInfo { common_dir: "/r/demo/.git".into(), is_worktree: true, ..Default::default() },
        );
        // Entries arrive name-sorted (as the engine does), which puts the
        // task ("apple") ahead of the main checkout — nesting must still
        // lead with the primary checkout regardless of entries order.
        let entries = vec![
            RepoEntry { name: "apple".into(), dir: "/r/demo/.claude/worktrees/apple".into() },
            RepoEntry { name: "demo".into(), dir: "/r/demo".into() },
        ];
        let payload = assemble(&entries, &git, &tracker, &store, &no_attr);
        assert_eq!(payload.repos.len(), 1, "worktree siblings nest into one row by common_dir");
        let dirs: Vec<&str> = payload.repos[0].folders.iter().map(|f| f.dir.as_str()).collect();
        assert_eq!(dirs, vec!["/r/demo", "/r/demo/.claude/worktrees/apple"]);
    }

    #[test]
    fn worktree_siblings_row_key_and_name_anchor_to_primary_not_alpha_sort() {
        // Regression: a row's `key`/`name` must not be decided by whichever
        // task sorts first, which shuffled rail position and collapse-state
        // persistence (both keyed on `repo.key`) whenever an earlier-sorting
        // task appeared. No origin URL here, so `name` must also come from
        // the primary's own entry rather than whichever task seeded the row.
        let tracker = AgentTracker::new();
        let mut store = SessionStore::new(None);
        store.ensure_default("/r/towles-tool", 1);
        store.ensure_default("/r/towles-tool/.claude/worktrees/aardvark-task", 1);
        let mut git = HashMap::new();
        git.insert(
            "/r/towles-tool".to_string(),
            GitInfo {
                common_dir: "/r/towles-tool/.git".into(),
                is_worktree: false,
                ..Default::default()
            },
        );
        git.insert(
            "/r/towles-tool/.claude/worktrees/aardvark-task".to_string(),
            GitInfo {
                common_dir: "/r/towles-tool/.git".into(),
                is_worktree: true,
                ..Default::default()
            },
        );
        // Name-sorted entries (as the engine feeds them) put the task well
        // ahead of the primary checkout.
        let entries = vec![
            RepoEntry {
                name: "aardvark-task".into(),
                dir: "/r/towles-tool/.claude/worktrees/aardvark-task".into(),
            },
            RepoEntry { name: "towles-tool".into(), dir: "/r/towles-tool".into() },
        ];
        let payload = assemble(&entries, &git, &tracker, &store, &no_attr);
        assert_eq!(payload.repos.len(), 1);
        assert_eq!(payload.repos[0].key, "path:/r/towles-tool", "key anchors to the primary");
        assert_eq!(payload.repos[0].name, "towles-tool", "name anchors to the primary");
    }

    #[test]
    fn explicitly_tracked_worktree_siblings_still_nest_by_common_dir() {
        // /r/task-0 and /r/task-1 are both explicitly tracked (repos.json),
        // but they're git-worktree siblings of each other — nesting is a
        // structural git fact (`common_dir`), not a function of how each
        // checkout got onto the rail, so they must still merge into one row.
        let tracker = AgentTracker::new();
        let mut store = SessionStore::new(None);
        store.ensure_default("/r/task-0", 1);
        store.ensure_default("/r/task-1", 1);
        let mut git = HashMap::new();
        git.insert(
            "/r/task-0".to_string(),
            GitInfo {
                common_dir: "/r/shared/.git".into(),
                is_worktree: false,
                ..Default::default()
            },
        );
        git.insert(
            "/r/task-1".to_string(),
            GitInfo {
                common_dir: "/r/shared/.git".into(),
                is_worktree: true,
                ..Default::default()
            },
        );
        let entries = vec![
            RepoEntry { name: "task-0".into(), dir: "/r/task-0".into() },
            RepoEntry { name: "task-1".into(), dir: "/r/task-1".into() },
        ];
        let payload = assemble(&entries, &git, &tracker, &store, &no_attr);
        assert_eq!(payload.repos.len(), 1);
        assert_eq!(payload.repos[0].folders.len(), 2);
    }

    #[test]
    fn same_origin_but_different_repo_never_merges() {
        // Two unrelated clones of the same remote must not merge into one
        // row — only a real `git worktree` relationship (matching
        // `common_dir`) does. Regression test for the bug `common_dir`
        // grouping replaced origin-URL grouping to fix.
        let tracker = AgentTracker::new();
        let mut store = SessionStore::new(None);
        store.ensure_default("/r/clone-a", 1);
        store.ensure_default("/r/clone-b", 1);
        let mut git = HashMap::new();
        git.insert(
            "/r/clone-a".to_string(),
            GitInfo {
                common_dir: "/r/clone-a/.git".into(),
                origin_url: Some("git@github.com:me/proj.git".into()),
                ..Default::default()
            },
        );
        git.insert(
            "/r/clone-b".to_string(),
            GitInfo {
                common_dir: "/r/clone-b/.git".into(),
                origin_url: Some("git@github.com:me/proj.git".into()),
                ..Default::default()
            },
        );
        let entries = vec![
            RepoEntry { name: "clone-a".into(), dir: "/r/clone-a".into() },
            RepoEntry { name: "clone-b".into(), dir: "/r/clone-b".into() },
        ];
        let payload = assemble(&entries, &git, &tracker, &store, &no_attr);
        assert_eq!(payload.repos.len(), 2);
    }

    /// A `SessionData` with just the fields `session_needs` reads set; the rest
    /// are inert defaults.
    fn session(live: bool, status: Option<AgentStatus>, unseen: bool) -> SessionData {
        SessionData {
            id: "s".into(),
            name: "shell 1".into(),
            live,
            unseen,
            agent_state: status.map(|status| AgentEvent {
                agent: "claude-code".into(),
                session: "s".into(),
                status,
                ts: 1,
                thread_id: None,
                thread_name: None,
                unseen: Some(unseen),
                details: None,
            }),
            ..Default::default()
        }
    }

    #[test]
    fn session_needs_requires_a_shell_and_attention_state() {
        // Live + waiting/error counts.
        assert!(session_needs(&session(true, Some(AgentStatus::Waiting), false)));
        assert!(session_needs(&session(true, Some(AgentStatus::Error), false)));
        // Not live: a stale status must NOT count.
        assert!(!session_needs(&session(false, Some(AgentStatus::Waiting), false)));
        assert!(!session_needs(&session(false, Some(AgentStatus::Error), false)));
        // Live, ended turn, unseen → your turn, counts. Seen → doesn't.
        assert!(session_needs(&session(true, Some(AgentStatus::Complete), true)));
        assert!(!session_needs(&session(true, Some(AgentStatus::Complete), false)));
        assert!(session_needs(&session(true, Some(AgentStatus::Interrupted), true)));
        // Live but busy/idle/no-agent never needs you.
        assert!(!session_needs(&session(true, Some(AgentStatus::Busy), false)));
        assert!(!session_needs(&session(true, Some(AgentStatus::Idle), false)));
        assert!(!session_needs(&session(true, None, false)));
    }

    #[test]
    fn assemble_time_needs_is_zero_before_stamping() {
        // The engine assembles live=false, so even a waiting agent yields
        // needs=0 until the app stamps shell liveness and recomputes.
        let mut tracker = AgentTracker::new();
        tracker.apply_event(ev("alpha", AgentStatus::Waiting, "ta"), false);
        let mut store = SessionStore::new(None);
        store.ensure_default("/r/alpha", 1);
        let git = HashMap::new();
        let entries = vec![RepoEntry { name: "alpha".into(), dir: "/r/alpha".into() }];
        let payload = assemble(&entries, &git, &tracker, &store, &no_attr);
        assert_eq!(payload.repos[0].folders[0].needs, 0);
        assert_eq!(payload.repos[0].needs, 0);
    }

    #[test]
    fn recompute_needs_bubbles_folder_to_repo() {
        let mut tracker = AgentTracker::new();
        tracker.apply_event(ev("alpha", AgentStatus::Waiting, "ta"), false);
        let mut store = SessionStore::new(None);
        store.ensure_default("/r/alpha", 1);
        let git = HashMap::new();
        let entries = vec![RepoEntry { name: "alpha".into(), dir: "/r/alpha".into() }];
        let mut payload = assemble(&entries, &git, &tracker, &store, &no_attr);
        // Simulate the app stamping the session's shell as live, then recompute.
        let mut since = NeedsSince::new();
        payload.repos[0].folders[0].sessions[0].live = true;
        recompute_needs(&mut payload, &mut since, 1_000);
        assert_eq!(payload.repos[0].folders[0].needs, 1);
        assert_eq!(payload.repos[0].needs, 1);
        assert_eq!(payload.repos[0].folders[0].sessions[0].needs_since_ms, Some(1_000));

        // Stamp it back to no shell: needs falls to 0 at both levels.
        payload.repos[0].folders[0].sessions[0].live = false;
        recompute_needs(&mut payload, &mut since, 2_000);
        assert_eq!(payload.repos[0].folders[0].needs, 0);
        assert_eq!(payload.repos[0].needs, 0);
        assert_eq!(payload.repos[0].folders[0].sessions[0].needs_since_ms, None);
    }

    #[test]
    fn needs_since_stamps_on_entry_holds_and_restamps_on_reentry() {
        let mut tracker = AgentTracker::new();
        tracker.apply_event(ev("alpha", AgentStatus::Waiting, "ta"), false);
        let mut store = SessionStore::new(None);
        store.ensure_default("/r/alpha", 1);
        let git = HashMap::new();
        let entries = vec![RepoEntry { name: "alpha".into(), dir: "/r/alpha".into() }];
        let build = |tracker: &AgentTracker| assemble(&entries, &git, tracker, &store, &no_attr);
        let mut since = NeedsSince::new();

        // Enters needs-you at t=100: stamped 100.
        let mut p = build(&tracker);
        p.repos[0].folders[0].sessions[0].live = true;
        recompute_needs(&mut p, &mut since, 100);
        assert_eq!(p.repos[0].folders[0].sessions[0].needs_since_ms, Some(100));

        // Still waiting at t=500: the original stamp is preserved (age grows).
        let mut p = build(&tracker);
        p.repos[0].folders[0].sessions[0].live = true;
        recompute_needs(&mut p, &mut since, 500);
        assert_eq!(p.repos[0].folders[0].sessions[0].needs_since_ms, Some(100));

        // Back to work at t=800: stamp cleared.
        let mut busy = AgentTracker::new();
        busy.apply_event(ev("alpha", AgentStatus::Busy, "ta"), false);
        let mut p = build(&busy);
        p.repos[0].folders[0].sessions[0].live = true;
        recompute_needs(&mut p, &mut since, 800);
        assert_eq!(p.repos[0].folders[0].sessions[0].needs_since_ms, None);

        // Blocked again at t=1200: a fresh stamp, not the stale 100.
        let mut p = build(&tracker);
        p.repos[0].folders[0].sessions[0].live = true;
        recompute_needs(&mut p, &mut since, 1_200);
        assert_eq!(p.repos[0].folders[0].sessions[0].needs_since_ms, Some(1_200));
    }

    #[test]
    fn attribute_routes_agents_to_matching_session() {
        let mut tracker = AgentTracker::new();
        tracker.apply_event(ev("alpha", AgentStatus::Busy, "ta"), false);
        let mut store = SessionStore::new(None);
        let s1 = store.add("/r/alpha", Some("one"), 1);
        let s2 = store.add("/r/alpha", Some("two"), 2);
        let git = HashMap::new();
        let entries = vec![RepoEntry { name: "alpha".into(), dir: "/r/alpha".into() }];
        // Attribute the (only) busy agent to session two.
        let target = s2.id.clone();
        let attribute = move |_: &AgentEvent| Some(target.clone());
        let payload = assemble(&entries, &git, &tracker, &store, &attribute);
        let folder = &payload.repos[0].folders[0];
        let one = folder.sessions.iter().find(|s| s.id == s1.id).unwrap();
        let two = folder.sessions.iter().find(|s| s.id == s2.id).unwrap();
        assert!(one.agent_state.is_none());
        assert_eq!(two.agent_state.as_ref().unwrap().status, AgentStatus::Busy);
    }

    #[test]
    fn an_unattributed_agent_returns_to_the_pane_that_ran_it() {
        // Pane two ran thread `ta` and recorded it. The live link is gone (the
        // pid is unreadable the moment the process exits, while the 60s CLI
        // snapshot still lists it) — the agent must stay on pane two rather
        // than jump to pane one with its unseen/needs-you state.
        let mut tracker = AgentTracker::new();
        tracker.apply_event(ev("alpha", AgentStatus::Complete, "ta"), false);
        let mut store = SessionStore::new(None);
        let s1 = store.add("/r/alpha", Some("one"), 1);
        let s2 = store.add("/r/alpha", Some("two"), 2);
        store.note_agent(&s2.id, "ta");
        let git = HashMap::new();
        let entries = vec![RepoEntry { name: "alpha".into(), dir: "/r/alpha".into() }];

        let payload = assemble(&entries, &git, &tracker, &store, &|_| None);
        let folder = &payload.repos[0].folders[0];
        let one = folder.sessions.iter().find(|s| s.id == s1.id).unwrap();
        let two = folder.sessions.iter().find(|s| s.id == s2.id).unwrap();
        assert!(one.agent_state.is_none());
        assert_eq!(two.agent_state.as_ref().unwrap().status, AgentStatus::Complete);
    }

    #[test]
    fn an_unremembered_agent_still_falls_back_to_the_default_pane() {
        // Nothing ever attributed this thread (no `/proc` on macOS), so the
        // default is all we have — better than hiding a running agent.
        let mut tracker = AgentTracker::new();
        tracker.apply_event(ev("alpha", AgentStatus::Busy, "tz"), false);
        let mut store = SessionStore::new(None);
        let s1 = store.add("/r/alpha", Some("one"), 1);
        let s2 = store.add("/r/alpha", Some("two"), 2);
        store.note_agent(&s2.id, "ta"); // a different thread
        let git = HashMap::new();
        let entries = vec![RepoEntry { name: "alpha".into(), dir: "/r/alpha".into() }];

        let payload = assemble(&entries, &git, &tracker, &store, &|_| None);
        let folder = &payload.repos[0].folders[0];
        let one = folder.sessions.iter().find(|s| s.id == s1.id).unwrap();
        assert_eq!(one.agent_state.as_ref().unwrap().status, AgentStatus::Busy);
    }

    #[test]
    fn a_sibling_folders_agent_does_not_default_onto_this_folders_pane() {
        // Two checkouts share the basename `alpha`, so both read the same
        // tracker bucket. The thread belongs to the other checkout's pane.
        let mut tracker = AgentTracker::new();
        tracker.apply_event(ev("alpha", AgentStatus::Busy, "ta"), false);
        let mut store = SessionStore::new(None);
        let mine = store.add("/r/one/alpha", Some("one"), 1);
        let theirs = store.add("/r/two/alpha", Some("one"), 2);
        store.note_agent(&theirs.id, "ta");
        let git = HashMap::new();
        let entries = vec![RepoEntry { name: "alpha".into(), dir: "/r/one/alpha".into() }];

        let payload = assemble(&entries, &git, &tracker, &store, &|_| None);
        let folder = &payload.repos[0].folders[0];
        let pane = folder.sessions.iter().find(|s| s.id == mine.id).unwrap();
        assert!(pane.agent_state.is_none());
    }

    #[test]
    fn foreign_attribution_is_dropped_not_defaulted() {
        // An agent positively attributed to a session id that matches none of
        // this folder's records runs in some other app instance's session
        // (sessions.json is shared) — it must not land on the default session,
        // even when the folder has only one (the old single-session mirror
        // leaked folder-level state here).
        let mut tracker = AgentTracker::new();
        tracker.apply_event(ev("alpha", AgentStatus::Busy, "ta"), false);
        let mut store = SessionStore::new(None);
        store.add("/r/alpha", Some("one"), 1);
        let git = HashMap::new();
        let entries = vec![RepoEntry { name: "alpha".into(), dir: "/r/alpha".into() }];
        let attribute = |_: &AgentEvent| Some("someone-elses-session".to_string());
        let payload = assemble(&entries, &git, &tracker, &store, &attribute);
        let folder = &payload.repos[0].folders[0];
        assert!(folder.sessions[0].agent_state.is_none());
        assert!(folder.sessions[0].agents.is_empty());
    }

    #[test]
    fn session_agents_supplement_idle_sessions_only() {
        // No tracker agent: the /proc-detected session agent fills the row.
        let tracker = AgentTracker::new();
        let mut store = SessionStore::new(None);
        let rec = store.add("/r/alpha", Some("shell 1"), 1);
        let git = HashMap::new();
        let entries = vec![RepoEntry { name: "alpha".into(), dir: "/r/alpha".into() }];

        let mut supplemental = HashMap::new();
        supplemental.insert(
            rec.id.clone(),
            AgentEvent {
                agent: "claude-code".into(),
                session: String::new(),
                status: AgentStatus::Busy,
                ts: 5,
                thread_id: None,
                thread_name: Some("uninstall gitbutler".into()),
                unseen: None,
                details: None,
            },
        );
        let payload = assemble_with(&entries, &git, &tracker, &store, &no_attr, &supplemental);
        let s = &payload.repos[0].folders[0].sessions[0];
        assert_eq!(s.agent_state.as_ref().unwrap().status, AgentStatus::Busy);
        assert_eq!(
            s.agent_state.as_ref().unwrap().thread_name.as_deref(),
            Some("uninstall gitbutler")
        );

        // With a real tracker agent, the CLI/tracker state wins over the supplement.
        let mut tracker2 = AgentTracker::new();
        tracker2.apply_event(ev("alpha", AgentStatus::Waiting, "ta"), false);
        let payload2 = assemble_with(&entries, &git, &tracker2, &store, &no_attr, &supplemental);
        let s2 = &payload2.repos[0].folders[0].sessions[0];
        assert_eq!(s2.agent_state.as_ref().unwrap().status, AgentStatus::Waiting);
    }

    #[test]
    fn repo_name_from_origin_variants() {
        assert_eq!(repo_name_from_origin("git@github.com:me/proj.git").as_deref(), Some("proj"));
        assert_eq!(
            repo_name_from_origin("https://github.com/me/proj.git").as_deref(),
            Some("proj")
        );
        assert_eq!(repo_name_from_origin("https://github.com/me/proj/").as_deref(), Some("proj"));
    }
}
