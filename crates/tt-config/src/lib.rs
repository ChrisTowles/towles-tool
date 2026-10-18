//! Configuration model for towles-tool, plus the resolver for every mutable state path the
//! CLI and app touch. It reads/writes `~/.config/towles-tool/towles-tool.settings.json`, so
//! the model tolerates unknown fields and defaults missing ones — never
//! `deny_unknown_fields`. Two test-enforced invariants keep that file safe: every property
//! name is `camelCase`, and writes go through [`save_merge`] so unknown keys survive.
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

mod app_identity;
mod collectors;
mod paths;
mod telemetry_views;

pub use app_identity::*;
pub use collectors::*;
pub use paths::*;
pub use telemetry_views::*;

pub const TOOL_NAME: &str = "towles-tool";

/// **The** clock read for this workspace. Logic crates take injected `now_ms`
/// so they stay deterministic; this is the boundary reading the real clock.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Epoch ms of a file timestamp; `None` for one before the epoch.
pub fn system_time_ms(t: std::time::SystemTime) -> Option<i64> {
    t.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis() as i64)
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

    /// Close a task as done on its own once its work has landed and its checkout
    /// holds nothing else. `None` = [`DEFAULT_AUTO_CLOSE_LANDED`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_close_landed: Option<bool>,

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

    /// The native Bevy surface (`tt-jarvis`), off by default; needs `tt-app`'s `bevy` feature.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jarvis_pane: Option<bool>,

    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_pane: Option<bool>,

    /// macOS only: Ctrl, not ⌘, is the shortcut modifier — in the app and in
    /// the code-server workbench, which loads its Windows/Linux keymap.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pc_keybindings: Option<bool>,

    /// Relaunch the previous run's Claude panes on launch without asking. `None` = on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_resume: Option<bool>,

    /// After a prompt is sent to a session waiting on you, focus the next one. `None` = on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub advance_after_submit: Option<bool>,
}

pub const DEFAULT_COMPACT_RECOMMEND_PERCENT: u8 = 30;

pub const DEFAULT_SHOW_UNMANAGED_WORKTREES: bool = false;

pub const DEFAULT_AUTO_CLOSE_LANDED: bool = true;

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

