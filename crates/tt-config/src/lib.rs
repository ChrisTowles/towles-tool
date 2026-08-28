//! Configuration model for the towles-tool CLI, plus the resolver for every mutable
//! state path the CLI and app touch. It mirrors the zod settings schema used by the
//! TypeScript CLI and reads/writes the *same* file
//! (`~/.config/towles-tool/towles-tool.settings.json`), so the model tolerates
//! unknown fields and defaults missing ones — never `deny_unknown_fields`. Two
//! test-enforced invariants keep that file safe: every property name is `camelCase`,
//! and writes go through [`save_merge`] so TS-owned keys survive.
//!
//! ## Task-scoped state
//!
//! Many worktree checkouts run concurrently, so this module derives a *scope* from
//! the running instance and, when scoped, nests all mutable state under
//! `…/towles-tool/tasks/<scope>/…` (see [`state_scope`]). Unscoped — the installed
//! daily driver — the paths are the historic defaults.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use thiserror::Error;

pub const TOOL_NAME: &str = "towles-tool";

/// **The** clock read for this workspace. Logic crates take injected `now_ms`
/// so they stay deterministic; this is the boundary reading the real clock.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Error)]
pub enum Error {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Could not determine home directory")]
    NoHomeDir,

    #[error("Could not determine data directory")]
    NoDataDir,
}

pub type Result<T> = std::result::Result<T, Error>;

/// Journal path templates (Luxon tokens, e.g. `{yyyy}`, `{MM}`) and base folders.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", default)]
pub struct JournalSettings {
    pub base_folder: String,

    pub daily_path_template: String,

    pub meeting_path_template: String,

    pub note_path_template: String,

    pub template_dir: String,
}

impl Default for JournalSettings {
    fn default() -> Self {
        Self {
            base_folder: home_dir_string(),
            daily_path_template:
                "journal/{monday:yyyy}/{monday:MM}/daily-notes/{monday:yyyy}-{monday:MM}-{monday:dd}-daily-notes.md"
                    .to_string(),
            meeting_path_template: "journal/{yyyy}/{MM}/meetings/{yyyy}-{MM}-{dd}-{title}.md"
                .to_string(),
            note_path_template: "journal/{yyyy}/{MM}/notes/{yyyy}-{MM}-{dd}-{title}.md".to_string(),
            template_dir: default_template_dir(),
        }
    }
}

/// AgentBoard preferences that reach this file. `None` until changed, so it
/// stays clean for the TS CLI. Not the whole `agentboard` block — but a key the
/// frontend owns still needs a field here, or [`save_merge`] drops its write.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", default)]
pub struct AgentboardSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compact_recommend_percent: Option<u8>,

    /// Master switch — off silences every [`NotifyKind`]. `None` = on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notify: Option<bool>,

    /// A kind notifies when its own level is at or above this. An unrecognized
    /// value reads as `None` rather than failing the whole file.
    #[serde(
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient",
        default
    )]
    pub notify_threshold: Option<NotifyLevel>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub copy_on_select: Option<bool>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_font_size: Option<u8>,

    /// Board shortcuts fire in a focused terminal, not swallowed as input.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shortcuts_work_in_terminal: Option<bool>,

    /// Gates the *reminder* only; the tracking is event log, with no switch.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shortcut_coach: Option<bool>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub board_group_by_repo: Option<bool>,

    /// Opaque: Rust never interprets it, and an unknown value reads as `None`.
    #[serde(
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient",
        default
    )]
    pub rail_filter: Option<RailFilter>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub rail_recent_hours: Option<u32>,

    /// Whether hand-marked quiet checkouts are on the rail. Opaque, like
    /// [`rail_filter`](Self::rail_filter).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub show_quiet: Option<bool>,

    /// Unlike [`rail_filter`](Self::rail_filter), this one *is* read in Rust.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub show_unmanaged_worktrees: Option<bool>,

    /// The native Bevy surface (`tt-jarvis`). Off by default — it holds a
    /// Wayland subsurface and a vsync-paced render thread, and the renderer is
    /// only in the binary at all when built with `tt-app`'s `bevy` feature.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jarvis_pane: Option<bool>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_pane: Option<bool>,
}

pub const DEFAULT_COMPACT_RECOMMEND_PERCENT: u8 = 30;

pub const DEFAULT_SHOW_UNMANAGED_WORKTREES: bool = false;

/// Not a scale: [`Active`](Self::Active) asks about *now* (running, dirty,
/// unpushed), [`Recent`](Self::Recent) about the last N hours.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum RailFilter {
    All,
    Active,
    Recent,
}

pub const DEFAULT_NOTIFY: bool = true;

pub const DEFAULT_NOTIFY_THRESHOLD: NotifyLevel = NotifyLevel::Routine;

/// Ordered `Routine < Important < Urgent`, which is the whole point —
/// [`AgentboardSettings::notify_threshold`] compares against it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum NotifyLevel {
    Routine,
    Important,
    Urgent,
}

impl NotifyLevel {
    pub const ALL: [NotifyLevel; 3] = [
        NotifyLevel::Routine,
        NotifyLevel::Important,
        NotifyLevel::Urgent,
    ];
}

/// Each carries a fixed [`NotifyLevel`]; the user picks a threshold, not a
/// per-kind switch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotifyKind {
    NeedsYou,
    MeetingStart,
    ChecksFailed,
    ReviewRequested,
    StaleCollector,
}

impl NotifyKind {
    /// Urgent where acting late is worthless; broken CI is important.
    pub fn level(self) -> NotifyLevel {
        match self {
            NotifyKind::NeedsYou | NotifyKind::MeetingStart => NotifyLevel::Urgent,
            NotifyKind::ChecksFailed => NotifyLevel::Important,
            NotifyKind::ReviewRequested | NotifyKind::StaleCollector => NotifyLevel::Routine,
        }
    }
}

impl AgentboardSettings {
    /// The one place the decision is made — callers gate on this, never the raw fields.
    pub fn notifies(&self, kind: NotifyKind) -> bool {
        self.notify.unwrap_or(DEFAULT_NOTIFY)
            && kind.level() >= self.notify_threshold.unwrap_or(DEFAULT_NOTIFY_THRESHOLD)
    }
}

/// Unrecognized reads as `None` rather than failing the whole shared file.
fn lenient<'de, D, T>(de: D) -> std::result::Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    Ok(Option::<serde_json::Value>::deserialize(de)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v).ok()))
}

/// One button in the new-task form that rewrites the goal you typed. Runs
/// `claude -p` with this improver's [`prompt`](Self::prompt) as the
/// *instruction*, the task text passed separately — never a template.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", default)]
pub struct PromptImprover {
    pub id: String,
    pub label: String,
    pub enabled: bool,
    /// Its own button; the rest stay under "More".
    pub preferred: bool,
    pub prompt: String,
}

