//! Data types and pure helpers for the store: the output/input structs that
//! serialize to the frontend's `camelCase` contract, the task-status/outcome
//! vocabulary, and the small pure decisions (event-time parsing, gh
//! close/reopen targeting) that need no database handle.

use chrono::{DateTime, FixedOffset};
use serde::{Deserialize, Serialize};

/// UTC, fixed width, matching the generated columns' `strftime` shape exactly: they compare
/// under SQLite's `BINARY` collation, so a mismatch silently returns wrong rows (tested).
pub(crate) const UTC_KEY_FORMAT: &str = "%Y-%m-%dT%H:%M:%S%.3fZ";

pub(crate) fn utc_key(ms: i64) -> String {
    match chrono::DateTime::from_timestamp_millis(ms) {
        Some(dt) => dt.format(UTC_KEY_FORMAT).to_string(),
        // `i64::MIN`/`i64::MAX` mean "no bound": clamp outside every real value, since
        // `unwrap_or` to the epoch would turn an unbounded window into an empty one.
        None if ms < 0 => "0000-01-01T00:00:00.000Z".to_string(),
        None => "9999-12-31T23:59:59.999Z".to_string(),
    }
}

/// `None` for anything not RFC 3339 — `query_events` skips the row rather than propagating.
pub(crate) fn parse_rfc3339(text: &str) -> Option<DateTime<FixedOffset>> {
    DateTime::parse_from_rfc3339(text).ok()
}

pub(crate) fn log_unparseable_event(external_id: &str, value: &str) {
    tracing::warn!(%external_id, %value, "tt-store: unparseable event time; row skipped");
}

pub(crate) const MCP_CALL_RETAIN: i64 = 500;

/// Public so writers can refuse a backfill the sweep would reclaim; days of slack for clock skew.
pub const EVENT_RETAIN_MS: i64 = 7 * 24 * 60 * 60 * 1000;

pub(crate) const MCP_CALL_SNAPSHOT_LIMIT: usize = 100;

pub const TASK_STATUSES: [&str; 3] = ["backlog", "doing", "done"];

/// Orthogonal to `status` (where the card sits): how the work finished, set once at close.
pub const TASK_OUTCOMES: [&str; 2] = ["done", "abandoned"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskOutcome {
    Done,
    Abandoned,
}

impl TaskOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskOutcome::Done => "done",
            TaskOutcome::Abandoned => "abandoned",
        }
    }

    pub fn parse(s: &str) -> Option<TaskOutcome> {
        match s {
            "done" => Some(TaskOutcome::Done),
            "abandoned" => Some(TaskOutcome::Abandoned),
            _ => None,
        }
    }
}

/// A `Task` is the user's work and nothing on the filesystem may retire it; a `Detected` row is
/// a worktree found with no task, retired when its directory goes. Adoption changes kind in place.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskKind {
    Task,
    Detected,
}

impl TaskKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskKind::Task => "task",
            TaskKind::Detected => "detected",
        }
    }

    /// Unknown kinds read as `Task`: a newer build's work is better shown than hidden.
    pub fn parse(s: &str) -> TaskKind {
        match s {
            "detected" => TaskKind::Detected,
            _ => TaskKind::Task,
        }
    }
}

/// Not a [`TaskItem`]: the rail polls this every few seconds and needs the binding, not the links.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RailWorktree {
    pub task_id: i64,
    pub kind: TaskKind,
    pub status: String,
    pub repo_root: String,
    pub dir: String,
    pub branch: Option<String>,
    /// Ordering key — never anything the filesystem reports.
    pub created_at: i64,
}

/// A task with no PR linked yet — its PR may have merged straight past the open sweep.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnlinkedWorktree {
    pub task_id: i64,
    pub repo: String,
    pub branch: String,
}

/// One constant so the manual "Archive done" button and the auto-sweep agree on "old enough".
pub const ARCHIVE_AFTER_MS: i64 = 7 * 24 * 60 * 60 * 1000;

