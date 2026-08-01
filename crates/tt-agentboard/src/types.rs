//! Shared serde types — camelCase on the wire, tolerant on input.
//!
//! The Folder Rail snapshot is three levels: a [`RepoData`] groups one repo's
//! `git worktree` siblings (by `GitInfo::common_dir`, never a shared remote),
//! each [`FolderData`] is a checkout, each [`SessionData`] a PTY. "Agent" is a
//! badge on a session, not an object of its own.
//!
//! Two rules. **Some fields are blank here by construction** — this crate can't
//! see PTYs, so `live`, `shell_kind`, `port_drift`, `needs`, `needs_since_ms`,
//! `has_port_drift` and `phase` are stamped by the app on the way out
//! (`stamp_pty_state`); a new field of that kind belongs on that same seam.
//! **A row is on screen because something wrote it down** — see [`RowRecord`].

use serde::{Deserialize, Serialize};

pub const JOURNAL_IDLE_TIMEOUT_MS: i64 = 120_000;

/// Follows `claude agents`: `busy` = working, `waiting` = blocked on the user,
/// `idle` = alive at the prompt. The terminals have no CLI equivalent.
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

/// Notification wording for [`crate::bridge::session_needs`], never an affordance.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NeedsYouReason {
    WaitingForInput,
    Errored,
    Finished,
}

impl AgentStatus {
    /// Finished a turn, awaiting acknowledgement.
    pub fn is_terminal(self) -> bool {
        matches!(self, AgentStatus::Complete | AgentStatus::Error | AgentStatus::Interrupted)
    }
}

/// State of a self-paced `/loop`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopInfo {
    pub next_wake_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

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
    /// Set by the tracker: the user hasn't seen this terminal state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unseen: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<AgentEventDetails>,
}

/// One PTY shell. `agent_state`/`agents` fill in when an agent is detected
/// running here (attributed via `TT_SESSION_ID`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionData {
    /// The PTY `term_id`. Persisted in sessions.json.
    pub id: String,
    pub name: String,
    pub created_at: i64,
    #[serde(default)]
    pub live: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell_kind: Option<String>,
    /// True when the latest agent event is an unseen terminal state.
    pub unseen: bool,
    /// When it *first* needed you, held across recomputes so the attention feed
    /// can order oldest-first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub needs_since_ms: Option<i64>,
    pub agent_state: Option<AgentEvent>,
    pub agents: Vec<AgentEvent>,
    /// Echo of the launch prompt, read-only. Nothing user-authored — there is no
    /// editable per-session note.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
    /// Ports this shell saw in `.env` at spawn that it now claims differently
    /// ([`crate::env_drift`]) — e.g. a sibling task's re-render rotated one.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub port_drift: Vec<crate::env_drift::PortDrift>,
}

/// Why a rail row exists — a record, never a fact about the filesystem.
/// Disjoint by construction (a task worktree is never a `repos.json` entry), so
/// exactly one record answers for any row, and detection can fill a row in but
/// never retire a task's.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(tag = "origin", rename_all = "camelCase")]
pub enum RowRecord {
    /// The one row kind with no task: tracking a repo is not a unit of work.
    #[default]
    Checkout,
    Task {
        task: RowTask,
    },
    /// A worktree no task claimed; adopting it is a kind change on this row.
    Detected {
        task: RowTask,
    },
}

impl RowRecord {
    pub fn task(&self) -> Option<&RowTask> {
        match self {
            RowRecord::Checkout => None,
            RowRecord::Task { task } | RowRecord::Detected { task } => Some(task),
        }
    }
}

/// Enough of the board row to badge and act on, not the whole
/// [`tt_store::TaskItem`] — this rides the ~2s emit path.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowTask {
    pub id: i64,
    /// Kanban column (`backlog`/`doing`/`done`).
    pub status: String,
    /// Known before the worktree exists — exactly when `git` can't answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

/// The worktree operation running **right now**, if any — deliberately only the
/// in-flight pair. "Detached" is not stored because it isn't an independent
/// fact: it is a task, plus a missing directory, plus nothing working on it, all
/// three already on the wire. A variant would make `Detached` with
/// `dir_missing: false` representable and meaningless.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum RowPhase {
    Creating { label: String },
    Removing { label: String },
}

