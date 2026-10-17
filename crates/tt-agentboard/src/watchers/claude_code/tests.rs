use super::*;
use std::sync::{Arc, Mutex};
use tempfile::TempDir;

struct Ctx {
    by_dir: Vec<(String, String)>,
    events: Vec<AgentEvent>,
}

impl Ctx {
    fn new() -> Self {
        Self { by_dir: Vec::new(), events: Vec::new() }
    }

    fn scan(&mut self, watcher: &mut ClaudeCodeAgentWatcher, cli: &AgentScan, now_ms: i64) {
        self.scan_with(watcher, cli, &[], now_ms);
    }

    fn scan_with(
        &mut self,
        watcher: &mut ClaudeCodeAgentWatcher,
        cli: &AgentScan,
        unlisted: &[CliAgent],
        now_ms: i64,
    ) {
        let by_dir = &self.by_dir;
        let resolve = |dir: &str| by_dir.iter().find(|(d, _)| d == dir).map(|(_, s)| s.clone());
        self.events.extend(watcher.scan(&resolve, cli, unlisted, now_ms));
    }
}

fn cli_agent(pid: i32, cwd: &str, sid: &str) -> CliAgent {
    CliAgent {
        pid,
        cwd: cwd.to_string(),
        kind: Some("interactive".into()),
        started_at: Some(1),
        session_id: sid.to_string(),
        name: Some(format!("slug-{pid}")),
    }
}

struct Fixture {
    _tmp: TempDir,
    projects: PathBuf,
    agents: Arc<Mutex<Vec<CliAgent>>>,
    watcher: ClaudeCodeAgentWatcher,
}

fn fixture() -> Fixture {
    let tmp = TempDir::new().unwrap();
    let projects = tmp.path().join("projects");
    std::fs::create_dir_all(&projects).unwrap();
    let agents: Arc<Mutex<Vec<CliAgent>>> = Arc::new(Mutex::new(Vec::new()));
    // No real /proc for fake pids; `drops_external_agents` overrides.
    let watcher = ClaudeCodeAgentWatcher::new(projects.clone(), Box::new(|_| true));
    Fixture { _tmp: tmp, projects, agents, watcher }
}

impl Fixture {
    /// A good `claude agents` answer listing whatever the test set.
    fn scan(&mut self, ctx: &mut Ctx, now_ms: i64) {
        self.scan_with(ctx, &[], now_ms);
    }

    fn scan_with(&mut self, ctx: &mut Ctx, unlisted: &[CliAgent], now_ms: i64) {
        let cli = AgentScan { agents: self.agents.lock().unwrap().clone(), ok: true };
        ctx.scan_with(&mut self.watcher, &cli, unlisted, now_ms);
    }
}

fn write_journal(projects: &Path, cwd: &str, sid: &str, lines: &[&str]) -> PathBuf {
    let dir = projects.join(encode_project_dir_name(cwd));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("{sid}.jsonl"));
    let mut text = lines.join("\n");
    text.push('\n');
    std::fs::write(&path, text).unwrap();
    path
}

const USER_LINE: &str = r#"{"timestamp":"2026-07-03T10:00:00.000Z","message":{"role":"user","content":"fix the flaky test"}}"#;
const RUNNING_LINE: &str = r#"{"timestamp":"2026-07-03T10:00:05.000Z","message":{"role":"assistant","model":"claude-sonnet-5","content":[{"type":"tool_use","name":"Bash"}],"usage":{"input_tokens":10,"output_tokens":5}}}"#;
const DONE_LINE: &str = r#"{"timestamp":"2026-07-03T10:00:10.000Z","message":{"role":"assistant","content":[{"type":"text","text":"all done"}]}}"#;
/// Text-only, but its response also asked for a tool, so `stop_reason` is
/// `tool_use`. The overwhelmingly common assistant entry.
const NARRATION_LINE: &str = r#"{"timestamp":"2026-07-03T10:00:07.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Let me check the tests."}],"stop_reason":"tool_use"}}"#;
/// A genuinely finished turn: text, handed back to the user.
const END_TURN_LINE: &str = r#"{"timestamp":"2026-07-03T10:00:12.000Z","message":{"role":"assistant","content":[{"type":"text","text":"all done"}],"stop_reason":"end_turn"}}"#;

/// Each content block is its own entry, so a working agent leaves
/// text-only entries every few seconds; none of them is a finished turn.
#[test]
fn mid_turn_narration_is_not_a_finished_turn() {
    let narration: TranscriptEntry = serde_json::from_str(NARRATION_LINE).unwrap();
    assert_eq!(determine_status(&narration), Some(AgentStatus::Busy));

    let ended: TranscriptEntry = serde_json::from_str(END_TURN_LINE).unwrap();
    assert_eq!(determine_status(&ended), Some(AgentStatus::Complete));

    let bare: TranscriptEntry = serde_json::from_str(DONE_LINE).unwrap();
    assert_eq!(determine_status(&bare), Some(AgentStatus::Complete));
}

