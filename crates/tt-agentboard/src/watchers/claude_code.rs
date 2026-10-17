//! Claude Code agent watcher. **Discovery and liveness come from `claude
//! agents --all --json`** ([`crate::claude_cli`]); **the journal says where the
//! turn stands** — busy or not, and everything else the CLI doesn't expose
//! (model, last tool, usage, sub-agents, `/loop` wakeups, the thread name).
//!
//! Per scan: list live agents, resolve each to a session by cwd, then emit the
//! journal's status with the count of background agents still out beside it.
//! A session that vanished gets one final journal read and a terminal emit.
//! Deliberate limit: one that exited before the server started never appears
//! at all. A session the cached CLI list doesn't have yet is passed in from
//! Claude Code's own session file.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use tt_claude_code::TranscriptEntry;

use crate::claude_cli::{AgentScan, CliAgent};
use crate::types::{AgentEvent, AgentEventDetails, AgentStatus, LoopInfo, SubagentInfo};
use crate::watchers::claude_usage::{ClaudeUsageSummary, usage_summary_of};
use crate::watchers::ledger::SubagentLedger;
use crate::watchers::subagents::{SubagentRollup, SubagentUsage};

const NAME: &str = "claude-code";
pub const JSONL_SUFFIX: &str = ".jsonl";
/// Shared CLI snapshot TTL, which alone sets how often the ~170ms Node process spawns.
pub const CLI_CACHE_TTL_MS: u64 = 60_000;

pub fn parse_timestamp_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|dt| dt.timestamp_millis())
}

/// Where an entry leaves the turn, `None` for one that doesn't move it. A user
/// entry starts a turn unless Claude Code wrote it itself (a skill body, a
/// compaction summary, a local command and its output); an interrupt ends one.
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
        "user" if entry.is_meta == Some(true) || entry.is_compact_summary == Some(true) => None,
        "user" => {
            let text = msg.content.as_ref().and_then(|c| c.first_text()).unwrap_or_default();
            let text = text.trim_start();
            if text.starts_with("[Request interrupted by user") {
                Some(AgentStatus::Idle)
            } else if LOCAL_ENTRY_PREFIXES.iter().any(|tag| text.starts_with(tag))
                || is_raw_slash_command(text)
            {
                None
            } else {
                Some(AgentStatus::Busy)
            }
        }
        _ => None,
    }
}

/// Entries no model turn follows: a slash command's own (a prompt command's
/// turn starts at the reply), `!` bash mode, and an unknown `/skill`.
const LOCAL_ENTRY_PREFIXES: [&str; 7] = [
    "<command-name>",
    "<command-message>",
    "<local-command-",
    "<bash-input>",
    "<bash-stdout>",
    "<bash-stderr>",
    "Unknown skill: ",
];

/// `/compact …` or a backgrounded `/code-review …`, logged as typed; a path
/// like `/home/u/x.rs` is a prompt.
fn is_raw_slash_command(text: &str) -> bool {
    let name = text.split_whitespace().next().and_then(|w| w.strip_prefix('/'));
    name.is_some_and(|n| n.starts_with(|c: char| c.is_ascii_alphabetic()) && !n.contains('/'))
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

fn assistant_tool_uses(
    entry: &TranscriptEntry,
) -> impl Iterator<Item = tt_claude_code::ToolUse<'_>> {
    let msg = entry.message.as_ref().filter(|m| m.role.as_deref() == Some("assistant"));
    msg.and_then(|m| m.content.as_ref()).into_iter().flat_map(|c| c.tool_uses())
}

fn last_tool_of(entry: &TranscriptEntry) -> Option<String> {
    assistant_tool_uses(entry)
        .filter_map(|tool| tool.name())
        .find(|name| *name != "AskUserQuestion")
        .map(str::to_string)
}