impl PromptImprover {
    /// The built-ins run along one axis — how sure you are of the task — from
    /// Direct to Interview. Only Direct is preferred.
    pub fn defaults() -> Vec<Self> {
        vec![
            Self {
                id: "direct".to_string(),
                label: "Direct".to_string(),
                enabled: true,
                preferred: true,
                prompt: DEFAULT_IMPROVER_DIRECT.to_string(),
            },
            Self {
                id: "clarify".to_string(),
                label: "Clarify".to_string(),
                enabled: true,
                preferred: false,
                prompt: DEFAULT_IMPROVER_CLARIFY.to_string(),
            },
            Self {
                id: "brainstorm".to_string(),
                label: "Brainstorm".to_string(),
                enabled: true,
                preferred: false,
                prompt: DEFAULT_IMPROVER_BRAINSTORM.to_string(),
            },
            Self {
                id: "interview".to_string(),
                label: "Interview".to_string(),
                enabled: true,
                preferred: false,
                prompt: DEFAULT_IMPROVER_INTERVIEW.to_string(),
            },
        ]
    }
}

pub const DEFAULT_IMPROVER_DIRECT: &str = "Restate the task clearly and concisely in one sentence.";

pub const DEFAULT_IMPROVER_CLARIFY: &str = "Restate the task in 2 to 3 sentences, making \
explicit what a one-line version leaves implied.";

pub const DEFAULT_IMPROVER_BRAINSTORM: &str = "Rewrite the task as a request for an \
implementation plan in HTML that leads with the decisions I'm most likely to tweak — data model, \
type interfaces, anything user-facing — and buries the mechanical work at the bottom.";

pub const DEFAULT_IMPROVER_INTERVIEW: &str = "Rewrite the task as a request to research the \
codebase first and then interview me one question at a time about what is still ambiguous, \
prioritizing questions where my answer would change the architecture.";

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", default)]
pub struct CollectorsSettings {
    pub calendar: CalendarCollector,
    pub prs: PrCollector,
    pub issues: IssueCollector,
    pub slack: SlackDmCollector,
}

/// Shells out to `claude -p` per source, so it costs tokens — off by default.
/// Its only purpose is **focus protection**, not calendar management.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", default)]
pub struct CalendarCollector {
    pub enabled: bool,
    pub refresh_minutes: u64,
    pub quiet_hours: CalendarQuietHours,
    /// Each enabled source is run separately and written under its own `id`,
    /// so a second calendar never displaces the first.
    pub sources: Vec<CalendarSource>,
}

impl Default for CalendarCollector {
    fn default() -> Self {
        Self {
            enabled: false,
            refresh_minutes: 15,
            quiet_hours: CalendarQuietHours::default(),
            sources: CalendarSource::defaults(),
        }
    }
}

/// User-editable because the built-in defaults need a Google/Outlook MCP that
/// may not be configured. Shape is not its job.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", default)]
pub struct CalendarSource {
    /// Also the store's `events.source` column; changing it orphans this calendar's rows.
    pub id: String,
    pub label: String,
    pub enabled: bool,
    pub prompt: String,
}

impl CalendarSource {
    /// Personal Google (on) and work Outlook (off). **Defaults, not a
    /// migration**: a file carrying the retired `"provider": "outlook"` and no
    /// `sources` gets this list and starts pulling the *other* calendar.
    pub fn defaults() -> Vec<Self> {
        vec![
            Self {
                id: "google".to_string(),
                label: "Google (personal)".to_string(),
                enabled: true,
                prompt: DEFAULT_CALENDAR_PROMPT_GOOGLE.to_string(),
            },
            Self {
                id: "outlook".to_string(),
                label: "Outlook (work)".to_string(),
                enabled: false,
                prompt: DEFAULT_CALENDAR_PROMPT_OUTLOOK.to_string(),
            },
        ]
    }
}

/// Asks *which events*, never about JSON — the schema is the shape contract.
/// **Times stay as reported**: a 13-digit epoch is arithmetic a model cannot
/// check, and a wrong one reads like a right one.
pub const DEFAULT_CALENDAR_PROMPT_GOOGLE: &str = "\
Using the Google Calendar MCP, list the events on my primary calendar for today \
only, in my local timezone. Report each time exactly as the calendar gives it, \
keeping its UTC offset — do not convert to UTC and do not compute epoch \
numbers. Skip all-day events and events I have declined. Omit any field whose \
value is null or unknown.";

pub const DEFAULT_CALENDAR_PROMPT_OUTLOOK: &str = "\
Using the Outlook (Microsoft 365) MCP, list the events on my default calendar \
for today only, in my local timezone. Report each time exactly as the calendar \
gives it, keeping its UTC offset — do not convert to UTC and do not compute \
epoch numbers. Skip all-day events and events I have declined. Omit any field \
whose value is null or unknown.";

/// Local-time window `[startHour:00, endHour:00)` outside which the
/// token-costing run is skipped. `weekdays` are **0 = Monday … 6 = Sunday**.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", default)]
pub struct CalendarQuietHours {
    pub enabled: bool,
    pub start_hour: u8,
    /// Exclusive: with the default `18`, the last runnable minute is `17:59`.
    pub end_hour: u8,
    pub weekdays: Vec<u8>,
}

