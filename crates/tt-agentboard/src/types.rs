//! Shared serde types.
//!
//! All wire types use camelCase field names, so snapshots serialize identically
//! to what the React client consumes. Input types are tolerant (no
//! `deny_unknown_fields`).

use serde::{Deserialize, Serialize};

pub const JOURNAL_IDLE_TIMEOUT_MS: i64 = 120_000;

/// Lifecycle status of an agent instance. Names follow the Claude Code CLI
/// conventions (`claude agents`): `busy` = working, `waiting` = blocked on
/// the user (questions/permission prompts), `idle` = alive at the prompt.
/// The terminals (`done`/`error`/`interrupted`) have no CLI equivalent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Idle,
    Busy,
    Complete,
    Error,
    Waiting,
    Interrupted,
}

/// Why a session needs you, derived from the agent status that tripped
/// [`crate::bridge::session_needs`]. Drives the notification body wording — a
/// reported text label only, never an interaction affordance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NeedsYouReason {
    /// Agent is blocked on the user (`Waiting`).
    WaitingForInput,
    /// Agent hit an error (`Error`).
    Errored,
    /// Agent's turn ended (`Complete` / `Interrupted`) and hasn't been seen yet.
    Finished,
}

impl AgentStatus {
    /// The "terminal" statuses: the agent finished a turn and is awaiting user
    /// acknowledgement.
    pub fn is_terminal(self) -> bool {
        matches!(self, AgentStatus::Complete | AgentStatus::Error | AgentStatus::Interrupted)
    }
}

/// State of a self-paced `/loop`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopInfo {
    /// Epoch ms when the loop is scheduled to fire next.
    pub next_wake_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// A sub-agent spawned by the parent session.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Optional per-agent live details.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventDetails {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_used: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_max: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_expires_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_ttl_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagents: Option<Vec<SubagentInfo>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#loop: Option<LoopInfo>,
}

/// A single agent-status event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub agent: String,
    pub session: String,
    pub status: AgentStatus,
    pub ts: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_name: Option<String>,
    /// Set by the tracker when serializing — true if the user hasn't seen this terminal state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unseen: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<AgentEventDetails>,
}

// Folder Rail snapshot (Repo → Folder → Session).
//
// The desktop model is three levels: a `RepoData` groups the checkouts of one
// logical repo (by `git remote get-url origin`), each `FolderData` is one
// checkout on disk, and each `SessionData` is one PTY shell inside a folder.
// "Agent" is not a separate object — it's a badge on a session where Claude is
// detected running (`agent_state` populated).

/// One PTY shell inside a folder. The wire type the React client renders as a
/// session row. `agent_state`/`agents` are populated when a Claude (or other)
/// agent is detected running in this PTY (attributed via `TT_SESSION_ID`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionData {
    /// Stable session id — equals the PTY `term_id`. Persisted in sessions.json.
    pub id: String,
    /// Display name: "shell 1" by default, user-renamable.
    pub name: String,
    pub created_at: i64,
    /// True when a PTY is currently running for this session. Assembled as
    /// `false` here (the Tauri-free engine can't see PTYs); the app stamps it
    /// from its terminal registry before emitting.
    #[serde(default)]
    pub live: bool,
    /// The shell's display name ("zsh", "bash", …), resolved once at PTY
    /// spawn time. Assembled as `None` here (same reason as `live`); the app
    /// stamps it from its terminal registry before emitting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell_kind: Option<String>,
    /// True when the latest agent event is an unseen terminal state.
    pub unseen: bool,
    /// Epoch ms when this session FIRST entered "needs you" (see
    /// [`crate::bridge::session_needs`]), or `None` when it doesn't need you
    /// right now. Stamped app-side by [`crate::bridge::recompute_needs`] and
    /// preserved across recomputes while the session keeps needing you, so the
    /// attention feed can order oldest-first. Assembled `None` here (the engine
    /// runs before shell-liveness is stamped, so nothing needs you yet).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub needs_since_ms: Option<i64>,
    /// Latest/priority agent event attributed to this PTY, if any.
    pub agent_state: Option<AgentEvent>,
    /// All agent instances attributed to this PTY (newest-first).
    pub agents: Vec<AgentEvent>,
    /// Echo of the prompt Claude was launched with in this PTY, auto-captured
    /// at launch and shown read-only as the row's hover tooltip
    /// (sessions.json). Nothing user-authored — there is no editable
    /// per-session or per-folder note.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
    /// Ports this session's shell saw in the folder's `.env` at spawn time
    /// that it now claims differently (see [`crate::env_drift`]) — e.g. a
    /// sibling task's re-render rotated a port this pane already bound to.
    /// Empty when nothing has drifted (the common case) or PTY liveness
    /// hasn't been stamped yet. Assembled empty here; the app stamps it from
    /// its terminal registry before emitting, same as `live`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub port_drift: Vec<crate::env_drift::PortDrift>,
}