#[test]
fn a_failed_cli_scan_finishes_no_session() {
    let mut f = fixture();
    write_journal(&f.projects, "/home/u/proj", "sid-f", &[USER_LINE, RUNNING_LINE]);
    *f.agents.lock().unwrap() = vec![cli_agent(100, "/home/u/proj", "sid-f")];
    let mut ctx = Ctx::new();
    ctx.by_dir.push(("/home/u/proj".into(), "proj".into()));
    f.scan(&mut ctx, 1_000);
    assert_eq!(ctx.events.len(), 1);

    ctx.scan(&mut f.watcher, &AgentScan { agents: Vec::new(), ok: false }, 2_000);
    assert_eq!(ctx.events.len(), 1, "a failed scan is not every agent exiting");

    // Still tracked, so the next good scan has nothing new to say.
    f.scan(&mut ctx, 3_000);
    assert_eq!(ctx.events.len(), 1);
}

#[test]
fn a_narration_entry_does_not_flip_a_working_agent_to_complete() {
    let mut f = fixture();
    write_journal(&f.projects, "/home/u/proj", "sid-n", &[USER_LINE, RUNNING_LINE]);
    *f.agents.lock().unwrap() = vec![cli_agent(100, "/home/u/proj", "sid-n")];
    let mut ctx = Ctx::new();
    ctx.by_dir.push(("/home/u/proj".into(), "proj".into()));

    f.scan(&mut ctx, 1_000);
    let before = ctx.events.len();

    write_journal(&f.projects, "/home/u/proj", "sid-n", &[USER_LINE, RUNNING_LINE, NARRATION_LINE]);
    f.scan(&mut ctx, 2_000);
    assert!(
        ctx.events[before..].iter().all(|e| e.status != AgentStatus::Complete),
        "narration must not report the turn as finished: {:?}",
        ctx.events[before..].iter().map(|e| e.status).collect::<Vec<_>>()
    );

    // The real turn end still lands.
    write_journal(
        &f.projects,
        "/home/u/proj",
        "sid-n",
        &[USER_LINE, RUNNING_LINE, NARRATION_LINE, END_TURN_LINE],
    );
    f.scan(&mut ctx, 3_000);
    assert_eq!(ctx.events.last().unwrap().status, AgentStatus::Complete);
}

#[test]
fn busy_agent_emits_running_with_journal_enrichment() {
    let mut f = fixture();
    write_journal(&f.projects, "/home/u/proj", "sid-1", &[USER_LINE, RUNNING_LINE]);
    *f.agents.lock().unwrap() = vec![cli_agent(100, "/home/u/proj", "sid-1")];
    let mut ctx = Ctx::new();
    ctx.by_dir.push(("/home/u/proj".into(), "proj".into()));

    f.scan(&mut ctx, 1_000);
    assert_eq!(ctx.events.len(), 1);
    let ev = &ctx.events[0];
    assert_eq!(ev.session, "proj");
    assert_eq!(ev.status, AgentStatus::Busy);
    assert_eq!(ev.thread_id.as_deref(), Some("sid-1"));
    assert_eq!(ev.thread_name.as_deref(), Some("fix the flaky test"));
    let details = ev.details.as_ref().unwrap();
    assert_eq!(details.model.as_deref(), Some("claude-sonnet-5"));
    assert_eq!(details.last_tool.as_deref(), Some("Bash"));
}

/// An interrupt appends a `<synthetic>` entry with all-zero usage, and it
/// is the newest entry with `usage` — but relabelling on it leaves a 1M
/// Sonnet run reading as `<synthetic>` on a 200K window for good.
#[test]
fn a_synthetic_entry_never_restates_the_model() {
    // Shape copied from a real journal (message.model = "<synthetic>").
    const SYNTHETIC_LINE: &str = r#"{"timestamp":"2026-07-03T10:00:30.000Z","message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"[Request interrupted]"}],"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#;
    let mut f = fixture();
    write_journal(&f.projects, "/home/u/proj", "sid-s", &[USER_LINE, RUNNING_LINE]);
    *f.agents.lock().unwrap() = vec![cli_agent(100, "/home/u/proj", "sid-s")];
    let mut ctx = Ctx::new();
    ctx.by_dir.push(("/home/u/proj".into(), "proj".into()));
    f.scan(&mut ctx, 1_000);
    let window = ctx.events.last().unwrap().details.as_ref().unwrap().context_max.unwrap();

    write_journal(&f.projects, "/home/u/proj", "sid-s", &[USER_LINE, RUNNING_LINE, SYNTHETIC_LINE]);
    f.scan(&mut ctx, 2_000);
    write_journal(&f.projects, "/home/u/proj", "sid-s", &[USER_LINE]);
    f.scan(&mut ctx, 3_000);

    let d = ctx.events.last().unwrap().details.as_ref().unwrap();
    assert_eq!(d.model.as_deref(), Some("claude-sonnet-5"));
    assert_eq!(d.context_max, Some(window));
}

