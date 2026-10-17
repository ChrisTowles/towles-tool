use super::*;

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
    /// Open issues with any of these labels, assigned to anyone, are offered on the
    /// Board as tasks to start. Empty asks GitHub nothing.
    pub watched_labels: Vec<String>,
}

impl Default for IssueCollector {
    fn default() -> Self {
        Self { enabled: true, refresh_minutes: 15, watched_labels: Vec::new() }
    }
}