// Column lists, kept in sync with the row-mapping closures in the domain modules.
pub(crate) const EVENT_COLS: &str =
    "id, source, external_id, title, starts_at, ends_at, attendees, location, join_url";
// `kind` is appended so the positional indices `map_task_row` reads stay put.
pub(crate) const TASK_COLS: &str = "id, text, status, position, created_at, completed_at, notes, \
     worktree_repo_root, worktree_repo, worktree_branch, worktree_dir, outcome, archived_at, goal, \
     summary, summary_at, kind";

/// Every read meaning *the user's board* carries this, so a [`TaskKind::Detected`] row never
/// reaches the Board, Cockpit, rollup or MCP `task_list`; `rail_worktrees` reads both kinds.
pub(crate) const TASK_KIND_FILTER: &str = "kind = 'task'";
pub(crate) const ISSUE_COLS: &str = "i.repo, i.number, i.title, i.labels, i.state, i.url, i.updated_ts, COALESCE(d.dismissed_ts, 0)";
pub(crate) const PR_COLS: &str = "p.repo, p.number, p.title, p.branch, p.state, p.checks, p.review_state, \
     p.url, p.updated_ts, COALESCE(d.dismissed_ts, 0)";
pub(crate) const RUN_COLS: &str = "collector, ran_at, ok, message";
// No dismissed_ts: DM handled state lives in the shared ledger, not this db.
pub(crate) const DM_COLS: &str = "channel, from_name, text, ts, from_me, url, fetched_at";
pub(crate) const MCP_CALL_COLS: &str = "id, ts, method, tool, args, ok, error, duration_ms, client";

pub(crate) const TASK_ORDER: &str = "\
ORDER BY CASE status
    WHEN 'backlog' THEN 0 WHEN 'doing' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
  position ASC, created_at ASC";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalEvent {
    pub id: i64,
    pub source: String,
    pub external_id: String,
    pub title: String,
    pub start: DateTime<FixedOffset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<DateTime<FixedOffset>>,
    pub attendees: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub join_url: Option<String>,
}

impl CalEvent {
    /// Lossy on purpose — the offset is presentation, not instant.
    pub fn start_ms(&self) -> i64 {
        self.start.timestamp_millis()
    }

    pub fn end_ms(&self) -> Option<i64> {
        self.end.map(|end| end.timestamp_millis())
    }
}