/// Why a rail row exists — the record behind it, never a fact about the
/// filesystem.
///
/// This is the rail's central rule in one type: **a row is on screen because
/// something wrote it down.** Detection fills a row in (git stats, whether the
/// directory is there) and may mint or retire a [`RowRecord::Detected`] one,
/// but it can never decide that a task's row should stop existing. That is what
/// lets a task appear the moment it is submitted, before `git worktree add` has
/// run, and stay put through a removal that takes a minute.
///
/// The two sets are disjoint by construction: a task worktree is never a
/// `repos.json` entry, so exactly one record answers for any row. Making this a
/// sum type rather than a flag plus an `Option` is deliberate — "tracked *and*
/// has a task" and "a task row *without* a task" are both unrepresentable.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(tag = "origin", rename_all = "camelCase")]
pub enum RowRecord {
    /// A `repos.json` entry — a checkout the user tracks. The main checkout of
    /// a repo, and the one row kind with no task: tracking a repo is not a unit
    /// of work, and `repos.json` is already its durable record.
    #[default]
    Checkout,
    /// A `tasks` row of kind `task` — the user's own work
    /// ([`tt_store::TaskKind::Task`]).
    Task { task: RowTask },
    /// A `tasks` row of kind `detected` — a git worktree found on disk that no
    /// task claimed ([`tt_store::TaskKind::Detected`]). Shown as "no task",
    /// with adopting it a kind change on this same row.
    Detected { task: RowTask },
}

impl RowRecord {
    /// The board row behind this rail row, if it has one.
    pub fn task(&self) -> Option<&RowTask> {
        match self {
            RowRecord::Checkout => None,
            RowRecord::Task { task } | RowRecord::Detected { task } => Some(task),
        }
    }
}

/// The board row behind a rail row: just enough to badge and act on it, not the
/// whole [`tt_store::TaskItem`] (the frontend already holds those from the
/// store snapshot, and this rides the ~2s emit path).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowTask {
    pub id: i64,
    /// Kanban column (`backlog`/`doing`/`done`).
    pub status: String,
    /// The branch the task's worktree is (or will be) on — known before the
    /// worktree exists, which is exactly when `git` can't answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

/// The worktree operation running on this row **right now**, if any.
///
/// Only the process doing the work can know this, so it is stamped by the app
/// on the way out (the same seam as `live`/`shellKind` — see
/// `stamp_pty_state`); the engine has nothing to say about it.
///
/// This deliberately carries *only* the in-flight pair. "Ready" and "detached"
/// are not stored anywhere because they are not independent facts: a row is
/// detached exactly when it has a task, its directory is missing, and nothing
/// is working on it — all three already on the wire (`record`, `dir_missing`,
/// this field). Giving them variants here would put a second, unenforced
/// answer to "is the directory there?" beside `dir_missing`, so `Detached`
/// with `dir_missing: false` would be representable and meaningless. Same
/// reasoning as [`RowRecord`]'s: make the contradictory state unrepresentable.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum RowPhase {
    /// `git fetch` / `worktree add` / `.env` render is running right now.
    Creating { label: String },
    /// The removal sequence is running right now.
    Removing { label: String },
}

