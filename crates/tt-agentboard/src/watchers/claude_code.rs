//! Claude Code agent watcher. **Discovery and liveness come from `claude
//! agents --all --json`** ([`crate::claude_cli`]); **journals are enrichment
//! only**, supplying what the CLI doesn't expose (model, last tool, usage,
//! sub-agents, `/loop` wakeups, the first-prompt thread name).
//!
//! Per scan: list live agents, resolve each to a session by cwd, then refine
//! status (`session_status`). A session that vanished gets one final
//! journal read and a terminal emit. Deliberate limit: one that exited before
//! the server started never appears at all. Live sessions the CLI doesn't list
//! go through the same rules via [`unlisted_events`].

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use tt_claude_code::{TranscriptEntry, parse_transcript};

use crate::claude_cli::CliAgent;
use crate::procenv::SessionAgentProc;
use crate::types::{AgentEvent, AgentEventDetails, AgentStatus, LoopInfo};
use crate::watchers::background::BackgroundAgents;
use crate::watchers::claude_usage::{ClaudeUsageSummary, extract_usage_summary};
use crate::watchers::subagents::{SubagentRollup, SubagentUsage};

const NAME: &str = "claude-code";
pub const JSONL_SUFFIX: &str = ".jsonl";
/// Shared CLI snapshot TTL. Consumers tick every 2-3s regardless, so this
/// alone sets the real spawn cadence for a ~170ms Node process; 60s keeps
/// liveness fresh enough for pinning while cutting that to once a minute.
pub const CLI_CACHE_TTL_MS: u64 = 60_000;

pub fn parse_timestamp_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|dt| dt.timestamp_millis())
}

/// With CLI-driven liveness this only informs the `idle` refinement and the
/// exit-time terminal emit.
fn determine_status(entry: &TranscriptEntry) -> Option<AgentStatus> {
    let msg = entry.message.as_ref()?;
    let role = msg.role.as_deref().filter(|r| !r.is_empty())?;

    match role {
        "assistant" => {
            let tool_uses: Vec<_> =
                msg.content.as_ref().map(|c| c.tool_uses().collect()).unwrap_or_default();
            if tool_uses.is_empty() {
                // Each content block is its own entry, so only `stop_reason`
                // separates a finished turn from mid-turn narration.
                return Some(turn_end_status(msg.stop_reason.as_deref()));
            }
            let all_asking = tool_uses.iter().all(|t| t.name() == Some("AskUserQuestion"));
            Some(if all_asking { AgentStatus::Waiting } else { AgentStatus::Busy })
        }
        "user" => Some(AgentStatus::Busy),
        _ => None,
    }
}

/// `tool_use` means the response also asked for a tool, so the text is
/// narration and the agent is still `Busy`. A missing `stop_reason` reads as
/// `Complete` — the safer guess for a signal whose job is to stop you missing
/// an agent that wants you.
fn turn_end_status(stop_reason: Option<&str>) -> AgentStatus {
    match stop_reason {
        Some("tool_use") => AgentStatus::Busy,
        _ => AgentStatus::Complete,
    }
}

fn extract_thread_name(entry: &TranscriptEntry) -> Option<String> {
    let msg = entry.message.as_ref()?;
    if msg.role.as_deref() != Some("user") {
        return None;
    }
    let text = msg.content.as_ref()?.first_text()?;
    if text.is_empty() || text.starts_with('<') || text.starts_with('{') {
        return None;
    }
    Some(text.chars().take(80).collect())
}

/// Claude Code's `<projects>` subdirectory name for a session rooted at `cwd`.
/// One-way: distinct cwds can collide, which is why [`find_journal`] still
/// probes. `pub` because `tt-app`'s resume picker calls it — don't narrow it
/// on a dead-code sweep.
pub fn encode_project_dir_name(cwd: &str) -> String {
    cwd.chars().map(|c| if matches!(c, '/' | '.' | '_') { '-' } else { c }).collect()
}

/// Locate `<projects>/<encoded cwd>/<session id>.jsonl`, falling back to
/// probing every project dir when the encode collides.
pub fn find_journal(projects_dir: &Path, cwd: &str, session_id: &str) -> Option<PathBuf> {
    let file = format!("{session_id}{JSONL_SUFFIX}");
    let guess = projects_dir.join(encode_project_dir_name(cwd)).join(&file);
    if guess.exists() {
        return Some(guess);
    }
    let entries = std::fs::read_dir(projects_dir).ok()?;
    for entry in entries.flatten() {
        let candidate = entry.path().join(&file);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(unix)]
fn metadata_file_id(meta: &std::fs::Metadata) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    Some((meta.dev(), meta.ino()))
}

#[cfg(not(unix))]
fn metadata_file_id(_meta: &std::fs::Metadata) -> Option<(u64, u64)> {
    None
}

const HEAD_PROBE_LEN: usize = 64;

fn read_head(path: &Path, len: usize) -> Option<Vec<u8>> {
    use std::io::Read;
    let f = std::fs::File::open(path).ok()?;
    let mut buf = Vec::with_capacity(len);
    f.take(len as u64).read_to_end(&mut buf).ok()?;
    Some(buf)
}

fn read_from_offset(path: &Path, offset: u64) -> Option<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    if offset > 0 {
        f.seek(SeekFrom::Start(offset)).ok()?;
    }
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(buf)
}

/// Bytes read for a bounded look at a transcript's head or tail.
pub(super) const TAIL_WINDOW: u64 = 128 * 1024;

/// Partial JSONL lines at either edge fail to parse and are dropped by
/// `parse_transcript`, so no newline alignment is needed.
pub(super) fn read_window(path: &Path, start: u64, max: u64) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else {
        return String::new();
    };
    if start > 0 && f.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    if f.take(max).read_to_end(&mut buf).is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&buf).into_owned()
}