/// A new-task preset: the goal it starts from, the improver it runs, and a command run
/// after the repo's own setup. Empty fields mean "none"; an empty `repo` applies to every
/// repo. None ship — they are the user's own.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", default)]
pub struct TaskTemplate {
    pub id: String,
    pub label: String,
    /// Repo name or checkout dir, as the Agentboard rail shows it.
    pub repo: String,
    pub goal: String,
    /// A [`PromptImprover::id`].
    pub improver: String,
    pub setup: String,
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

/// The Claude mod's next-prompt suggestion: one context-free `claude -p` question per
/// keystroke, never automatic. `question` is the instruction; the context goes after it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", default)]
pub struct NextPromptSettings {
    pub question: String,
    pub model: String,
    /// Spend past this in a local day refuses further calls until tomorrow.
    pub daily_budget_usd: f64,
}

/// The on-disk event log (`tt-telemetry`). Read once at startup by the writer,
/// and by the Settings screen's "prune now".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", default)]
pub struct TelemetrySettings {
    /// Daily `events-<date>.jsonl` files kept; older ones are deleted on rollover.
    pub retain_days: u32,
}

pub const DEFAULT_TELEMETRY_RETAIN_DAYS: u32 = 14;

/// Bounds on [`TelemetrySettings::retain_days`]: at least today, at most a year.
pub const TELEMETRY_RETAIN_DAYS_RANGE: std::ops::RangeInclusive<u32> = 1..=365;

impl Default for TelemetrySettings {
    fn default() -> Self {
        Self { retain_days: DEFAULT_TELEMETRY_RETAIN_DAYS }
    }
}

impl TelemetrySettings {
    /// [`Self::retain_days`] clamped into [`TELEMETRY_RETAIN_DAYS_RANGE`].
    pub fn retain_days(&self) -> usize {
        self.retain_days
            .clamp(*TELEMETRY_RETAIN_DAYS_RANGE.start(), *TELEMETRY_RETAIN_DAYS_RANGE.end())
            as usize
    }
}

pub const DEFAULT_NEXT_PROMPT_QUESTION: &str = "What is the person most likely to type as \
their next prompt to this coding agent? Answer with the prompt exactly as they would type it, \
in their own style and length, and how confident you are from 0 to 1. Answer an empty prompt if \
you cannot tell.";

impl Default for NextPromptSettings {
    fn default() -> Self {
        Self {
            question: DEFAULT_NEXT_PROMPT_QUESTION.to_string(),
            model: "haiku".to_string(),
            daily_budget_usd: 0.20,
        }
    }
}

/// The Claude mod's end-of-turn copy offer: the `! <command>` lines Claude hands the user.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", default)]
pub struct ClipSuggestSettings {
    pub enabled: bool,
}

impl Default for ClipSuggestSettings {
    fn default() -> Self {
        Self { enabled: true }
    }
}

/// Which builds an installed app updates itself to.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    /// Published releases, newest semver wins.
    #[default]
    Stable,
    /// The rolling `main-build` prerelease every push to main refreshes.
    Main,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", default)]
pub struct UpdatesSettings {
    pub channel: UpdateChannel,
}

/// `tt-mcp`'s HTTP transport. No bearer token: `Origin` and `Content-Type` checks defend it.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", default)]
pub struct McpSettings {
    /// The fallback for an app outside any checkout; a checkout serves its `.env` claim.
    pub port: u16,
}

pub const DEFAULT_MCP_PORT: u16 = 47870;

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

    pub task_templates: Vec<TaskTemplate>,

    /// The Telemetry Log tab's saved views; see [`SavedView::defaults`].
    pub saved_views: Vec<SavedView>,
    pub saved_queries: Vec<SavedQuery>,

    /// The Telemetry Rules tab's scorers; see [`TelemetryRule::defaults`].
    pub telemetry_rules: Vec<TelemetryRule>,

    pub collectors: CollectorsSettings,

    /// Lenient on purpose: a hand-edit slip (`"mcp": null`) must not fail the whole file.
    #[serde(default, deserialize_with = "lenient_mcp")]
    pub mcp: McpSettings,

    /// Lenient for the same reason as `mcp`.
    #[serde(default, deserialize_with = "lenient_next_prompt")]
    pub next_prompt: NextPromptSettings,

    /// Lenient for the same reason as `mcp`.
    #[serde(default, deserialize_with = "lenient_telemetry")]
    pub telemetry: TelemetrySettings,

    /// Lenient for the same reason as `mcp`.
    #[serde(default, deserialize_with = "lenient_clip_suggest")]
    pub clip_suggest: ClipSuggestSettings,

    /// Lenient for the same reason as `mcp`.
    #[serde(default, deserialize_with = "lenient_updates")]
    pub updates: UpdatesSettings,
}

fn lenient_updates<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<UpdatesSettings, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).unwrap_or_default())
}

fn lenient_telemetry<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<TelemetrySettings, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).unwrap_or_default())
}

fn lenient_clip_suggest<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<ClipSuggestSettings, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).unwrap_or_default())
}

fn lenient_next_prompt<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<NextPromptSettings, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).unwrap_or_default())
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
            task_templates: Vec::new(),
            saved_views: SavedView::defaults(),
            saved_queries: SavedQuery::defaults(),
            telemetry_rules: TelemetryRule::defaults(),
            collectors: CollectorsSettings::default(),
            mcp: McpSettings::default(),
            next_prompt: NextPromptSettings::default(),
            telemetry: TelemetrySettings::default(),
            clip_suggest: ClipSuggestSettings::default(),
            updates: UpdatesSettings::default(),
        }
    }
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
mod tests;