fn loop_state_of(entry: &TranscriptEntry) -> Option<LoopInfo> {
    let tool = assistant_tool_uses(entry).find(|t| t.name() == Some("ScheduleWakeup"))?;
    let input = tool.input();
    let delay = input.and_then(|i| i.get("delaySeconds")).and_then(|v| v.as_f64())?;
    let scheduled_at = entry.timestamp.as_deref().and_then(parse_timestamp_ms)?;
    let reason = input.and_then(|i| i.get("reason")).and_then(|v| v.as_str()).map(str::to_string);
    Some(LoopInfo { next_wake_at: scheduled_at + (delay * 1000.0) as i64, reason })
}

/// Claude Code labels its own generated entries with a bracketed model id, and
/// they are structurally ordinary assistant entries — taking the newest one's
/// identity would relabel a 1M Sonnet session onto the 200K window. Real ids
/// are never bracketed, so this rejects placeholders but not an unknown model.
fn is_placeholder_model(model: &str) -> bool {
    model.starts_with('<')
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
    ledger: SubagentLedger,
}

impl Journal {
    /// Consume what was appended to `path` since the last call; an unchanged
    /// length costs one `stat`.
    fn refresh(&mut self, path: &Path) {
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
                model: self.model.take(),
                context_max: self.context_max,
                ..Journal::default()
            };
        }
        self.file_id = file_id;
        if size == self.offset {
            return;
        }

        // Journals reach tens of MB, so this streams a line at a time from
        // the last offset; a partial trailing line waits for the next refresh.
        let Ok(file) = std::fs::File::open(path) else {
            return;
        };
        let mut reader = BufReader::new(file);
        if reader.seek(SeekFrom::Start(self.offset)).is_err() {
            return;
        }
        let capture_head = self.offset == 0;
        let mut line = Vec::new();
        loop {
            line.clear();
            let n = match reader.read_until(b'\n', &mut line) {
                Ok(n) if n > 0 && line.ends_with(b"\n") => n,
                _ => break,
            };
            if capture_head && self.head.len() < HEAD_PROBE_LEN {
                let take = (HEAD_PROBE_LEN - self.head.len()).min(n);
                self.head.extend_from_slice(&line[..take]);
            }
            self.offset += n as u64;
            if let Ok(entry) =
                serde_json::from_str::<TranscriptEntry>(&String::from_utf8_lossy(&line))
            {
                self.observe(&entry);
            }
        }
    }

    fn observe(&mut self, entry: &TranscriptEntry) {
        if self.thread_name.is_none() {
            self.thread_name = extract_thread_name(entry);
        }
        if let Some(s) = determine_status(entry) {
            self.status = s;
        }
        self.ledger.observe(entry);
        if let Some(usage) = usage_summary_of(entry) {
            self.remember_identity(&usage);
            self.usage = Some(usage);
        }
        if let Some(tool) = last_tool_of(entry) {
            self.last_tool = Some(tool);
        }
        if let Some(loop_state) = loop_state_of(entry) {
            self.loop_state = Some(loop_state);
        }
    }

    /// `None` only when there is nothing at all to report; a known model alone
    /// is worth an event, or a rotation would blank a readout we can answer.
    fn details(
        &self,
        threads: &SubagentRollup,
        process_started_at: Option<i64>,
    ) -> Option<AgentEventDetails> {
        let running = self.ledger.running(process_started_at);
        let tasks = self.ledger.tasks_running(process_started_at);
        let count = threads.threads.len() as i64;
        if self.usage.is_none()
            && self.last_tool.is_none()
            && count == 0
            && self.loop_state.is_none()
            && self.model.is_none()
            && running.is_empty()
            && tasks == 0
        {
            return None;
        }
        let background = running.iter().filter(|l| l.background).count();
        let subagents: Vec<SubagentInfo> = running
            .iter()
            .map(|l| {
                let thread = threads.thread(l.agent_id.as_deref(), l.tool_use_id.as_deref());
                let meta = thread.map(|t| &t.meta);
                SubagentInfo {
                    agent_type: l.agent_type.clone().or_else(|| meta?.agent_type.clone()),
                    description: l.description.clone().or_else(|| meta?.description.clone()),
                    context_used: thread.map(|t| t.context).filter(|c| *c > 0),
                }
            })
            .collect();
        let usage = self.usage.as_ref();
        Some(AgentEventDetails {
            model: self.model.clone(),
            context_used: usage.map(|u| u.context_used),
            context_max: self.context_max.or(usage.map(|u| u.context_max)),
            cache_expires_at: usage.and_then(|u| u.cache_expires_at),
            cache_ttl_ms: usage.and_then(|u| u.cache_ttl_ms),
            last_activity_at: usage.map(|u| u.last_activity_at),
            last_tool: self.last_tool.clone(),
            subagents: (!subagents.is_empty()).then_some(subagents),
            subagent_context_used: (count > 0).then_some(threads.total_context),
            subagent_count: (count > 0).then_some(count),
            r#loop: self.loop_state.clone(),
            background_agents: (background > 0).then_some(background as i64),
            background_tasks: (tasks > 0).then_some(tasks as i64),
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

/// One change in where a journal leaves its session, replayed from line one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalStep {
    pub at_ms: i64,
    pub status: AgentStatus,
    /// Background agents plus tasks still out.
    pub background: i64,
    /// Started by a prompt the user typed, not by a report Claude Code delivered.
    pub prompted: bool,
}

/// A whole journal as the watcher would have read it live, line by line.
#[derive(Debug, Clone, Default)]
pub struct JournalReplay {
    pub cwd: Option<String>,
    /// `cli` for a session someone typed into; `sdk-cli` for a `claude -p`.
    pub entrypoint: Option<String>,
    pub git_branch: Option<String>,
    pub thread_name: Option<String>,
    /// Every change of status or background count. Every launch counts, as if
    /// one process ran the session throughout.
    pub steps: Vec<JournalStep>,
}

pub fn replay_journal(path: &Path) -> JournalReplay {
    let mut journal = Journal::default();
    let mut out = JournalReplay::default();
    let Ok(file) = std::fs::File::open(path) else {
        return out;
    };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(entry) = serde_json::from_str::<TranscriptEntry>(&line) else {
            continue;
        };
        let Some(at_ms) = entry.timestamp.as_deref().and_then(parse_timestamp_ms) else {
            continue;
        };
        if out.cwd.is_none() {
            out.cwd = entry.cwd.clone();
        }
        if out.entrypoint.is_none() {
            out.entrypoint = entry.entrypoint.clone();
        }
        if entry.git_branch.as_deref().is_some_and(|b| !b.is_empty()) {
            out.git_branch = entry.git_branch.clone();
        }
        journal.observe(&entry);
        let ledger = &journal.ledger;
        let background = (ledger.background_running(None) + ledger.tasks_running(None)) as i64;
        let status = journal.status;
        if out.steps.last().is_some_and(|s| s.status == status && s.background == background) {
            continue;
        }
        let prompted = is_typed_prompt(&entry);
        out.steps.push(JournalStep { at_ms, status, background, prompted });
    }
    out.thread_name = journal.thread_name;
    out
}

fn is_typed_prompt(entry: &TranscriptEntry) -> bool {
    let text = entry
        .message
        .as_ref()
        .filter(|m| m.role.as_deref() == Some("user"))
        .and_then(|m| m.content.as_ref())
        .and_then(|c| c.first_text());
    determine_status(entry) == Some(AgentStatus::Busy)
        && text.is_some_and(|t| !t.trim_start().starts_with('<'))
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
    /// Was this pid launched by an app instance we report? Injectable for tests.
    app_launched: Box<dyn Fn(i32) -> bool + Send>,
}

impl ClaudeCodeAgentWatcher {
    /// Injectable app-launched predicate; tests pass fixtures.
    pub fn new(projects_dir: PathBuf, app_launched: Box<dyn Fn(i32) -> bool + Send>) -> Self {
        Self { projects_dir, sessions: HashMap::new(), app_launched }
    }

    /// Real `~/.claude/projects`, admitting only agents in `scope`.
    pub fn with_defaults(scope: crate::procenv::InstanceScope) -> Self {
        let projects_dir = tt_config::claude_dir().join("projects");
        Self::new(projects_dir, Box::new(move |pid| crate::procenv::in_scope(pid, &scope)))
    }

    fn find_journal(&self, cwd: &str, session_id: &str) -> Option<PathBuf> {
        find_journal(&self.projects_dir, cwd, session_id)
    }

    fn enrich_from_journal(&mut self, session_id: &str, cwd: &str) {
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
            state.subagents = state.subagent_usage.scan(&dir);
        }

        state.journal.refresh(&path);
    }

    /// First-prompt text beats the CLI's interactive slugs (`proj-44`);
    /// background sessions get descriptive CLI names.
    fn event_parts(state: &SessionState, status: AgentStatus) -> Emitted {
        let journal = &state.journal;
        let thread_name = journal.thread_name.clone().or_else(|| state.cli_name.clone());
        (status, thread_name, journal.details(&state.subagents, state.process_started_at))
    }

    /// A process that exited took its background agents and tasks with it, whatever the
    /// ledger still holds — else the pane would read as working for good.
    fn exit_parts(state: &SessionState) -> Emitted {
        let (status, name, mut details) =
            Self::event_parts(state, exit_status(state.journal.status));
        if let Some(d) = details.as_mut() {
            d.background_agents = None;
            d.background_tasks = None;
        }
        (status, name, details)
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

    /// One full scan of the host's `claude agents` answer at logical time
    /// `now_ms`; the caller owns the cadence and the CLI call. `resolve` maps an
    /// agent's cwd to a board session, `None` if unmatched. `unlisted` are live
    /// sessions `cli` doesn't have yet, taken as listed.
    pub fn scan(
        &mut self,
        resolve: &dyn Fn(&str) -> Option<String>,
        cli: &AgentScan,
        unlisted: &[CliAgent],
        now_ms: i64,
    ) -> Vec<AgentEvent> {
        let mut events = Vec::new();
        // A failed scan's empty list proves nothing: reading it as "all gone"
        // would finish every live agent and fire a needs-you for each.
        if !cli.ok {
            return events;
        }
        let mut agents: Vec<&CliAgent> = cli.agents.iter().collect();
        for agent in unlisted {
            if !agents.iter().any(|a| a.session_id == agent.session_id) {
                agents.push(agent);
            }
        }
        let live_ids: HashSet<&str> = agents.iter().map(|a| a.session_id.as_str()).collect();

        for agent in agents {
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

            self.enrich_from_journal(&agent.session_id, &agent.cwd);
            let state = self.sessions.get_mut(&agent.session_id).unwrap();
            state.session = Some(session);
            state.cli_name = agent.name.clone();
            state.process_started_at = agent.started_at;

            let parts = Self::event_parts(state, state.journal.status);
            if state.emitted.as_ref() != Some(&parts) {
                state.emitted = Some(parts.clone());
                Self::emit(&mut events, &state.session, parts, &agent.session_id, now_ms);
            }
        }

        let gone: Vec<String> =
            self.sessions.keys().filter(|id| !live_ids.contains(id.as_str())).cloned().collect();
        for session_id in gone {
            let cwd = String::new();
            self.enrich_from_journal(&session_id, &cwd);
            let Some(state) = self.sessions.remove(&session_id) else {
                continue;
            };
            if state.emitted.is_none() {
                // Never resolved/emitted — nothing on the board to finalize.
                continue;
            }
            // A verdict already on the board, perhaps already seen, isn't news.
            let parts = Self::exit_parts(&state);
            if state.emitted.as_ref() != Some(&parts) {
                Self::emit(&mut events, &state.session, parts, &session_id, now_ms);
            }
        }
        events
    }
}

#[cfg(test)]
mod tests;
