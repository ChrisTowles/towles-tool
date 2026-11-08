//! The queue: every checkout on Agent Board — task worktrees and repo roots
//! alike, the tree's own rows — in the order to work them: what waits on you,
//! then what's idle at its prompt for your next word, what runs and needs
//! nothing, what's parked, and what has no shell open. A task owning the checkout lends
//! it a title and a rank; nothing else needs one. Pure — agent waits come from the
//! PTY-first `needs_reason`, landed state from the rail's `ops::work_state`, PR
//! and CI facts from the collector cache; only rank and snoozes are the user's.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tt_store::{
    ChecksState, CiConclusion, CiRun, CiStatus, PrItem, PrState, QueueSnooze, ReviewState, TaskItem,
};

use crate::bridge::StatePayload;
use crate::types::{FolderData, NeedsYouReason, RepoData, SessionData};

/// Most urgent first; the declaration order is the severity tiebreak.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WaitReason {
    Unblock,
    Answer,
    Review,
    FixCi,
    AddressReview,
    Land,
    Cleanup,
}

impl WaitReason {
    /// An agent sits idle until this is handled, so it jumps the rank order.
    pub fn blocks_agent(self) -> bool {
        matches!(self, Self::Unblock | Self::Answer)
    }

    /// The words the queue chip and `needs_you` say it in; the PR tells approved from merely green.
    pub fn phrase(self, pr: Option<&QueuePr>) -> &'static str {
        match self {
            Self::Unblock => "errored",
            Self::Answer => "asking",
            Self::Review => "finished",
            Self::FixCi => "CI red",
            Self::AddressReview => "changes asked",
            Self::Land if pr.is_some_and(|p| p.review_state == ReviewState::Approved) => {
                "PR approved"
            }
            Self::Land => "ready to land",
            Self::Cleanup => "landed",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unblock => "unblock",
            Self::Answer => "answer",
            Self::Review => "review",
            Self::FixCi => "fix_ci",
            Self::AddressReview => "address_review",
            Self::Land => "land",
            Self::Cleanup => "cleanup",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Lane {
    OnYou,
    /// A live session, nothing doing — it moves when you do, so it leads Running.
    Idle,
    Running,
    Parked,
    /// No live session — nothing to answer for until a shell is opened.
    NoShell,
}

/// How long a fresh `Answer` wait reads as still running. A permission prompt that
/// clears itself (auto-approved, or answered from the terminal) would otherwise bounce the row
/// Running → On you → Running and the head with it.
pub const ANSWER_GRACE_MS: i64 = 3_000;

/// The stable string a checkout's snooze is stored under; the store never parses it.
pub fn snooze_key(folder_dir: &str) -> String {
    format!("folder:{folder_dir}")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuePr {
    pub repo: String,
    pub number: i64,
    pub url: String,
    pub state: PrState,
    pub checks: ChecksState,
    pub review_state: ReviewState,
}

/// One failing workflow run folded into an item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueCi {
    pub workflow: String,
    pub url: String,
    pub conclusion: CiConclusion,
    pub updated_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    /// The board task owning the checkout, if any; the row's identity is `folder_dir`.
    pub task_id: Option<i64>,
    pub lane: Lane,
    pub reason: Option<WaitReason>,
    /// `reason` in words — [`WaitReason::phrase`].
    pub why: Option<String>,
    pub also: Vec<WaitReason>,
    pub title: String,
    pub repo: String,
    pub branch: String,
    pub folder_dir: String,
    pub session_id: Option<String>,
    /// The session's own reported line — never terminal output.
    pub said: Option<String>,
    pub running_agents: u32,
    pub pr: Option<QueuePr>,
    pub ci: Vec<QueueCi>,
    /// The owning task's board rank; a checkout no task owns has none.
    pub rank: Option<i64>,
    /// When the row entered its state: the wait began, CI broke, or the agent
    /// started working or reached its prompt.
    pub since_ms: Option<i64>,
    pub snoozed_until_ms: Option<i64>,
    /// Held only while the PR's checks are pending.
    pub snoozed_until_ci: bool,
    pub snoozed: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskQueue {
    /// The `folder_dir` of the first row on you.
    pub next: Option<String>,
    pub items: Vec<QueueItem>,
    /// When the earliest held `Answer` grace ends — the app rebuilds then, since
    /// nothing else may tick. Never sent.
    #[serde(skip)]
    pub settles_at_ms: Option<i64>,
    /// Snooze keys set "until CI finishes" whose CI has finished — the app drops
    /// them, so the next push doesn't re-hide the row. Never sent.
    #[serde(skip)]
    pub spent_snoozes: Vec<String>,
}

impl QueueItem {
    /// Batch landing takes only this: a task's open PR, approved and green. A merely green
    /// PR still says "ready to land" but waits for a human to choose it.
    pub fn landable(&self) -> bool {
        self.task_id.is_some()
            && self.pr.as_ref().is_some_and(|p| {
                p.state == PrState::Open
                    && p.checks == ChecksState::Passing
                    && p.review_state == ReviewState::Approved
            })
    }
}

impl TaskQueue {
    /// Tasks to close as done without asking: landed, nothing left in the checkout, and
    /// no agent mid-turn or waiting on an answer there. Removal re-runs its own guards.
    pub fn auto_close_candidates(&self) -> impl Iterator<Item = &QueueItem> {
        self.items.iter().filter(|i| {
            let landed =
                i.reason == Some(WaitReason::Cleanup) || i.also.contains(&WaitReason::Cleanup);
            let agent_busy =
                i.lane == Lane::Running || i.reason.is_some_and(WaitReason::blocks_agent);
            i.task_id.is_some() && landed && !agent_busy
        })
    }
}

pub struct QueueInputs<'a> {
    pub tasks: &'a [TaskItem],
    pub state: &'a StatePayload,
    pub prs: &'a [PrItem],
    pub ci_runs: &'a [CiRun],
    pub snoozes: &'a [QueueSnooze],
    pub now_ms: i64,
}

pub fn build(inputs: QueueInputs<'_>) -> TaskQueue {
    let mut owners: HashMap<&str, &TaskItem> = HashMap::new();
    for task in inputs.tasks.iter().filter(|t| !t.closed && t.archived_at.is_none()) {
        if let Some(dir) = task.worktree.as_ref().and_then(|w| w.dir.as_deref()) {
            owners.entry(dir).or_insert(task);
        }
    }
    let snoozes: HashMap<&str, &QueueSnooze> =
        inputs.snoozes.iter().map(|s| (s.key.as_str(), s)).collect();
    let lookup = Lookup::new(inputs.prs, inputs.ci_runs);
    let mut settles_at_ms: Option<i64> = None;

    let mut items: Vec<QueueItem> = inputs
        .state
        .repos
        .iter()
        .flat_map(|r| r.folders.iter().map(move |f| (r, f)))
        .map(|(repo, folder)| {
            let task = owners.get(folder.dir.as_str()).copied();
            checkout_item(repo, folder, task, &lookup, inputs.now_ms, &mut settles_at_ms)
        })
        .collect();
    let mut spent_snoozes = Vec::new();
    for item in &mut items {
        if let Some(key) = apply_snooze(item, &snoozes, inputs.now_ms) {
            spent_snoozes.push(key);
        }
    }
    items.sort_by(|a, b| {
        order_key(a).cmp(&order_key(b)).then_with(|| a.folder_dir.cmp(&b.folder_dir))
    });
    let next = items.iter().find(|i| i.lane == Lane::OnYou).map(|i| i.folder_dir.clone());
    TaskQueue { next, items, settles_at_ms, spent_snoozes }
}

/// A checkout's row, titled and ranked by the task owning it when one does.
fn checkout_item(
    repo: &RepoData,
    folder: &FolderData,
    task: Option<&TaskItem>,
    lookup: &Lookup<'_>,
    now_ms: i64,
    settles_at_ms: &mut Option<i64>,
) -> QueueItem {
    let mut item = base_item(task.map(|t| t.id), task.map(|t| t.rank), repo, folder);
    item.pr = match task {
        Some(task) => lookup.task_pr(task, &item.repo, &item.branch),
        // A main checkout's branch is the base, which no PR heads.
        None if folder.is_worktree => lookup.branch_pr(&item.repo, &item.branch),
        None => None,
    };
    // A main checkout owns no branch's CI.
    if folder.is_worktree {
        item.ci = lookup.branch_ci(&item.repo, &item.branch);
    }
    let mut reasons = agent_reasons(folder, &mut item, now_ms, settles_at_ms);
    reasons.extend(pr_reasons(item.pr.as_ref()));
    reasons.extend(ci_reasons(&item.ci));
    if holds_landed_work(folder, item.pr.as_ref()) {
        reasons.push((WaitReason::Cleanup, None));
    }
    settle(&mut item, reasons);
    item.lane = derive_lane(
        item.reason,
        item.running_agents,
        item.pr.as_ref().is_some_and(|p| p.state == PrState::Open) || holds_unlanded_work(folder),
        item.session_id.is_some(),
    );
    if item.since_ms.is_none() {
        item.since_ms = lane_since(folder, &item);
    }
    item.said = said_for(folder, item.session_id.as_deref());
    item.title = match task {
        Some(task) => task.text.clone(),
        // The tree's own label for a main checkout, which the repo tag already names.
        None => item.said.clone().unwrap_or_else(|| {
            if folder.is_worktree { folder.name.clone() } else { "Root".to_string() }
        }),
    };
    item
}

/// Lane, then — in On you — agent-blocking reasons first, then rank (ranked
/// tasks ahead of unranked checkouts), severity, age.
pub fn order_key(item: &QueueItem) -> (Lane, u8, i64, Option<WaitReason>, i64) {
    let tier = match (item.lane, item.reason) {
        (Lane::OnYou, Some(r)) if r.blocks_agent() => 0,
        _ => 1,
    };
    let rank = item.rank.unwrap_or(i64::MAX);
    (item.lane, tier, rank, item.reason, item.since_ms.unwrap_or(i64::MAX))
}

fn base_item(
    task_id: Option<i64>,
    rank: Option<i64>,
    repo: &RepoData,
    folder: &FolderData,
) -> QueueItem {
    QueueItem {
        task_id,
        lane: Lane::Idle,
        reason: None,
        why: None,
        also: Vec::new(),
        title: String::new(),
        repo: repo
            .origin_url
            .as_deref()
            .and_then(tt_git::remote::repo_slug_from_remote_preserving_case)
            .unwrap_or_else(|| repo.name.clone()),
        branch: folder.branch.clone(),
        folder_dir: folder.dir.clone(),
        session_id: None,
        said: None,
        running_agents: 0,
        pr: None,
        ci: Vec::new(),
        rank,
        since_ms: None,
        snoozed_until_ms: None,
        snoozed_until_ci: false,
        snoozed: false,
    }
}

/// How long the row has been in a lane with no wait of its own: the oldest
/// working agent's run, the idle one's time at its prompt, a red CI's break.
fn lane_since(folder: &FolderData, item: &QueueItem) -> Option<i64> {
    let live = || folder.sessions.iter().filter(|s| s.live);
    match (item.lane, item.reason) {
        (Lane::Running, _) => live()
            .filter(|s| s.agent_state.as_ref().is_some_and(|a| a.is_working()))
            .filter_map(|s| s.phase_since_ms)
            .min(),
        (Lane::Idle, _) => live()
            .find(|s| Some(s.id.as_str()) == item.session_id.as_deref())
            .and_then(|s| s.phase_since_ms),
        (Lane::OnYou, Some(WaitReason::FixCi)) => item.ci.iter().map(|c| c.updated_ms).max(),
        _ => None,
    }
}

/// Agent waits per session, plus the running count and the session to open. A
/// wait for an answer still inside [`ANSWER_GRACE_MS`] counts as running instead.
fn agent_reasons(
    folder: &FolderData,
    item: &mut QueueItem,
    now_ms: i64,
    settles_at_ms: &mut Option<i64>,
) -> Vec<(WaitReason, Option<(i64, String)>)> {
    let live: Vec<&SessionData> = folder.sessions.iter().filter(|s| s.live).collect();
    item.running_agents =
        live.iter().filter(|s| s.agent_state.as_ref().is_some_and(|a| a.is_working())).count()
            as u32;
    item.session_id = live.iter().max_by_key(|s| s.created_at).map(|s| s.id.clone());
    live.iter()
        .filter_map(|s| {
            let reason = match s.needs_reason? {
                NeedsYouReason::Errored => WaitReason::Unblock,
                NeedsYouReason::WaitingForInput => WaitReason::Answer,
                NeedsYouReason::Finished => WaitReason::Review,
            };
            if let (WaitReason::Answer, Some(since)) = (reason, s.needs_since_ms)
                && (0..ANSWER_GRACE_MS).contains(&(now_ms - since))
            {
                item.running_agents += 1;
                let settles = since + ANSWER_GRACE_MS;
                *settles_at_ms = Some(settles_at_ms.map_or(settles, |t| t.min(settles)));
                return None;
            }
            Some((reason, Some((s.needs_since_ms.unwrap_or(i64::MAX), s.id.clone()))))
        })
        .collect()
}

fn session_said(s: &SessionData) -> Option<String> {
    let thread = s.agent_state.as_ref().and_then(|a| a.thread_name.as_deref()).map(str::trim);
    if let Some(thread) = thread.filter(|t| !t.is_empty() && *t != "Claude Code") {
        return Some(thread.to_string());
    }
    s.purpose.as_deref().map(str::trim).filter(|p| !p.is_empty()).map(str::to_string)
}

/// The PR and CI caches keyed once per build, so each checkout is a lookup, not a scan.
/// Repo names compare case-insensitively; the first row wins, as the caches are newest-first.
struct Lookup<'a> {
    open_by_branch: HashMap<(String, &'a str), &'a PrItem>,
    by_number: HashMap<(String, i64), &'a PrItem>,
    failing_by_branch: HashMap<(String, &'a str), Vec<&'a CiRun>>,
}

impl<'a> Lookup<'a> {
    fn new(prs: &'a [PrItem], runs: &'a [CiRun]) -> Self {
        let mut open_by_branch = HashMap::new();
        let mut by_number = HashMap::new();
        for p in prs {
            let repo = p.repo.to_ascii_lowercase();
            by_number.entry((repo.clone(), p.number)).or_insert(p);
            if p.state == PrState::Open {
                open_by_branch.entry((repo, p.branch.as_str())).or_insert(p);
            }
        }
        let mut failing_by_branch: HashMap<_, Vec<&CiRun>> = HashMap::new();
        for r in
            runs.iter().filter(|r| r.status == CiStatus::Completed && r.conclusion.is_failure())
        {
            failing_by_branch
                .entry((r.repo.to_ascii_lowercase(), r.branch.as_str()))
                .or_default()
                .push(r);
        }
        Self { open_by_branch, by_number, failing_by_branch }
    }

    /// The task's linked PR, else the open PR on its branch.
    fn task_pr(&self, task: &TaskItem, repo: &str, branch: &str) -> Option<QueuePr> {
        let linked = task.prs.iter().rev().find_map(|link| {
            self.by_number.get(&(link.repo.to_ascii_lowercase(), link.number)).copied()
        });
        linked.map(queue_pr).or_else(|| self.branch_pr(repo, branch))
    }

    fn branch_pr(&self, repo: &str, branch: &str) -> Option<QueuePr> {
        let key = (repo.to_ascii_lowercase(), branch);
        self.open_by_branch.get(&key).copied().map(queue_pr)
    }

    /// The failing runs on the item's own branch of its repo.
    fn branch_ci(&self, repo: &str, branch: &str) -> Vec<QueueCi> {
        if branch.is_empty() {
            return Vec::new();
        }
        let key = (repo.to_ascii_lowercase(), branch);
        self.failing_by_branch
            .get(&key)
            .into_iter()
            .flatten()
            .map(|r| QueueCi {
                workflow: r.workflow.clone(),
                url: r.url.clone(),
                conclusion: r.conclusion,
                updated_ms: r.updated_ms,
            })
            .collect()
    }
}

fn queue_pr(p: &PrItem) -> QueuePr {
    QueuePr {
        repo: p.repo.clone(),
        number: p.number,
        url: p.url.clone(),
        state: p.state,
        checks: p.checks,
        review_state: p.review_state,
    }
}

fn ci_reasons(ci: &[QueueCi]) -> Vec<(WaitReason, Option<(i64, String)>)> {
    if ci.is_empty() { Vec::new() } else { vec![(WaitReason::FixCi, None)] }
}

fn pr_reasons(pr: Option<&QueuePr>) -> Vec<(WaitReason, Option<(i64, String)>)> {
    let Some(pr) = pr.filter(|p| p.state == PrState::Open) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if pr.checks == ChecksState::Failing {
        out.push((WaitReason::FixCi, None));
    }
    if pr.review_state == ReviewState::ChangesRequested {
        out.push((WaitReason::AddressReview, None));
    }
    let green = matches!(pr.checks, ChecksState::Passing | ChecksState::None);
    if out.is_empty()
        && green
        && matches!(pr.review_state, ReviewState::Approved | ReviewState::None)
    {
        out.push((WaitReason::Land, None));
    }
    out
}

/// A worktree whose commits or edits haven't landed — work that would be lost.
fn holds_unlanded_work(folder: &FolderData) -> bool {
    folder.is_worktree
        && !folder.dir_missing
        && folder.landed.is_none()
        && (folder.dirty || folder.commits_unlanded > 0)
}

/// Landed by git or by a merged PR, and nothing in the folder would be lost.
fn holds_landed_work(folder: &FolderData, pr: Option<&QueuePr>) -> bool {
    let landed = folder.landed.is_some() || pr.is_some_and(|p| p.state == PrState::Merged);
    folder.is_worktree && landed && !folder.dirty && folder.commits_unlanded == 0
}

/// Most severe reason wins; on a tie, the oldest wait — and its session is the one to open.
/// A working agent outranks a wait it can carry on through, so that reason is dropped.
fn settle(item: &mut QueueItem, mut reasons: Vec<(WaitReason, Option<(i64, String)>)>) {
    reasons.sort_by_key(|(r, s)| (*r, s.as_ref().map_or(i64::MAX, |s| s.0)));
    let mut seen = std::collections::HashSet::new();
    reasons.retain(|(r, _)| seen.insert(*r));
    let Some((primary, session)) = reasons.first().cloned() else {
        return;
    };
    if let Some((since, id)) = session {
        item.since_ms = (since != i64::MAX).then_some(since);
        item.session_id = Some(id);
    }
    if item.running_agents > 0 && !primary.blocks_agent() && primary != WaitReason::Review {
        return;
    }
    item.reason = Some(primary);
    item.why = Some(primary.phrase(item.pr.as_ref()).to_string());
    item.also = reasons[1..].iter().map(|(r, _)| *r).collect();
}

/// Where a settled row sits: waiting on you, working, parked on something outstanding (an open
/// PR or work that would be lost), or at rest. Pure, so no lane is assigned and then demoted.
fn derive_lane(
    reason: Option<WaitReason>,
    running_agents: u32,
    parked: bool,
    has_session: bool,
) -> Lane {
    if reason.is_some() {
        Lane::OnYou
    } else if running_agents > 0 {
        Lane::Running
    } else if parked {
        Lane::Parked
    } else if has_session {
        Lane::Idle
    } else {
        Lane::NoShell
    }
}

/// Parks a row the user snoozed — while the reason it was set on is still the
/// row's reason, the time has not run out, and (for "until CI finishes") the
/// PR's checks are still pending, so a new reason resurfaces it. Returns the key
/// of an "until CI" snooze whose CI is done, which nothing should hold again.
fn apply_snooze(
    item: &mut QueueItem,
    snoozes: &HashMap<&str, &QueueSnooze>,
    now_ms: i64,
) -> Option<String> {
    let reason = item.reason?;
    let key = snooze_key(&item.folder_dir);
    let s = snoozes.get(key.as_str())?;
    if s.reason != reason.as_str() || s.until_ms.is_some_and(|u| u <= now_ms) {
        return None;
    }
    if s.until_ci && item.pr.as_ref().is_none_or(|p| p.checks != ChecksState::Pending) {
        return Some(key);
    }
    item.lane = Lane::Parked;
    item.snoozed = true;
    item.snoozed_until_ms = s.until_ms;
    item.snoozed_until_ci = s.until_ci;
    None
}

fn said_for(folder: &FolderData, session_id: Option<&str>) -> Option<String> {
    folder.sessions.iter().find(|s| Some(s.id.as_str()) == session_id).and_then(session_said)
}

#[cfg(test)]
mod tests {
    use tt_store::{RankMove, Store};

    use super::*;
    use crate::types::{AgentEvent, AgentStatus};

    fn session(
        id: &str,
        status: AgentStatus,
        needs: Option<NeedsYouReason>,
        since: i64,
    ) -> SessionData {
        SessionData {
            id: id.to_string(),
            name: id.to_string(),
            live: true,
            needs_reason: needs,
            needs_since_ms: needs.map(|_| since),
            agent_state: Some(AgentEvent {
                agent: "claude".to_string(),
                session: id.to_string(),
                status,
                ts: 0,
                thread_id: None,
                thread_name: Some(format!("{id} says")),
                unseen: None,
                details: None,
            }),
            ..Default::default()
        }
    }

    fn waiting(id: &str, since: i64) -> SessionData {
        session(id, AgentStatus::Waiting, Some(NeedsYouReason::WaitingForInput), since)
    }

    fn folder(dir: &str, sessions: Vec<SessionData>) -> FolderData {
        FolderData {
            name: dir.to_string(),
            dir: dir.to_string(),
            branch: format!("feat{dir}"),
            is_worktree: true,
            sessions,
            ..Default::default()
        }
    }

    fn state(folders: Vec<FolderData>) -> StatePayload {
        StatePayload {
            repos: vec![RepoData {
                key: "k".to_string(),
                dir: "/r".to_string(),
                name: "repo".to_string(),
                origin_url: Some("git@github.com:o/repo.git".to_string()),
                folders,
                needs: 0,
                meta: None,
                color: Default::default(),
                archived: false,
            }],
            compact_recommend_percent: 30,
            windows: Default::default(),
            collapsed: Default::default(),
            agent_scan_ok: true,
            ts: 0,
        }
    }

    fn pr(branch: &str, state: PrState, checks: ChecksState, review: ReviewState) -> PrItem {
        PrItem {
            repo: "o/repo".to_string(),
            number: 7,
            title: "t".to_string(),
            branch: branch.to_string(),
            state,
            checks,
            review_state: review,
            url: "u".to_string(),
            updated_ts: 0,
            dismissed_ts: 0,
            base_branch: "main".to_string(),
        }
    }

    fn ci(workflow: &str, branch: &str, conclusion: CiConclusion) -> CiRun {
        CiRun {
            repo: "o/repo".to_string(),
            workflow: workflow.to_string(),
            status: CiStatus::Completed,
            conclusion,
            created_ms: 1,
            updated_ms: 10,
            url: format!("u/{workflow}"),
            head_sha: "abc".to_string(),
            event: "push".to_string(),
            branch: branch.to_string(),
        }
    }

    /// Tasks `a`, `b`, `c`… in rank order, each bound to worktree `/<name>`.
    fn store(names: &[&str]) -> (Store, Vec<i64>) {
        let s = Store::open_in_memory().unwrap();
        let ids = names
            .iter()
            .map(|n| {
                let t = s.add_task(n, "backlog", None, None, 1).unwrap();
                let dir = format!("/{n}");
                s.set_task_worktree(
                    t.id,
                    "/r",
                    Some("o/repo"),
                    Some(&format!("feat{dir}")),
                    Some(&dir),
                )
                .unwrap();
                t.id
            })
            .collect();
        (s, ids)
    }

    fn run(s: &Store, st: &StatePayload, prs: &[PrItem], now_ms: i64) -> TaskQueue {
        run_ci(s, st, prs, &[], now_ms)
    }

    fn run_ci(
        s: &Store,
        st: &StatePayload,
        prs: &[PrItem],
        ci_runs: &[CiRun],
        now_ms: i64,
    ) -> TaskQueue {
        build(QueueInputs {
            tasks: &s.open_tasks().unwrap(),
            state: st,
            prs,
            ci_runs,
            snoozes: &s.queue_snoozes().unwrap(),
            now_ms,
        })
    }

    fn snooze(s: &Store, dir: &str, reason: &str, until_ms: Option<i64>) {
        let until = tt_store::SnoozeUntil { reason, until_ms, until_ci: false };
        s.snooze_queue_item(&snooze_key(dir), until, 0).unwrap();
    }

    fn item<'a>(q: &'a TaskQueue, dir: &str) -> &'a QueueItem {
        q.items.iter().find(|i| i.folder_dir == dir).unwrap()
    }

    fn next(dir: &str) -> Option<String> {
        Some(dir.to_string())
    }

    fn summary(q: &TaskQueue) -> Vec<(String, Lane, Option<WaitReason>)> {
        q.items.iter().map(|i| (i.title.clone(), i.lane, i.reason)).collect()
    }

    fn row(t: &str, lane: Lane, r: Option<WaitReason>) -> (String, Lane, Option<WaitReason>) {
        (t.to_string(), lane, r)
    }

    #[test]
    fn blocked_agents_jump_rank_then_rank_decides() {
        let (s, _) = store(&["a", "b", "c"]);
        let st = state(vec![
            folder(
                "/a",
                vec![session(
                    "sa",
                    AgentStatus::Complete,
                    Some(NeedsYouReason::Finished),
                    5,
                )],
            ),
            folder("/b", vec![]),
            folder("/c", vec![waiting("sc", 9)]),
        ]);
        let q = run(
            &s,
            &st,
            &[pr(
                "feat/b",
                PrState::Open,
                ChecksState::Failing,
                ReviewState::None,
            )],
            0,
        );
        use Lane::*;
        use WaitReason::*;
        assert_eq!(
            summary(&q),
            [
                row("c", OnYou, Some(Answer)),
                row("a", OnYou, Some(Review)),
                row("b", OnYou, Some(FixCi))
            ]
        );
        let head = &q.items[0];
        assert_eq!(q.next.as_deref(), Some(head.folder_dir.as_str()));
        assert_eq!((head.session_id.as_deref(), head.since_ms), (Some("sc"), Some(9)));
        assert_eq!(head.said.as_deref(), Some("sc says"));
        assert_eq!(head.repo, "o/repo");
        assert_eq!(head.folder_dir, "/c");
    }

    #[test]
    fn running_parked_idle_and_shell_less_with_nothing_on_you() {
        let (s, _) = store(&["run", "park", "idle", "cold"]);
        let st = state(vec![
            folder("/run", vec![session("s", AgentStatus::Busy, None, 0)]),
            folder("/park", vec![]),
            folder("/idle", vec![session("i", AgentStatus::Idle, None, 0)]),
            folder("/cold", vec![]),
        ]);
        let q = run(
            &s,
            &st,
            &[pr(
                "feat/park",
                PrState::Open,
                ChecksState::Pending,
                ReviewState::None,
            )],
            0,
        );
        use Lane::*;
        assert_eq!(
            summary(&q),
            [
                row("idle", Idle, None),
                row("run", Running, None),
                row("park", Parked, None),
                row("cold", NoShell, None),
            ]
        );
        assert_eq!(item(&q, "/run").running_agents, 1);
        assert_eq!(q.next, None, "nothing waits on you, so there is no next up");
    }

    #[test]
    fn a_fresh_answer_wait_reads_as_running_until_its_grace_ends() {
        let (s, _) = store(&["prompt", "errored"]);
        let errored = session("e", AgentStatus::Error, Some(NeedsYouReason::Errored), 1_000);
        let st = state(vec![
            folder("/prompt", vec![waiting("p", 1_000)]),
            folder("/errored", vec![errored]),
        ]);
        let q = run(&s, &st, &[], 1_000 + ANSWER_GRACE_MS - 1);
        assert_eq!(item(&q, "/prompt").lane, Lane::Running);
        assert_eq!(item(&q, "/prompt").running_agents, 1);
        assert_eq!(item(&q, "/errored").lane, Lane::OnYou, "only answers wait out a grace");
        assert_eq!(q.settles_at_ms, Some(1_000 + ANSWER_GRACE_MS));

        let q = run(&s, &st, &[], 1_000 + ANSWER_GRACE_MS);
        assert_eq!(item(&q, "/prompt").reason, Some(WaitReason::Answer));
        assert_eq!(q.settles_at_ms, None);
    }

    #[test]
    fn pr_reasons_land_and_review_and_a_working_agent_hides_them() {
        let (s, _) = store(&["land", "rev", "busy"]);
        let st = state(vec![
            folder("/land", vec![]),
            folder("/rev", vec![]),
            folder("/busy", vec![session("s", AgentStatus::Busy, None, 0)]),
        ]);
        let mut busy = pr("feat/busy", PrState::Open, ChecksState::Failing, ReviewState::None);
        busy.number = 9;
        let prs = [
            pr("feat/land", PrState::Open, ChecksState::Passing, ReviewState::Approved),
            pr("feat/rev", PrState::Open, ChecksState::Passing, ReviewState::ChangesRequested),
            busy,
        ];
        let q = run(&s, &st, &prs, 0);
        use Lane::*;
        use WaitReason::*;
        assert_eq!(
            summary(&q),
            [
                row("land", OnYou, Some(Land)),
                row("rev", OnYou, Some(AddressReview)),
                row("busy", Running, None)
            ]
        );
    }

    #[test]
    fn severity_wins_and_the_rest_are_also() {
        let (s, _) = store(&["a"]);
        let st = state(vec![folder(
            "/a",
            vec![
                session("s1", AgentStatus::Complete, Some(NeedsYouReason::Finished), 1),
                session("s2", AgentStatus::Error, Some(NeedsYouReason::Errored), 2),
            ],
        )]);
        let q = run(
            &s,
            &st,
            &[pr(
                "feat/a",
                PrState::Open,
                ChecksState::Failing,
                ReviewState::None,
            )],
            0,
        );
        let item = &q.items[0];
        assert_eq!(item.reason, Some(WaitReason::Unblock));
        assert_eq!(item.also, [WaitReason::Review, WaitReason::FixCi]);
        assert_eq!(item.session_id.as_deref(), Some("s2"));
    }

    #[test]
    fn landed_clean_worktree_is_cleanup_but_dirty_is_not() {
        let (s, _) = store(&["clean", "dirty"]);
        let mut clean = folder("/clean", vec![]);
        clean.landed = Some("merged".to_string());
        let mut dirty = folder("/dirty", vec![]);
        dirty.landed = Some("merged".to_string());
        dirty.dirty = true;
        let q = run(&s, &state(vec![clean, dirty]), &[], 0);
        assert_eq!(q.items[0].reason, Some(WaitReason::Cleanup));
        assert_eq!(q.items[1].lane, Lane::NoShell, "dirty is left alone");
    }

    #[test]
    fn auto_close_takes_landed_tasks_but_never_a_working_agent() {
        let (s, _) = store(&["idle", "busy", "asking", "open"]);
        let landed = |dir: &str, sessions| {
            let mut f = folder(dir, sessions);
            f.landed = Some("PR merged".to_string());
            f
        };
        let st = state(vec![
            landed("/idle", vec![session("i", AgentStatus::Idle, None, 0)]),
            landed("/busy", vec![session("b", AgentStatus::Busy, None, 0)]),
            landed("/asking", vec![waiting("a", 0)]),
            folder("/open", vec![]),
        ]);
        let q = run(&s, &st, &[], 10_000);
        let picked: Vec<&str> = q.auto_close_candidates().map(|i| i.title.as_str()).collect();
        assert_eq!(picked, vec!["idle"]);
    }

    #[test]
    fn auto_close_skips_checkouts_no_task_owns() {
        let (s, _) = store(&[]);
        let mut f = folder("/stray", vec![]);
        f.landed = Some("merged".to_string());
        let q = run(&s, &state(vec![f]), &[], 0);
        assert_eq!(q.items[0].reason, Some(WaitReason::Cleanup));
        assert_eq!(q.auto_close_candidates().count(), 0);
    }

    #[test]
    fn snooze_parks_only_while_the_reason_and_time_hold() {
        let (s, _) = store(&["a", "b"]);
        let st = state(vec![
            folder("/a", vec![waiting("s", -ANSWER_GRACE_MS)]),
            folder("/b", vec![]),
        ]);
        let a = "/a";
        snooze(&s, a, "answer", Some(100));
        let q = run(&s, &st, &[], 50);
        assert_eq!(item(&q, a).lane, Lane::Parked);
        assert!(item(&q, a).snoozed);
        assert_eq!(q.next, None);
        assert_eq!(run(&s, &st, &[], 150).next, next(a), "expired");
        snooze(&s, a, "review", None);
        assert_eq!(run(&s, &st, &[], 50).next, next(a), "a new reason resurfaces it");
    }

    #[test]
    fn a_snooze_holds_one_row_only() {
        let (s, _) = store(&["one", "other"]);
        let st = state(vec![
            folder("/one", vec![waiting("s1", -ANSWER_GRACE_MS)]),
            folder("/other", vec![waiting("so", -ANSWER_GRACE_MS)]),
        ]);
        let (one, other) = ("/one", "/other");
        snooze(&s, one, "answer", Some(100));
        let q = run(&s, &st, &[], 50);
        assert_eq!(item(&q, one).lane, Lane::Parked);
        assert_eq!(item(&q, one).snoozed_until_ms, Some(100));
        assert_eq!(item(&q, other).lane, Lane::OnYou, "a sibling row is untouched");
        assert_eq!(q.next, next(other));
        assert_eq!(item(&run(&s, &st, &[], 150), one).lane, Lane::OnYou, "timed out");
    }

    #[test]
    fn an_until_ci_snooze_holds_while_checks_pend_then_is_spent() {
        let (s, _) = store(&["x"]);
        let st = state(vec![folder("/x", vec![waiting("s", 5)])]);
        let until = tt_store::SnoozeUntil { reason: "answer", until_ms: None, until_ci: true };
        s.snooze_queue_item(&snooze_key("/x"), until, 0).unwrap();
        let pending = [pr(
            "feat/x",
            PrState::Open,
            ChecksState::Pending,
            ReviewState::None,
        )];
        let q = run(&s, &st, &pending, 10_000);
        assert!(item(&q, "/x").snoozed_until_ci);
        assert_eq!(item(&q, "/x").lane, Lane::Parked);
        assert!(q.spent_snoozes.is_empty());
        let done = [pr(
            "feat/x",
            PrState::Open,
            ChecksState::Passing,
            ReviewState::None,
        )];
        let q = run(&s, &st, &done, 10_000);
        assert_eq!(item(&q, "/x").lane, Lane::OnYou);
        assert_eq!(q.spent_snoozes, [snooze_key("/x")]);
    }

    #[test]
    fn why_says_the_reason_in_words_and_tells_approved_from_green() {
        let (s, _) = store(&["ask", "ok", "green"]);
        let st = state(vec![
            folder("/ask", vec![waiting("s", 0)]),
            folder("/ok", vec![]),
            folder("/green", vec![]),
        ]);
        let mut green = pr("feat/green", PrState::Open, ChecksState::Passing, ReviewState::None);
        green.number = 9;
        let prs = [
            pr("feat/ok", PrState::Open, ChecksState::Passing, ReviewState::Approved),
            green,
        ];
        let q = run(&s, &st, &prs, 10_000);
        let why = |d: &str| item(&q, d).why.clone();
        assert_eq!(why("/ask").as_deref(), Some("asking"));
        assert_eq!(why("/ok").as_deref(), Some("PR approved"));
        assert_eq!(why("/green").as_deref(), Some("ready to land"));
        assert!(item(&q, "/ok").landable());
        assert!(!item(&q, "/green").landable(), "green but unapproved waits for a human");
        assert!(!item(&q, "/ask").landable());
    }

    #[test]
    fn rows_off_the_on_you_lane_carry_how_long_they_have_been_so() {
        let (s, _) = store(&["busy", "idle"]);
        let mut busy = session("b", AgentStatus::Busy, None, 0);
        busy.phase_since_ms = Some(400);
        let mut idle = session("i", AgentStatus::Idle, None, 0);
        idle.phase_since_ms = Some(700);
        let st = state(vec![folder("/busy", vec![busy]), folder("/idle", vec![idle])]);
        let q = run(&s, &st, &[], 1_000);
        assert_eq!(
            (item(&q, "/busy").lane, item(&q, "/busy").since_ms),
            (Lane::Running, Some(400))
        );
        assert_eq!((item(&q, "/idle").lane, item(&q, "/idle").since_ms), (Lane::Idle, Some(700)));
        let runs = [ci("CI", "feat/busy", CiConclusion::Failure)];
        let st = state(vec![folder("/busy", vec![])]);
        assert_eq!(item(&run_ci(&s, &st, &[], &runs, 0), "/busy").since_ms, Some(10));
    }

    #[test]
    fn a_snooze_on_red_ci_ends_when_its_reason_changes() {
        let (s, _) = store(&["x"]);
        let st = state(vec![folder("/x", vec![])]);
        let runs = [ci("CI", "feat/x", CiConclusion::Failure)];
        let x = "/x";
        snooze(&s, x, "answer", None);
        assert_eq!(item(&run_ci(&s, &st, &[], &runs, 0), x).lane, Lane::OnYou);
        snooze(&s, x, "fix_ci", None);
        let q = run_ci(&s, &st, &[], &runs, 0);
        assert_eq!(item(&q, x).lane, Lane::Parked);
        assert_eq!(q.next, None);
    }

    #[test]
    fn every_checkout_is_a_row_and_ranked_tasks_lead_their_tier() {
        let (s, ids) = store(&["a"]);
        let mut main = folder("/main", vec![waiting("sm", 1)]);
        main.is_worktree = false;
        main.branch = "main".to_string();
        let mut root = folder("/root", vec![]);
        root.is_worktree = false;
        let st = state(vec![
            folder("/a", vec![waiting("sa", 9)]),
            folder("/loose", vec![]),
            main,
            folder("/quiet", vec![]),
            root,
        ]);
        let prs = [
            pr("feat/loose", PrState::Open, ChecksState::Passing, ReviewState::Approved),
            pr("main", PrState::Open, ChecksState::Failing, ReviewState::None),
        ];
        let q = run(&s, &st, &prs, 0);
        use Lane::*;
        use WaitReason::*;
        assert_eq!(
            summary(&q),
            [
                row("a", OnYou, Some(Answer)),
                row("sm says", OnYou, Some(Answer)),
                row("/loose", OnYou, Some(Land)),
                row("/quiet", NoShell, None),
                row("Root", NoShell, None),
            ]
        );
        assert_eq!((item(&q, "/a").task_id, item(&q, "/main").task_id), (Some(ids[0]), None));
        assert_eq!(item(&q, "/main").pr, None, "a root's branch is no PR's head");
    }

    #[test]
    fn a_task_or_pr_or_run_with_no_checkout_is_not_a_row() {
        let (s, _) = store(&["x", "gone"]);
        let st = state(vec![folder("/x", vec![])]);
        let mut red = pr("other", PrState::Open, ChecksState::Failing, ReviewState::None);
        red.number = 2;
        let q = run_ci(&s, &st, &[red], &[ci("Nightly", "main", CiConclusion::Failure)], 0);
        assert_eq!(summary(&q), [row("x", Lane::NoShell, None)]);
    }

    #[test]
    fn red_ci_folds_into_its_task_only() {
        let (s, _) = store(&["a"]);
        let runs = [
            ci("CI", "feat/a", CiConclusion::Failure),
            ci("CI", "feat/b", CiConclusion::Failure),
        ];
        let q = run_ci(&s, &state(vec![folder("/a", vec![])]), &[], &runs, 0);
        assert_eq!(summary(&q), [row("a", Lane::OnYou, Some(WaitReason::FixCi))]);
        assert_eq!(q.items[0].ci.len(), 1, "the task carries its own branch's run");
    }

    #[test]
    fn worktrees_holding_unlanded_work_are_parked() {
        let (s, _) = store(&["ahead", "dirty", "landed"]);
        let mut ahead = folder("/ahead", vec![]);
        ahead.commits_unlanded = 2;
        let mut dirty = folder("/dirty", vec![]);
        dirty.dirty = true;
        let mut landed = folder("/landed", vec![]);
        landed.landed = Some("merged".to_string());
        landed.commits_unlanded = 2;
        let q = run(&s, &state(vec![ahead, dirty, landed]), &[], 0);
        let mut got = summary(&q);
        got.sort();
        use Lane::*;
        assert_eq!(
            got,
            [
                row("ahead", Parked, None),
                row("dirty", Parked, None),
                row("landed", NoShell, None),
            ]
        );
    }

    #[test]
    fn reranking_changes_next_up() {
        let (s, ids) = store(&["a", "b"]);
        let st = state(vec![
            folder("/a", vec![waiting("sa", 1)]),
            folder("/b", vec![waiting("sb", 1)]),
        ]);
        assert_eq!(run(&s, &st, &[], 0).next, next("/a"));
        s.move_task(ids[1], RankMove::Top).unwrap();
        assert_eq!(run(&s, &st, &[], 0).next, next("/b"));
    }

    #[test]
    fn enums_serialize_snake_case() {
        assert_eq!(serde_json::to_value(WaitReason::FixCi).unwrap(), serde_json::json!("fix_ci"));
        assert_eq!(serde_json::to_value(Lane::Idle).unwrap(), serde_json::json!("idle"));
        assert_eq!(serde_json::to_value(Lane::NoShell).unwrap(), serde_json::json!("no_shell"));
    }

    fn pr_item(branch: &str, state: PrState) -> PrItem {
        pr(branch, state, ChecksState::None, ReviewState::None)
    }

    #[test]
    fn derive_lane_orders_waiting_over_working_over_parked_over_rest() {
        let wait = Some(WaitReason::Land);
        assert_eq!(derive_lane(wait, 0, true, true), Lane::OnYou);
        assert_eq!(derive_lane(None, 2, true, true), Lane::Running);
        assert_eq!(derive_lane(None, 0, true, true), Lane::Parked);
        assert_eq!(derive_lane(None, 0, false, true), Lane::Idle);
        assert_eq!(derive_lane(None, 0, false, false), Lane::NoShell);
    }

    #[test]
    fn lookup_matches_repo_case_insensitively_and_prefers_the_first_open_pr() {
        let mut newer = pr_item("feat/x", PrState::Open);
        newer.number = 8;
        newer.repo = "O/Repo".to_string();
        let mut older = pr_item("feat/x", PrState::Open);
        older.number = 3;
        let mut merged = pr_item("feat/y", PrState::Merged);
        merged.number = 4;
        let prs = [newer, older, merged];
        let lookup = Lookup::new(&prs, &[]);
        assert_eq!(lookup.branch_pr("o/repo", "feat/x").map(|p| p.number), Some(8));
        assert_eq!(lookup.branch_pr("o/repo", "feat/y"), None, "a merged PR heads no live branch");
    }
}