fn extract_last_tool(entries: &[TranscriptEntry]) -> Option<String> {
    for entry in entries.iter().rev() {
        let Some(msg) = &entry.message else { continue };
        if msg.role.as_deref() != Some("assistant") {
            continue;
        }
        let Some(content) = &msg.content else {
            continue;
        };
        for tool in content.tool_uses() {
            let Some(name) = tool.name() else { continue };
            if name == "AskUserQuestion" {
                continue;
            }
            return Some(name.to_string());
        }
    }
    None
}

fn extract_loop_state(entries: &[TranscriptEntry]) -> Option<LoopInfo> {
    for entry in entries.iter().rev() {
        let Some(msg) = &entry.message else { continue };
        if msg.role.as_deref() != Some("assistant") {
            continue;
        }
        let Some(content) = &msg.content else {
            continue;
        };
        for tool in content.tool_uses() {
            if tool.name() != Some("ScheduleWakeup") {
                continue;
            }
            let input = tool.input();
            let delay = input.and_then(|i| i.get("delaySeconds")).and_then(|v| v.as_f64());
            let scheduled_at = entry.timestamp.as_deref().and_then(parse_timestamp_ms);
            let (Some(delay), Some(ts)) = (delay, scheduled_at) else {
                return None;
            };
            let reason =
                input.and_then(|i| i.get("reason")).and_then(|v| v.as_str()).map(str::to_string);
            return Some(LoopInfo { next_wake_at: ts + (delay * 1000.0) as i64, reason });
        }
    }
    None
}

/// Where the next read resumes, so a partial trailing line is never consumed.
fn consumed_len(bytes: &[u8]) -> usize {
    match bytes.iter().rposition(|&b| b == b'\n') {
        Some(i) => i + 1,
        None => 0,
    }
}

/// Claude Code labels its own generated entries with a bracketed model id, and
/// they are structurally ordinary assistant entries — taking the newest one's
/// identity would relabel a 1M Sonnet session onto the 200K window. Real ids
/// are never bracketed, so this rejects placeholders but not an unknown model.
fn is_placeholder_model(model: &str) -> bool {
    model.starts_with('<')
}

/// How long a CLI `busy`/`waiting` is trusted past the journal's turn-end:
/// past ordinary CLI lag, short enough that a stuck session self-heals.
const STALE_BUSY_JOURNAL_MS: i64 = 60_000;

/// The one map from what is known about a live session to its status, for the
/// watcher's CLI-listed sessions and the engine's unlisted ones alike. `cli` is
/// the CLI's verdict, `None` when it didn't list the session, which leaves the
/// journal's reading. A CLI `idle` takes the journal's `complete` (unseen-✓
/// flow) or `waiting`. A CLI `busy`/`waiting` is never re-derived while the
/// process stays listed, so a journal ending in a plain final response with
/// nothing appended since overrules it. Last, a finished turn with background
/// agents still out is not waiting on you — their reports start the next one;
/// a question (`Waiting`) still is.
fn session_status(
    cli: Option<AgentStatus>,
    journal: &Journal,
    process_started_at: Option<i64>,
    now_ms: i64,
) -> AgentStatus {
    let silence_ms = now_ms.saturating_sub(journal.updated_at);
    let status = match cli {
        None => journal.status,
        Some(AgentStatus::Idle) => match journal.status {
            AgentStatus::Complete | AgentStatus::Waiting => journal.status,
            _ => AgentStatus::Idle,
        },
        Some(_)
            if journal.status == AgentStatus::Complete && silence_ms > STALE_BUSY_JOURNAL_MS =>
        {
            AgentStatus::Complete
        }
        Some(cli) => cli,
    };
    match status {
        AgentStatus::Idle | AgentStatus::Complete
            if journal.background.running(process_started_at) > 0 =>
        {
            AgentStatus::Background
        }
        other => other,
    }
}

fn exit_status(journal_status: AgentStatus) -> AgentStatus {
    match journal_status {
        AgentStatus::Complete | AgentStatus::Waiting => AgentStatus::Complete,
        _ => AgentStatus::Interrupted,
    }
}

/// What the last emit carried; a scan emits again only when this changes.
type Emitted = (AgentStatus, Option<String>, Option<AgentEventDetails>);

/// What a session's parent journal says, consumed incrementally.
#[derive(Debug, Clone, Default)]
struct Journal {
    status: AgentStatus,
    /// Last refresh that consumed new bytes; feeds `session_status`'s
    /// staleness check. `0` until first read.
    updated_at: i64,
    offset: u64,
    /// A same-path replacement that GREW the file passes the shrink check but
    /// invalidates the offset; the inode catches most of those (unix only).
    file_id: Option<(u64, u64)>,
    /// The inode is NOT reliable identity: ext4 hands a just-freed inode to
    /// the next file created, so remove+recreate at one path can keep its
    /// `(dev, ino)`. Journals are append-only, so a changed head is definitive.
    head: Vec<u8>,
    thread_name: Option<String>,
    usage: Option<ClaudeUsageSummary>,
    /// Session-level, and only ever *stated* inside an assistant `usage`
    /// entry — so the rotation reset would blank the readout until the next
    /// reply, which on an idle session is never.
    model: Option<String>,
    context_max: Option<i64>,
    last_tool: Option<String>,
    loop_state: Option<LoopInfo>,
    background: BackgroundAgents,
}