/// A [`TaskItem`] payload predating the `kind` field is the user's own work.
fn default_task_kind() -> TaskKind {
    TaskKind::Task
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskItem {
    pub id: i64,
    #[serde(default = "default_task_kind")]
    pub kind: TaskKind,
    pub text: String,
    pub status: String,
    pub position: i64,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<String>,
    /// The agent's wrap-up; separate from `notes`, which `task_start` reads back as instructions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<TaskWorktree>,
    #[serde(default)]
    pub issues: Vec<TaskIssueLink>,
    #[serde(default)]
    pub prs: Vec<TaskPrLink>,
    /// A closed task renders in the terminal column regardless of its frozen kanban `status`.
    #[serde(default)]
    pub closed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_outcome: Option<String>,
    #[serde(default)]
    pub has_worktree: bool,
}

impl TaskItem {
    /// Strictly `merged`, never `closed`: an unmerged-closed PR is evidence of abandonment.
    pub fn inferred_outcome(&self) -> TaskOutcome {
        if self.status == "done" || self.prs.iter().any(|pr| pr.state == "merged") {
            TaskOutcome::Done
        } else {
            TaskOutcome::Abandoned
        }
    }

    /// The one place the derived presentation fields are computed (see `Store::query_tasks`).
    pub(crate) fn with_derived_fields(mut self) -> Self {
        self.closed = self.status == "done" || self.outcome.is_some();
        self.display_outcome = self
            .outcome
            .clone()
            .or_else(|| (self.status == "done").then(|| TaskOutcome::Done.as_str().to_string()));
        self.has_worktree = self.worktree.as_ref().is_some_and(|w| w.dir.is_some());
        self
    }
}

/// `repo_root` is required even for a "task only" submit — it puts every task in a repo swimlane.
/// It and `branch` survive worktree removal as history; `dir` is cleared with the worktree.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWorktree {
    pub repo_root: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskIssueLink {
    pub repo: String,
    pub number: i64,
    pub url: String,
    pub state: String,
}

/// Empty for links already in the target state, so re-running is a no-op and a half-failed
/// batch converges on retry. Pure, so testable without the shell that spawns `gh`.
pub fn gh_close_reopen_targets(
    old_status: &str,
    new_status: &str,
    issues: &[TaskIssueLink],
) -> Vec<(String, i64, bool)> {
    if old_status == new_status {
        return Vec::new();
    }
    let close = if new_status == "done" {
        true
    } else if old_status == "done" {
        false
    } else {
        return Vec::new();
    };
    issues
        .iter()
        .filter(|link| if close { link.state != "closed" } else { link.state == "closed" })
        .map(|link| (link.repo.clone(), link.number, close))
        .collect()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPrLink {
    pub repo: String,
    pub number: i64,
    pub url: String,
    pub state: String,
    pub checks: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueItem {
    pub repo: String,
    pub number: i64,
    pub title: String,
    pub labels: Vec<String>,
    pub state: String,
    pub url: String,
    pub updated_ts: i64,
    /// `updated_ts` at last dismissal, `0` if never; hidden while `dismissed_ts >= updated_ts`, so
    /// a dismissal survives the item leaving and re-entering but expires once the item changes.
    pub dismissed_ts: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrItem {
    pub repo: String,
    pub number: i64,
    pub title: String,
    pub branch: String,
    pub state: String,
    pub checks: String,
    pub review_state: String,
    pub url: String,
    pub updated_ts: i64,
    pub dismissed_ts: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectRun {
    pub collector: String,
    pub ran_at: i64,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Banner only when `!from_me && dismissed_ts < ts`; `from_me`: the latest message is the user's.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DmItem {
    pub channel: String,
    pub from_name: String,
    pub text: String,
    pub ts: i64,
    pub from_me: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub fetched_at: i64,
    pub dismissed_ts: i64,
}

/// One handled MCP request; `client` comes from the request's own `_meta.clientInfo`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCall {
    pub id: i64,
    pub ts: i64,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<String>,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub events: Vec<CalEvent>,
    pub tasks: Vec<TaskItem>,
    pub issues: Vec<IssueItem>,
    pub prs: Vec<PrItem>,
    pub runs: Vec<CollectRun>,
    pub dms: Vec<DmItem>,
    #[serde(default)]
    pub mcp_calls: Vec<McpCall>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventInput {
    pub external_id: String,
    pub title: String,
    /// A `DateTime`, not a `String`: serde rejects an unparseable value at the edge, and
    /// `FixedOffset` (not `Utc`) keeps the offset that normalizing would discard.
    pub start: DateTime<FixedOffset>,
    #[serde(default)]
    pub end: Option<DateTime<FixedOffset>>,
    #[serde(default)]
    pub attendees: Vec<String>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub join_url: Option<String>,
}

impl EventInput {
    pub fn start_ms(&self) -> i64 {
        self.start.timestamp_millis()
    }

    pub fn end_ms(&self) -> Option<i64> {
        self.end.map(|end| end.timestamp_millis())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueInput {
    pub repo: String,
    pub number: i64,
    pub title: String,
    #[serde(default)]
    pub labels: Vec<String>,
    pub state: String,
    pub url: String,
    pub updated_ts: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DmInput {
    pub channel: String,
    pub from_name: String,
    pub text: String,
    pub ts: i64,
    pub from_me: bool,
    #[serde(default)]
    pub url: Option<String>,
}

/// One handled request; `ts` comes from the dispatcher's injected `now_ms`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCallInput {
    pub method: String,
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub args: Option<String>,
    pub ok: bool,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    #[serde(default)]
    pub client: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrInput {
    pub repo: String,
    pub number: i64,
    pub title: String,
    pub branch: String,
    pub state: String,
    pub checks: String,
    pub review_state: String,
    pub url: String,
    pub updated_ts: i64,
}