impl Default for CalendarQuietHours {
    fn default() -> Self {
        Self { enabled: true, start_hour: 8, end_hour: 18, weekdays: vec![0, 1, 2, 3, 4] }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", default)]
pub struct PrCollector {
    pub enabled: bool,
    /// The authored + review-requested sweep Board/Cockpit render — the fast cadence.
    pub refresh_seconds: u64,
    /// Looser on purpose: it only catches a just-merged branch before its
    /// worktree is removed. The `gh` plugin hook nudges this sweep the moment a
    /// merge happens, so the cadence is a backstop, not the mechanism.
    pub merged_refresh_minutes: u64,
}

impl Default for PrCollector {
    fn default() -> Self {
        Self { enabled: true, refresh_seconds: 1200, merged_refresh_minutes: 60 }
    }
}

/// Polls one DM conversation and surfaces unanswered messages in the attention
/// banner. Needs a user OAuth token with `im:history` — off until one is set.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", default)]
pub struct SlackDmCollector {
    pub enabled: bool,
    pub token: String,
    /// App-level token (`xapp-…`) for Socket Mode; empty = poll-only.
    #[serde(default)]
    pub app_token: String,
    pub watch_user_id: String,
    pub watch_name: String,
    pub refresh_seconds: u64,
}

impl Default for SlackDmCollector {
    fn default() -> Self {
        Self {
            enabled: false,
            token: String::new(),
            app_token: String::new(),
            watch_user_id: String::new(),
            watch_name: String::new(),
            refresh_seconds: 60,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", default)]
pub struct IssueCollector {
    pub enabled: bool,
    pub refresh_minutes: u64,
}

impl Default for IssueCollector {
    fn default() -> Self {
        Self { enabled: true, refresh_minutes: 15 }
    }
}

/// `tt-mcp`'s HTTP transport — Rust-only, and the legacy TS CLI reverts it on
/// any run. **No bearer token**: refusing any `Origin` plus requiring
/// `Content-Type: application/json` defends the same thing.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", default)]
pub struct McpSettings {
    /// Only the *fallback*, for an app outside any checkout: an instance in one
    /// serves its `.env`'s `${tt:port 8787-8986}` claim instead. The plugin's
    /// `.mcp.json` expands `${TT_MCP_PORT:-8787}`, hence this value.
    pub port: u16,
}

pub const DEFAULT_MCP_PORT: u16 = 8787;

impl Default for McpSettings {
    fn default() -> Self {
        Self { port: DEFAULT_MCP_PORT }
    }
}

/// Top-level user settings, mirroring `UserSettingsSchema` in the TS CLI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", default)]
pub struct UserSettings {
    pub preferred_editor: String,

    pub journal_settings: JournalSettings,

    pub agentboard: AgentboardSettings,

    pub prompt_improvers: Vec<PromptImprover>,

    pub collectors: CollectorsSettings,

    /// Lenient on purpose: the docs invite hand-editing, and a slip
    /// (`"mcp": null`) must not fail the whole file — every command loads it,
    /// so that would brick the app, journal and collect at once.
    #[serde(default, deserialize_with = "lenient_mcp")]
    pub mcp: McpSettings,
}

/// Non-objects are rejected before serde sees them: a struct deserializes from
/// a JSON *array* positionally, so `"mcp": [9999]` would otherwise set the port.
fn lenient_mcp<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<McpSettings, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    match value {
        serde_json::Value::Object(_) => Ok(serde_json::from_value(value).unwrap_or_default()),
        _ => Ok(McpSettings::default()),
    }
}

impl Default for UserSettings {
    fn default() -> Self {
        Self {
            preferred_editor: "code".to_string(),
            journal_settings: JournalSettings::default(),
            agentboard: AgentboardSettings::default(),
            prompt_improvers: PromptImprover::defaults(),
            collectors: CollectorsSettings::default(),
            mcp: McpSettings::default(),
        }
    }
}

fn home_dir() -> Result<PathBuf> {
    dirs::home_dir().ok_or(Error::NoHomeDir)
}

fn home_dir_string() -> String {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).to_string_lossy().to_string()
}

fn default_template_dir() -> String {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".config")
        .join(TOOL_NAME)
        .join("templates")
        .to_string_lossy()
        .to_string()
}

/// Non-empty forces that scope name, empty forces *unscoped*, unset detects.
pub const STATE_SCOPE_ENV: &str = "TT_STATE_SCOPE";

/// Shared stores ignore an *auto-detected* scope — they describe the machine,
/// not one checkout — but a *forced* scope isolates everything.
enum Scope {
    None,
    Auto(String),
    Forced(String),
}

const SCOPE_DIR: &str = "tasks";

/// What [`SCOPE_DIR`] was called before the worktree-"slot"→"task" rename.
const LEGACY_SCOPE_DIR: &str = "slots";

/// The single place either unscoped base is derived, so the migration and
/// [`instance_state_bases`] can't disagree. Deliberately does *not* call
/// [`detect_scope`]: the migration runs inside it.
fn state_base_dirs() -> (Result<PathBuf>, Result<PathBuf>) {
    (
        dirs::data_dir().ok_or(Error::NoDataDir).map(|d| d.join(TOOL_NAME)),
        home_dir().map(|h| h.join(".config").join(TOOL_NAME)),
    )
}

/// One-time `slots/`→`tasks/` rename, only when the old dir exists and the new
/// does not. A failure just means `tasks/` is created fresh, losing one
/// checkout's ephemeral data — never the shared settings, un-nested at the base.
fn ensure_state_layout_migrated() {
    static MIGRATED: std::sync::Once = std::sync::Once::new();
    MIGRATED.call_once(|| {
        let (data, config) = state_base_dirs();
        for base in [data, config].into_iter().flatten() {
            let old = base.join(LEGACY_SCOPE_DIR);
            let new = base.join(SCOPE_DIR);
            if old.is_dir() && !new.exists() {
                let _ = std::fs::rename(&old, &new);
            }
        }
    });
}

fn detect_scope() -> Scope {
    ensure_state_layout_migrated();
    match std::env::var(STATE_SCOPE_ENV) {
        Ok(v) if !v.trim().is_empty() => Scope::Forced(sanitize_scope(&v)),
        Ok(_) => Scope::None,
        Err(_) => match std::env::current_dir().ok().as_deref().and_then(task_scope_from_dir) {
            Some(s) => Scope::Auto(s),
            None => Scope::None,
        },
    }
}

/// [`STATE_SCOPE_ENV`] wins; otherwise walk up to a checkout of *this* repo.
/// An installed `tt` elsewhere stays unscoped, sharing the daily-driver config.
pub fn state_scope() -> Option<String> {
    match detect_scope() {
        Scope::None => None,
        Scope::Auto(s) | Scope::Forced(s) => Some(s),
    }
}

/// **The one definition of "a checkout of this repo"**: nearest ancestor with a
/// `crates/tt-config` dir. A packaged app gets `None` and falls back to settings.
pub fn checkout_root_from_dir(dir: &Path) -> Option<PathBuf> {
    dir.ancestors().find(|a| a.join("crates").join("tt-config").is_dir()).map(Path::to_path_buf)
}

/// The main checkout owning a `<repo>/.claude/worktrees/<name>` task.
fn main_checkout_of(root: &Path) -> Option<&Path> {
    root.parent()
        .filter(|p| p.file_name().is_some_and(|n| n == "worktrees"))
        .and_then(Path::parent)
        .filter(|p| p.file_name().is_some_and(|n| n == ".claude"))
        .and_then(Path::parent)
}

/// Split from [`state_scope`] to be testable against temp dirs. A task's bare
/// dir name isn't unique across repos, so scopes qualify as `<repo>-<name>`.
pub fn task_scope_from_dir(dir: &Path) -> Option<String> {
    let root = checkout_root_from_dir(dir)?;
    let name = root.file_name().and_then(|n| n.to_str())?;
    // `<repo>/.claude/worktrees/<name>` → qualify with the repo dir name.
    let main = main_checkout_of(&root).and_then(Path::file_name).and_then(|n| n.to_str());
    Some(sanitize_scope(&match main {
        Some(repo) => format!("{repo}-{name}"),
        None => name.to_string(),
    }))
}

/// Like [`detect_scope`], but the ambient cwd never scopes: the nudge writer
/// runs wherever `gh` did, so cwd nesting would split it from its watchers.
fn detect_forced_scope() -> Scope {
    ensure_state_layout_migrated();
    match std::env::var(STATE_SCOPE_ENV) {
        Ok(v) if !v.trim().is_empty() => Scope::Forced(sanitize_scope(&v)),
        _ => Scope::None,
    }
}

/// One safe path segment. Only guards a hand-set `TT_STATE_SCOPE`.
fn sanitize_scope(raw: &str) -> String {
    raw.trim()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '-' })
        .collect()
}