/// Same session, same model; only the position-derived counters are stale.
#[test]
fn model_survives_a_journal_rotation() {
    let mut f = fixture();
    write_journal(&f.projects, "/home/u/proj", "sid-r", &[USER_LINE, RUNNING_LINE]);
    *f.agents.lock().unwrap() = vec![cli_agent(100, "/home/u/proj", "sid-r")];
    let mut ctx = Ctx::new();
    ctx.by_dir.push(("/home/u/proj".into(), "proj".into()));
    f.scan(&mut ctx, 1_000);

    // Shorter file with a different head → the rotation reset path.
    write_journal(&f.projects, "/home/u/proj", "sid-r", &[USER_LINE]);
    f.scan(&mut ctx, 2_000);

    let d = ctx.events.last().unwrap().details.as_ref().unwrap();
    assert_eq!(d.model.as_deref(), Some("claude-sonnet-5"));
    // The counters are position-dependent, so they *should* be gone.
    assert_eq!(d.context_used, None);
}

#[test]
fn a_session_the_cli_has_not_listed_yet_is_read_like_a_listed_one() {
    let mut f = fixture();
    let path = write_journal(&f.projects, "/home/u/p", "sid-new", &[USER_LINE, RUNNING_LINE]);
    let mut ctx = Ctx::new();
    ctx.by_dir.push(("/home/u/p".into(), "p".into()));
    let unlisted = [cli_agent(9, "/home/u/p", "sid-new")];

    f.scan_with(&mut ctx, &unlisted, 1_000);
    let ev = ctx.events.last().unwrap();
    assert_eq!(ev.status, AgentStatus::Busy);
    assert_eq!(ev.thread_name.as_deref(), Some("fix the flaky test"));

    {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "{END_TURN_LINE}").unwrap();
    }
    f.scan_with(&mut ctx, &unlisted, 2_000);
    assert_eq!(ctx.events.last().unwrap().status, AgentStatus::Complete);

    // The CLI catching up is the same session, not a new one to announce.
    let emitted = ctx.events.len();
    *f.agents.lock().unwrap() = unlisted.to_vec();
    f.scan_with(&mut ctx, &unlisted, 3_000);
    f.scan(&mut ctx, 4_000);
    assert_eq!(ctx.events.len(), emitted);
}

#[test]
fn a_partial_trailing_line_waits_for_its_newline() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("s.jsonl");
    let (first, rest) = END_TURN_LINE.split_at(40);
    std::fs::write(&path, format!("{USER_LINE}\n{RUNNING_LINE}\n{first}")).unwrap();
    let mut journal = Journal::default();
    journal.refresh(&path);
    assert_eq!(journal.status, AgentStatus::Busy);
    assert_eq!(journal.offset as usize, USER_LINE.len() + RUNNING_LINE.len() + 2);
    assert_eq!(journal.head, USER_LINE.as_bytes()[..HEAD_PROBE_LEN]);

    let mut file = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
    std::io::Write::write_all(&mut file, format!("{rest}\n").as_bytes()).unwrap();
    journal.refresh(&path);
    assert_eq!(journal.status, AgentStatus::Complete);
    assert_eq!(journal.offset, std::fs::metadata(&path).unwrap().len());
    assert_eq!(journal.last_tool.as_deref(), Some("Bash"));
}

#[test]
fn the_journal_says_where_a_listed_session_stands() {
    const ASK_LINE: &str = r#"{"message":{"role":"assistant","content":[{"type":"tool_use","name":"AskUserQuestion"}]}}"#;
    let mut f = fixture();
    write_journal(&f.projects, "/home/u/a", "sid-done", &[USER_LINE, DONE_LINE]);
    write_journal(&f.projects, "/home/u/b", "sid-mid", &[USER_LINE, RUNNING_LINE]);
    write_journal(&f.projects, "/home/u/c", "sid-ask", &[USER_LINE, ASK_LINE]);
    *f.agents.lock().unwrap() = vec![
        cli_agent(1, "/home/u/a", "sid-done"),
        cli_agent(2, "/home/u/b", "sid-mid"),
        cli_agent(3, "/home/u/c", "sid-ask"),
        cli_agent(4, "/home/u/a", "sid-new"),
    ];
    let mut ctx = Ctx::new();
    for dir in ["a", "b", "c"] {
        ctx.by_dir.push((format!("/home/u/{dir}"), dir.into()));
    }

    f.scan(&mut ctx, 1_000);
    let by_thread: std::collections::HashMap<&str, AgentStatus> =
        ctx.events.iter().map(|e| (e.thread_id.as_deref().unwrap(), e.status)).collect();
    assert_eq!(by_thread["sid-done"], AgentStatus::Complete);
    assert_eq!(by_thread["sid-mid"], AgentStatus::Busy);
    assert_eq!(by_thread["sid-ask"], AgentStatus::Waiting);
    assert_eq!(by_thread["sid-new"], AgentStatus::Idle);
}