/// One checkout on disk (a clone, a worktree, or a task), holding 1..N sessions.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderData {
    pub name: String,
    pub dir: String,
    /// How the rail groups a row whose directory doesn't exist yet, since
    /// `common_dir` needs a directory that is actually there.
    #[serde(default)]
    pub repo_root: String,
    pub record: RowRecord,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<RowPhase>,
    /// A tracked checkout moved or deleted. Such rows are ghosts: still carrying
    /// session records, unworkable until re-tracked.
    pub dir_missing: bool,
    pub branch: String,
    pub is_worktree: bool,
    /// Committed vs `compared_base`, then uncommitted vs `HEAD`. Two quantities,
    /// never summed — [`crate::git_info::GitInfo`] says why.
    pub committed_files: i64,
    pub committed_added: i64,
    pub committed_removed: i64,
    pub uncommitted_files: i64,
    pub uncommitted_added: i64,
    pub uncommitted_removed: i64,
    /// `uncommitted_files` is a floor — an untracked directory was too large to
    /// list. See [`crate::git_info::GitInfo::uncommitted_capped`].
    #[serde(default)]
    pub uncommitted_capped: bool,
    pub commits_ahead: i64,
    pub commits_behind: i64,
    /// Unlike `committed_files`, which stays nonzero for any real branch even
    /// once merged, this is the fact a safe-to-delete check needs.
    pub dirty: bool,
    /// 0 once every commit is patch-equivalent to something already on the base,
    /// even across a rebase/squash merge — which `commits_ahead`, being
    /// SHA-reachability, can never see past.
    pub commits_unlanded: i64,
    /// How the work reached `compared_base` (`"merged"`, `"rebase-merged"`,
    /// `"squash-merged"`, `"upstream gone"`), else `None`. Git evidence, not a
    /// GitHub PR — which never sees a locally-merged branch, and whose "merged"
    /// says nothing about work committed since.
    pub landed: Option<String>,
    pub sessions: Vec<SessionData>,
    /// Bubbles to the repo. See `bridge::session_needs`.
    pub needs: i64,
    /// Overrides the origin/main-or-master auto-detect (folder_meta.json).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_branch: Option<String>,
    /// A worktree's `.tt-task` `base=` — what the diff pane compares against
    /// absent an override, instead of always claiming "vs main".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_base_branch: Option<String>,
    /// What `committed*`/`commits*` were measured against. Empty until computed.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub compared_base: String,
    /// So the rail can say *when*, rather than leaving "unchanged" and "stuck"
    /// indistinguishable.
    #[serde(default)]
    pub computed_at_ms: i64,
    /// Newest of `HEAD`'s commit time, `worktree_touched_ms`, and the last pane
    /// opened here; the frontend maxes it against agent events only it sees.
    #[serde(default)]
    pub worked_at_ms: i64,
    /// Newest mtime among the changed paths (0 when clean). Separate from
    /// `worked_at_ms`, which opening a pane also moves: this is the only field
    /// here that shifts when an edit lands whose aggregate counts match what was
    /// already there, so the diff pane folds it into its refetch key.
    #[serde(default)]
    pub worktree_touched_ms: i64,
    #[serde(default)]
    pub has_port_drift: bool,
    /// Gates the dev-servers button; the `.claude/launch.json` configs are
    /// fetched on demand, not carried here.
    #[serde(default)]
    pub has_launch_config: bool,
    /// Forced-quiet override (folder_meta.json) — off the rail regardless of
    /// actual activity.
    #[serde(default)]
    pub quiet: bool,
}

/// A checkout and its `git worktree` siblings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoData {
    /// `"path:<dir>"` of whichever folder `assemble_state` saw first (stable
    /// across polls: entries are name-sorted).
    pub key: String,
    /// The dir in `key`, as a field, so readers never parse it back out. Repo
    /// identity (`meta`) is looked up by it.
    pub dir: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_url: Option<String>,
    pub folders: Vec<FolderData>,
    pub needs: i64,
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
