//! The task queue: every checkout on Agent Board, in the order to work them —
//! what waits on you, then what runs, what's parked, what's idle. A checkout a
//! board task owns is that task's row. Pure — agent waits come from the
//! PTY-first `needs_reason`, landed state from the rail's `ops::work_state`, PR
//! and CI facts from the collector cache; only rank and snoozes are the user's.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tt_store::{CiRun, PrItem, QueueSnooze, TaskItem};

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
    Running,
    Parked,
    Idle,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum QueueKey {
    Task { id: i64 },
    Unfiled { folder_dir: String },
}

impl QueueKey {
    /// The stable string a snooze is stored under; the store never parses it.
    pub fn snooze_key(&self) -> String {
        match self {
            Self::Task { id } => format!("task:{id}"),
            Self::Unfiled { folder_dir } => format!("unfiled:{folder_dir}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuePr {
    pub repo: String,
    pub number: i64,
    pub url: String,
    pub state: String,
    pub checks: String,
    pub review_state: String,
}

/// One failing workflow run folded into an item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueCi {
    pub workflow: String,
    pub url: String,
    pub conclusion: String,
    pub updated_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    pub key: QueueKey,
    pub lane: Lane,
    pub reason: Option<WaitReason>,
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
    pub rank: i64,
    pub since_ms: Option<i64>,
    pub snoozed_until_ms: Option<i64>,
    pub snoozed: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskQueue {
    pub next: Option<QueueKey>,
    pub items: Vec<QueueItem>,
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
    let failing = failing_ci(inputs.ci_runs);

    let mut items: Vec<QueueItem> = inputs
        .state
        .repos
        .iter()
        .flat_map(|r| r.folders.iter().map(move |f| (r, f)))
        .map(|(repo, folder)| {
            let task = owners.get(folder.dir.as_str()).copied();
            checkout_item(repo, folder, task, inputs.prs, &failing)
        })
        .collect();
    for item in &mut items {
        apply_snooze(item, &snoozes, inputs.now_ms);
    }
    items.sort_by(|a, b| {
        order_key(a).cmp(&order_key(b)).then_with(|| key_str(&a.key).cmp(&key_str(&b.key)))
    });
    let next = items.iter().find(|i| i.lane == Lane::OnYou).map(|i| i.key.clone());
    TaskQueue { next, items }
}

/// One checkout's row — its task's, when a task owns it.
fn checkout_item(
    repo: &RepoData,
    folder: &FolderData,
    task: Option<&TaskItem>,
    prs: &[PrItem],
    failing: &[&CiRun],
) -> QueueItem {
    let key = match task {
        Some(t) => QueueKey::Task { id: t.id },
        None => QueueKey::Unfiled { folder_dir: folder.dir.clone() },
    };
    let mut item = base_item(key, task.map_or(i64::MAX, |t| t.rank), repo, folder);
    // A main checkout owns no branch's PR or CI.
    item.pr = match task {
        Some(t) => task_pr(t, &item, prs),
        None if folder.is_worktree => branch_pr(&item, prs),
        None => None,
    };
    if folder.is_worktree {
        item.ci = branch_ci(&item, failing);
    }
    let mut reasons = agent_reasons(folder, &mut item);
    reasons.extend(pr_reasons(item.pr.as_ref()));
    reasons.extend(ci_reasons(&item.ci));
    if task.is_some() && holds_landed_work(folder, item.pr.as_ref()) {
        reasons.push((WaitReason::Cleanup, None));
    }
    settle(&mut item, reasons);
    if item.lane == Lane::Idle && holds_unlanded_work(folder) {
        item.lane = Lane::Parked;
    }
    item.said = said_for(folder, item.session_id.as_deref());
    item.title = match task {
        Some(t) => t.text.clone(),
        None => item.said.clone().unwrap_or_else(|| folder.name.clone()),
    };
    item
}

/// Lane, then — in On you — agent-blocking reasons first, then rank, severity, age.
pub fn order_key(item: &QueueItem) -> (Lane, u8, i64, Option<WaitReason>, i64) {
    let tier = match (item.lane, item.reason) {
        (Lane::OnYou, Some(r)) if r.blocks_agent() => 0,
        _ => 1,
    };
    (item.lane, tier, item.rank, item.reason, item.since_ms.unwrap_or(i64::MAX))
}

fn key_str(key: &QueueKey) -> String {
    match key {
        QueueKey::Task { id } => format!("task:{id:020}"),
        QueueKey::Unfiled { folder_dir } => format!("unfiled:{folder_dir}"),
    }
}

fn base_item(key: QueueKey, rank: i64, repo: &RepoData, folder: &FolderData) -> QueueItem {
    QueueItem {
        key,
        lane: Lane::Idle,
        reason: None,
        also: Vec::new(),
        title: String::new(),
        repo: repo
            .origin_url
            .as_deref()
            .and_then(tt_git::task_assign::repo_slug_from_remote_preserving_case)
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
        snoozed: false,
    }
}

/// Agent waits per session, plus the running count and the session to open.
fn agent_reasons(
    folder: &FolderData,
    item: &mut QueueItem,
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

/// The task's linked PR, else the open PR on its branch.
fn task_pr(task: &TaskItem, item: &QueueItem, prs: &[PrItem]) -> Option<QueuePr> {
    let linked = task.prs.iter().rev().find_map(|link| {
        prs.iter().find(|p| p.number == link.number && p.repo.eq_ignore_ascii_case(&link.repo))
    });
    linked.map(queue_pr).or_else(|| branch_pr(item, prs))
}

fn branch_pr(item: &QueueItem, prs: &[PrItem]) -> Option<QueuePr> {
    prs.iter()
        .find(|p| {
            p.state == "open" && p.branch == item.branch && p.repo.eq_ignore_ascii_case(&item.repo)
        })
        .map(queue_pr)
}

fn queue_pr(p: &PrItem) -> QueuePr {
    QueuePr {
        repo: p.repo.clone(),
        number: p.number,
        url: p.url.clone(),
        state: p.state.clone(),
        checks: p.checks.clone(),
        review_state: p.review_state.clone(),
    }
}

/// A finished run that broke: the client's `ciTone` "failed".
fn failing_ci(runs: &[CiRun]) -> Vec<&CiRun> {
    runs.iter()
        .filter(|r| {
            r.status == "completed"
                && matches!(r.conclusion.as_str(), "failure" | "timed_out" | "startup_failure")
        })
        .collect()
}

/// The failing runs on the item's own branch of its repo.
fn branch_ci(item: &QueueItem, failing: &[&CiRun]) -> Vec<QueueCi> {
    if item.branch.is_empty() {
        return Vec::new();
    }
    failing
        .iter()
        .filter(|r| r.branch == item.branch && r.repo.eq_ignore_ascii_case(&item.repo))
        .map(|r| QueueCi {
            workflow: r.workflow.clone(),
            url: r.url.clone(),
            conclusion: r.conclusion.clone(),
            updated_ms: r.updated_ms,
        })
        .collect()
}

fn ci_reasons(ci: &[QueueCi]) -> Vec<(WaitReason, Option<(i64, String)>)> {
    if ci.is_empty() { Vec::new() } else { vec![(WaitReason::FixCi, None)] }
}

fn pr_reasons(pr: Option<&QueuePr>) -> Vec<(WaitReason, Option<(i64, String)>)> {
    let Some(pr) = pr.filter(|p| p.state == "open") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if pr.checks == "failing" {
        out.push((WaitReason::FixCi, None));
    }
    if pr.review_state == "changes_requested" {
        out.push((WaitReason::AddressReview, None));
    }
    let green = matches!(pr.checks.as_str(), "passing" | "none");
    if out.is_empty() && green && matches!(pr.review_state.as_str(), "approved" | "") {
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
    let landed = folder.landed.is_some() || pr.is_some_and(|p| p.state == "merged");
    folder.is_worktree && landed && !folder.dirty && folder.commits_unlanded == 0
}

/// Most severe reason wins; on a tie, the oldest wait — and its session is the one to open.
fn settle(item: &mut QueueItem, mut reasons: Vec<(WaitReason, Option<(i64, String)>)>) {
    reasons.sort_by_key(|(r, s)| (*r, s.as_ref().map_or(i64::MAX, |s| s.0)));
    let mut seen = std::collections::HashSet::new();
    reasons.retain(|(r, _)| seen.insert(*r));
    let Some((primary, session)) = reasons.first().cloned() else {
        item.lane = if item.running_agents > 0 {
            Lane::Running
        } else if item.pr.as_ref().is_some_and(|p| p.state == "open") {
            Lane::Parked
        } else {
            Lane::Idle
        };
        return;
    };
    item.lane = Lane::OnYou;
    item.reason = Some(primary);
    item.also = reasons[1..].iter().map(|(r, _)| *r).collect();
    if let Some((since, id)) = session {
        item.since_ms = (since != i64::MAX).then_some(since);
        item.session_id = Some(id);
    }
    if item.running_agents > 0 && !primary.blocks_agent() && primary != WaitReason::Review {
        item.lane = Lane::Running;
        item.reason = None;
        item.also.clear();
    }
}

/// Parks a row the user snoozed — while the reason it was set on is still the
/// row's reason and the time has not run out, so a new reason resurfaces it.
fn apply_snooze(item: &mut QueueItem, snoozes: &HashMap<&str, &QueueSnooze>, now_ms: i64) {
    let Some(reason) = item.reason else {
        return;
    };
    if let Some(s) = snoozes.get(item.key.snooze_key().as_str())
        && s.reason == reason.as_str()
        && s.until_ms.is_none_or(|u| u > now_ms)
    {
        item.lane = Lane::Parked;
        item.snoozed = true;
        item.snoozed_until_ms = s.until_ms;
    }
}

fn said_for(folder: &FolderData, session_id: Option<&str>) -> Option<String> {
    folder.sessions.iter().find(|s| Some(s.id.as_str()) == session_id).and_then(session_said)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

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
            }],
            compact_recommend_percent: 30,
            windows: Default::default(),
            collapsed: Default::default(),
            agent_scan_ok: true,
            ts: 0,
        }
    }

    fn pr(branch: &str, state: &str, checks: &str, review: &str) -> PrItem {
        PrItem {
            repo: "o/repo".to_string(),
            number: 7,
            title: "t".to_string(),
            branch: branch.to_string(),
            state: state.to_string(),
            checks: checks.to_string(),
            review_state: review.to_string(),
            url: "u".to_string(),
            updated_ts: 0,
            dismissed_ts: 0,
        }
    }

    fn ci(workflow: &str, branch: &str, conclusion: &str) -> CiRun {
        CiRun {
            repo: "o/repo".to_string(),
            workflow: workflow.to_string(),
            status: "completed".to_string(),
            conclusion: conclusion.to_string(),
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

    fn snooze(s: &Store, key: &QueueKey, reason: &str, until_ms: Option<i64>) {
        s.snooze_queue_item(&key.snooze_key(), reason, until_ms, 0).unwrap();
    }

    fn item<'q>(q: &'q TaskQueue, key: &QueueKey) -> &'q QueueItem {
        q.items.iter().find(|i| &i.key == key).unwrap()
    }

    fn summary(q: &TaskQueue) -> Vec<(String, Lane, Option<WaitReason>)> {
        q.items.iter().map(|i| (i.title.clone(), i.lane, i.reason)).collect()
    }

    fn row(t: &str, lane: Lane, r: Option<WaitReason>) -> (String, Lane, Option<WaitReason>) {
        (t.to_string(), lane, r)
    }

    fn unfiled(dir: &str) -> QueueKey {
        QueueKey::Unfiled { folder_dir: dir.to_string() }
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
        let q = run(&s, &st, &[pr("feat/b", "open", "failing", "")], 0);
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
        assert_eq!(q.next, Some(head.key.clone()));
        assert_eq!((head.session_id.as_deref(), head.since_ms), (Some("sc"), Some(9)));
        assert_eq!(head.said.as_deref(), Some("sc says"));
        assert_eq!(head.repo, "o/repo");
        assert_eq!(head.folder_dir, "/c");
    }

    #[test]
    fn running_parked_and_idle_with_nothing_on_you() {
        let (s, _) = store(&["run", "park", "idle"]);
        let st = state(vec![
            folder("/run", vec![session("s", AgentStatus::Busy, None, 0)]),
            folder("/park", vec![]),
            folder("/idle", vec![]),
        ]);
        let q = run(&s, &st, &[pr("feat/park", "open", "pending", "")], 0);
        use Lane::*;
        assert_eq!(
            summary(&q),
            [
                row("run", Running, None),
                row("park", Parked, None),
                row("idle", Idle, None)
            ]
        );
        assert_eq!(q.items[0].running_agents, 1);
        assert_eq!(q.next, None, "nothing waits on you, so there is no next up");
    }

    #[test]
    fn pr_reasons_land_and_review_and_a_working_agent_hides_them() {
        let (s, _) = store(&["land", "rev", "busy"]);
        let st = state(vec![
            folder("/land", vec![]),
            folder("/rev", vec![]),
            folder("/busy", vec![session("s", AgentStatus::Busy, None, 0)]),
        ]);
        let mut busy = pr("feat/busy", "open", "failing", "");
        busy.number = 9;
        let prs = [
            pr("feat/land", "open", "passing", "approved"),
            pr("feat/rev", "open", "passing", "changes_requested"),
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
        let q = run(&s, &st, &[pr("feat/a", "open", "failing", "")], 0);
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
        assert_eq!(q.items[1].lane, Lane::Idle, "dirty is left alone");
    }

    #[test]
    fn snooze_parks_only_while_the_reason_and_time_hold() {
        let (s, ids) = store(&["a", "b"]);
        let st = state(vec![folder("/a", vec![waiting("s", 1)]), folder("/b", vec![])]);
        let a = QueueKey::Task { id: ids[0] };
        snooze(&s, &a, "answer", Some(100));
        let q = run(&s, &st, &[], 50);
        assert_eq!(item(&q, &a).lane, Lane::Parked);
        assert!(item(&q, &a).snoozed);
        assert_eq!(q.next, None);
        assert_eq!(run(&s, &st, &[], 150).next, Some(a.clone()), "expired");
        snooze(&s, &a, "review", None);
        assert_eq!(run(&s, &st, &[], 50).next, Some(a), "a new reason resurfaces it");
    }

    #[test]
    fn a_snooze_holds_one_row_only() {
        let (s, _) = store(&[]);
        let st = state(vec![
            folder("/loose", vec![waiting("sl", 1)]),
            folder("/other", vec![waiting("so", 1)]),
        ]);
        let (loose, other) = (unfiled("/loose"), unfiled("/other"));
        snooze(&s, &loose, "answer", Some(100));
        let q = run(&s, &st, &[], 50);
        assert_eq!(item(&q, &loose).lane, Lane::Parked);
        assert_eq!(item(&q, &loose).snoozed_until_ms, Some(100));
        assert_eq!(item(&q, &other).lane, Lane::OnYou, "a sibling row is untouched");
        assert_eq!(q.next, Some(other));
        assert_eq!(item(&run(&s, &st, &[], 150), &loose).lane, Lane::OnYou, "timed out");
    }

    #[test]
    fn a_snooze_on_red_ci_ends_when_its_reason_changes() {
        let (s, _) = store(&[]);
        let st = state(vec![folder("/x", vec![])]);
        let runs = [ci("CI", "feat/x", "failure")];
        let x = unfiled("/x");
        snooze(&s, &x, "answer", None);
        assert_eq!(item(&run_ci(&s, &st, &[], &runs, 0), &x).lane, Lane::OnYou);
        snooze(&s, &x, "fix_ci", None);
        let q = run_ci(&s, &st, &[], &runs, 0);
        assert_eq!(item(&q, &x).lane, Lane::Parked);
        assert_eq!(q.next, None);
    }

    #[test]
    fn snooze_keys_are_distinct_per_kind() {
        let keys = [QueueKey::Task { id: 1 }, unfiled("1")];
        let strs: HashSet<String> = keys.iter().map(QueueKey::snooze_key).collect();
        assert_eq!(strs.len(), 2);
        assert_eq!(keys[1].snooze_key(), "unfiled:1");
    }

    #[test]
    fn every_checkout_is_a_row_and_tasks_outrank_loose_ones() {
        let (s, _) = store(&["a"]);
        let st = state(vec![
            folder("/a", vec![waiting("sa", 9)]),
            folder("/loose", vec![waiting("sl", 1)]),
            folder("/idle", vec![session("si", AgentStatus::Idle, None, 0)]),
            folder("/empty", vec![]),
        ]);
        let q = run(&s, &st, &[], 0);
        use Lane::*;
        let answer = Some(WaitReason::Answer);
        assert_eq!(
            summary(&q),
            [
                row("a", OnYou, answer),
                row("sl says", OnYou, answer),
                row("/empty", Idle, None),
                row("si says", Idle, None),
            ]
        );
        assert_eq!(q.items[1].key, unfiled("/loose"));
    }

    #[test]
    fn a_task_or_pr_or_run_with_no_checkout_is_not_a_row() {
        let (s, _) = store(&["gone"]);
        let st = state(vec![folder("/x", vec![])]);
        let mut red = pr("other", "open", "failing", "");
        red.number = 2;
        let q = run_ci(&s, &st, &[red], &[ci("Nightly", "main", "failure")], 0);
        assert_eq!(summary(&q), [row("/x", Lane::Idle, None)]);
    }

    #[test]
    fn red_ci_folds_into_its_worktree_but_a_main_checkout_owns_none() {
        let (s, _) = store(&["a"]);
        let mut main = folder("/main", vec![]);
        main.is_worktree = false;
        main.branch = "main".to_string();
        let runs = [
            ci("CI", "feat/a", "failure"),
            ci("Nightly", "main", "failure"),
        ];
        let q = run_ci(&s, &state(vec![folder("/a", vec![]), main]), &[], &runs, 0);
        assert_eq!(
            summary(&q),
            [
                row("a", Lane::OnYou, Some(WaitReason::FixCi)),
                row("/main", Lane::Idle, None)
            ]
        );
        assert_eq!(q.items[0].ci.len(), 1, "the task carries its own branch's run");
    }

    #[test]
    fn worktrees_holding_unlanded_work_are_parked() {
        let (s, _) = store(&[]);
        let mut ahead = folder("/ahead", vec![]);
        ahead.commits_unlanded = 2;
        let mut dirty = folder("/dirty", vec![]);
        dirty.dirty = true;
        let mut landed = folder("/landed", vec![]);
        landed.landed = Some("merged".to_string());
        landed.commits_unlanded = 2;
        let mut main = folder("/main", vec![]);
        main.is_worktree = false;
        main.dirty = true;
        let q = run(&s, &state(vec![ahead, dirty, landed, main]), &[], 0);
        let mut got = summary(&q);
        got.sort();
        use Lane::*;
        assert_eq!(
            got,
            [
                row("/ahead", Parked, None),
                row("/dirty", Parked, None),
                row("/landed", Idle, None),
                row("/main", Idle, None),
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
        assert_eq!(run(&s, &st, &[], 0).next, Some(QueueKey::Task { id: ids[0] }));
        s.move_task(ids[1], RankMove::Top).unwrap();
        assert_eq!(run(&s, &st, &[], 0).next, Some(QueueKey::Task { id: ids[1] }));
    }

    #[test]
    fn keys_serialize_tagged_camel_case() {
        assert_eq!(
            serde_json::to_value(unfiled("/x")).unwrap(),
            serde_json::json!({"kind": "unfiled", "folderDir": "/x"})
        );
        assert_eq!(serde_json::to_value(WaitReason::FixCi).unwrap(), serde_json::json!("fix_ci"));
        assert_eq!(serde_json::to_value(Lane::Idle).unwrap(), serde_json::json!("idle"));
    }
}