#[test]
fn entries_claude_code_writes_itself_do_not_start_a_turn() {
    let status = |line: &str| determine_status(&serde_json::from_str(line).unwrap());
    for line in [
        r#"{"isMeta":true,"message":{"role":"user","content":"Base directory for this skill"}}"#,
        r#"{"isCompactSummary":true,"message":{"role":"user","content":"This session is being continued"}}"#,
        r#"{"message":{"role":"user","content":"<command-name>/clear</command-name>"}}"#,
        r#"{"message":{"role":"user","content":"<local-command-stdout>ok</local-command-stdout>"}}"#,
        r#"{"message":{"role":"user","content":"<bash-input>git status</bash-input>"}}"#,
        r#"{"message":{"role":"user","content":"<bash-stdout></bash-stdout><bash-stderr>fatal</bash-stderr>"}}"#,
        r#"{"message":{"role":"user","content":"<bash-stderr>(eval):1: not found</bash-stderr>"}}"#,
        r#"{"message":{"role":"user","content":"Unknown skill: rebase"}}"#,
        r#"{"message":{"role":"user","content":"/compact keep the plan"}}"#,
        r#"{"message":{"role":"user","content":"/code-review low --fix"}}"#,
    ] {
        assert_eq!(status(line), None, "{line}");
    }
    let interrupted = r#"{"message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#;
    assert_eq!(status(interrupted), Some(AgentStatus::Idle));
    assert_eq!(status(USER_LINE), Some(AgentStatus::Busy));
    let path_prompt = r#"{"message":{"role":"user","content":"/home/u/x.rs why does this fail"}}"#;
    assert_eq!(status(path_prompt), Some(AgentStatus::Busy));
}

#[test]
fn a_bash_mode_command_after_a_finished_turn_leaves_it_complete() {
    let mut f = fixture();
    let bash_in = r#"{"message":{"role":"user","content":"<bash-input>gs</bash-input>"}}"#;
    let bash_out = r#"{"message":{"role":"user","content":"<bash-stdout></bash-stdout><bash-stderr>fatal: not a git repository</bash-stderr>"}}"#;
    write_journal(
        &f.projects,
        "/home/u/p",
        "sid-bash",
        &[USER_LINE, END_TURN_LINE, bash_in, bash_out],
    );
    *f.agents.lock().unwrap() = vec![cli_agent(9, "/home/u/p", "sid-bash")];
    let mut ctx = Ctx::new();
    ctx.by_dir.push(("/home/u/p".into(), "p".into()));

    f.scan(&mut ctx, 1_000);
    assert_eq!(ctx.events.last().unwrap().status, AgentStatus::Complete);
}

#[test]
fn a_finished_turn_with_a_background_agent_out_counts_it_until_it_reports() {
    let mut f = fixture();
    let launch = r#"{"type":"user","timestamp":"2026-09-30T22:00:00Z","toolUseResult":{"status":"async_launched","agentId":"a1"}}"#;
    let path = write_journal(&f.projects, "/home/u/a", "sid-bg", &[USER_LINE, launch, DONE_LINE]);
    *f.agents.lock().unwrap() = vec![cli_agent(1, "/home/u/a", "sid-bg")];
    let mut ctx = Ctx::new();
    ctx.by_dir.push(("/home/u/a".into(), "a".into()));

    f.scan(&mut ctx, 1_000);
    let ev = ctx.events.last().unwrap();
    assert_eq!(ev.status, AgentStatus::Complete);
    assert_eq!(ev.details.as_ref().unwrap().background_agents, Some(1));
    assert!(ev.is_working());

    let done = r#"{"type":"queue-operation","timestamp":"2026-09-30T22:05:00Z","content":"<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>"}"#;
    let mut text = std::fs::read_to_string(&path).unwrap();
    text.push_str(done);
    text.push('\n');
    std::fs::write(&path, text).unwrap();
    f.scan(&mut ctx, 2_000);
    let ev = ctx.events.last().unwrap();
    assert_eq!(ev.status, AgentStatus::Complete);
    assert_eq!(ev.details.as_ref().and_then(|d| d.background_agents), None);
    assert!(!ev.is_working());
}

