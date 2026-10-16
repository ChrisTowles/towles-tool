//! The board replayed from a recorded or hand-written scenario: checkouts,
//! their sessions, and each session's status over time. [`frame`] builds the
//! [`StatePayload`] and [`TaskQueue`] the app would emit at any instant through
//! the real `recompute_needs` and `queue::build`, so the rail can be watched —
//! and the row churn counted ([`lane_changes`]) — without live agents.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tt_store::PrItem;

use crate::bridge::{SinceStamps, StatePayload, needs_reason, recompute_needs};
use crate::queue::{Lane, QueueInputs, TaskQueue};
use crate::repo_meta::{HexColor, resolve_colors};
use crate::types::{
    AgentEvent, AgentEventDetails, AgentStatus, FolderData, RepoData, RowRecord, RowTask,
    SessionData,
};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scenario {
    pub name: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub checkouts: Vec<SimCheckout>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SimCheckout {
    pub repo: String,
    pub dir: String,
    pub branch: String,
    pub is_worktree: bool,
    pub dirty: bool,
    pub commits_unlanded: i64,
    /// Committed files, lines added, lines removed.
    pub diff: (i64, i64, i64),
    pub landed: Option<String>,
    pub pr: Option<SimPr>,
    pub sessions: Vec<SimSession>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SimPr {
    pub number: i64,
    pub state: String,
    pub checks: String,
    pub review_state: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SimSession {
    pub id: String,
    pub title: Option<String>,
    /// The shell exists from here (the scenario's start when absent)…
    pub opened_ms: Option<i64>,
    /// …until here.
    pub closed_ms: Option<i64>,
    pub steps: Vec<SimStep>,
}

/// A change at `t`; an absent field keeps its previous value.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SimStep {
    pub t: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<AgentStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<i64>,
    /// The user looked: a finished turn stops being unseen.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub seen: bool,
    /// The user typed the prompt this turn answers; otherwise a report Claude
    /// Code delivered (a background task, a monitor, a wakeup) started it.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub prompted: bool,
}

/// Where one session stands at an instant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SessionAt {
    status: AgentStatus,
    background: i64,
    unseen: bool,
    /// When it last entered needs-you, while it is there.
    needs_since: Option<i64>,
    changed_at: i64,
}

fn session_at(session: &SimSession, now_ms: i64) -> Option<SessionAt> {
    let mut at: Option<SessionAt> = None;
    for step in session.steps.iter().take_while(|s| s.t <= now_ms) {
        let prev = at.unwrap_or(SessionAt {
            status: AgentStatus::Idle,
            background: 0,
            unseen: false,
            needs_since: None,
            changed_at: step.t,
        });
        let status = step.status.unwrap_or(prev.status);
        let mut unseen = match step.status {
            Some(s) if s.is_terminal() => prev.unseen || !prev.status.is_terminal(),
            Some(_) => false,
            None => prev.unseen,
        };
        unseen &= !step.seen;
        let mut next = SessionAt {
            status,
            background: step.background.unwrap_or(prev.background),
            unseen,
            needs_since: prev.needs_since,
            changed_at: if status == prev.status { prev.changed_at } else { step.t },
        };
        let needs = needs_reason(&session_data(session, &next, now_ms)).is_some();
        next.needs_since = match (needs, prev.needs_since) {
            (false, _) => None,
            (true, Some(since)) => Some(since),
            (true, None) => Some(step.t),
        };
        at = Some(next);
    }
    at
}

fn session_data(session: &SimSession, at: &SessionAt, created_at: i64) -> SessionData {
    let details = (at.background > 0)
        .then(|| AgentEventDetails { background_tasks: Some(at.background), ..Default::default() });
    let agent = AgentEvent {
        agent: "claude-code".to_string(),
        session: session.id.clone(),
        status: at.status,
        ts: at.changed_at,
        thread_id: Some(session.id.clone()),
        thread_name: session.title.clone(),
        unseen: Some(at.unseen),
        details,
    };
    SessionData {
        id: session.id.clone(),
        name: "claude".to_string(),
        created_at,
        live: true,
        shell_kind: Some("zsh".to_string()),
        unseen: at.unseen,
        working: agent.is_working(),
        agent_state: Some(agent.clone()),
        agents: vec![agent],
        ..Default::default()
    }
}

fn folder_data(
    checkout: &SimCheckout,
    index: usize,
    start_ms: i64,
    now_ms: i64,
    since: &mut SinceStamps,
) -> FolderData {
    let mut worked_at_ms = 0;
    let sessions: Vec<SessionData> = checkout
        .sessions
        .iter()
        .filter(|s| {
            s.opened_ms.is_none_or(|t| t <= now_ms) && s.closed_ms.is_none_or(|t| t > now_ms)
        })
        .map(|s| {
            let opened = s.opened_ms.unwrap_or(start_ms);
            let at = session_at(s, now_ms).unwrap_or(SessionAt {
                status: AgentStatus::Idle,
                background: 0,
                unseen: false,
                needs_since: None,
                changed_at: opened,
            });
            worked_at_ms = worked_at_ms.max(at.changed_at);
            if let Some(t) = at.needs_since {
                since.seed(&s.id, t);
            }
            session_data(s, &at, opened)
        })
        .collect();
    let name = checkout.dir.rsplit('/').next().unwrap_or_default().to_string();
    let record = if checkout.is_worktree {
        let branch = Some(checkout.branch.clone());
        RowRecord::Task {
            task: RowTask { id: -(index as i64 + 1), status: "in_progress".into(), branch },
        }
    } else {
        RowRecord::Checkout
    };
    let (files, added, removed) = checkout.diff;
    FolderData {
        name,
        dir: checkout.dir.clone(),
        record,
        branch: checkout.branch.clone(),
        is_worktree: checkout.is_worktree,
        committed_files: files,
        committed_added: added,
        committed_removed: removed,
        commits_ahead: checkout.commits_unlanded,
        dirty: checkout.dirty,
        commits_unlanded: checkout.commits_unlanded,
        landed: checkout.landed.clone(),
        sessions,
        compared_base: "main".to_string(),
        computed_at_ms: now_ms,
        worked_at_ms: worked_at_ms.max(now_ms - 60_000),
        ..Default::default()
    }
}

fn origin_url(repo: &str) -> String {
    format!("https://github.com/sim/{repo}.git")
}

/// The payload the app would emit at `now_ms`, `recompute_needs` included.
pub fn state_at(scenario: &Scenario, now_ms: i64) -> StatePayload {
    let mut since = SinceStamps::new();
    let mut repos: Vec<RepoData> = Vec::new();
    for (index, checkout) in scenario.checkouts.iter().enumerate() {
        let folder = folder_data(checkout, index, scenario.start_ms, now_ms, &mut since);
        match repos.iter_mut().find(|r| r.name == checkout.repo) {
            Some(repo) if checkout.is_worktree => repo.folders.push(folder),
            Some(repo) => repo.folders.insert(0, folder),
            None => repos.push(RepoData {
                key: format!("path:{}", checkout.dir),
                dir: checkout.dir.clone(),
                name: checkout.repo.clone(),
                origin_url: Some(origin_url(&checkout.repo)),
                folders: vec![folder],
                needs: 0,
                meta: None,
                color: HexColor::default(),
            }),
        }
    }
    let colors = resolve_colors(&vec![None; repos.len()]);
    for (repo, color) in repos.iter_mut().zip(colors) {
        repo.color = color;
        if let Some(root) = repo.folders.iter().find(|f| !f.is_worktree) {
            repo.key = format!("path:{}", root.dir);
            repo.dir = root.dir.clone();
        }
    }
    let mut payload = StatePayload {
        repos,
        compact_recommend_percent: 30,
        windows: Default::default(),
        collapsed: Default::default(),
        agent_scan_ok: true,
        ts: now_ms,
    };
    recompute_needs(&mut payload, &mut since, now_ms);
    payload
}

fn prs(scenario: &Scenario) -> Vec<PrItem> {
    scenario
        .checkouts
        .iter()
        .filter_map(|c| {
            let pr = c.pr.as_ref()?;
            Some(PrItem {
                repo: format!("sim/{}", c.repo),
                number: pr.number,
                title: c.branch.clone(),
                branch: c.branch.clone(),
                state: pr.state.clone(),
                checks: pr.checks.clone(),
                review_state: pr.review_state.clone(),
                url: format!("https://github.com/sim/{}/pull/{}", c.repo, pr.number),
                updated_ts: 0,
                dismissed_ts: 0,
                base_branch: "main".to_string(),
            })
        })
        .collect()
}

/// The board and the queue at `now_ms`.
pub fn frame(scenario: &Scenario, now_ms: i64) -> (StatePayload, TaskQueue) {
    let state = state_at(scenario, now_ms);
    let prs = prs(scenario);
    let queue = crate::queue::build(QueueInputs {
        tasks: &[],
        state: &state,
        prs: &prs,
        ci_runs: &[],
        snoozes: &[],
        now_ms,
    });
    (state, queue)
}

/// [`frame`] at scenario time `sim_ms`, every timestamp moved onto the wall
/// clock so ages read as they would live: what happened a minute before
/// `sim_ms` reads as a minute before `wall_ms`.
pub fn frame_on_wall(scenario: &Scenario, sim_ms: i64, wall_ms: i64) -> (StatePayload, TaskQueue) {
    let (mut state, mut queue) = frame(scenario, sim_ms);
    let d = wall_ms - sim_ms;
    let shift = |t: &mut i64| *t += d;
    state.ts += d;
    for folder in state.repos.iter_mut().flat_map(|r| &mut r.folders) {
        shift(&mut folder.computed_at_ms);
        shift(&mut folder.worked_at_ms);
        for session in &mut folder.sessions {
            shift(&mut session.created_at);
            session.needs_since_ms.iter_mut().for_each(shift);
            for agent in session.agent_state.iter_mut().chain(&mut session.agents) {
                shift(&mut agent.ts);
            }
        }
    }
    for item in &mut queue.items {
        item.since_ms.iter_mut().for_each(shift);
        item.snoozed_until_ms.iter_mut().for_each(shift);
    }
    (state, queue)
}

/// Every lane and wait reason the rail can show, at once, plus two rows that
/// keep moving: an agent you prompt in a loop, and one its own background
/// reports keep waking. Thirty minutes from `start_ms`.
pub fn gallery(start_ms: i64) -> Scenario {
    let at = |s: i64| start_ms + s * 1_000;
    let st = |s: i64, status: AgentStatus| SimStep {
        t: at(s),
        status: Some(status),
        ..Default::default()
    };
    let bg = |s: i64, status: AgentStatus, n: i64| SimStep { background: Some(n), ..st(s, status) };
    let seen = |s: i64| SimStep { t: at(s), seen: true, ..Default::default() };
    let session = |id: &str, title: &str, steps: Vec<SimStep>| SimSession {
        id: id.to_string(),
        title: Some(title.to_string()),
        steps,
        ..Default::default()
    };
    let wt = |repo: &str, name: &str, sessions: Vec<SimSession>| SimCheckout {
        repo: repo.to_string(),
        dir: format!("/sim/{repo}/.claude/worktrees/{name}"),
        branch: format!("feat/{name}"),
        is_worktree: true,
        diff: (3, 48, 12),
        commits_unlanded: 1,
        sessions,
        ..Default::default()
    };
    let root = |repo: &str, sessions: Vec<SimSession>| SimCheckout {
        repo: repo.to_string(),
        dir: format!("/sim/{repo}"),
        branch: "main".to_string(),
        sessions,
        ..Default::default()
    };
    let pr = |number: i64, state: &str, checks: &str, review: &str| SimPr {
        number,
        state: state.to_string(),
        checks: checks.to_string(),
        review_state: review.to_string(),
    };
    use AgentStatus::*;

    // You prompt, it works 40s, finishes; you read it after 20s and prompt 20s later.
    let mut prompted = Vec::new();
    let mut t = 0;
    while t < 1_800 {
        prompted.push(SimStep { prompted: true, ..st(t, Busy) });
        prompted.extend([st(t + 40, Complete), seen(t + 60)]);
        t += 80;
    }
    // A finished turn with a background shell out; each report wakes a short turn.
    let mut woken = vec![SimStep { prompted: true, ..st(0, Busy) }];
    let mut t = 30;
    while t < 1_800 {
        woken.extend([
            bg(t, Complete, 1),
            bg(t + 45, Busy, 0),
            bg(t + 53, Complete, 0),
        ]);
        woken.push(seen(t + 58));
        woken.push(SimStep { t: at(t + 60), prompted: true, ..st(t + 60, Busy) });
        t += 90;
    }

    let checkouts = vec![
        root("towles-tool", vec![session("root", "Root", vec![st(0, Complete), seen(1)])]),
        wt("towles-tool", "running", vec![session("run", "Busy mid-turn", vec![st(0, Busy)])]),
        wt(
            "towles-tool",
            "background-out",
            vec![session(
                "bg",
                "Finished, two background shells out",
                vec![bg(0, Complete, 2)],
            )],
        ),
        wt(
            "towles-tool",
            "asking",
            vec![session("ask", "Asked you a question", vec![st(0, Waiting)])],
        ),
        wt(
            "towles-tool",
            "finished-unseen",
            vec![session(
                "review",
                "Finished, not looked at",
                vec![st(0, Busy), st(2, Complete)],
            )],
        ),
        wt("towles-tool", "errored", vec![session("err", "Hit an API error", vec![st(0, Error)])]),
        wt(
            "towles-tool",
            "interrupted",
            vec![session(
                "int",
                "Interrupted mid-turn",
                vec![st(0, Busy), st(2, Interrupted)],
            )],
        ),
        wt(
            "towles-tool",
            "idle-seen",
            vec![session(
                "idle",
                "Finished and read",
                vec![st(0, Complete), seen(1)],
            )],
        ),
        SimCheckout {
            dirty: true,
            ..wt(
                "towles-tool",
                "parked-dirty",
                vec![session(
                    "pk",
                    "Idle with uncommitted work",
                    vec![st(0, Complete), seen(1)],
                )],
            )
        },
        SimCheckout {
            commits_unlanded: 0,
            diff: (0, 0, 0),
            ..wt("towles-tool", "no-shell", vec![])
        },
        SimCheckout {
            pr: Some(pr(701, "open", "pending", "")),
            ..wt(
                "dotfiles",
                "pr-pending",
                vec![session(
                    "prp",
                    "PR open, checks running",
                    vec![st(0, Complete), seen(1)],
                )],
            )
        },
        SimCheckout {
            pr: Some(pr(702, "open", "passing", "approved")),
            ..wt(
                "dotfiles",
                "pr-land",
                vec![session(
                    "land",
                    "PR approved and green",
                    vec![st(0, Complete), seen(1)],
                )],
            )
        },
        SimCheckout {
            pr: Some(pr(703, "open", "failing", "")),
            ..wt("dotfiles", "pr-failing", vec![])
        },
        SimCheckout {
            pr: Some(pr(704, "open", "passing", "changes_requested")),
            ..wt("dotfiles", "pr-changes", vec![])
        },
        SimCheckout {
            pr: Some(pr(705, "open", "failing", "")),
            ..wt(
                "dotfiles",
                "pr-failing-running",
                vec![session("fr", "Fixing the failing check", vec![st(0, Busy)])],
            )
        },
        SimCheckout {
            landed: Some("merged".into()),
            commits_unlanded: 0,
            diff: (0, 0, 0),
            pr: Some(pr(706, "merged", "passing", "approved")),
            ..wt(
                "dotfiles",
                "landed",
                vec![session(
                    "done",
                    "Merged, clean",
                    vec![st(0, Complete), seen(1)],
                )],
            )
        },
        wt(
            "blog",
            "two-sessions",
            vec![
                session("two-a", "One working", vec![st(0, Busy)]),
                session("two-b", "One asking", vec![st(0, Waiting)]),
            ],
        ),
        wt("blog", "prompt-loop", vec![session("loop", "You prompt it every 80s", prompted)]),
        wt("blog", "self-woken", vec![session("woke", "Background reports wake it", woken)]),
    ];
    Scenario { name: "gallery".into(), start_ms, end_ms: at(1_800), checkouts }
}

/// A checkout's row moving lane — what the eye catches as the queue jumping.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneChange {
    pub at_ms: i64,
    pub folder_dir: String,
    pub from: Lane,
    pub to: Lane,
    /// How long the row sat in `from` before moving.
    pub dwell_ms: i64,
}

