//! The task queue: every open board task in one order, with what each is
//! waiting on the user for. Pure — agent waits come from the PTY-first
//! `needs_reason`, landed state from the rail's `ops::work_state`, PR facts
//! from the collector cache; only rank and snoozes are the user's.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use tt_store::{PrItem, TaskItem, TaskSnooze};

use crate::bridge::StatePayload;
use crate::types::{FolderData, NeedsYouReason, SessionData};

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
    Start,
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
            Self::Start => "start",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Lane {
    OnYou,
    Running,
    Parked,
    Backlog,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    pub key: QueueKey,
    pub lane: Lane,
    pub reason: Option<WaitReason>,
    pub also: Vec<WaitReason>,
    pub title: String,
    pub goal: Option<String>,
    pub repo: String,
    pub branch: Option<String>,
    pub folder_dir: Option<String>,
    pub session_id: Option<String>,
    /// The session's own reported line — never terminal output.
    pub said: Option<String>,
    pub running_agents: u32,
    pub pr: Option<QueuePr>,
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
    pub snoozes: &'a [TaskSnooze],
    pub now_ms: i64,
}

pub fn build(inputs: QueueInputs<'_>) -> TaskQueue {
    let folders: HashMap<&str, (&str, Option<&str>, &FolderData)> = inputs
        .state
        .repos
        .iter()
        .flat_map(|r| {
            r.folders
                .iter()
                .map(move |f| (f.dir.as_str(), (r.name.as_str(), r.origin_url.as_deref(), f)))
        })
        .collect();
    let snoozes: HashMap<i64, &TaskSnooze> =
        inputs.snoozes.iter().map(|s| (s.task_id, s)).collect();

    let mut items = Vec::new();
    let mut task_dirs = HashSet::new();
    for task in inputs.tasks.iter().filter(|t| !t.closed && t.archived_at.is_none()) {
        let dir = task.worktree.as_ref().and_then(|w| w.dir.as_deref());
        if let Some(dir) = dir {
            task_dirs.insert(dir);
        }
        let folder = dir.and_then(|d| folders.get(d));
        let mut item = base_item(QueueKey::Task { id: task.id }, task.rank, folder.copied());
        item.title = task.text.clone();
        item.goal = task.goal.clone();
        if item.repo.is_empty() {
            item.repo = task.worktree.as_ref().and_then(|w| w.repo.clone()).unwrap_or_default();
        }
        if item.branch.is_none() {
            item.branch = task.worktree.as_ref().and_then(|w| w.branch.clone());
        }
        item.pr = task_pr(task, &item, inputs.prs);
        let mut reasons = agent_reasons(folder.map(|f| f.2), &mut item);
        reasons.extend(pr_reasons(item.pr.as_ref()));
        if folder.is_some_and(|f| holds_landed_work(f.2, item.pr.as_ref())) {
            reasons.push((WaitReason::Cleanup, None));
        }
        settle(&mut item, reasons);
        item.said = folder.and_then(|f| said_for(f.2, item.session_id.as_deref()));
        if let Some(reason) = item.reason
            && let Some(snooze) = snoozes.get(&task.id)
            && snooze.reason == reason.as_str()
            && snooze.until_ms.is_none_or(|until| until > inputs.now_ms)
        {
            item.lane = Lane::Parked;
            item.snoozed = true;
            item.snoozed_until_ms = snooze.until_ms;
        }
        items.push(item);
    }

    for (dir, folder) in &folders {
        if task_dirs.contains(dir)
            || !folder.2.sessions.iter().any(|s| s.live && s.agent_state.is_some())
        {
            continue;
        }
        let mut item =
            base_item(QueueKey::Unfiled { folder_dir: dir.to_string() }, i64::MAX, Some(*folder));
        let reasons = agent_reasons(Some(folder.2), &mut item);
        settle(&mut item, reasons);
        if !matches!(item.lane, Lane::OnYou | Lane::Running) {
            continue;
        }
        item.said = said_for(folder.2, item.session_id.as_deref());
        item.title = item.said.clone().unwrap_or_else(|| folder.2.name.clone());
        items.push(item);
    }

    promote_start(&mut items, &snoozes, inputs.now_ms);
    items.sort_by(|a, b| {
        order_key(a).cmp(&order_key(b)).then_with(|| key_str(&a.key).cmp(&key_str(&b.key)))
    });
    let next = items
        .iter()
        .find(|i| i.lane == Lane::OnYou)
        .or_else(|| items.iter().find(|i| i.lane == Lane::Backlog))
        .map(|i| i.key.clone());
    TaskQueue { next, items }
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

fn base_item(
    key: QueueKey,
    rank: i64,
    folder: Option<(&str, Option<&str>, &FolderData)>,
) -> QueueItem {
    let repo = folder
        .map(|(name, origin, _)| {
            origin
                .and_then(tt_git::task_assign::repo_slug_from_remote_preserving_case)
                .unwrap_or_else(|| name.to_string())
        })
        .unwrap_or_default();
    QueueItem {
        key,
        lane: Lane::Backlog,
        reason: None,
        also: Vec::new(),
        title: String::new(),
        goal: None,
        repo,
        branch: folder.map(|f| f.2.branch.clone()),
        folder_dir: folder.map(|f| f.2.dir.clone()),
        session_id: None,
        said: None,
        running_agents: 0,
        pr: None,
        rank,
        since_ms: None,
        snoozed_until_ms: None,
        snoozed: false,
    }
}

/// Agent waits per session, plus the running count and the session to open.
fn agent_reasons(
    folder: Option<&FolderData>,
    item: &mut QueueItem,
) -> Vec<(WaitReason, Option<(i64, String)>)> {
    let Some(folder) = folder else {
        return Vec::new();
    };
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
    let by_branch = || {
        let branch = item.branch.as_deref()?;
        prs.iter().find(|p| {
            p.state == "open" && p.branch == branch && p.repo.eq_ignore_ascii_case(&item.repo)
        })
    };
    linked.or_else(by_branch).map(|p| QueuePr {
        repo: p.repo.clone(),
        number: p.number,
        url: p.url.clone(),
        state: p.state.clone(),
        checks: p.checks.clone(),
        review_state: p.review_state.clone(),
    })
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

/// Landed by git or by a merged PR, and nothing in the folder would be lost.
fn holds_landed_work(folder: &FolderData, pr: Option<&QueuePr>) -> bool {
    let landed = folder.landed.is_some() || pr.is_some_and(|p| p.state == "merged");
    folder.is_worktree && landed && !folder.dirty && folder.commits_unlanded == 0
}

/// Most severe reason wins; on a tie, the oldest wait — and its session is the one to open.
fn settle(item: &mut QueueItem, mut reasons: Vec<(WaitReason, Option<(i64, String)>)>) {
    reasons.sort_by_key(|(r, s)| (*r, s.as_ref().map_or(i64::MAX, |s| s.0)));
    let mut seen = HashSet::new();
    reasons.retain(|(r, _)| seen.insert(*r));
    let Some((primary, session)) = reasons.first().cloned() else {
        item.lane = if item.running_agents > 0 {
            Lane::Running
        } else if item.pr.as_ref().is_some_and(|p| p.state == "open") {
            Lane::Parked
        } else {
            Lane::Backlog
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

/// The top-ranked backlog task becomes `start`; one snoozed from starting is parked.
fn promote_start(items: &mut [QueueItem], snoozes: &HashMap<i64, &TaskSnooze>, now_ms: i64) {
    for item in items.iter_mut().filter(|i| i.lane == Lane::Backlog) {
        let QueueKey::Task { id } = item.key else {
            continue;
        };
        if let Some(s) = snoozes.get(&id)
            && s.reason == WaitReason::Start.as_str()
            && s.until_ms.is_none_or(|u| u > now_ms)
        {
            item.lane = Lane::Parked;
            item.snoozed = true;
            item.snoozed_until_ms = s.until_ms;
        }
    }
    if let Some(item) = items.iter_mut().filter(|i| i.lane == Lane::Backlog).min_by_key(|i| i.rank)
    {
        item.lane = Lane::OnYou;
        item.reason = Some(WaitReason::Start);
    }
}

fn said_for(folder: &FolderData, session_id: Option<&str>) -> Option<String> {
    folder.sessions.iter().find(|s| Some(s.id.as_str()) == session_id).and_then(session_said)
}

#[cfg(test)]
mod tests {
    use tt_store::{RankMove, Store};

    use super::*;
    use crate::types::{AgentEvent, AgentStatus, RepoData};

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
        build(QueueInputs {
            tasks: &s.open_tasks().unwrap(),
            state: st,
            prs,
            snoozes: &s.task_snoozes().unwrap(),
            now_ms,
        })
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
            folder(
                "/c",
                vec![session(
                    "sc",
                    AgentStatus::Waiting,
                    Some(NeedsYouReason::WaitingForInput),
                    9,
                )],
            ),
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
    }

    #[test]
    fn running_parked_backlog_and_one_start() {
        let (s, _) = store(&["run", "park", "b1", "b2"]);
        let st = state(vec![folder(
            "/run",
            vec![session("s", AgentStatus::Busy, None, 0)],
        )]);
        let q = run(&s, &st, &[pr("feat/park", "open", "pending", "")], 0);
        use Lane::*;
        assert_eq!(
            summary(&q),
            [
                row("b1", OnYou, Some(WaitReason::Start)),
                row("run", Running, None),
                row("park", Parked, None),
                row("b2", Backlog, None),
            ]
        );
        assert_eq!(q.items[1].running_agents, 1);
    }

    #[test]
    fn pr_reasons_land_and_review_and_a_working_agent_hides_them() {
        let (s, _) = store(&["land", "rev", "busy"]);
        let st = state(vec![folder(
            "/busy",
            vec![session("s", AgentStatus::Busy, None, 0)],
        )]);
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
        assert_eq!(q.items[1].reason, Some(WaitReason::Start), "dirty is just backlog");
    }

    #[test]
    fn snooze_parks_only_while_the_reason_and_time_hold() {
        let (s, ids) = store(&["a", "b"]);
        let st = state(vec![folder(
            "/a",
            vec![session(
                "s",
                AgentStatus::Waiting,
                Some(NeedsYouReason::WaitingForInput),
                1,
            )],
        )]);
        s.snooze_task(ids[0], "answer", Some(100), 0).unwrap();
        let q = run(&s, &st, &[], 50);
        assert_eq!(q.items.iter().find(|i| i.title == "a").unwrap().lane, Lane::Parked);
        assert!(q.items.iter().find(|i| i.title == "a").unwrap().snoozed);
        assert_eq!(q.items[0].title, "b", "b is promoted to start in its place");
        assert_eq!(run(&s, &st, &[], 150).items[0].title, "a", "expired");
        s.snooze_task(ids[0], "review", None, 0).unwrap();
        assert_eq!(run(&s, &st, &[], 50).items[0].title, "a", "a new reason resurfaces it");
        s.snooze_task(ids[1], "start", None, 0).unwrap();
        s.snooze_task(ids[0], "answer", None, 0).unwrap();
        assert_eq!(run(&s, &st, &[], 50).next, None);
    }

    #[test]
    fn unfiled_agents_are_listed_after_tasks_and_idle_ones_dropped() {
        let (s, _) = store(&["a"]);
        let st = state(vec![
            folder(
                "/a",
                vec![session(
                    "sa",
                    AgentStatus::Waiting,
                    Some(NeedsYouReason::WaitingForInput),
                    9,
                )],
            ),
            folder(
                "/loose",
                vec![session(
                    "sl",
                    AgentStatus::Waiting,
                    Some(NeedsYouReason::WaitingForInput),
                    1,
                )],
            ),
            folder("/idle", vec![session("si", AgentStatus::Idle, None, 0)]),
        ]);
        let q = run(&s, &st, &[], 0);
        assert_eq!(q.items.len(), 2);
        assert_eq!(q.items[1].key, QueueKey::Unfiled { folder_dir: "/loose".to_string() });
        assert_eq!(q.items[1].title, "sl says");
    }

    #[test]
    fn reranking_changes_next_up() {
        let (s, ids) = store(&["a", "b"]);
        let st = state(vec![
            folder(
                "/a",
                vec![session(
                    "sa",
                    AgentStatus::Waiting,
                    Some(NeedsYouReason::WaitingForInput),
                    1,
                )],
            ),
            folder(
                "/b",
                vec![session(
                    "sb",
                    AgentStatus::Waiting,
                    Some(NeedsYouReason::WaitingForInput),
                    1,
                )],
            ),
        ]);
        assert_eq!(run(&s, &st, &[], 0).next, Some(QueueKey::Task { id: ids[0] }));
        s.move_task(ids[1], RankMove::Top).unwrap();
        assert_eq!(run(&s, &st, &[], 0).next, Some(QueueKey::Task { id: ids[1] }));
    }

    #[test]
    fn keys_serialize_tagged_camel_case() {
        let key = QueueKey::Unfiled { folder_dir: "/x".to_string() };
        assert_eq!(
            serde_json::to_value(&key).unwrap(),
            serde_json::json!({"kind": "unfiled", "folderDir": "/x"})
        );
        assert_eq!(serde_json::to_value(WaitReason::FixCi).unwrap(), serde_json::json!("fix_ci"));
    }
}