/// A monitor's event wakes the agent for a turn that ends at the prompt
/// again; the watch is out the whole time, so the session never reads free.
#[test]
fn a_monitor_keeps_its_session_working_across_its_events() {
    let mut f = fixture();
    let call = r#"{"type":"assistant","timestamp":"2026-09-30T22:00:00Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_m","name":"Monitor","input":{"command":"gh run watch"}}]}}"#;
    let armed = r#"{"type":"user","timestamp":"2026-09-30T22:00:01Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_m"}]},"toolUseResult":{"taskId":"m1","timeoutMs":300000,"persistent":false}}"#;
    let path =
        write_journal(&f.projects, "/home/u/m", "sid-mon", &[USER_LINE, call, armed, DONE_LINE]);
    *f.agents.lock().unwrap() = vec![cli_agent(1, "/home/u/m", "sid-mon")];
    let mut ctx = Ctx::new();
    ctx.by_dir.push(("/home/u/m".into(), "m".into()));
    let append = |line: &str| {
        let mut text = std::fs::read_to_string(&path).unwrap();
        text.push_str(line);
        text.push('\n');
        std::fs::write(&path, text).unwrap();
    };
    let notify = |ts: &str, body: &str| {
        format!(
            r#"{{"type":"queue-operation","operation":"enqueue","timestamp":"{ts}","content":"<task-notification>\n<task-id>m1</task-id>\n{body}\n</task-notification>"}}"#
        )
    };

    f.scan(&mut ctx, 1_000);
    assert_eq!(ctx.events.last().unwrap().details.as_ref().unwrap().background_tasks, Some(1));
    assert!(ctx.events.last().unwrap().is_working());

    append(&notify("2026-09-30T22:05:00Z", "<event>build passed</event>"));
    append(END_TURN_LINE);
    f.scan(&mut ctx, 2_000);
    assert!(ctx.events.last().unwrap().is_working(), "an event is not the end of the watch");

    append(&notify("2026-09-30T22:06:00Z", "<status>completed</status>"));
    f.scan(&mut ctx, 3_000);
    let ev = ctx.events.last().unwrap();
    assert_eq!(ev.details.as_ref().and_then(|d| d.background_tasks), None);
    assert!(!ev.is_working());
}

#[test]
fn an_exit_takes_its_background_agents_with_it() {
    let mut f = fixture();
    let launch = r#"{"type":"user","timestamp":"2026-09-30T22:00:00Z","toolUseResult":{"status":"async_launched","agentId":"a1"}}"#;
    write_journal(&f.projects, "/home/u/a", "sid-gone", &[USER_LINE, launch, DONE_LINE]);
    *f.agents.lock().unwrap() = vec![cli_agent(1, "/home/u/a", "sid-gone")];
    let mut ctx = Ctx::new();
    ctx.by_dir.push(("/home/u/a".into(), "a".into()));
    f.scan(&mut ctx, 1_000);
    assert!(ctx.events.last().unwrap().is_working());

    f.agents.lock().unwrap().clear();
    f.scan(&mut ctx, 2_000);
    let ev = ctx.events.last().unwrap();
    assert_eq!(ev.status, AgentStatus::Complete);
    assert_eq!(ev.details.as_ref().and_then(|d| d.background_agents), None);
    assert!(!ev.is_working());
}