/// The one nesting rule, pure for tests: instance state nests under any
/// scope; shared stores nest only under a forced scope.
fn nest(base: PathBuf, scope: &Scope, instance: bool) -> PathBuf {
    match scope {
        Scope::None => base,
        Scope::Auto(s) if instance => base.join(SCOPE_DIR).join(s),
        Scope::Auto(_) => base,
        Scope::Forced(s) => base.join(SCOPE_DIR).join(s),
    }
}

/// *Instance* state (sessions, windows, tt.db): any scope applies.
fn instance_under(base: PathBuf) -> PathBuf {
    nest(base, &detect_scope(), true)
}

/// *Shared* stores (settings, tracked repos — one copy per machine): only a
/// forced [`STATE_SCOPE_ENV`] scopes them.
fn shared_under(base: PathBuf) -> PathBuf {
    nest(base, &detect_scope(), false)
}

fn config_dir() -> Result<PathBuf> {
    Ok(shared_under(home_dir()?.join(".config").join(TOOL_NAME)))
}

pub fn config_path() -> Result<PathBuf> {
    Ok(config_dir()?.join(format!("{TOOL_NAME}.settings.json")))
}

/// Instance-scoped: a branch's schema experiments must not touch the daily
/// driver's tt.db.
fn data_dir() -> Result<PathBuf> {
    Ok(instance_under(dirs::data_dir().ok_or(Error::NoDataDir)?.join(TOOL_NAME)))
}

pub fn store_db_path() -> Result<PathBuf> {
    Ok(data_dir()?.join("tt.db"))
}

/// The tt.db owned by a *named* scope. Removal needs "whose database holds the
/// row for the checkout I deleted?" — `tt task rm` inside a worktree would
/// otherwise open that worktree's empty tt.db and orphan the real row.
pub fn store_db_path_for_scope(scope: Option<&str>) -> Result<PathBuf> {
    let base = dirs::data_dir().ok_or(Error::NoDataDir)?.join(TOOL_NAME);
    let base = match detect_scope() {
        Scope::Forced(forced) => base.join(SCOPE_DIR).join(forced),
        _ => match scope {
            Some(scope) => base.join(SCOPE_DIR).join(scope),
            None => base,
        },
    };
    Ok(base.join("tt.db"))
}

/// Machine-global: a note only lands if writer and every watcher resolve one
/// dir, and addressing is the note's own `TT_SESSION_ID` line. Outside
/// `data_dir()` to dodge tt.db's WAL churn.
pub fn nudge_dir_path() -> Result<PathBuf> {
    let base = dirs::data_dir().ok_or(Error::NoDataDir)?.join(TOOL_NAME);
    Ok(nest(base, &detect_forced_scope(), true).join("nudge"))
}

/// Instance-scoped, so "which task spawned these commands?" is answerable from
/// the path alone. Its own subdirectory so rotation never walks tt.db.
pub fn telemetry_dir() -> Result<PathBuf> {
    Ok(data_dir()?.join("telemetry"))
}

/// Pasted images must become a file before a path can go into a prompt, and
/// deliberately not one in the repo. Temp: a screenshot isn't state.
pub fn pasted_images_dir() -> PathBuf {
    std::env::temp_dir().join(TOOL_NAME).join("pasted-images")
}

/// PID locks. Temp, not `config_dir()`: a lock means nothing once its creator
/// exits. Unscoped — per-checkout holders vary the lock *name* instead.
pub fn locks_dir() -> PathBuf {
    std::env::temp_dir().join(TOOL_NAME).join("locks")
}

pub fn agentboard_dir() -> Result<PathBuf> {
    Ok(instance_under(home_dir()?.join(".config").join(TOOL_NAME)).join("agentboard"))
}

/// repos.json — which repos exist is the same fact from every checkout.
pub fn agentboard_shared_dir() -> Result<PathBuf> {
    Ok(config_dir()?.join("agentboard"))
}

/// Collector results, shared like `repos.json`: what GitHub says about a PR depends
/// on the machine's token, not which folder asked. One file per collector per repo.
pub fn gh_cache_dir() -> Result<PathBuf> {
    Ok(config_dir()?.join("gh-cache"))
}

/// The browser pane's Chrome profile. *Shared* — a sign-in is a machine fact —
/// and starts empty: login persistence, never an import of the personal
/// profile. Chrome allows one process per profile dir, so tt-app serializes
/// access with an `InstanceLock`.
pub fn browser_profile_dir() -> Result<PathBuf> {
    Ok(shared_under(dirs::data_dir().ok_or(Error::NoDataDir)?.join(TOOL_NAME))
        .join("chrome-profile"))
}

/// Watched-DM handled ledger. *Shared*: kept in per-instance tt.db, a dismissal
/// evaporated whenever the next launch resolved a different scope.
pub fn dm_dismissals_path() -> Result<PathBuf> {
    Ok(shared_under(dirs::data_dir().ok_or(Error::NoDataDir)?.join(TOOL_NAME))
        .join("dm-dismissals.json"))
}

/// *Instance-scoped*, like the rest of a checkout's state.
pub fn code_server_user_data_dir() -> Result<PathBuf> {
    Ok(data_dir()?.join("code-server"))
}

/// code-server's window-registry socket: temp like [`locks_dir`], pid-named — the
/// instance dir overflows `sun_path`, and the registry dies with its server.
pub fn code_server_session_socket() -> PathBuf {
    std::env::temp_dir().join(TOOL_NAME).join(format!("code-server-{}.sock", std::process::id()))
}

/// Where each workbench's bridge extension listens, one socket per window.
/// Temp and pid-named for the same reasons as [`code_server_session_socket`].
pub fn code_server_bridge_dir() -> PathBuf {
    std::env::temp_dir().join(TOOL_NAME).join(format!("bridge-{}", std::process::id()))
}

/// Where the app unpacks the code-server it provisions for itself. *Shared*:
/// 740 MB is not a per-checkout cost. Version-scoped inside, by the installer.
pub fn code_server_install_dir() -> Result<PathBuf> {
    Ok(shared_under(dirs::data_dir().ok_or(Error::NoDataDir)?.join(TOOL_NAME))
        .join("code-server-dist"))
}

/// *Shared*, like the Chrome profile: an installed extension is a machine fact.
pub fn code_server_extensions_dir() -> Result<PathBuf> {
    Ok(shared_under(dirs::data_dir().ok_or(Error::NoDataDir)?.join(TOOL_NAME))
        .join("code-server-extensions"))
}

/// The hand-edited half of VS Code's `User/`. *Shared*; the state DB beside it
/// is not, since two running apps would write it at once.
pub fn code_server_shared_user_dir() -> Result<PathBuf> {
    Ok(shared_under(dirs::data_dir().ok_or(Error::NoDataDir)?.join(TOOL_NAME))
        .join("code-server-user"))
}

/// Claimed-port ledgers. *Shared*: every worktree reads the same one, and it
/// must survive reboots (so not [`locks_dir`]) and stay out of a clone.
pub fn task_ports_dir() -> Result<PathBuf> {
    Ok(config_dir()?.join("task-ports"))
}