impl Journal {
    /// Consume what was appended to `path` since the last call; an unchanged
    /// length costs one `stat`.
    fn refresh(&mut self, path: &Path, now_ms: i64) {
        let Ok(meta) = std::fs::metadata(path) else {
            return;
        };
        let size = meta.len();
        let file_id = metadata_file_id(&meta);
        // Shrunk file → reset and re-derive: all journal-derived state is
        // stale, not just the offset. A same-path replacement that grew past
        // the old offset is the same situation, caught by the inode — or, when
        // ext4 reuses the freed inode, by the head (see `Journal::head`).
        // Probed only when the file moved: an unchanged size is the idle case.
        let head_changed = !self.head.is_empty()
            && self.offset > 0
            && size != self.offset
            && read_head(path, self.head.len()).is_some_and(|h| h != self.head);
        let rotated = size < self.offset
            || (file_id.is_some() && self.file_id.is_some() && file_id != self.file_id)
            || head_changed;
        if rotated {
            // `model`/`context_max` survive: same session, same model, and
            // re-deriving costs a full assistant turn.
            *self = Journal {
                updated_at: self.updated_at,
                model: self.model.take(),
                context_max: self.context_max,
                ..Journal::default()
            };
        }
        self.file_id = file_id;
        if size == self.offset {
            return;
        }

        // Journals reach tens of MB and append several times a second while
        // an agent streams; re-reading the whole file per scan was a hot loop.
        let Some(fresh) = read_from_offset(path, self.offset) else {
            return;
        };
        let consumed = consumed_len(&fresh);
        if consumed == 0 {
            return;
        }
        let text = String::from_utf8_lossy(&fresh[..consumed]);
        let parsed = parse_transcript(&text);
        if self.offset == 0 {
            self.head = fresh[..consumed.min(HEAD_PROBE_LEN)].to_vec();
        }
        self.offset += consumed as u64;
        self.updated_at = now_ms;

        for entry in &parsed {
            if self.thread_name.is_none()
                && let Some(name) = extract_thread_name(entry)
            {
                self.thread_name = Some(name);
            }
            if let Some(s) = determine_status(entry) {
                self.status = s;
            }
            self.background.observe(entry);
        }
        if let Some(usage) = extract_usage_summary(&parsed) {
            self.remember_identity(&usage);
            self.usage = Some(usage);
        }
        if let Some(tool) = extract_last_tool(&parsed) {
            self.last_tool = Some(tool);
        }
        if let Some(loop_state) = extract_loop_state(&parsed) {
            self.loop_state = Some(loop_state);
        }
    }

    /// `None` only when there is nothing at all to report; a known model alone
    /// is worth an event, or a rotation would blank a readout we can answer.
    fn details(&self, sub: &SubagentRollup, background: usize) -> Option<AgentEventDetails> {
        if self.usage.is_none()
            && self.last_tool.is_none()
            && sub.count == 0
            && self.loop_state.is_none()
            && self.model.is_none()
            && background == 0
        {
            return None;
        }
        let usage = self.usage.as_ref();
        Some(AgentEventDetails {
            model: self.model.clone(),
            context_used: usage.map(|u| u.context_used),
            context_max: self.context_max.or(usage.map(|u| u.context_max)),
            cache_expires_at: usage.and_then(|u| u.cache_expires_at),
            cache_ttl_ms: usage.and_then(|u| u.cache_ttl_ms),
            last_activity_at: usage.map(|u| u.last_activity_at),
            last_tool: self.last_tool.clone(),
            subagents: (!sub.active.is_empty()).then(|| sub.active.clone()),
            subagent_context_used: (sub.count > 0).then_some(sub.total_context),
            subagent_count: (sub.count > 0).then_some(sub.count),
            r#loop: self.loop_state.clone(),
            background_agents: (background > 0).then_some(background as i64),
        })
    }

    /// Silence is never an update: a summary naming no usable model leaves the
    /// known one alone. The two are recorded together because the window comes
    /// from the model this same entry named — accepting them independently
    /// could pair one entry's model with another's window.
    fn remember_identity(&mut self, usage: &ClaudeUsageSummary) {
        if usage.model.is_empty() || is_placeholder_model(&usage.model) {
            return;
        }
        self.model = Some(usage.model.clone());
        self.context_max = Some(usage.context_max);
    }
}

#[derive(Debug, Clone, Default)]
struct SessionState {
    emitted: Option<Emitted>,
    journal: Journal,
    journal_path: Option<PathBuf>,
    subagents: SubagentRollup,
    subagent_usage: SubagentUsage,
    /// `startedAt` of the process now running this session.
    process_started_at: Option<i64>,
    session: Option<String>,
    cli_name: Option<String>,
}

/// CLI discovery, journal enrichment.
pub struct ClaudeCodeAgentWatcher {
    projects_dir: PathBuf,
    sessions: HashMap<String, SessionState>,
    agents_source: Box<dyn Fn() -> Vec<CliAgent> + Send>,
    /// Was this pid launched by an app instance we report? Injectable so tests
    /// aren't at the mercy of real `/proc`. Externally-started sessions, and
    /// another instance's PTYs under per-instance scope, are dropped.
    app_launched: Box<dyn Fn(i32) -> bool + Send>,
}

impl ClaudeCodeAgentWatcher {
    /// Injectable CLI source and app-launched predicate; tests pass fixtures.
    pub fn new(
        projects_dir: PathBuf,
        agents_source: Box<dyn Fn() -> Vec<CliAgent> + Send>,
        app_launched: Box<dyn Fn(i32) -> bool + Send>,
    ) -> Self {
        Self { projects_dir, sessions: HashMap::new(), agents_source, app_launched }
    }