/// A sub-agent whose transcript has been silent for ten minutes is still
/// running until the parent journal says otherwise.
#[test]
fn the_sub_agent_list_and_the_background_count_come_from_one_ledger() {
    let mut f = fixture();
    let call = |id: &str| {
        format!(
            r#"{{"type":"assistant","timestamp":"2026-09-30T22:00:00Z","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"{id}","name":"Agent","input":{{"description":"look around","subagent_type":"Explore"}}}}]}}}}"#
        )
    };
    let launched = r#"{"type":"user","timestamp":"2026-09-30T22:00:01Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_bg"}]},"toolUseResult":{"status":"async_launched","agentId":"abg"}}"#;
    let (fg, bg) = (call("toolu_fg"), call("toolu_bg"));
    let path = write_journal(&f.projects, "/home/u/a", "sid-l", &[USER_LINE, &bg, launched, &fg]);
    let subagents = path.with_extension("").join("subagents");
    std::fs::create_dir_all(&subagents).unwrap();
    let usage = r#"{"type":"assistant","timestamp":"2026-09-30T22:00:05Z","message":{"role":"assistant","usage":{"input_tokens":700}}}"#;
    std::fs::write(subagents.join("agent-afg.jsonl"), format!("{usage}\n")).unwrap();
    std::fs::write(subagents.join("agent-afg.meta.json"), r#"{"toolUseId":"toolu_fg"}"#).unwrap();
    std::fs::write(subagents.join("agent-old.jsonl"), format!("{usage}\n")).unwrap();
    *f.agents.lock().unwrap() = vec![cli_agent(1, "/home/u/a", "sid-l")];
    let mut ctx = Ctx::new();
    ctx.by_dir.push(("/home/u/a".into(), "a".into()));

    f.scan(&mut ctx, 1_000);
    let d = ctx.events.last().unwrap().details.clone().unwrap();
    let listed = d.subagents.unwrap();
    assert_eq!(listed.len(), 2);
    assert!(listed.iter().all(|s| s.agent_type.as_deref() == Some("Explore")));
    assert_eq!(listed.iter().filter_map(|s| s.context_used).collect::<Vec<_>>(), [700]);
    assert_eq!(d.background_agents, Some(1));
    assert_eq!(d.subagent_count, Some(2));

    let fg_done = r#"{"type":"user","timestamp":"2026-09-30T22:20:00Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_fg"}]},"toolUseResult":{"status":"completed","agentId":"afg"}}"#;
    let bg_done = r#"{"type":"queue-operation","timestamp":"2026-09-30T22:30:00Z","content":"<task-notification><task-id>abg</task-id></task-notification>"}"#;
    let mut text = std::fs::read_to_string(&path).unwrap();
    text.push_str(&format!("{fg_done}\n{bg_done}\n"));
    std::fs::write(&path, text).unwrap();
    f.scan(&mut ctx, 2_000);
    let d = ctx.events.last().unwrap().details.clone().unwrap();
    assert_eq!((d.subagents, d.background_agents), (None, None));
    assert_eq!(d.subagent_context_used, Some(1_400));
}

#[test]
fn a_finished_turn_reads_complete_on_the_first_scan() {
    let mut f = fixture();
    write_journal(&f.projects, "/home/u/p", "sid-stuck", &[USER_LINE, DONE_LINE]);
    *f.agents.lock().unwrap() = vec![cli_agent(9, "/home/u/p", "sid-stuck")];
    let mut ctx = Ctx::new();
    ctx.by_dir.push(("/home/u/p".into(), "p".into()));

    f.scan(&mut ctx, 1_000);
    assert_eq!(ctx.events.last().unwrap().status, AgentStatus::Complete);
}

#[test]
fn busy_with_in_flight_tool_call_never_goes_stale() {
    let mut f = fixture();
    write_journal(&f.projects, "/home/u/p", "sid-running", &[USER_LINE, RUNNING_LINE]);
    *f.agents.lock().unwrap() = vec![cli_agent(9, "/home/u/p", "sid-running")];
    let mut ctx = Ctx::new();
    ctx.by_dir.push(("/home/u/p".into(), "p".into()));

    f.scan(&mut ctx, 1_000);
    f.scan(&mut ctx, 1_000 + 3_600_000);
    assert_eq!(ctx.events.last().unwrap().status, AgentStatus::Busy);
}

#[test]
fn drops_external_agents() {
    // Two live Claudes in one checkout; only the app-launched pid 100
    // should reach the board.
    let tmp = TempDir::new().unwrap();
    let projects = tmp.path().join("projects");
    std::fs::create_dir_all(&projects).unwrap();
    write_journal(&projects, "/home/u/proj", "app-sid", &[USER_LINE, RUNNING_LINE]);
    write_journal(&projects, "/home/u/proj", "ext-sid", &[USER_LINE, RUNNING_LINE]);
    let agents = vec![
        cli_agent(100, "/home/u/proj", "app-sid"),
        cli_agent(200, "/home/u/proj", "ext-sid"),
    ];
    let mut watcher = ClaudeCodeAgentWatcher::new(
        projects,
        Box::new(|pid| pid == 100), // only pid 100 carries TT_SESSION_ID
    );
    let mut ctx = Ctx::new();
    ctx.by_dir.push(("/home/u/proj".into(), "session-x".into()));

    ctx.scan(&mut watcher, &AgentScan { agents, ok: true }, 1_000);

    assert_eq!(ctx.events.len(), 1, "external agent should be dropped");
    assert_eq!(ctx.events[0].thread_id.as_deref(), Some("app-sid"));
}

#[test]
fn no_reemit_without_change_but_usage_delta_reemits() {
    let mut f = fixture();
    let path = write_journal(&f.projects, "/home/u/p", "sid-1", &[USER_LINE, RUNNING_LINE]);
    *f.agents.lock().unwrap() = vec![cli_agent(9, "/home/u/p", "sid-1")];
    let mut ctx = Ctx::new();
    ctx.by_dir.push(("/home/u/p".into(), "p".into()));

    f.scan(&mut ctx, 1_000);
    f.scan(&mut ctx, 3_000);
    assert_eq!(ctx.events.len(), 1, "steady state must not re-emit");

    // Usage growth without a status change re-emits.
    let more = r#"{"timestamp":"2026-07-03T10:00:20.000Z","message":{"role":"assistant","model":"claude-sonnet-5","content":[{"type":"tool_use","name":"Read"}],"usage":{"input_tokens":900,"output_tokens":50}}}"#;
    let mut text = std::fs::read_to_string(&path).unwrap();
    text.push_str(more);
    text.push('\n');
    std::fs::write(&path, text).unwrap();

    f.scan(&mut ctx, 5_000);
    assert_eq!(ctx.events.len(), 2);
    assert_eq!(ctx.events[1].status, AgentStatus::Busy);
    assert_eq!(ctx.events[1].details.as_ref().unwrap().last_tool.as_deref(), Some("Read"));
}

#[test]
fn exiting_after_a_finished_turn_does_not_announce_it_again() {
    let mut f = fixture();
    write_journal(&f.projects, "/home/u/a", "sid-done", &[USER_LINE, END_TURN_LINE]);
    *f.agents.lock().unwrap() = vec![cli_agent(1, "/home/u/a", "sid-done")];
    let mut ctx = Ctx::new();
    ctx.by_dir.push(("/home/u/a".into(), "a".into()));
    f.scan(&mut ctx, 1_000);
    assert_eq!(ctx.events.last().unwrap().status, AgentStatus::Complete);
    ctx.events.clear();

    f.agents.lock().unwrap().clear();
    f.scan(&mut ctx, 5_000);
    assert!(ctx.events.is_empty(), "{:?}", ctx.events);
}

#[test]
fn exit_emits_done_or_interrupted_from_final_journal() {
    let mut f = fixture();
    let done_path = write_journal(&f.projects, "/home/u/a", "sid-done", &[USER_LINE, RUNNING_LINE]);
    write_journal(&f.projects, "/home/u/b", "sid-mid", &[USER_LINE, RUNNING_LINE]);
    *f.agents.lock().unwrap() = vec![
        cli_agent(1, "/home/u/a", "sid-done"),
        cli_agent(2, "/home/u/b", "sid-mid"),
    ];
    let mut ctx = Ctx::new();
    ctx.by_dir.push(("/home/u/a".into(), "a".into()));
    ctx.by_dir.push(("/home/u/b".into(), "b".into()));
    f.scan(&mut ctx, 1_000);
    ctx.events.clear();

    // sid-done's journal completes before it exits; sid-mid dies mid-run.
    let mut text = std::fs::read_to_string(&done_path).unwrap();
    text.push_str(DONE_LINE);
    text.push('\n');
    std::fs::write(&done_path, text).unwrap();
    f.agents.lock().unwrap().clear();

    f.scan(&mut ctx, 5_000);
    let by_thread: std::collections::HashMap<&str, AgentStatus> =
        ctx.events.iter().map(|e| (e.thread_id.as_deref().unwrap(), e.status)).collect();
    assert_eq!(by_thread["sid-done"], AgentStatus::Complete);
    assert_eq!(by_thread["sid-mid"], AgentStatus::Interrupted);
    // Gone for good: nothing further on later scans.
    ctx.events.clear();
    f.scan(&mut ctx, 7_000);
    assert!(ctx.events.is_empty());
}

#[test]
fn unresolved_agents_never_emit_even_on_exit() {
    let mut f = fixture();
    write_journal(&f.projects, "/home/u/x", "sid-x", &[USER_LINE, RUNNING_LINE]);
    *f.agents.lock().unwrap() = vec![cli_agent(1, "/home/u/x", "sid-x")];
    let mut ctx = Ctx::new(); // resolves nothing
    f.scan(&mut ctx, 1_000);
    f.agents.lock().unwrap().clear();
    f.scan(&mut ctx, 3_000);
    assert!(ctx.events.is_empty());
}

#[test]
fn cli_name_is_fallback_when_journal_has_no_prompt() {
    let mut f = fixture();
    // Journal whose only user line is system-like (skipped by the name rule).
    write_journal(
        &f.projects,
        "/home/u/p",
        "sid-1",
        &[r#"{"message":{"role":"user","content":"<system>boot</system>"}}"#],
    );
    *f.agents.lock().unwrap() = vec![cli_agent(7, "/home/u/p", "sid-1")];
    let mut ctx = Ctx::new();
    ctx.by_dir.push(("/home/u/p".into(), "p".into()));
    f.scan(&mut ctx, 1_000);
    assert_eq!(ctx.events[0].thread_name.as_deref(), Some("slug-7"));
}

#[test]
fn shrunk_journal_resets_and_rederives() {
    let mut f = fixture();
    let path = write_journal(&f.projects, "/home/u/p", "sid-1", &[USER_LINE, RUNNING_LINE]);
    *f.agents.lock().unwrap() = vec![cli_agent(7, "/home/u/p", "sid-1")];
    let mut ctx = Ctx::new();
    ctx.by_dir.push(("/home/u/p".into(), "p".into()));
    f.scan(&mut ctx, 1_000);

    // Truncate + rewrite with a different prompt: state re-derives.
    let replacement = r#"{"message":{"role":"user","content":"a brand new thread"}}"#;
    std::fs::write(&path, format!("{replacement}\n")).unwrap();
    f.scan(&mut ctx, 3_000);
    let last = ctx.events.last().unwrap();
    assert_eq!(last.thread_name.as_deref(), Some("a brand new thread"));
}

#[test]
fn encode_project_dir_name_collapses_slash_dot_and_underscore() {
    assert_eq!(encode_project_dir_name("/home/u/my.app"), "-home-u-my-app");
    assert_eq!(encode_project_dir_name("/a/b/test_atinotes"), "-a-b-test-atinotes");
    assert_eq!(
        encode_project_dir_name("/home/u/repo/.claude/worktrees/fix-thing"),
        "-home-u-repo--claude-worktrees-fix-thing"
    );
}

#[test]
fn journal_found_by_probe_when_the_recorded_cwd_no_longer_matches_the_journal_dir() {
    let mut f = fixture();
    let dir = f.projects.join("-home-u-renamed-proj");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("sid-1.jsonl"), format!("{USER_LINE}\n")).unwrap();
    *f.agents.lock().unwrap() = vec![cli_agent(7, "/home/u/my-app", "sid-1")];
    let mut ctx = Ctx::new();
    ctx.by_dir.push(("/home/u/my-app".into(), "p".into()));
    f.scan(&mut ctx, 1_000);
    assert_eq!(ctx.events[0].thread_name.as_deref(), Some("fix the flaky test"));
}

#[test]
fn incremental_append_is_picked_up_across_scans() {
    let mut f = fixture();
    let path = write_journal(&f.projects, "/home/u/proj", "sid-inc", &[USER_LINE, RUNNING_LINE]);
    *f.agents.lock().unwrap() = vec![cli_agent(100, "/home/u/proj", "sid-inc")];
    let mut ctx = Ctx::new();
    ctx.by_dir.push(("/home/u/proj".into(), "proj".into()));
    f.scan(&mut ctx, 1_000);
    assert_eq!(ctx.events.last().unwrap().status, AgentStatus::Busy);

    {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "{DONE_LINE}").unwrap();
    }
    *f.agents.lock().unwrap() = vec![cli_agent(100, "/home/u/proj", "sid-inc")];
    f.scan(&mut ctx, 2_000);
    assert_eq!(ctx.events.last().unwrap().status, AgentStatus::Complete);
}