/// Reaches scopes *other than* the running process's, which
/// [`data_dir`]/[`agentboard_dir`] can't. Ignores an auto-detected scope; a
/// *forced* [`STATE_SCOPE_ENV`] still nests both so tests stay off the real tree.
pub struct InstanceStateBases {
    pub data: PathBuf,
    pub config: PathBuf,
}

impl InstanceStateBases {
    pub fn scope_parents(&self) -> [PathBuf; 2] {
        [self.data.join(SCOPE_DIR), self.config.join(SCOPE_DIR)]
    }

    pub fn agentboard_dir(&self, scope: Option<&str>) -> PathBuf {
        match scope {
            None => self.config.join("agentboard"),
            Some(s) => self.config.join(SCOPE_DIR).join(s).join("agentboard"),
        }
    }
}

pub fn instance_state_bases() -> Result<InstanceStateBases> {
    let (data, config) = state_base_dirs();
    let (data, config) = (data?, config?);
    match detect_scope() {
        Scope::Forced(s) => Ok(InstanceStateBases {
            data: data.join(SCOPE_DIR).join(&s),
            config: config.join(SCOPE_DIR).join(&s),
        }),
        Scope::None | Scope::Auto(_) => Ok(InstanceStateBases { data, config }),
    }
}

pub fn agentboard_dir_lossy() -> PathBuf {
    agentboard_dir().unwrap_or_else(|_| PathBuf::from(".").join("agentboard"))
}

pub fn agentboard_shared_dir_lossy() -> PathBuf {
    agentboard_shared_dir().unwrap_or_else(|_| PathBuf::from(".").join("agentboard"))
}

/// The dirs owned by `scope`, so `tt task rm` can delete a removed task's
/// state. Targets *another* checkout's scope, so the ambient one is ignored —
/// running inside a task must not nest the target under the runner's scope.
pub fn instance_state_dirs_for_scope(scope: &str) -> Vec<PathBuf> {
    let scope = sanitize_scope(scope);
    if scope.is_empty() {
        return Vec::new();
    }
    let (data, config) = state_base_dirs();
    [config, data]
        .into_iter()
        .flatten()
        .map(|base| shared_under(base).join(SCOPE_DIR).join(&scope))
        .collect()
}

pub fn load() -> Result<UserSettings> {
    load_from(&config_path()?)
}

pub fn load_from(path: &Path) -> Result<UserSettings> {
    if !path.exists() {
        let settings = UserSettings::default();
        save_to(path, &settings)?;
        return Ok(settings);
    }
    let raw = std::fs::read_to_string(path)?;
    let settings = serde_json::from_str(&raw)?;
    Ok(settings)
}

/// Drops unmodeled keys already on disk; the shared settings file uses [`save_merge_to`].
fn save_to(path: &Path, settings: &UserSettings) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(settings)?;
    write_private(path, &json)?;
    Ok(())
}