/// One checkout of a repo on disk (a clone, a worktree, or a task). Holds 1..N
/// PTY sessions.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderData {
    /// Basename (disambiguated on collision) — e.g. "task-0".
    pub name: String,
    /// Absolute path to the checkout.
    pub dir: String,
    /// The checkout this row belongs to (its own `dir` for a
    /// [`RowRecord::Checkout`]). How the rail groups a row whose directory
    /// doesn't exist yet: grouping is otherwise by `GitInfo::common_dir`, which
    /// git can only report for a directory that is actually there.
    #[serde(default)]
    pub repo_root: String,
    /// Why this row exists — see [`RowRecord`].
    pub record: RowRecord,
    /// The worktree operation running on this row right now, if any — see
    /// [`RowPhase`]. Always `None` from the engine; the app fills it in on the
    /// way out, since only the process running the operation knows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<RowPhase>,
    /// True when `dir` no longer exists on disk — a tracked repo whose checkout
    /// was moved or deleted. Such folders are "ghosts": they still carry stale
    /// session records but can't be worked in until re-tracked or untracked.
    /// Filesystem-derived (carried in on [`crate::git_info::GitInfo`]).
    pub dir_missing: bool,
    pub branch: String,
    pub is_worktree: bool,
    /// The branch's *committed* diff vs `compared_base`, and the working
    /// tree's *uncommitted* diff vs `HEAD`. Two separate quantities, never
    /// summed — see [`crate::git_info::GitInfo`]'s doc for why one blended
    /// number was unreadable.
    pub committed_files: i64,
    pub committed_added: i64,
    pub committed_removed: i64,
    pub uncommitted_files: i64,
    pub uncommitted_added: i64,
    pub uncommitted_removed: i64,
    /// Commits on this branch that origin/main doesn't have.
    pub commits_ahead: i64,
    /// Commits on origin/main that this branch doesn't have.
    pub commits_behind: i64,
    /// True when the working tree has uncommitted changes (staged, unstaged,
    /// or untracked) — `GitInfo::dirty`, i.e. `uncommitted_files > 0`. Unlike
    /// `committed_files`, which stays nonzero for any real branch even once
    /// merged, this is the real "no uncommitted changes" fact a "safe to
    /// delete" check needs.
    pub dirty: bool,
    /// Of `commits_ahead`, how many haven't landed on `compared_base` yet —
    /// `GitInfo::commits_unlanded`. 0 once every commit on this branch is
    /// patch-equivalent to something already there, even across a
    /// rebase/squash merge that gave them new SHAs (which `commits_ahead`,
    /// being SHA-reachability, can never see past).
    pub commits_unlanded: i64,
    /// How this branch's work reached `compared_base` (`"merged"`,
    /// `"rebase-merged"`, `"squash-merged"`, `"upstream gone"`), or `None`
    /// when it hasn't fully landed — `GitInfo::landed`. Lets the rail state
    /// that a branch is finished on git evidence, rather than only inferring
    /// it from a GitHub PR (which never sees a locally-merged branch, and
    /// whose "merged" says nothing about work committed since).
    pub landed: Option<String>,
    pub sessions: Vec<SessionData>,
    /// Number of sessions that "need you" (see `bridge::session_needs`): a live
    /// shell whose agent is waiting/errored, or whose turn just ended and is
    /// still unseen. Bubbles up to the repo. Computed app-side after
    /// shell-liveness stamping (`bridge::recompute_needs`).
    pub needs: i64,
    /// Branch this folder's diff pane compares against (`DiffMode::Main`),
    /// overriding the origin/main-or-master auto-detect (folder_meta.json).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_branch: Option<String>,
    /// For a worktree only: the ref it was actually created from, read
    /// from its `.tt-task` marker (`base=`). Lets the diff pane show what it
    /// auto-compares against when `base_branch` has no manual override,
    /// instead of always claiming "vs main". `None` for a non-task checkout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_base_branch: Option<String>,
    /// The ref `committed*`/`commitsAhead`/`commitsBehind` were actually
    /// measured against (`GitInfo::compared_base`) — e.g. `"origin/main"` or
    /// `"origin/docs/readme-task-clean"`. Empty before the folder's git stats
    /// have been computed at least once.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub compared_base: String,
    /// When these git stats were last verified (`GitInfo::computed_at_ms`), so
    /// the rail can say *when* rather than leaving "unchanged" and "stuck"
    /// indistinguishable. 0 before the first compute.
    #[serde(default)]
    pub computed_at_ms: i64,
    /// When this checkout was last worked in, epoch ms (0 for never) — the
    /// newest of `HEAD`'s commit time, the newest mtime among the working
    /// tree's changed paths ([`crate::git_info::GitInfo`]) and the last pane
    /// opened or closed here ([`crate::folder_meta::FolderMeta`]). The
    /// frontend's worked-recently rail filter maxes this against agent-event
    /// timestamps, which only it can see.
    #[serde(default)]
    pub worked_at_ms: i64,
    /// True when any live session in this folder has `port_drift` — bubbles
    /// the per-session detail up to a rail badge. Computed app-side after PTY
    /// liveness stamping (mirrors `needs`).
    #[serde(default)]
    pub has_port_drift: bool,
    /// True when this checkout has a Claude Desktop `.claude/launch.json`
    /// (`GitInfo::has_launch_config`) — gates the rail's dev-servers button
    /// and dims/branches the pane header's (always-mounted there for
    /// discoverability); the configs themselves are fetched on demand, not
    /// carried on the snapshot.
    #[serde(default)]
    pub has_launch_config: bool,
    /// Forced-quiet override (folder_meta.json) — the frontend keeps this
    /// folder off the rail under either narrowing filter regardless of its
    /// actual activity signals below.
    #[serde(default)]
    pub quiet: bool,
}