#[test]
fn replaced_journal_resets_offset_and_rederives() {
    let mut f = fixture();
    let path = write_journal(&f.projects, "/home/u/proj", "sid-rot", &[USER_LINE, RUNNING_LINE]);
    *f.agents.lock().unwrap() = vec![cli_agent(100, "/home/u/proj", "sid-rot")];
    let mut ctx = Ctx::new();
    ctx.by_dir.push(("/home/u/proj".into(), "proj".into()));
    f.scan(&mut ctx, 1_000);
    assert_eq!(ctx.events.last().unwrap().thread_name.as_deref(), Some("fix the flaky test"));

    // Replace the journal at the same path with a LARGER file (new inode):
    // without rotation detection the stored offset would land mid-file and
    // the new head (thread name) would never be seen.
    std::fs::remove_file(&path).unwrap();
    let new_user = r#"{"timestamp":"2026-07-03T11:00:00.000Z","message":{"role":"user","content":"a rewritten journal with a much longer opening prompt than before"}}"#;
    write_journal(&f.projects, "/home/u/proj", "sid-rot", &[new_user, RUNNING_LINE, DONE_LINE]);
    *f.agents.lock().unwrap() = vec![cli_agent(100, "/home/u/proj", "sid-rot")];
    f.scan(&mut ctx, 2_000);
    let ev = ctx.events.last().unwrap();
    assert_eq!(
        ev.thread_name.as_deref(),
        Some("a rewritten journal with a much longer opening prompt than before")
    );
    assert_eq!(ev.status, AgentStatus::Complete);
}