    /// Real `~/.claude/projects` + the shared cached CLI call, admitting only
    /// agents in `scope`.
    pub fn with_defaults(scope: crate::procenv::InstanceScope) -> Self {
        let projects_dir =
            dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".claude").join("projects");
        Self::new(
            projects_dir,
            Box::new(|| {
                crate::claude_cli::fetch_agents_cached(std::time::Duration::from_millis(
                    CLI_CACHE_TTL_MS,
                ))
                .agents
            }),
            Box::new(move |pid| crate::procenv::in_scope(pid, &scope)),
        )
    }

    fn find_journal(&self, cwd: &str, session_id: &str) -> Option<PathBuf> {
        find_journal(&self.projects_dir, cwd, session_id)
    }

    fn enrich_from_journal(&mut self, session_id: &str, cwd: &str, now_ms: i64) {
        let path = match self.sessions.get(session_id).and_then(|s| s.journal_path.clone()) {
            Some(p) if p.exists() => Some(p),
            _ => self.find_journal(cwd, session_id),
        };
        let state = self.sessions.entry(session_id.to_string()).or_default();
        state.journal_path = path.clone();
        let Some(path) = path else { return };

        // Sub-agents live in a sibling dir and burn tokens while the parent
        // journal stays static for minutes — so compute every scan.
        if let Some(base) = path.to_str().and_then(|s| s.strip_suffix(JSONL_SUFFIX)) {
            let dir = PathBuf::from(format!("{base}/subagents"));
            let rollup =
                state.subagent_usage.scan(&dir, now_ms, crate::types::JOURNAL_IDLE_TIMEOUT_MS);
            state.subagents = rollup;
        }

        state.journal.refresh(&path, now_ms);
    }

    /// First-prompt text beats the CLI's interactive slugs (`proj-44`);
    /// background sessions get descriptive CLI names.
    fn event_parts(state: &SessionState, status: AgentStatus) -> Emitted {
        let journal = &state.journal;
        let thread_name = journal.thread_name.clone().or_else(|| state.cli_name.clone());
        let background = journal.background.running(state.process_started_at);
        (status, thread_name, journal.details(&state.subagents, background))
    }

    fn emit(
        events: &mut Vec<AgentEvent>,
        session: &Option<String>,
        (status, thread_name, details): Emitted,
        session_id: &str,
        now_ms: i64,
    ) {
        let Some(session) = session.clone() else {
            return;
        };
        events.push(AgentEvent {
            agent: NAME.to_string(),
            session,
            status,
            ts: now_ms,
            thread_id: Some(session_id.to_string()),
            thread_name,
            unseen: None,
            details,
        });
    }

    /// One full scan at logical time `now_ms`; the caller owns the cadence.
    /// `resolve` maps an agent's cwd to a board session, `None` if unmatched.
    pub fn scan(
        &mut self,
        resolve: &dyn Fn(&str) -> Option<String>,
        now_ms: i64,
    ) -> Vec<AgentEvent> {
        let mut events = Vec::new();
        let agents = (self.agents_source)();
        let live_ids: HashSet<String> = agents.iter().map(|a| a.session_id.clone()).collect();

        for agent in &agents {
            // A Claude started in an external terminal — even one whose cwd is
            // inside a tracked checkout — or in another instance's PTY is not
            // ours to surface. (Env read is Linux-only; elsewhere nothing is
            // excluded.)
            if !(self.app_launched)(agent.pid) {
                continue;
            }
            let Some(session) = resolve(&agent.cwd) else {
                continue;
            };

            self.enrich_from_journal(&agent.session_id, &agent.cwd, now_ms);
            let state = self.sessions.get_mut(&agent.session_id).unwrap();
            state.session = Some(session);
            state.cli_name = agent.name.clone();
            state.process_started_at = agent.started_at;

            // An unrecognized CLI status reads as `idle`: listed, verdict unknown.
            let cli = agent.agent_status().unwrap_or(AgentStatus::Idle);
            let status =
                session_status(Some(cli), &state.journal, state.process_started_at, now_ms);
            let parts = Self::event_parts(state, status);
            if state.emitted.as_ref() != Some(&parts) {
                state.emitted = Some(parts.clone());
                Self::emit(&mut events, &state.session, parts, &agent.session_id, now_ms);
            }
        }

        let gone: Vec<String> =
            self.sessions.keys().filter(|id| !live_ids.contains(*id)).cloned().collect();
        for session_id in gone {
            let cwd = String::new();
            self.enrich_from_journal(&session_id, &cwd, now_ms);
            let Some(state) = self.sessions.remove(&session_id) else {
                continue;
            };
            if state.emitted.is_none() {
                // Never resolved/emitted — nothing on the board to finalize.
                continue;
            }
            let parts = Self::event_parts(&state, exit_status(state.journal.status));
            Self::emit(&mut events, &state.session, parts, &session_id, now_ms);
        }
        events
    }
}

/// Journals of live sessions the CLI didn't list, kept between rebuilds so
/// they are read incrementally, like the watcher's.
static UNLISTED: LazyLock<Mutex<HashMap<PathBuf, Journal>>> = LazyLock::new(Default::default);

/// An event per live app-launched session the CLI didn't list, keyed by its
/// `TT_SESSION_ID`, through the watcher's own [`session_status`]. A journal
/// not passed again is forgotten.
pub fn unlisted_events(procs: &[SessionAgentProc], now_ms: i64) -> HashMap<String, AgentEvent> {
    let mut journals = UNLISTED.lock().unwrap_or_else(|e| e.into_inner());
    let mut kept = HashMap::new();
    let mut events = HashMap::new();
    for proc in procs {
        let mut journal = Journal::default();
        if let Some(path) = &proc.transcript {
            journal = journals.remove(path).unwrap_or_default();
            journal.refresh(path, now_ms);
        }
        let background = journal.background.running(proc.started_at);
        let event = AgentEvent {
            agent: NAME.to_string(),
            session: String::new(),
            status: session_status(None, &journal, proc.started_at, now_ms),
            ts: now_ms,
            thread_id: None,
            thread_name: journal.thread_name.clone(),
            unseen: None,
            details: journal.details(&SubagentRollup::default(), background),
        };
        events.insert(proc.session_id.clone(), event);
        if let Some(path) = &proc.transcript {
            kept.insert(path.clone(), journal);
        }
    }
    *journals = kept;
    events
}