/// 0600: the settings file holds live credentials, so it must not inherit the
/// umask. Chmod after the write, not `OpenOptions::mode`, because this also
/// rewrites existing files, whose mode `open` wouldn't touch.
fn write_private(path: &Path, contents: &str) -> Result<()> {
    std::fs::write(path, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

pub fn save_merge(settings: &UserSettings) -> Result<()> {
    save_merge_to(&config_path()?, settings)
}

/// **Preserves keys this model doesn't capture** (the TS CLI's); known fields
/// win. Every write to the shared file — [`save_to`] would drop the other's.
fn save_merge_to(path: &Path, settings: &UserSettings) -> Result<()> {
    let mut base = if path.exists() {
        serde_json::from_str::<serde_json::Value>(&std::fs::read_to_string(path)?)
            .unwrap_or_else(|_| serde_json::Value::Object(serde_json::Map::new()))
    } else {
        serde_json::Value::Object(serde_json::Map::new())
    };
    merge_json(&mut base, &serde_json::to_value(settings)?);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    write_private(path, &serde_json::to_string_pretty(&base)?)?;
    Ok(())
}

fn merge_json(base: &mut serde_json::Value, incoming: &serde_json::Value) {
    match (base, incoming) {
        (serde_json::Value::Object(b), serde_json::Value::Object(i)) => {
            for (k, v) in i {
                merge_json(b.entry(k.clone()).or_insert(serde_json::Value::Null), v);
            }
        }
        (b, i) => *b = i.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// The drift guard for a struct whose field names leave `camelCase`.
    fn json_schema() -> serde_json::Value {
        let schema = schemars::schema_for!(UserSettings);
        serde_json::to_value(schema).expect("settings JSON schema should serialize")
    }

    #[test]
    fn defaults_match_ts_cli() {
        let settings = UserSettings::default();
        assert_eq!(settings.preferred_editor, "code");
        assert!(settings.journal_settings.daily_path_template.contains("daily-notes"));
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("towles-tool.settings.json");

        let settings = UserSettings { preferred_editor: "nvim".to_string(), ..Default::default() };
        save_to(&path, &settings).unwrap();

        let loaded = load_from(&path).unwrap();
        assert_eq!(loaded, settings);
    }

    /// The file holds Slack tokens; neither write path may widen it.
    #[cfg(unix)]
    #[test]
    fn saves_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new().unwrap();
        let settings = UserSettings::default();

        for path in [
            dir.path().join("fresh.json"),
            dir.path().join("merged.json"),
        ] {
            // Tightened on an existing file, not inherited at creation.
            std::fs::write(&path, "{}").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

            if path.ends_with("fresh.json") {
                save_to(&path, &settings).unwrap();
            } else {
                save_merge_to(&path, &settings).unwrap();
            }

            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "{} left at {mode:o}", path.display());
        }
    }

    #[test]
    fn load_from_missing_creates_defaults() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nested").join("towles-tool.settings.json");

        assert!(!path.exists());
        let loaded = load_from(&path).unwrap();
        assert!(path.exists());
        assert_eq!(loaded, UserSettings::default());
    }

    #[test]
    fn tolerates_unknown_fields_and_fills_defaults() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("towles-tool.settings.json");
        std::fs::write(
            &path,
            r#"{"preferredEditor":"vim","futureFlag":true,"journalSettings":{"baseFolder":"/tmp/j"}}"#,
        )
        .unwrap();

        let loaded = load_from(&path).unwrap();
        assert_eq!(loaded.preferred_editor, "vim");
        assert_eq!(loaded.journal_settings.base_folder, "/tmp/j");
        assert!(loaded.journal_settings.daily_path_template.contains("daily-notes"));
    }

    #[test]
    fn tolerates_unknown_fields_at_every_nesting_level() {
        // Shared with the TS CLI: never reject an unmodeled key, at any depth.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("towles-tool.settings.json");
        std::fs::write(
            &path,
            r#"{
                "preferredEditor": "hx",
                "rootTsOnly": {"any": "shape"},
                "journalSettings": {"baseFolder": "/j", "journalTsOnly": 1},
                "agentboard": {"mux": "tmux", "agentboardTsOnly": true},
                "mcp": {"port": 9191, "mcpTsOnly": [1, 2, 3]},
                "collectors": {
                    "collectorsTsOnly": "x",
                    "prs": {"enabled": false, "prsTsOnly": 7},
                    "calendar": {
                        "enabled": true,
                        "calendarTsOnly": {"nested": "too"},
                        "sources": [
                            {"id": "google", "label": "G", "enabled": true, "prompt": "p", "sourceTsOnly": 9}
                        ]
                    }
                }
            }"#,
        )
        .unwrap();

        let loaded = load_from(&path).unwrap();
        assert_eq!(loaded.preferred_editor, "hx");
        assert_eq!(loaded.journal_settings.base_folder, "/j");
        assert_eq!(loaded.mcp.port, 9191);
        assert!(!loaded.collectors.prs.enabled);
        assert!(loaded.collectors.calendar.enabled);
        assert_eq!(loaded.collectors.calendar.sources.len(), 1);
        assert_eq!(loaded.collectors.calendar.sources[0].id, "google");
        assert!(loaded.journal_settings.daily_path_template.contains("daily-notes"));
        assert_eq!(loaded.collectors.issues.refresh_minutes, 15);

        let mut edited = loaded;
        edited.preferred_editor = "code".to_string();
        save_merge_to(&path, &edited).unwrap();
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["preferredEditor"], "code", "known edit wins");
        assert_eq!(raw["rootTsOnly"]["any"], "shape", "root unknown survives");
        assert_eq!(raw["journalSettings"]["journalTsOnly"], 1);
        assert_eq!(raw["agentboard"]["agentboardTsOnly"], true);
        assert_eq!(raw["mcp"]["mcpTsOnly"][0], 1);
        assert_eq!(raw["collectors"]["collectorsTsOnly"], "x");
        assert_eq!(raw["collectors"]["prs"]["prsTsOnly"], 7);
        assert_eq!(raw["collectors"]["calendar"]["calendarTsOnly"]["nested"], "too");
    }

    #[test]
    fn malformed_mcp_block_falls_back_to_default_without_failing_the_file() {
        // Hand-editing is invited, so a slip must not brick every consumer.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("towles-tool.settings.json");
        for bad_block in [
            r#"null"#,
            r#"{"port":"8787"}"#, // string, not integer
            r#"[9999]"#,          // array: must not set the port positionally
        ] {
            std::fs::write(&path, format!(r#"{{"preferredEditor":"vim","mcp":{bad_block}}}"#))
                .unwrap();
            let loaded = load_from(&path).unwrap();
            assert_eq!(loaded.preferred_editor, "vim", "rest of the file still loads");
            assert_eq!(loaded.mcp.port, DEFAULT_MCP_PORT, "falls back for {bad_block}");
        }

        std::fs::write(&path, r#"{"mcp":{"port":9123}}"#).unwrap();
        assert_eq!(load_from(&path).unwrap().mcp.port, 9123);
    }

    #[test]
    fn save_merge_preserves_unknown_keys() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("towles-tool.settings.json");
        std::fs::write(
            &path,
            r#"{"preferredEditor":"vim","futureFlag":true,"journalSettings":{"baseFolder":"/old","tsOnly":42}}"#,
        )
        .unwrap();

        let mut settings = load_from(&path).unwrap();
        settings.preferred_editor = "code".to_string();
        settings.journal_settings.base_folder = "/new".to_string();
        save_merge_to(&path, &settings).unwrap();

        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["preferredEditor"], "code");
        assert_eq!(raw["journalSettings"]["baseFolder"], "/new");
        assert_eq!(raw["futureFlag"], true);
        assert_eq!(raw["journalSettings"]["tsOnly"], 42);
    }

    #[test]
    fn serializes_camel_case() {
        let json = serde_json::to_string(&UserSettings::default()).unwrap();
        assert!(json.contains("\"preferredEditor\""));
        assert!(json.contains("\"journalSettings\""));
        assert!(json.contains("\"dailyPathTemplate\""));
        assert!(json.contains("\"collectors\""));
        assert!(json.contains("\"refreshMinutes\""));
    }

    #[test]
    fn collectors_defaults() {
        let c = UserSettings::default().collectors;
        assert!(!c.calendar.enabled);
        assert_eq!(c.calendar.refresh_minutes, 15);
        let ids: Vec<&str> = c.calendar.sources.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["google", "outlook"]);
        assert!(c.calendar.sources[0].enabled, "google on by default");
        assert!(!c.calendar.sources[1].enabled, "outlook opt-in");
        assert_eq!(c.calendar.sources[0].prompt, DEFAULT_CALENDAR_PROMPT_GOOGLE);
        assert_eq!(c.calendar.sources[1].prompt, DEFAULT_CALENDAR_PROMPT_OUTLOOK);
        assert!(c.calendar.quiet_hours.enabled);
        assert_eq!(c.calendar.quiet_hours.start_hour, 8);
        assert_eq!(c.calendar.quiet_hours.end_hour, 18);
        assert_eq!(c.calendar.quiet_hours.weekdays, vec![0, 1, 2, 3, 4]);
        assert!(c.prs.enabled);
        assert_eq!(c.prs.refresh_seconds, 1200);
        assert_eq!(c.prs.merged_refresh_minutes, 60);
        assert!(c.issues.enabled);
        assert_eq!(c.issues.refresh_minutes, 15);
        assert!(!c.slack.enabled);
        assert!(c.slack.token.is_empty());
        assert!(c.slack.app_token.is_empty());
        assert_eq!(c.slack.refresh_seconds, 60);
    }

    #[test]
    fn prompt_improver_defaults() {
        let s = UserSettings::default();
        let ids: Vec<&str> = s.prompt_improvers.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, vec!["direct", "clarify", "brainstorm", "interview"]);
        assert!(s.prompt_improvers.iter().all(|g| g.enabled));
        let preferred: Vec<&str> =
            s.prompt_improvers.iter().filter(|g| g.preferred).map(|g| g.id.as_str()).collect();
        assert_eq!(preferred, vec!["direct"]);
        // Instructions *about* the task, never templates containing it.
        assert!(s.prompt_improvers.iter().all(|g| !g.prompt.trim().is_empty()));
        assert!(!s.prompt_improvers.iter().any(|g| g.prompt.contains("{goal}")));
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"promptImprovers\""));
    }

    #[test]
    fn notify_defaults_unset_and_everything_on() {
        let s = UserSettings::default();
        assert!(s.agentboard.notify.is_none());
        assert!(s.agentboard.notify_threshold.is_none());
        let json = serde_json::to_string(&s).unwrap();
        assert!(!json.contains("notify"));
        assert!(
            [
                NotifyKind::NeedsYou,
                NotifyKind::MeetingStart,
                NotifyKind::ChecksFailed,
                NotifyKind::ReviewRequested,
                NotifyKind::StaleCollector,
            ]
            .into_iter()
            .all(|k| s.agentboard.notifies(k))
        );
    }

    #[test]
    fn notify_threshold_filters_by_level() {
        let mut ab = AgentboardSettings {
            notify_threshold: Some(NotifyLevel::Important),
            ..Default::default()
        };
        assert!(ab.notifies(NotifyKind::MeetingStart), "urgent clears an important threshold");
        assert!(ab.notifies(NotifyKind::ChecksFailed), "at the threshold still fires");
        assert!(!ab.notifies(NotifyKind::ReviewRequested), "routine is below it");
        assert!(!ab.notifies(NotifyKind::StaleCollector));

        ab.notify_threshold = Some(NotifyLevel::Urgent);
        assert!(ab.notifies(NotifyKind::NeedsYou));
        assert!(!ab.notifies(NotifyKind::ChecksFailed));
    }

    #[test]
    fn notify_off_silences_even_the_most_urgent_kind() {
        let ab = AgentboardSettings {
            notify: Some(false),
            notify_threshold: Some(NotifyLevel::Routine),
            ..Default::default()
        };
        assert!(!ab.notifies(NotifyKind::MeetingStart));
        assert!(!ab.notifies(NotifyKind::NeedsYou));
    }

    #[test]
    fn notify_threshold_round_trips_camel_case_and_tolerates_junk() {
        let json = r#"{"agentboard":{"notify":false,"notifyThreshold":"important"}}"#;
        let s: UserSettings = serde_json::from_str(json).unwrap();
        assert_eq!(s.agentboard.notify, Some(false));
        assert_eq!(s.agentboard.notify_threshold, Some(NotifyLevel::Important));
        assert!(serde_json::to_string(&s).unwrap().contains("\"notifyThreshold\":\"important\""));

        // A newer build's level defaults rather than failing the whole file.
        let odd = r#"{"agentboard":{"notifyThreshold":"apocalyptic"}}"#;
        let s: UserSettings = serde_json::from_str(odd).unwrap();
        assert!(s.agentboard.notify_threshold.is_none());
        assert!(s.agentboard.notifies(NotifyKind::StaleCollector));
    }

    #[test]
    fn copy_on_select_defaults_unset_and_on() {
        let s = UserSettings::default();
        assert!(s.agentboard.copy_on_select.is_none());
        let json = serde_json::to_string(&s).unwrap();
        assert!(!json.contains("copyOnSelect"));
        assert!(s.agentboard.copy_on_select.unwrap_or(true));
    }

    #[test]
    fn shortcuts_work_in_terminal_defaults_unset_and_on() {
        let s = UserSettings::default();
        assert!(s.agentboard.shortcuts_work_in_terminal.is_none());
        let json = serde_json::to_string(&s).unwrap();
        assert!(!json.contains("shortcutsWorkInTerminal"));
        assert!(s.agentboard.shortcuts_work_in_terminal.unwrap_or(true));
    }

    #[test]
    fn shortcut_coach_defaults_unset_and_on() {
        let s = UserSettings::default();
        assert!(s.agentboard.shortcut_coach.is_none());
        let json = serde_json::to_string(&s).unwrap();
        assert!(!json.contains("shortcutCoach"));
        assert!(s.agentboard.shortcut_coach.unwrap_or(true));
    }

    #[test]
    fn terminal_font_size_defaults_unset_and_thirteen() {
        let s = UserSettings::default();
        assert!(s.agentboard.terminal_font_size.is_none());
        let json = serde_json::to_string(&s).unwrap();
        assert!(!json.contains("terminalFontSize"));
        assert_eq!(s.agentboard.terminal_font_size.unwrap_or(13), 13);
    }

    #[test]
    fn terminal_font_size_tolerates_unknown_and_roundtrips() {
        let json = r#"{"agentboard":{"terminalFontSize":17,"someFutureKey":true}}"#;
        let s: UserSettings = serde_json::from_str(json).unwrap();
        assert_eq!(s.agentboard.terminal_font_size, Some(17));
        let out = serde_json::to_string(&s).unwrap();
        assert!(out.contains("\"terminalFontSize\":17"));
    }

    #[test]
    fn json_schema_has_properties() {
        let schema = json_schema();
        let props = &schema["properties"];
        assert!(props.get("preferredEditor").is_some());
        assert!(props.get("journalSettings").is_some());
        assert!(props.get("agentboard").is_some());
    }

    /// The TS CLI expects `camelCase`; an underscore here is a break waiting.
    #[test]
    fn json_schema_property_names_are_camel_case() {
        fn walk(node: &serde_json::Value, offenders: &mut Vec<String>) {
            match node {
                serde_json::Value::Object(map) => {
                    if let Some(serde_json::Value::Object(props)) = map.get("properties") {
                        for name in props.keys() {
                            if name.contains('_') {
                                offenders.push(name.clone());
                            }
                        }
                    }
                    for value in map.values() {
                        walk(value, offenders);
                    }
                }
                serde_json::Value::Array(items) => {
                    for item in items {
                        walk(item, offenders);
                    }
                }
                _ => {}
            }
        }

        let schema = json_schema();
        let mut offenders = Vec::new();
        walk(&schema, &mut offenders);
        assert!(
            offenders.is_empty(),
            "schema has non-camelCase property names (would break the shared TS-CLI file): {offenders:?}",
        );
    }

    /// The schema must reach the nested collector tree, not just the top level.
    #[test]
    fn json_schema_covers_nested_collectors() {
        let schema = json_schema();
        let defs = &schema["definitions"];
        assert!(defs.get("CollectorsSettings").is_some());
        let cal = &defs["CalendarCollector"]["properties"];
        assert!(cal.get("refreshMinutes").is_some());
        assert!(cal.get("sources").is_some());
        // The user-facing escape hatch; absent, the settings UI can't offer it.
        let src = &defs["CalendarSource"]["properties"];
        assert!(src.get("prompt").is_some());
        assert!(src.get("enabled").is_some());
        let prs = &defs["PrCollector"]["properties"];
        assert!(prs.get("refreshSeconds").is_some());
        assert!(prs.get("mergedRefreshMinutes").is_some());
    }

    /// [`save_to`] drops unmodeled TS keys where [`save_merge_to`] keeps them;
    /// a refactor making them agree must be deliberate.
    #[test]
    fn save_to_drops_unknown_keys() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("towles-tool.settings.json");
        std::fs::write(
            &path,
            r#"{"preferredEditor":"vim","futureFlag":true,"journalSettings":{"baseFolder":"/old","tsOnly":42}}"#,
        )
        .unwrap();

        let settings = load_from(&path).unwrap();
        save_to(&path, &settings).unwrap();

        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["preferredEditor"], "vim");
        assert_eq!(raw["journalSettings"]["baseFolder"], "/old");
        assert!(raw.get("futureFlag").is_none());
        assert!(raw["journalSettings"].get("tsOnly").is_none());
    }

    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// The one `unsafe` env seam in these tests; every caller holds ENV_LOCK.
    fn set_scope_env(value: Option<&str>) {
        // SAFETY: guarded by ENV_LOCK.
        unsafe {
            match value {
                Some(v) => std::env::set_var(STATE_SCOPE_ENV, v),
                None => std::env::remove_var(STATE_SCOPE_ENV),
            }
        }
    }

    /// A task-checkout layout, plus a nested crate dir for subdir detection.
    fn task_checkout(root_name: &str) -> TempDir {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join(root_name);
        std::fs::create_dir_all(root.join("crates").join("tt-config")).unwrap();
        std::fs::create_dir_all(root.join("crates").join("tt-store").join("src")).unwrap();
        dir
    }

    #[test]
    fn task_checkout_dir_derives_scope() {
        let dir = task_checkout("towles-tool");
        let root = dir.path().join("towles-tool");
        assert_eq!(task_scope_from_dir(&root), Some("towles-tool".to_string()));
        assert_eq!(
            task_scope_from_dir(&root.join("crates").join("tt-store").join("src")),
            Some("towles-tool".to_string())
        );
    }

    #[test]
    fn nested_worktree_checkout_is_repo_qualified() {
        // Carries the main checkout's name, so same-named tasks of different
        // repos never share state.
        let dir = TempDir::new().unwrap();
        let task = dir.path().join("towles-tool").join(".claude").join("worktrees").join("migrate");
        std::fs::create_dir_all(task.join("crates").join("tt-config")).unwrap();
        assert_eq!(task_scope_from_dir(&task), Some("towles-tool-migrate".to_string()));
    }

    #[test]
    fn worktrees_dir_outside_claude_is_not_qualified() {
        let dir = TempDir::new().unwrap();
        let checkout = dir.path().join("worktrees").join("thing");
        std::fs::create_dir_all(checkout.join("crates").join("tt-config")).unwrap();
        assert_eq!(task_scope_from_dir(&checkout), Some("thing".to_string()));
    }

    #[test]
    fn non_repo_dir_is_unscoped() {
        let dir = TempDir::new().unwrap();
        assert_eq!(task_scope_from_dir(dir.path()), None);
    }

    #[test]
    fn arbitrary_git_repo_is_unscoped() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("some-other-project");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join("crates").join("their-crate")).unwrap();
        std::fs::write(root.join("Cargo.toml"), "[workspace]\n").unwrap();
        assert_eq!(task_scope_from_dir(&root), None);
    }

    #[test]
    fn sanitize_scope_keeps_scope_names_and_strips_others() {
        assert_eq!(sanitize_scope("towles-tool-task-2"), "towles-tool-task-2");
        assert_eq!(sanitize_scope("  weird/name space "), "weird-name-space");
    }

    #[test]
    fn env_override_forces_scope_and_empty_forces_unscoped() {
        let _guard = ENV_LOCK.lock().unwrap();
        let base = PathBuf::from("/home/x/.config/towles-tool");

        // A FORCED scope nests shared stores too, so tests stay off real files.
        set_scope_env(Some("my-scope"));
        assert_eq!(state_scope(), Some("my-scope".to_string()));
        assert_eq!(instance_under(base.clone()), base.join("tasks").join("my-scope"));
        assert_eq!(shared_under(base.clone()), base.join("tasks").join("my-scope"));

        set_scope_env(Some(""));
        assert_eq!(state_scope(), None);
        assert_eq!(instance_under(base.clone()), base);
        assert_eq!(shared_under(base.clone()), base);

        set_scope_env(None);
    }

    /// Pure resolvers with a hand-built Scope: auto-detection reads the cwd.
    #[test]
    fn auto_scope_nests_instance_but_not_shared() {
        let base = PathBuf::from("/home/x/.config/towles-tool");
        let auto = Scope::Auto("towles-tool-thing".into());
        assert_eq!(nest(base.clone(), &auto, true), base.join("tasks").join("towles-tool-thing"));
        assert_eq!(nest(base.clone(), &auto, false), base);
    }

    #[test]
    fn config_dir_override_wins_via_env_but_scoped_paths_nest() {
        let _guard = ENV_LOCK.lock().unwrap();
        set_scope_env(Some("task-9"));
        let cfg = config_dir().unwrap();
        assert!(cfg.ends_with("towles-tool/tasks/task-9"), "got {}", cfg.display());
        assert!(config_path().unwrap().ends_with("task-9/towles-tool.settings.json"));
        assert!(store_db_path().unwrap().ends_with("towles-tool/tasks/task-9/tt.db"));
        assert!(agentboard_dir().unwrap().ends_with("tasks/task-9/agentboard"));
        set_scope_env(None);
    }

    /// Machine-wide even when auto-scoped; a forced scope sandboxes them.
    #[test]
    fn instance_state_bases_ignore_auto_but_honor_forced_scope() {
        let _guard = ENV_LOCK.lock().unwrap();

        set_scope_env(Some(""));
        let bases = instance_state_bases().unwrap();
        assert!(bases.data.ends_with("towles-tool"), "got {}", bases.data.display());
        assert!(bases.config.ends_with(".config/towles-tool"), "got {}", bases.config.display());
        let [data_tasks, config_tasks] = bases.scope_parents();
        assert!(data_tasks.ends_with("towles-tool/tasks"));
        assert!(config_tasks.ends_with(".config/towles-tool/tasks"));
        assert!(bases.agentboard_dir(None).ends_with("towles-tool/agentboard"));
        assert!(
            bases
                .agentboard_dir(Some("repo-thing"))
                .ends_with("towles-tool/tasks/repo-thing/agentboard")
        );

        set_scope_env(Some("sandbox"));
        let bases = instance_state_bases().unwrap();
        assert!(bases.data.ends_with("towles-tool/tasks/sandbox"));
        assert!(bases.config.ends_with(".config/towles-tool/tasks/sandbox"));

        set_scope_env(None);
    }

    #[test]
    fn instance_state_dirs_target_the_named_scope_not_the_ambient_one() {
        let _guard = ENV_LOCK.lock().unwrap();
        set_scope_env(Some(""));
        let dirs = instance_state_dirs_for_scope("towles-tool-thing");
        assert!(!dirs.is_empty());
        for dir in &dirs {
            assert!(dir.ends_with("towles-tool/tasks/towles-tool-thing"), "got {}", dir.display());
        }
        assert!(instance_state_dirs_for_scope("  ").is_empty());

        // A FORCED scope nests the targets too, off the real machine paths.
        set_scope_env(Some("test-world"));
        for dir in instance_state_dirs_for_scope("towles-tool-thing") {
            assert!(
                dir.ends_with("tasks/test-world/tasks/towles-tool-thing"),
                "got {}",
                dir.display()
            );
        }
        set_scope_env(None);
    }

    #[test]
    fn unscoped_paths_match_historic_defaults() {
        let _guard = ENV_LOCK.lock().unwrap();
        set_scope_env(Some(""));
        assert!(config_dir().unwrap().ends_with(".config/towles-tool"));
        assert!(config_path().unwrap().ends_with("towles-tool/towles-tool.settings.json"));
        assert!(store_db_path().unwrap().ends_with("towles-tool/tt.db"));
        assert!(agentboard_dir().unwrap().ends_with("towles-tool/agentboard"));
        set_scope_env(None);
    }
}
