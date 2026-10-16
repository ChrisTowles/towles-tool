//! Record a board scenario from real sessions, or report the row churn in one.
//!
//! ```sh
//! cargo run -p tt-agentboard --example sim -- record --since 2026-10-14T13:00:00-05:00 --hours 4 --out s.json
//! cargo run -p tt-agentboard --example sim -- report s.json
//! ```
//!
//! `record` replays every Claude Code journal under `~/.claude/projects` that was
//! active in the window, one checkout per cwd. Where the app's event log has
//! `agent.status_changed` records for a session (`--telemetry <dir>`, default
//! the app's own), those PTY-resolved statuses replace the journal's reading.
//! The output carries real prompt text in its titles: keep it out of the repo.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use tt_agentboard::AgentStatus;
use tt_agentboard::queue::Lane;
use tt_agentboard::sim::{Scenario, SimCheckout, SimSession, SimStep, lane_changes};
use tt_agentboard::watchers::claude_code::{JournalReplay, parse_timestamp_ms, replay_journal};

/// How long before a typed prompt the user is taken to have read the turn.
const READ_BEFORE_PROMPT_MS: i64 = 20_000;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| {
        args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).map(String::as_str)
    };
    match args.first().map(String::as_str) {
        Some("record") => {
            let since = flag("--since").and_then(parse_timestamp_ms).expect("--since <rfc3339>");
            let hours: f64 = flag("--hours").map_or(3.0, |h| h.parse().expect("--hours"));
            let end = since + (hours * 3_600_000.0) as i64;
            let telemetry = flag("--telemetry").map(PathBuf::from).or_else(default_telemetry);
            let scenario = record(since, end, telemetry.as_deref());
            let json = serde_json::to_string_pretty(&scenario).unwrap();
            match flag("--out") {
                Some(out) => std::fs::write(out, json).expect("write --out"),
                None => println!("{json}"),
            }
            report(&scenario);
        }
        Some("report") => {
            let path = args.get(1).expect("report <scenario.json>");
            let scenario: Scenario =
                serde_json::from_str(&std::fs::read_to_string(path).expect("read")).expect("parse");
            report(&scenario);
        }
        _ => {
            eprintln!("usage: sim record --since <rfc3339> [--hours 3] [--out f] | sim report <f>")
        }
    }
}

fn default_telemetry() -> Option<PathBuf> {
    let dir = dirs::data_dir()?.join("towles-tool/tasks/towles-tool/telemetry");
    dir.exists().then_some(dir)
}

fn record(start: i64, end: i64, telemetry: Option<&Path>) -> Scenario {
    let projects = tt_config::claude_dir().join("projects");
    let resolved = telemetry.map(|d| resolved_statuses(d, start, end)).unwrap_or_default();
    let mut by_cwd: BTreeMap<String, (JournalReplay, Vec<SimSession>)> = BTreeMap::new();
    for project in std::fs::read_dir(&projects).into_iter().flatten().flatten() {
        for file in std::fs::read_dir(project.path()).into_iter().flatten().flatten() {
            let path = file.path();
            let fresh = file
                .metadata()
                .and_then(|m| m.modified())
                .map(|t| {
                    t.duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64 >= start
                })
                .unwrap_or(false);
            if path.extension().is_none_or(|e| e != "jsonl") || !fresh {
                continue;
            }
            let replay = replay_journal(&path);
            // A `claude -p` the app ran (naming a branch, a summary) is no pane.
            if replay.entrypoint.as_deref().is_some_and(|e| e != "cli") {
                continue;
            }
            let id = path.file_stem().unwrap().to_string_lossy().to_string();
            let Some(session) = sim_session(&id, &replay, resolved.get(&id), start, end) else {
                continue;
            };
            let Some(cwd) = replay.cwd.clone() else {
                continue;
            };
            by_cwd.entry(cwd).or_insert_with(|| (replay, Vec::new())).1.push(session);
        }
    }
    let checkouts = by_cwd
        .into_iter()
        .map(|(cwd, (replay, mut sessions))| {
            sessions.sort_by_key(|s| s.steps.first().map_or(0, |s| s.t));
            // One pane per checkout: a later session replaced the earlier one's shell.
            for i in 1..sessions.len() {
                let next_open = sessions[i].opened_ms;
                sessions[i - 1].closed_ms = next_open.or(Some(start));
            }
            let (repo, is_worktree) = match cwd.split_once("/.claude/worktrees/") {
                Some((root, _)) => (root.rsplit('/').next().unwrap().to_string(), true),
                None => (cwd.rsplit('/').next().unwrap().to_string(), false),
            };
            SimCheckout {
                repo,
                dir: cwd,
                branch: replay.git_branch.unwrap_or_else(|| "main".into()),
                is_worktree,
                sessions,
                ..Default::default()
            }
        })
        .collect();
    let name = format!("recorded {}", chrono::DateTime::from_timestamp_millis(start).unwrap());
    Scenario { name, start_ms: start, end_ms: end, checkouts }
}