#[cfg(test)]
mod tests {
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

        fn scan(&mut self, watcher: &mut ClaudeCodeAgentWatcher, now_ms: i64) {
            let by_dir = &self.by_dir;
            let resolve = |dir: &str| by_dir.iter().find(|(d, _)| d == dir).map(|(_, s)| s.clone());
            self.events.extend(watcher.scan(&resolve, now_ms));
        }
    }

    fn cli_agent(pid: i32, cwd: &str, sid: &str, status: &str) -> CliAgent {
        CliAgent {
            pid,
            cwd: cwd.to_string(),
            kind: Some("interactive".into()),
            started_at: Some(1),
            session_id: sid.to_string(),
            name: Some(format!("slug-{pid}")),
            status: Some(status.to_string()),
            waiting_for: None,
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
        let source = agents.clone();
        let watcher = ClaudeCodeAgentWatcher::new(
            projects.clone(),
            Box::new(move || source.lock().unwrap().clone()),
            // No real /proc for fake pids; `drops_external_agents` overrides.
            Box::new(|_| true),
        );
        Fixture { _tmp: tmp, projects, agents, watcher }
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
    fn a_narration_entry_does_not_flip_a_working_agent_to_complete() {
        let mut f = fixture();
        write_journal(&f.projects, "/home/u/proj", "sid-n", &[USER_LINE, RUNNING_LINE]);
        *f.agents.lock().unwrap() = vec![CliAgent {
            // Unrecognized, so read as a CLI `idle` that defers to the journal.
            status: None,
            ..cli_agent(100, "/home/u/proj", "sid-n", "busy")
        }];
        let mut ctx = Ctx::new();
        ctx.by_dir.push(("/home/u/proj".into(), "proj".into()));

        ctx.scan(&mut f.watcher, 1_000);
        let before = ctx.events.len();

        write_journal(
            &f.projects,
            "/home/u/proj",
            "sid-n",
            &[USER_LINE, RUNNING_LINE, NARRATION_LINE],
        );
        ctx.scan(&mut f.watcher, 2_000);
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
        ctx.scan(&mut f.watcher, 3_000);
        assert_eq!(ctx.events.last().unwrap().status, AgentStatus::Complete);
    }

    #[test]
    fn busy_agent_emits_running_with_journal_enrichment() {
        let mut f = fixture();
        write_journal(&f.projects, "/home/u/proj", "sid-1", &[USER_LINE, RUNNING_LINE]);
        *f.agents.lock().unwrap() = vec![cli_agent(100, "/home/u/proj", "sid-1", "busy")];
        let mut ctx = Ctx::new();
        ctx.by_dir.push(("/home/u/proj".into(), "proj".into()));

        ctx.scan(&mut f.watcher, 1_000);
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
        *f.agents.lock().unwrap() = vec![cli_agent(100, "/home/u/proj", "sid-s", "busy")];
        let mut ctx = Ctx::new();
        ctx.by_dir.push(("/home/u/proj".into(), "proj".into()));
        ctx.scan(&mut f.watcher, 1_000);
        let window = ctx.events.last().unwrap().details.as_ref().unwrap().context_max.unwrap();

        write_journal(
            &f.projects,
            "/home/u/proj",
            "sid-s",
            &[USER_LINE, RUNNING_LINE, SYNTHETIC_LINE],
        );
        ctx.scan(&mut f.watcher, 2_000);
        write_journal(&f.projects, "/home/u/proj", "sid-s", &[USER_LINE]);
        ctx.scan(&mut f.watcher, 3_000);

        let d = ctx.events.last().unwrap().details.as_ref().unwrap();
        assert_eq!(d.model.as_deref(), Some("claude-sonnet-5"));
        assert_eq!(d.context_max, Some(window));
    }

    /// Same session, same model; only the position-derived counters are stale.
    #[test]
    fn model_survives_a_journal_rotation() {
        let mut f = fixture();
        write_journal(&f.projects, "/home/u/proj", "sid-r", &[USER_LINE, RUNNING_LINE]);
        *f.agents.lock().unwrap() = vec![cli_agent(100, "/home/u/proj", "sid-r", "busy")];
        let mut ctx = Ctx::new();
        ctx.by_dir.push(("/home/u/proj".into(), "proj".into()));
        ctx.scan(&mut f.watcher, 1_000);

        // Shorter file with a different head → the rotation reset path.
        write_journal(&f.projects, "/home/u/proj", "sid-r", &[USER_LINE]);
        ctx.scan(&mut f.watcher, 2_000);

        let d = ctx.events.last().unwrap().details.as_ref().unwrap();
        assert_eq!(d.model.as_deref(), Some("claude-sonnet-5"));
        // The counters are position-dependent, so they *should* be gone.
        assert_eq!(d.context_used, None);
    }

    fn unlisted(path: &Path, started_at: Option<i64>) -> SessionAgentProc {
        SessionAgentProc {
            session_id: "s00tt".into(),
            pid: 1,
            transcript: Some(path.to_path_buf()),
            started_at,
        }
    }

    #[test]
    fn unlisted_session_reads_name_and_status_from_its_journal() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("s.jsonl");
        let mut text = [USER_LINE, RUNNING_LINE].join("\n");
        text.push('\n');
        std::fs::write(&path, &text).unwrap();
        let ev = &unlisted_events(&[unlisted(&path, None)], 1_000)["s00tt"];
        assert_eq!(ev.thread_name.as_deref(), Some("fix the flaky test"));
        assert_eq!(ev.status, AgentStatus::Busy);
        assert_eq!(ev.details.as_ref().unwrap().model.as_deref(), Some("claude-sonnet-5"));

        {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
            writeln!(file, "{END_TURN_LINE}").unwrap();
        }
        let ev = &unlisted_events(&[unlisted(&path, None)], 2_000)["s00tt"];
        assert_eq!(ev.thread_name.as_deref(), Some("fix the flaky test"));
        assert_eq!(ev.status, AgentStatus::Complete);

        let gone = unlisted(&tmp.path().join("missing.jsonl"), None);
        let ev = &unlisted_events(&[gone], 3_000)["s00tt"];
        assert_eq!((ev.thread_name.as_deref(), ev.status), (None, AgentStatus::Idle));
    }

    /// A bounded tail read lost the launch line once the turn ran long.
    #[test]
    fn unlisted_session_sees_a_background_agent_launched_long_before_the_tail() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("s.jsonl");
        let launch = r#"{"type":"user","timestamp":"2026-09-30T22:00:00Z","toolUseResult":{"status":"async_launched","agentId":"a1"}}"#;
        let mut lines = vec![USER_LINE, launch];
        lines.extend(std::iter::repeat_n(NARRATION_LINE, 1_000));
        lines.push(END_TURN_LINE);
        let mut text = lines.join("\n");
        text.push('\n');
        assert!(text.len() as u64 > TAIL_WINDOW);
        std::fs::write(&path, &text).unwrap();

        let ev = &unlisted_events(&[unlisted(&path, Some(0))], 1_000)["s00tt"];
        assert_eq!(ev.status, AgentStatus::Background);
        assert_eq!(ev.details.as_ref().unwrap().background_agents, Some(1));

        let resumed_later = parse_timestamp_ms("2026-09-30T23:00:00Z");
        let ev = &unlisted_events(&[unlisted(&path, resumed_later)], 2_000)["s00tt"];
        assert_eq!(ev.status, AgentStatus::Complete);
    }

    #[test]
    fn idle_refines_by_journal_and_waiting_maps_to_question() {
        let mut f = fixture();
        // Journal ends done → idle process shows Done (unseen-✓ flow).
        write_journal(&f.projects, "/home/u/a", "sid-done", &[USER_LINE, DONE_LINE]);
        // Journal mid-run → idle process shows Waiting.
        write_journal(&f.projects, "/home/u/b", "sid-mid", &[USER_LINE, RUNNING_LINE]);
        *f.agents.lock().unwrap() = vec![
            cli_agent(1, "/home/u/a", "sid-done", "idle"),
            cli_agent(2, "/home/u/b", "sid-mid", "idle"),
            cli_agent(3, "/home/u/a", "sid-perm", "waiting"),
        ];
        let mut ctx = Ctx::new();
        ctx.by_dir.push(("/home/u/a".into(), "a".into()));
        ctx.by_dir.push(("/home/u/b".into(), "b".into()));

        ctx.scan(&mut f.watcher, 1_000);
        let by_thread: std::collections::HashMap<&str, AgentStatus> =
            ctx.events.iter().map(|e| (e.thread_id.as_deref().unwrap(), e.status)).collect();
        assert_eq!(by_thread["sid-done"], AgentStatus::Complete);
        assert_eq!(by_thread["sid-mid"], AgentStatus::Idle);
        assert_eq!(by_thread["sid-perm"], AgentStatus::Waiting);
    }

    #[test]
    fn a_finished_turn_with_a_background_agent_out_is_background_until_it_reports() {
        let mut f = fixture();
        let launch = r#"{"type":"user","timestamp":"2026-09-30T22:00:00Z","toolUseResult":{"status":"async_launched","agentId":"a1"}}"#;
        let path =
            write_journal(&f.projects, "/home/u/a", "sid-bg", &[USER_LINE, launch, DONE_LINE]);
        *f.agents.lock().unwrap() = vec![cli_agent(1, "/home/u/a", "sid-bg", "idle")];
        let mut ctx = Ctx::new();
        ctx.by_dir.push(("/home/u/a".into(), "a".into()));

        ctx.scan(&mut f.watcher, 1_000);
        let ev = ctx.events.last().unwrap();
        assert_eq!(ev.status, AgentStatus::Background);
        assert_eq!(ev.details.as_ref().unwrap().background_agents, Some(1));

        let done = r#"{"type":"queue-operation","timestamp":"2026-09-30T22:05:00Z","content":"<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>"}"#;
        let mut text = std::fs::read_to_string(&path).unwrap();
        text.push_str(done);
        text.push('\n');
        std::fs::write(&path, text).unwrap();
        ctx.scan(&mut f.watcher, 2_000);
        let ev = ctx.events.last().unwrap();
        assert_eq!(ev.status, AgentStatus::Complete);
        assert_eq!(ev.details.as_ref().and_then(|d| d.background_agents), None);
    }

    #[test]
    fn stuck_busy_from_stale_cli_status_self_heals_to_complete() {
        // The reported bug: the CLI keeps reporting `busy` long after the
        // transcript recorded the turn's end, and the board pulsed forever.
        let mut f = fixture();
        write_journal(&f.projects, "/home/u/p", "sid-stuck", &[USER_LINE, DONE_LINE]);
        *f.agents.lock().unwrap() = vec![cli_agent(9, "/home/u/p", "sid-stuck", "busy")];
        let mut ctx = Ctx::new();
        ctx.by_dir.push(("/home/u/p".into(), "p".into()));

        // A brief CLI lag must not flip it immediately, or the dot flaps.
        ctx.scan(&mut f.watcher, 1_000);
        assert_eq!(ctx.events.last().unwrap().status, AgentStatus::Busy);

        // Nothing new in the journal plus a CLI still insisting past the
        // window means stuck bookkeeping, not a working agent.
        ctx.scan(&mut f.watcher, 1_000 + STALE_BUSY_JOURNAL_MS + 1);
        assert_eq!(ctx.events.last().unwrap().status, AgentStatus::Complete);
    }

    #[test]
    fn busy_with_in_flight_tool_call_never_goes_stale() {
        // A multi-minute build writes nothing meanwhile, but the journal still
        // shows Busy — so staleness must never kick in, however long it runs.
        let mut f = fixture();
        write_journal(&f.projects, "/home/u/p", "sid-running", &[USER_LINE, RUNNING_LINE]);
        *f.agents.lock().unwrap() = vec![cli_agent(9, "/home/u/p", "sid-running", "busy")];
        let mut ctx = Ctx::new();
        ctx.by_dir.push(("/home/u/p".into(), "p".into()));

        ctx.scan(&mut f.watcher, 1_000);
        ctx.scan(&mut f.watcher, 1_000 + STALE_BUSY_JOURNAL_MS * 10);
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
            cli_agent(100, "/home/u/proj", "app-sid", "busy"),
            cli_agent(200, "/home/u/proj", "ext-sid", "busy"),
        ];
        let mut watcher = ClaudeCodeAgentWatcher::new(
            projects,
            Box::new(move || agents.clone()),
            Box::new(|pid| pid == 100), // only pid 100 carries TT_SESSION_ID
        );
        let mut ctx = Ctx::new();
        ctx.by_dir.push(("/home/u/proj".into(), "session-x".into()));

        ctx.scan(&mut watcher, 1_000);

        assert_eq!(ctx.events.len(), 1, "external agent should be dropped");
        assert_eq!(ctx.events[0].thread_id.as_deref(), Some("app-sid"));
    }

    #[test]
    fn no_reemit_without_change_but_usage_delta_reemits() {
        let mut f = fixture();
        let path = write_journal(&f.projects, "/home/u/p", "sid-1", &[USER_LINE, RUNNING_LINE]);
        *f.agents.lock().unwrap() = vec![cli_agent(9, "/home/u/p", "sid-1", "busy")];
        let mut ctx = Ctx::new();
        ctx.by_dir.push(("/home/u/p".into(), "p".into()));

        ctx.scan(&mut f.watcher, 1_000);
        ctx.scan(&mut f.watcher, 3_000);
        assert_eq!(ctx.events.len(), 1, "steady state must not re-emit");

        // Usage growth without a status change re-emits.
        let more = r#"{"timestamp":"2026-07-03T10:00:20.000Z","message":{"role":"assistant","model":"claude-sonnet-5","content":[{"type":"tool_use","name":"Read"}],"usage":{"input_tokens":900,"output_tokens":50}}}"#;
        let mut text = std::fs::read_to_string(&path).unwrap();
        text.push_str(more);
        text.push('\n');
        std::fs::write(&path, text).unwrap();

        ctx.scan(&mut f.watcher, 5_000);
        assert_eq!(ctx.events.len(), 2);
        assert_eq!(ctx.events[1].status, AgentStatus::Busy);
        assert_eq!(ctx.events[1].details.as_ref().unwrap().last_tool.as_deref(), Some("Read"));
    }

    #[test]
    fn exit_emits_done_or_interrupted_from_final_journal() {
        let mut f = fixture();
        let done_path =
            write_journal(&f.projects, "/home/u/a", "sid-done", &[USER_LINE, RUNNING_LINE]);
        write_journal(&f.projects, "/home/u/b", "sid-mid", &[USER_LINE, RUNNING_LINE]);
        *f.agents.lock().unwrap() = vec![
            cli_agent(1, "/home/u/a", "sid-done", "busy"),
            cli_agent(2, "/home/u/b", "sid-mid", "busy"),
        ];
        let mut ctx = Ctx::new();
        ctx.by_dir.push(("/home/u/a".into(), "a".into()));
        ctx.by_dir.push(("/home/u/b".into(), "b".into()));
        ctx.scan(&mut f.watcher, 1_000);
        ctx.events.clear();

        // sid-done's journal completes before it exits; sid-mid dies mid-run.
        let mut text = std::fs::read_to_string(&done_path).unwrap();
        text.push_str(DONE_LINE);
        text.push('\n');
        std::fs::write(&done_path, text).unwrap();
        f.agents.lock().unwrap().clear();

        ctx.scan(&mut f.watcher, 5_000);
        let by_thread: std::collections::HashMap<&str, AgentStatus> =
            ctx.events.iter().map(|e| (e.thread_id.as_deref().unwrap(), e.status)).collect();
        assert_eq!(by_thread["sid-done"], AgentStatus::Complete);
        assert_eq!(by_thread["sid-mid"], AgentStatus::Interrupted);
        // Gone for good: nothing further on later scans.
        ctx.events.clear();
        ctx.scan(&mut f.watcher, 7_000);
        assert!(ctx.events.is_empty());
    }

    #[test]
    fn unresolved_agents_never_emit_even_on_exit() {
        let mut f = fixture();
        write_journal(&f.projects, "/home/u/x", "sid-x", &[USER_LINE, RUNNING_LINE]);
        *f.agents.lock().unwrap() = vec![cli_agent(1, "/home/u/x", "sid-x", "busy")];
        let mut ctx = Ctx::new(); // resolves nothing
        ctx.scan(&mut f.watcher, 1_000);
        f.agents.lock().unwrap().clear();
        ctx.scan(&mut f.watcher, 3_000);
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
        *f.agents.lock().unwrap() = vec![cli_agent(7, "/home/u/p", "sid-1", "busy")];
        let mut ctx = Ctx::new();
        ctx.by_dir.push(("/home/u/p".into(), "p".into()));
        ctx.scan(&mut f.watcher, 1_000);
        assert_eq!(ctx.events[0].thread_name.as_deref(), Some("slug-7"));
    }

    #[test]
    fn shrunk_journal_resets_and_rederives() {
        let mut f = fixture();
        let path = write_journal(&f.projects, "/home/u/p", "sid-1", &[USER_LINE, RUNNING_LINE]);
        *f.agents.lock().unwrap() = vec![cli_agent(7, "/home/u/p", "sid-1", "busy")];
        let mut ctx = Ctx::new();
        ctx.by_dir.push(("/home/u/p".into(), "p".into()));
        ctx.scan(&mut f.watcher, 1_000);

        // Truncate + rewrite with a different prompt: state re-derives.
        let replacement = r#"{"message":{"role":"user","content":"a brand new thread"}}"#;
        std::fs::write(&path, format!("{replacement}\n")).unwrap();
        ctx.scan(&mut f.watcher, 3_000);
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
        *f.agents.lock().unwrap() = vec![cli_agent(7, "/home/u/my-app", "sid-1", "busy")];
        let mut ctx = Ctx::new();
        ctx.by_dir.push(("/home/u/my-app".into(), "p".into()));
        ctx.scan(&mut f.watcher, 1_000);
        assert_eq!(ctx.events[0].thread_name.as_deref(), Some("fix the flaky test"));
    }

    #[test]
    fn incremental_append_is_picked_up_across_scans() {
        let mut f = fixture();
        let path =
            write_journal(&f.projects, "/home/u/proj", "sid-inc", &[USER_LINE, RUNNING_LINE]);
        *f.agents.lock().unwrap() = vec![cli_agent(100, "/home/u/proj", "sid-inc", "busy")];
        let mut ctx = Ctx::new();
        ctx.by_dir.push(("/home/u/proj".into(), "proj".into()));
        ctx.scan(&mut f.watcher, 1_000);
        assert_eq!(ctx.events.last().unwrap().status, AgentStatus::Busy);

        {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
            writeln!(file, "{DONE_LINE}").unwrap();
        }
        *f.agents.lock().unwrap() = vec![cli_agent(100, "/home/u/proj", "sid-inc", "idle")];
        ctx.scan(&mut f.watcher, 2_000);
        assert_eq!(ctx.events.last().unwrap().status, AgentStatus::Complete);
    }

    #[test]
    fn replaced_journal_resets_offset_and_rederives() {
        let mut f = fixture();
        let path =
            write_journal(&f.projects, "/home/u/proj", "sid-rot", &[USER_LINE, RUNNING_LINE]);
        *f.agents.lock().unwrap() = vec![cli_agent(100, "/home/u/proj", "sid-rot", "busy")];
        let mut ctx = Ctx::new();
        ctx.by_dir.push(("/home/u/proj".into(), "proj".into()));
        ctx.scan(&mut f.watcher, 1_000);
        assert_eq!(ctx.events.last().unwrap().thread_name.as_deref(), Some("fix the flaky test"));

        // Replace the journal at the same path with a LARGER file (new inode):
        // without rotation detection the stored offset would land mid-file and
        // the new head (thread name) would never be seen.
        std::fs::remove_file(&path).unwrap();
        let new_user = r#"{"timestamp":"2026-07-03T11:00:00.000Z","message":{"role":"user","content":"a rewritten journal with a much longer opening prompt than before"}}"#;
        write_journal(&f.projects, "/home/u/proj", "sid-rot", &[new_user, RUNNING_LINE, DONE_LINE]);
        *f.agents.lock().unwrap() = vec![cli_agent(100, "/home/u/proj", "sid-rot", "idle")];
        ctx.scan(&mut f.watcher, 2_000);
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
        *f.agents.lock().unwrap() = vec![cli_agent(100, "/home/u/proj", "sid-same", "busy")];
        let mut ctx = Ctx::new();
        ctx.by_dir.push(("/home/u/proj".into(), "proj".into()));
        ctx.scan(&mut f.watcher, 1_000);
        assert_eq!(ctx.events.last().unwrap().thread_name.as_deref(), Some("fix the flaky test"));

        // Rewrite the journal LARGER, in place (`fs::write` truncates the
        // existing file, so the inode is guaranteed unchanged — the case
        // remove+recreate only hits when the fs reuses the freed inode). The
        // shrink and inode checks both pass; only the head change gives the
        // replacement away.
        let new_user = r#"{"timestamp":"2026-07-03T11:00:00.000Z","message":{"role":"user","content":"a rewritten journal with a much longer opening prompt than before"}}"#;
        write_journal(
            &f.projects,
            "/home/u/proj",
            "sid-same",
            &[new_user, RUNNING_LINE, DONE_LINE],
        );
        *f.agents.lock().unwrap() = vec![cli_agent(100, "/home/u/proj", "sid-same", "idle")];
        ctx.scan(&mut f.watcher, 2_000);
        let ev = ctx.events.last().unwrap();
        assert_eq!(
            ev.thread_name.as_deref(),
            Some("a rewritten journal with a much longer opening prompt than before")
        );
        assert_eq!(ev.status, AgentStatus::Complete);
    }
}
