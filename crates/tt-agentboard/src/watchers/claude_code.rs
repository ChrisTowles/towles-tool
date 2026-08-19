//! Claude Code agent watcher. **Discovery and liveness come from `claude
//! agents --all --json`** ([`crate::claude_cli`]); **journals are enrichment
//! only**, supplying what the CLI doesn't expose (model, last tool, usage,
//! sub-agents, `/loop` wakeups, the first-prompt thread name).
//!
//! Per scan: list live agents, resolve each to a session by cwd, then refine
//! status (`refine_busy`/`refine_idle`). A session that vanished gets one final
//! journal read and a terminal emit. Deliberate limit: one that exited before
//! the server started never appears at all.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use tt_claude_code::{TranscriptEntry, parse_transcript};

use crate::claude_cli::CliAgent;
use crate::types::{AgentEvent, AgentEventDetails, AgentStatus, LoopInfo};
use crate::watcher::{AgentWatcher, JSONL_SUFFIX, WatcherContext};
use crate::watchers::claude_usage::{ClaudeUsageSummary, extract_usage_summary};
use crate::watchers::subagents::{self, SubagentRollup, SubagentUsage};

const NAME: &str = "claude-code";
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

/// `(thread_name, status)` for a live agent detected outside the CLI snapshot.
/// Bounded reads keep large transcripts cheap: the name is near the top, the
/// status near the bottom.
pub fn enrich_from_transcript(path: &Path) -> (Option<String>, AgentStatus) {
    const WINDOW: u64 = 128 * 1024;
    let head = read_window(path, 0, WINDOW);
    let thread_name = parse_transcript(&head).iter().find_map(extract_thread_name);
    let len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let tail = read_window(path, len.saturating_sub(WINDOW), WINDOW);
    let status = parse_transcript(&tail)
        .iter()
        .rev()
        .find_map(determine_status)
        .unwrap_or(AgentStatus::Idle);
    (thread_name, status)
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

/// Partial JSONL lines at either edge fail to parse and are dropped by
/// `parse_transcript`, so no newline alignment is needed.
fn read_window(path: &Path, start: u64, max: u64) -> String {
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

fn summary_to_details(s: &ClaudeUsageSummary) -> AgentEventDetails {
    AgentEventDetails {
        // Empty means "unknown", so `SessionState`'s known model can fill in.
        model: Some(s.model.clone()).filter(|m| !m.is_empty()),
        context_used: Some(s.context_used),
        context_max: Some(s.context_max),
        cache_expires_at: s.cache_expires_at,
        cache_ttl_ms: s.cache_ttl_ms,
        last_activity_at: Some(s.last_activity_at),
        last_tool: None,
        subagents: None,
        subagent_context_used: None,
        subagent_count: None,
        r#loop: None,
    }
}

fn build_details(
    usage: Option<&ClaudeUsageSummary>,
    last_tool: Option<&str>,
    subagents: &SubagentRollup,
    loop_state: Option<&LoopInfo>,
) -> Option<AgentEventDetails> {
    let has_subagents = subagents.count > 0;
    if usage.is_none() && last_tool.is_none() && !has_subagents && loop_state.is_none() {
        return None;
    }
    let mut base = usage.map(summary_to_details).unwrap_or_default();
    if let Some(t) = last_tool {
        base.last_tool = Some(t.to_string());
    }
    if has_subagents {
        base.subagent_count = Some(subagents.count);
        base.subagent_context_used = Some(subagents.total_context);
        if !subagents.active.is_empty() {
            base.subagents = Some(subagents.active.clone());
        }
    }
    if let Some(l) = loop_state {
        base.r#loop = Some(l.clone());
    }
    Some(base)
}

/// A CLI `idle` takes the journal's view where the UI treats it specially:
/// `complete` (unseen-✓ flow) or `waiting`; anything else is plain `idle`.
fn refine_idle(journal_status: AgentStatus) -> AgentStatus {
    match journal_status {
        AgentStatus::Complete => AgentStatus::Complete,
        AgentStatus::Waiting => AgentStatus::Waiting,
        _ => AgentStatus::Idle,
    }
}

/// How long a CLI `busy`/`waiting` is trusted past the journal's turn-end:
/// past ordinary CLI lag, short enough that a stuck session self-heals.
const STALE_BUSY_JOURNAL_MS: i64 = 60_000;

/// The `busy`-side counterpart to `refine_idle`. Nothing re-derives the CLI's
/// status while the process stays listed, so bookkeeping that fails to flip
/// back would show the agent "working" forever. Only a journal that recorded a
/// plain no-tool-call final response, with nothing appended since, counts.
fn refine_busy(
    cli_status: AgentStatus,
    journal_status: AgentStatus,
    journal_silence_ms: i64,
) -> AgentStatus {
    if journal_status == AgentStatus::Complete && journal_silence_ms > STALE_BUSY_JOURNAL_MS {
        AgentStatus::Complete
    } else {
        cli_status
    }
}

fn exit_status(journal_status: AgentStatus) -> AgentStatus {
    match journal_status {
        AgentStatus::Complete | AgentStatus::Waiting => AgentStatus::Complete,
        _ => AgentStatus::Interrupted,
    }
}

#[derive(Debug, Clone)]
struct SessionState {
    emitted_status: Option<AgentStatus>,
    journal_status: AgentStatus,
    /// Last scan that consumed new bytes; feeds `refine_busy`'s staleness
    /// check. `0` until first read.
    journal_updated_at: i64,
    file_offset: u64,
    /// A same-path replacement that GREW the file passes the shrink check but
    /// invalidates the offset; the inode catches most of those (unix only).
    file_id: Option<(u64, u64)>,
    /// The inode is NOT reliable identity: ext4 hands a just-freed inode to
    /// the next file created, so remove+recreate at one path can keep its
    /// `(dev, ino)`. Journals are append-only, so a changed head is definitive.
    head: Vec<u8>,
    journal_path: Option<PathBuf>,
    thread_name: Option<String>,
    usage: Option<ClaudeUsageSummary>,
    /// Session-level, and only ever *stated* inside an assistant `usage`
    /// entry — so the rotation reset would blank the readout until the next
    /// reply, which on an idle session is never. Carried across like
    /// `thread_name`: neither changes when the journal is replaced.
    model: Option<String>,
    context_max: Option<i64>,
    last_tool: Option<String>,
    subagents: SubagentRollup,
    subagent_sig: String,
    subagent_usage: SubagentUsage,
    loop_state: Option<LoopInfo>,
    /// Part of the emit gate, so usage deltas broadcast with no status change.
    last_emit_sig: Option<String>,
    session: Option<String>,
    cli_name: Option<String>,
}

impl Default for SessionState {
    fn default() -> Self {
        Self {
            emitted_status: None,
            journal_status: AgentStatus::Idle,
            journal_updated_at: 0,
            file_offset: 0,
            file_id: None,
            head: Vec::new(),
            journal_path: None,
            thread_name: None,
            usage: None,
            model: None,
            context_max: None,
            last_tool: None,
            subagents: SubagentRollup::default(),
            subagent_sig: String::new(),
            subagent_usage: SubagentUsage::default(),
            loop_state: None,
            last_emit_sig: None,
            session: None,
            cli_name: None,
        }
    }
}

impl SessionState {
    fn details(&self) -> Option<AgentEventDetails> {
        let from_tail = build_details(
            self.usage.as_ref(),
            self.last_tool.as_deref(),
            &self.subagents,
            self.loop_state.as_ref(),
        );
        // Worth an event alone: after a rotation there is nothing else to
        // report yet, and `None` would blank a readout we can still answer.
        let mut d = match from_tail {
            Some(d) => d,
            None if self.model.is_some() => AgentEventDetails::default(),
            None => return None,
        };
        if d.model.is_none() {
            d.model.clone_from(&self.model);
        }
        if d.context_max.is_none() {
            d.context_max = self.context_max;
        }
        Some(d)
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

// Watcher.

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
            state.subagent_sig = format!(
                "{}|{}|{}",
                subagents::signature(&rollup.active),
                rollup.total_context,
                rollup.count
            );
            state.subagents = rollup;
        }

        let Ok(meta) = std::fs::metadata(&path) else {
            return;
        };
        let size = meta.len();
        let file_id = metadata_file_id(&meta);
        // Shrunk file → reset and re-derive: all journal-derived state is
        // stale, not just the offset. A same-path replacement that grew past
        // the old offset is the same situation, caught by the inode — or, when
        // ext4 reuses the freed inode, by the head (see `SessionState::head`).
        let head_changed = !state.head.is_empty()
            && state.file_offset > 0
            && read_head(&path, state.head.len()).is_some_and(|h| h != state.head);
        let rotated = size < state.file_offset
            || (file_id.is_some() && state.file_id.is_some() && file_id != state.file_id)
            || head_changed;
        if rotated {
            state.file_offset = 0;
            state.journal_status = AgentStatus::Idle;
            state.thread_name = None;
            state.usage = None;
            state.last_tool = None;
            state.loop_state = None;
            state.head.clear();
            // `model`/`context_max` survive: same session, same model, and
            // re-deriving costs a full assistant turn.
        }
        state.file_id = file_id;
        if size == state.file_offset {
            return;
        }

        // Journals reach tens of MB and append several times a second while
        // an agent streams; re-reading the whole file per scan was a hot loop.
        let Some(fresh) = read_from_offset(&path, state.file_offset) else {
            return;
        };
        let consumed = consumed_len(&fresh);
        if consumed == 0 {
            return;
        }
        let text = String::from_utf8_lossy(&fresh[..consumed]);
        let parsed = parse_transcript(&text);
        if state.file_offset == 0 {
            state.head = fresh[..consumed.min(HEAD_PROBE_LEN)].to_vec();
        }
        state.file_offset += consumed as u64;
        state.journal_updated_at = now_ms;

        for entry in &parsed {
            if state.thread_name.is_none()
                && let Some(name) = extract_thread_name(entry)
            {
                state.thread_name = Some(name);
            }
            if let Some(s) = determine_status(entry) {
                state.journal_status = s;
            }
        }
        if let Some(usage) = extract_usage_summary(&parsed) {
            state.remember_identity(&usage);
            state.usage = Some(usage);
        }
        if let Some(tool) = extract_last_tool(&parsed) {
            state.last_tool = Some(tool);
        }
        if let Some(loop_state) = extract_loop_state(&parsed) {
            state.loop_state = Some(loop_state);
        }
    }

    fn emit(
        ctx: &mut dyn WatcherContext,
        state: &SessionState,
        status: AgentStatus,
        session_id: &str,
        now_ms: i64,
    ) {
        let Some(session) = state.session.clone() else {
            return;
        };
        ctx.emit(AgentEvent {
            agent: NAME.to_string(),
            session,
            status,
            ts: now_ms,
            thread_id: Some(session_id.to_string()),
            // First-prompt text beats the CLI's interactive slugs (`proj-44`);
            // background agents get descriptive CLI names.
            thread_name: state.thread_name.clone().or_else(|| state.cli_name.clone()),
            unseen: None,
            details: state.details(),
        });
    }
}

impl AgentWatcher for ClaudeCodeAgentWatcher {
    fn scan(&mut self, ctx: &mut dyn WatcherContext, now_ms: i64) {
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
            let Some(session) = ctx.resolve_session(&agent.cwd) else {
                continue;
            };

            self.enrich_from_journal(&agent.session_id, &agent.cwd, now_ms);
            let state = self.sessions.get_mut(&agent.session_id).unwrap();
            state.session = Some(session);
            state.cli_name = agent.name.clone();

            let status = match agent.agent_status() {
                Some(AgentStatus::Idle) | None => refine_idle(state.journal_status),
                Some(other) => refine_busy(
                    other,
                    state.journal_status,
                    now_ms.saturating_sub(state.journal_updated_at),
                ),
            };

            // Gate: a status change, or a details change caught by signature.
            let status_changed = state.emitted_status != Some(status);
            let sig = format!(
                "{}|{:?}|{:?}|{:?}|{:?}",
                state.subagent_sig,
                state.loop_state.as_ref().map(|l| l.next_wake_at),
                state.usage.as_ref().map(|u| (u.context_used, u.cache_expires_at)),
                state.thread_name,
                // Outlives the usage summary it came from, so a newly-learned
                // model has to open the gate on its own.
                (&state.model, state.context_max),
            );
            let details_changed = state.last_emit_sig.as_deref() != Some(sig.as_str());

            if status_changed || details_changed {
                state.emitted_status = Some(status);
                state.last_emit_sig = Some(sig);
                let state = state.clone();
                Self::emit(ctx, &state, status, &agent.session_id, now_ms);
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
            if state.session.is_none() || state.emitted_status.is_none() {
                // Never resolved/emitted — nothing on the board to finalize.
                continue;
            }
            let status = exit_status(state.journal_status);
            Self::emit(ctx, &state, status, &session_id, now_ms);
        }
    }
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
    }

    impl WatcherContext for Ctx {
        fn resolve_session(&self, project_dir: &str) -> Option<String> {
            self.by_dir.iter().find(|(d, _)| d == project_dir).map(|(_, s)| s.clone())
        }
        fn emit(&mut self, event: AgentEvent) {
            self.events.push(event);
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
        let dir = projects.join(cwd.replace('/', "-"));
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

    /// The needs-you flicker at its source: each content block is its own
    /// entry, so a working agent leaves text-only entries every few seconds.
    /// Reading those as a finished turn flashed "⚑ Needs you" and a
    /// notification, then took them away on the next tool call.
    #[test]
    fn mid_turn_narration_is_not_a_finished_turn() {
        let narration: TranscriptEntry = serde_json::from_str(NARRATION_LINE).unwrap();
        assert_eq!(determine_status(&narration), Some(AgentStatus::Busy));

        let ended: TranscriptEntry = serde_json::from_str(END_TURN_LINE).unwrap();
        assert_eq!(determine_status(&ended), Some(AgentStatus::Complete));

        // Older transcripts and partial re-logs keep the original reading
        // rather than silently dropping a real turn end.
        let bare: TranscriptEntry = serde_json::from_str(DONE_LINE).unwrap();
        assert_eq!(determine_status(&bare), Some(AgentStatus::Complete));
    }

    /// End-to-end: a narration entry mid-tool-run must not change status.
    /// Before the `stop_reason` check this flipped `busy` → `complete`, and
    /// every flip is one visible flash of the banner.
    #[test]
    fn a_narration_entry_does_not_flip_a_working_agent_to_complete() {
        let mut f = fixture();
        write_journal(&f.projects, "/home/u/proj", "sid-n", &[USER_LINE, RUNNING_LINE]);
        *f.agents.lock().unwrap() = vec![CliAgent {
            // Falls through to `refine_idle`, trusting the journal outright.
            status: None,
            ..cli_agent(100, "/home/u/proj", "sid-n", "busy")
        }];
        let mut ctx = Ctx::new();
        ctx.by_dir.push(("/home/u/proj".into(), "proj".into()));

        f.watcher.scan(&mut ctx, 1_000);
        let before = ctx.events.len();

        write_journal(
            &f.projects,
            "/home/u/proj",
            "sid-n",
            &[USER_LINE, RUNNING_LINE, NARRATION_LINE],
        );
        f.watcher.scan(&mut ctx, 2_000);
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
        f.watcher.scan(&mut ctx, 3_000);
        assert_eq!(ctx.events.last().unwrap().status, AgentStatus::Complete);
    }

    #[test]
    fn busy_agent_emits_running_with_journal_enrichment() {
        let mut f = fixture();
        write_journal(&f.projects, "/home/u/proj", "sid-1", &[USER_LINE, RUNNING_LINE]);
        *f.agents.lock().unwrap() = vec![cli_agent(100, "/home/u/proj", "sid-1", "busy")];
        let mut ctx = Ctx::new();
        ctx.by_dir.push(("/home/u/proj".into(), "proj".into()));

        f.watcher.scan(&mut ctx, 1_000);
        assert_eq!(ctx.events.len(), 1);
        let ev = &ctx.events[0];
        assert_eq!(ev.session, "proj");
        assert_eq!(ev.status, AgentStatus::Busy);
        assert_eq!(ev.thread_id.as_deref(), Some("sid-1"));
        // Journal first prompt beats the CLI slug.
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
        f.watcher.scan(&mut ctx, 1_000);
        let window = ctx.events.last().unwrap().details.as_ref().unwrap().context_max.unwrap();

        // Then the journal is replaced: remembered identity is all that's left.
        write_journal(
            &f.projects,
            "/home/u/proj",
            "sid-s",
            &[USER_LINE, RUNNING_LINE, SYNTHETIC_LINE],
        );
        f.watcher.scan(&mut ctx, 2_000);
        write_journal(&f.projects, "/home/u/proj", "sid-s", &[USER_LINE]);
        f.watcher.scan(&mut ctx, 3_000);

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
        f.watcher.scan(&mut ctx, 1_000);

        // Shorter file with a different head → the rotation reset path.
        write_journal(&f.projects, "/home/u/proj", "sid-r", &[USER_LINE]);
        f.watcher.scan(&mut ctx, 2_000);

        let d = ctx.events.last().unwrap().details.as_ref().unwrap();
        assert_eq!(d.model.as_deref(), Some("claude-sonnet-5"));
        // The counters are position-dependent, so they *should* be gone.
        assert_eq!(d.context_used, None);
    }

    #[test]
    fn enrich_from_transcript_reads_name_and_status() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("s.jsonl");

        // First user message → thread name; last assistant-complete → Complete.
        let mut text = [USER_LINE, DONE_LINE].join("\n");
        text.push('\n');
        std::fs::write(&path, &text).unwrap();
        let (name, status) = enrich_from_transcript(&path);
        assert_eq!(name.as_deref(), Some("fix the flaky test"));
        assert_eq!(status, AgentStatus::Complete);

        // Mid tool-run → Busy (task name still resolves from the head).
        let mut running = [USER_LINE, RUNNING_LINE].join("\n");
        running.push('\n');
        std::fs::write(&path, &running).unwrap();
        let (name2, status2) = enrich_from_transcript(&path);
        assert_eq!(name2.as_deref(), Some("fix the flaky test"));
        assert_eq!(status2, AgentStatus::Busy);

        // Missing file → no name, Idle fallback (never panics).
        let (n3, s3) = enrich_from_transcript(&tmp.path().join("missing.jsonl"));
        assert_eq!(n3, None);
        assert_eq!(s3, AgentStatus::Idle);
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

        f.watcher.scan(&mut ctx, 1_000);
        let by_thread: std::collections::HashMap<&str, AgentStatus> =
            ctx.events.iter().map(|e| (e.thread_id.as_deref().unwrap(), e.status)).collect();
        assert_eq!(by_thread["sid-done"], AgentStatus::Complete);
        assert_eq!(by_thread["sid-mid"], AgentStatus::Idle);
        assert_eq!(by_thread["sid-perm"], AgentStatus::Waiting);
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
        f.watcher.scan(&mut ctx, 1_000);
        assert_eq!(ctx.events.last().unwrap().status, AgentStatus::Busy);

        // Nothing new in the journal plus a CLI still insisting past the
        // window means stuck bookkeeping, not a working agent.
        f.watcher.scan(&mut ctx, 1_000 + STALE_BUSY_JOURNAL_MS + 1);
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

        f.watcher.scan(&mut ctx, 1_000);
        f.watcher.scan(&mut ctx, 1_000 + STALE_BUSY_JOURNAL_MS * 10);
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

        watcher.scan(&mut ctx, 1_000);

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

        f.watcher.scan(&mut ctx, 1_000);
        f.watcher.scan(&mut ctx, 3_000);
        assert_eq!(ctx.events.len(), 1, "steady state must not re-emit");

        // Usage growth without a status change re-emits.
        let more = r#"{"timestamp":"2026-07-03T10:00:20.000Z","message":{"role":"assistant","model":"claude-sonnet-5","content":[{"type":"tool_use","name":"Read"}],"usage":{"input_tokens":900,"output_tokens":50}}}"#;
        let mut text = std::fs::read_to_string(&path).unwrap();
        text.push_str(more);
        text.push('\n');
        std::fs::write(&path, text).unwrap();

        f.watcher.scan(&mut ctx, 5_000);
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
        f.watcher.scan(&mut ctx, 1_000);
        ctx.events.clear();

        // sid-done's journal completes before it exits; sid-mid dies mid-run.
        let mut text = std::fs::read_to_string(&done_path).unwrap();
        text.push_str(DONE_LINE);
        text.push('\n');
        std::fs::write(&done_path, text).unwrap();
        f.agents.lock().unwrap().clear();

        f.watcher.scan(&mut ctx, 5_000);
        let by_thread: std::collections::HashMap<&str, AgentStatus> =
            ctx.events.iter().map(|e| (e.thread_id.as_deref().unwrap(), e.status)).collect();
        assert_eq!(by_thread["sid-done"], AgentStatus::Complete);
        assert_eq!(by_thread["sid-mid"], AgentStatus::Interrupted);
        // Gone for good: nothing further on later scans.
        ctx.events.clear();
        f.watcher.scan(&mut ctx, 7_000);
        assert!(ctx.events.is_empty());
    }

    #[test]
    fn unresolved_agents_never_emit_even_on_exit() {
        let mut f = fixture();
        write_journal(&f.projects, "/home/u/x", "sid-x", &[USER_LINE, RUNNING_LINE]);
        *f.agents.lock().unwrap() = vec![cli_agent(1, "/home/u/x", "sid-x", "busy")];
        let mut ctx = Ctx::new(); // resolves nothing
        f.watcher.scan(&mut ctx, 1_000);
        f.agents.lock().unwrap().clear();
        f.watcher.scan(&mut ctx, 3_000);
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
        f.watcher.scan(&mut ctx, 1_000);
        assert_eq!(ctx.events[0].thread_name.as_deref(), Some("slug-7"));
    }

    #[test]
    fn shrunk_journal_resets_and_rederives() {
        let mut f = fixture();
        let path = write_journal(&f.projects, "/home/u/p", "sid-1", &[USER_LINE, RUNNING_LINE]);
        *f.agents.lock().unwrap() = vec![cli_agent(7, "/home/u/p", "sid-1", "busy")];
        let mut ctx = Ctx::new();
        ctx.by_dir.push(("/home/u/p".into(), "p".into()));
        f.watcher.scan(&mut ctx, 1_000);

        // Truncate + rewrite with a different prompt: state re-derives.
        let replacement = r#"{"message":{"role":"user","content":"a brand new thread"}}"#;
        std::fs::write(&path, format!("{replacement}\n")).unwrap();
        f.watcher.scan(&mut ctx, 3_000);
        let last = ctx.events.last().unwrap();
        assert_eq!(last.thread_name.as_deref(), Some("a brand new thread"));
    }

    #[test]
    fn encode_project_dir_name_collapses_slash_dot_and_underscore() {
        // Verified against real `~/.claude/projects` entries, not assumed —
        // see the doc comment on `encode_project_dir_name`.
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
        // A checkout that moved after the session started (or any other way
        // the encoded guess and the actual directory diverge): the probe
        // fallback is what still finds it, not the guess.
        let dir = f.projects.join("-home-u-renamed-proj");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("sid-1.jsonl"), format!("{USER_LINE}\n")).unwrap();
        *f.agents.lock().unwrap() = vec![cli_agent(7, "/home/u/my-app", "sid-1", "busy")];
        let mut ctx = Ctx::new();
        ctx.by_dir.push(("/home/u/my-app".into(), "p".into()));
        f.watcher.scan(&mut ctx, 1_000);
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
        f.watcher.scan(&mut ctx, 1_000);
        assert_eq!(ctx.events.last().unwrap().status, AgentStatus::Busy);

        // Append (same file, same inode): the next scan must parse only the new
        // tail and still see the completion.
        {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
            writeln!(file, "{DONE_LINE}").unwrap();
        }
        *f.agents.lock().unwrap() = vec![cli_agent(100, "/home/u/proj", "sid-inc", "idle")];
        f.watcher.scan(&mut ctx, 2_000);
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
        f.watcher.scan(&mut ctx, 1_000);
        assert_eq!(ctx.events.last().unwrap().thread_name.as_deref(), Some("fix the flaky test"));

        // Replace the journal at the same path with a LARGER file (new inode):
        // without rotation detection the stored offset would land mid-file and
        // the new head (thread name) would never be seen.
        std::fs::remove_file(&path).unwrap();
        let new_user = r#"{"timestamp":"2026-07-03T11:00:00.000Z","message":{"role":"user","content":"a rewritten journal with a much longer opening prompt than before"}}"#;
        write_journal(&f.projects, "/home/u/proj", "sid-rot", &[new_user, RUNNING_LINE, DONE_LINE]);
        *f.agents.lock().unwrap() = vec![cli_agent(100, "/home/u/proj", "sid-rot", "idle")];
        f.watcher.scan(&mut ctx, 2_000);
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
        f.watcher.scan(&mut ctx, 1_000);
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
        f.watcher.scan(&mut ctx, 2_000);
        let ev = ctx.events.last().unwrap();
        assert_eq!(
            ev.thread_name.as_deref(),
            Some("a rewritten journal with a much longer opening prompt than before")
        );
        assert_eq!(ev.status, AgentStatus::Complete);
    }
}
