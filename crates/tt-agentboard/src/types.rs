//! Shared serde types — camelCase on the wire, tolerant on input.
//!
//! The Folder Rail snapshot is three levels: a [`RepoData`] groups one repo's
//! `git worktree` siblings (by `GitInfo::common_dir`, never a shared remote),
//! each [`FolderData`] is a checkout, each [`SessionData`] a PTY. "Agent" is a
//! badge on a session, not an object of its own.
//!
//! Two rules. **Fields only the app can see are blank here by construction** —
//! `stamp_pty_state` fills them on the way out, and a new one belongs there too.
//! **A row is on screen because something wrote it down** — see [`RowRecord`].

use serde::{Deserialize, Serialize};

pub const JOURNAL_IDLE_TIMEOUT_MS: i64 = 120_000;

/// Follows `claude agents`: `busy` = working, `waiting` = blocked on the user,
/// `idle` = alive at the prompt. The terminals have no CLI equivalent, and nor
/// does `background`: at the prompt, but its background agents are still out.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    #[default]
    Idle,
    Busy,
    Complete,
    Error,
    Waiting,
    Interrupted,
    Background,
}

/// The client's one needs-you answer, and notification wording — never an affordance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NeedsYouReason {
    WaitingForInput,
    Errored,
    Finished,
}

impl AgentStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, AgentStatus::Complete | AgentStatus::Error | AgentStatus::Interrupted)
    }

    pub fn is_working(self) -> bool {
        matches!(self, AgentStatus::Busy | AgentStatus::Background)
    }

    /// Headline precedence when one pane holds several threads.
    pub fn rank(self) -> u8 {
        match self {
            AgentStatus::Waiting => 6,
            AgentStatus::Error => 5,
            AgentStatus::Busy => 4,
            AgentStatus::Background => 3,
            AgentStatus::Interrupted => 2,
            AgentStatus::Complete => 1,
            AgentStatus::Idle => 0,
        }
    }
}

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
    /// Context this thread carries — spend the parent's readout never shows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_used: Option<i64>,
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
    /// Every sub-agent spawned, finished included: `subagents` lists only the
    /// active few, and shedding them on retirement would under-report spend.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_context_used: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_count: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#loop: Option<LoopInfo>,
    /// Background agents launched and not yet reported back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_agents: Option<i64>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unseen: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<AgentEventDetails>,
}

/// One PTY shell; `agent_state` fills in when an agent is attributed to it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionData {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    #[serde(default)]
    pub live: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell_kind: Option<String>,
    /// True when the latest agent event is an unseen terminal state.
    pub unseen: bool,
    /// First entry into needs-you, held across recomputes for oldest-first order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub needs_since_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub needs_reason: Option<NeedsYouReason>,
    #[serde(default)]
    pub working: bool,
    pub agent_state: Option<AgentEvent>,
    pub agents: Vec<AgentEvent>,
    /// Echo of the launch prompt, read-only — never user-authored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
    /// `.env` ports that changed since spawn ([`crate::env_drift`]).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub port_drift: Vec<crate::env_drift::PortDrift>,
}

/// Why a rail row exists — a record, never a fact about the filesystem. Disjoint,
/// so detection can fill a row in but never retire a task's.
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

/// Not the whole [`tt_store::TaskItem`] — this rides the ~2s emit path.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowTask {
    pub id: i64,
    pub status: String,
    /// Known before the worktree exists — exactly when `git` can't answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

/// The worktree operation running **right now**. "Detached" isn't stored: it is
/// a task plus a missing directory plus nothing working on it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum RowPhase {
    Creating { label: String },
    Removing { label: String },
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderData {
    pub name: String,
    pub dir: String,
    /// Groups a row whose directory doesn't exist yet, which `common_dir` can't.
    #[serde(default)]
    pub repo_root: String,
    pub record: RowRecord,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<RowPhase>,
    /// A tracked checkout moved or deleted: a ghost row until re-tracked.
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
    /// `uncommitted_files` is a floor: an untracked directory was too big to list.
    #[serde(default)]
    pub uncommitted_capped: bool,
    /// HEAD-vs-index totals — the only numbers that move on a bare `git add`,
    /// so the diff pane's refresh key must include them.
    #[serde(default)]
    pub staged_files: i64,
    #[serde(default)]
    pub staged_added: i64,
    #[serde(default)]
    pub staged_removed: i64,
    pub commits_ahead: i64,
    pub commits_behind: i64,
    /// Unlike `committed_files`, the fact a safe-to-delete check needs.
    pub dirty: bool,
    /// 0 once every commit is patch-equivalent to the base, even across a
    /// rebase/squash merge, which `commits_ahead` can never see past.
    pub commits_unlanded: i64,
    /// Git evidence, not a GitHub PR, which never sees a locally-merged branch.
    pub landed: Option<String>,
    pub sessions: Vec<SessionData>,
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
    #[serde(default)]
    pub computed_at_ms: i64,
    /// Newest of `HEAD`'s commit time, `worktree_touched_ms`, and the last pane
    /// opened here; the frontend maxes it against agent events only it sees.
    #[serde(default)]
    pub worked_at_ms: i64,
    /// Changed paths' newest mtime: the one field that moves when an edit leaves
    /// the counts unchanged, so the diff pane's refetch key needs it.
    #[serde(default)]
    pub worktree_touched_ms: i64,
    #[serde(default)]
    pub has_port_drift: bool,
    #[serde(default)]
    pub has_launch_config: bool,
    /// Forced-quiet override (folder_meta.json), regardless of actual activity.
    #[serde(default)]
    pub quiet: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoData {
    /// `"path:<dir>"` of the folder that leads the row.
    pub key: String,
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
            AgentStatus::Waiting,
            AgentStatus::Background,
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