/// Every lane change across the scenario, sampled each `step_ms` the way the
/// app's ~2s emit loop would see it.
pub fn lane_changes(scenario: &Scenario, step_ms: i64) -> Vec<LaneChange> {
    let mut last: HashMap<String, (Lane, i64)> = HashMap::new();
    let mut out = Vec::new();
    let mut t = scenario.start_ms;
    while t <= scenario.end_ms {
        let (_, queue) = frame(scenario, t);
        for item in &queue.items {
            match last.get(&item.folder_dir) {
                Some(&(lane, since)) if lane != item.lane => {
                    out.push(LaneChange {
                        at_ms: t,
                        folder_dir: item.folder_dir.clone(),
                        from: lane,
                        to: item.lane,
                        dwell_ms: t - since,
                    });
                    last.insert(item.folder_dir.clone(), (item.lane, t));
                }
                Some(_) => {}
                None => {
                    last.insert(item.folder_dir.clone(), (item.lane, t));
                }
            }
        }
        t += step_ms;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_000_000;

    fn step(t: i64, status: AgentStatus) -> SimStep {
        SimStep { t, status: Some(status), ..Default::default() }
    }

    fn one(steps: Vec<SimStep>) -> Scenario {
        Scenario {
            name: "t".into(),
            start_ms: T0,
            end_ms: T0 + 120_000,
            checkouts: vec![SimCheckout {
                repo: "r".into(),
                dir: "/sim/r/.claude/worktrees/a".into(),
                branch: "feat/a".into(),
                is_worktree: true,
                sessions: vec![SimSession { id: "s".into(), steps, ..Default::default() }],
                ..Default::default()
            }],
        }
    }

    fn lane(s: &Scenario, t: i64) -> Lane {
        frame(s, t).1.items[0].lane
    }

    #[test]
    fn a_finished_turn_waits_on_you_until_seen_then_idles() {
        let mut steps = vec![
            step(T0, AgentStatus::Busy),
            step(T0 + 10_000, AgentStatus::Complete),
        ];
        steps.push(SimStep { t: T0 + 20_000, seen: true, ..Default::default() });
        let s = one(steps);
        assert_eq!(lane(&s, T0 + 5_000), Lane::Running);
        assert_eq!(lane(&s, T0 + 15_000), Lane::OnYou);
        assert_eq!(lane(&s, T0 + 25_000), Lane::Idle);
    }

    #[test]
    fn background_work_out_keeps_a_finished_turn_running() {
        let mut done = step(T0 + 10_000, AgentStatus::Complete);
        done.background = Some(1);
        let s = one(vec![step(T0, AgentStatus::Busy), done]);
        assert_eq!(lane(&s, T0 + 15_000), Lane::Running);
    }

    #[test]
    fn needs_since_holds_from_when_the_wait_began() {
        let s = one(vec![
            step(T0, AgentStatus::Busy),
            step(T0 + 10_000, AgentStatus::Complete),
        ]);
        let (state, _) = frame(&s, T0 + 50_000);
        let session = &state.repos[0].folders[0].sessions[0];
        assert_eq!(session.needs_since_ms, Some(T0 + 10_000));
    }

    #[test]
    fn lane_changes_count_each_move_with_its_dwell() {
        let s = one(vec![
            step(T0, AgentStatus::Busy),
            step(T0 + 10_000, AgentStatus::Complete),
            step(T0 + 30_000, AgentStatus::Busy),
        ]);
        let moves = lane_changes(&s, 1_000);
        let lanes: Vec<_> = moves.iter().map(|m| (m.from, m.to, m.dwell_ms)).collect();
        assert_eq!(
            lanes,
            vec![
                (Lane::Running, Lane::OnYou, 10_000),
                (Lane::OnYou, Lane::Running, 20_000)
            ]
        );
    }

    #[test]
    fn the_gallery_shows_every_lane_and_wait_reason() {
        use crate::queue::WaitReason;
        let (_, queue) = frame(&gallery(T0), T0 + 10_000);
        for lane in [
            Lane::OnYou,
            Lane::Idle,
            Lane::Running,
            Lane::Parked,
            Lane::NoShell,
        ] {
            assert!(queue.items.iter().any(|i| i.lane == lane), "{lane:?}");
        }
        for reason in [
            WaitReason::Unblock,
            WaitReason::Answer,
            WaitReason::Review,
            WaitReason::FixCi,
            WaitReason::AddressReview,
            WaitReason::Land,
            WaitReason::Cleanup,
        ] {
            assert!(queue.items.iter().any(|i| i.reason == Some(reason)), "{reason:?}");
        }
    }

    #[test]
    fn on_the_wall_clock_a_wait_is_as_old_as_it_was_in_the_scenario() {
        let s = one(vec![
            step(T0, AgentStatus::Busy),
            step(T0 + 10_000, AgentStatus::Complete),
        ]);
        let wall = 5_000_000_000;
        let (state, queue) = frame_on_wall(&s, T0 + 50_000, wall);
        assert_eq!(queue.items[0].since_ms, Some(wall - 40_000));
        assert_eq!(state.ts, wall);
    }

    #[test]
    fn a_closed_shell_leaves_its_checkout_without_one() {
        let mut s = one(vec![step(T0, AgentStatus::Busy)]);
        s.checkouts[0].sessions[0].closed_ms = Some(T0 + 5_000);
        assert_eq!(lane(&s, T0 + 1_000), Lane::Running);
        assert_eq!(lane(&s, T0 + 6_000), Lane::NoShell);
    }
}