#[test]
fn rewritten_journal_with_same_inode_detected_by_head_change() {
    let mut f = fixture();
    write_journal(&f.projects, "/home/u/proj", "sid-same", &[USER_LINE, RUNNING_LINE]);
    *f.agents.lock().unwrap() = vec![cli_agent(100, "/home/u/proj", "sid-same")];
    let mut ctx = Ctx::new();
    ctx.by_dir.push(("/home/u/proj".into(), "proj".into()));
    f.scan(&mut ctx, 1_000);
    assert_eq!(ctx.events.last().unwrap().thread_name.as_deref(), Some("fix the flaky test"));

    // Rewrite the journal LARGER, in place (`fs::write` truncates the
    // existing file, so the inode is guaranteed unchanged — the case
    // remove+recreate only hits when the fs reuses the freed inode). The
    // shrink and inode checks both pass; only the head change gives the
    // replacement away.
    let new_user = r#"{"timestamp":"2026-07-03T11:00:00.000Z","message":{"role":"user","content":"a rewritten journal with a much longer opening prompt than before"}}"#;
    write_journal(&f.projects, "/home/u/proj", "sid-same", &[new_user, RUNNING_LINE, DONE_LINE]);
    *f.agents.lock().unwrap() = vec![cli_agent(100, "/home/u/proj", "sid-same")];
    f.scan(&mut ctx, 2_000);
    let ev = ctx.events.last().unwrap();
    assert_eq!(
        ev.thread_name.as_deref(),
        Some("a rewritten journal with a much longer opening prompt than before")
    );
    assert_eq!(ev.status, AgentStatus::Complete);
}