/// A logical repo: a checkout and every other folder on the rail that's a
/// `git worktree` sibling of it (same `GitInfo::common_dir`), whether that
/// sibling is explicitly tracked in `repos.json` or only discovered via `git
/// worktree list` — see `crate::bridge::assemble_state`. Two folders never
/// merge into one `RepoData` merely for sharing an origin remote; only an
/// actual worktree relationship does.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoData {
    /// `"path:<dir>"` of whichever folder in this group `assemble_state`
    /// happened to see first (stable across polls: entries are name-sorted).
    pub key: String,
    /// Absolute dir of the checkout this row is anchored to — the same dir
    /// embedded in `key`, but as a field, so readers never parse it back out
    /// of the key string. Repo identity (`meta`) is looked up by it.
    pub dir: String,
    /// Display name: the repo segment of `owner/repo`, else the folder basename.
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_url: Option<String>,
    pub folders: Vec<FolderData>,
    /// Σ of `folder.needs` across this repo's checkouts.
    pub needs: i64,
    /// The user-chosen icon/color for this repo, absent until they pick one.
    /// See [`crate::repo_meta`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<crate::repo_meta::RepoMeta>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn agent_status_serializes_lowercase() {
        assert_eq!(serde_json::to_value(AgentStatus::Busy).unwrap(), json!("busy"));
        assert_eq!(
            serde_json::from_value::<AgentStatus>(json!("interrupted")).unwrap(),
            AgentStatus::Interrupted
        );
    }

    #[test]
    fn terminal_statuses_are_the_end_of_turn_ones() {
        for s in [
            AgentStatus::Complete,
            AgentStatus::Error,
            AgentStatus::Interrupted,
        ] {
            assert!(s.is_terminal());
        }
        for s in [
            AgentStatus::Idle,
            AgentStatus::Busy,
            AgentStatus::Idle,
            AgentStatus::Waiting,
        ] {
            assert!(!s.is_terminal());
        }
    }

    #[test]
    fn agent_event_omits_absent_optionals_and_camelcases() {
        let ev = AgentEvent {
            agent: "claude".into(),
            session: "proj".into(),
            status: AgentStatus::Busy,
            ts: 1000,
            thread_id: None,
            thread_name: None,
            unseen: None,
            details: None,
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v, json!({"agent":"claude","session":"proj","status":"busy","ts":1000}));
    }

    #[test]
    fn agent_details_loop_key_renamed() {
        let details = AgentEventDetails {
            r#loop: Some(LoopInfo { next_wake_at: 5, reason: Some("poll".into()) }),
            last_tool: Some("Bash".into()),
            ..Default::default()
        };
        let v = serde_json::to_value(&details).unwrap();
        assert_eq!(v["loop"]["nextWakeAt"], json!(5));
        assert_eq!(v["lastTool"], json!("Bash"));
        assert!(v.get("model").is_none());
    }
}