fn sim_session(
    id: &str,
    replay: &JournalReplay,
    resolved: Option<&Vec<SimStep>>,
    start: i64,
    end: i64,
) -> Option<SimSession> {
    let before = replay.steps.iter().rev().find(|s| s.at_ms < start);
    let inside: Vec<_> = replay.steps.iter().filter(|s| (start..end).contains(&s.at_ms)).collect();
    let busy_at_start = before.is_some_and(|s| s.status == AgentStatus::Busy || s.background > 0);
    if inside.is_empty() && !busy_at_start {
        return None;
    }
    let mut steps: Vec<SimStep> = Vec::new();
    if let Some(b) = before {
        steps.push(SimStep {
            t: start,
            status: Some(b.status),
            background: Some(b.background),
            seen: true,
            ..Default::default()
        });
    }
    for s in &inside {
        if s.prompted {
            let read_at =
                (s.at_ms - READ_BEFORE_PROMPT_MS).max(steps.last().map_or(start, |p| p.t));
            steps.push(SimStep { t: read_at, seen: true, ..Default::default() });
        }
        steps.push(SimStep {
            t: s.at_ms,
            status: Some(s.status),
            background: Some(s.background),
            prompted: s.prompted,
            ..Default::default()
        });
    }
    if let Some(pty) = resolved {
        // The app saw this session: its resolved statuses are the truth, the
        // journal's background counts and read times still apply.
        steps.retain(|s| s.status.is_none());
        steps.extend(pty.iter().cloned());
        steps.sort_by_key(|s| s.t);
    }
    let opened_ms = before.is_none().then(|| steps.first().map(|s| s.t)).flatten();
    Some(SimSession {
        id: id.to_string(),
        title: replay.thread_name.clone(),
        opened_ms,
        closed_ms: None,
        steps,
    })
}

/// `agent.status_changed` records by Claude session id.
fn resolved_statuses(dir: &Path, start: i64, end: i64) -> HashMap<String, Vec<SimStep>> {
    let mut out: HashMap<String, Vec<SimStep>> = HashMap::new();
    for file in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let Ok(text) = std::fs::read_to_string(file.path()) else {
            continue;
        };
        for line in text.lines().filter(|l| l.contains("agent.status_changed")) {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            let field = |k: &str| v.get(k).and_then(|x| x.as_str());
            let (Some(thread), Some(to), Some(at)) =
                (field("thread"), field("to"), field("ts").and_then(parse_timestamp_ms))
            else {
                continue;
            };
            if !(start..end).contains(&at) {
                continue;
            }
            let Ok(status) = serde_json::from_value::<AgentStatus>(to.into()) else {
                continue;
            };
            let background = v.get("background").and_then(|b| b.as_i64());
            out.entry(thread.to_string()).or_default().push(SimStep {
                t: at,
                status: Some(status),
                background,
                ..Default::default()
            });
        }
    }
    out
}

fn report(scenario: &Scenario) {
    let moves = lane_changes(scenario, 2_000);
    let hours = (scenario.end_ms - scenario.start_ms) as f64 / 3_600_000.0;
    let sessions: usize = scenario.checkouts.iter().map(|c| c.sessions.len()).sum();
    eprintln!(
        "{}: {} checkouts, {sessions} sessions, {:.1}h — {} lane changes ({:.0}/h)",
        scenario.name,
        scenario.checkouts.len(),
        hours,
        moves.len(),
        moves.len() as f64 / hours.max(0.01)
    );
    let mut pairs: BTreeMap<(Lane, Lane), (usize, usize)> = BTreeMap::new();
    for m in &moves {
        let e = pairs.entry((m.from, m.to)).or_default();
        e.0 += 1;
        e.1 += usize::from(m.dwell_ms < 60_000);
    }
    eprintln!("  from → to                 count  (of which `from` lasted under 60s)");
    for ((from, to), (n, quick)) in pairs {
        eprintln!("  {:<10} → {:<10}  {n:>5}  ({quick})", format!("{from:?}"), format!("{to:?}"));
    }
    let (mut typed, mut reported) = (0, 0);
    for session in scenario.checkouts.iter().flat_map(|c| &c.sessions) {
        let mut prev = None;
        for step in session.steps.iter().filter(|s| s.status.is_some()) {
            if step.status == Some(AgentStatus::Busy) && prev != step.status {
                if step.prompted { typed += 1 } else { reported += 1 }
            }
            prev = step.status;
        }
    }
    eprintln!("  turns started: {typed} by a typed prompt, {reported} by anything else");
    let mut bounces = 0;
    let mut last: HashMap<&str, &tt_agentboard::sim::LaneChange> = HashMap::new();
    for m in &moves {
        if let Some(prev) = last.get(m.folder_dir.as_str())
            && prev.from == m.to
            && m.dwell_ms < 60_000
        {
            bounces += 1;
        }
        last.insert(&m.folder_dir, m);
    }
    eprintln!("  bounces (A → B → A, under 60s in B): {bounces}");
}
