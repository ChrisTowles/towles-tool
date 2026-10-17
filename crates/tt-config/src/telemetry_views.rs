use super::*;

/// How a [`TelemetryFilter`] compares a record's value with its own.
/// `Gt`/`Lt` compare numerically when both sides parse as numbers and
/// lexically otherwise; `Contains` is a case-insensitive substring.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "lowercase")]
pub enum FilterOp {
    #[default]
    Eq,
    Neq,
    Contains,
    Gt,
    Lt,
}

/// One structured predicate on the Telemetry screen's Log tab. `field` is a
/// base column of a record (`kind`, `level`, `target`, `name`, `ttTask`,
/// `ttBuildSha`, `durationMs`) or any key in its `fields`
/// (`process.executable.name`, `outcome`, `message`). Lives here rather than
/// in `tt-telemetry` because saved views persist it in the settings file.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", default)]
pub struct TelemetryFilter {
    pub field: String,
    pub op: FilterOp,
    pub value: String,
}

impl TelemetryFilter {
    pub fn new(field: &str, op: FilterOp, value: &str) -> Self {
        Self { field: field.to_string(), op, value: value.to_string() }
    }
}

/// A named Log-tab query: its filters, how many days back it reads, and its
/// free-text search. Shared across instances like every other setting.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", default)]
pub struct SavedView {
    pub id: String,
    pub label: String,
    pub filters: Vec<TelemetryFilter>,
    pub days: u32,
    pub query: String,
}

impl SavedView {
    /// The questions the log has actually been asked, as views: which `gh`
    /// calls failed, which spawns were slow, and when a notification fired.
    pub fn defaults() -> Vec<Self> {
        vec![
            Self {
                id: "gh-failures".to_string(),
                label: "gh failures".to_string(),
                filters: vec![
                    TelemetryFilter::new("process.executable.name", FilterOp::Eq, "gh"),
                    TelemetryFilter::new("outcome", FilterOp::Neq, "ok"),
                ],
                days: 1,
                query: String::new(),
            },
            Self {
                id: "slow-spawns".to_string(),
                label: "spawns > 2 s".to_string(),
                filters: vec![
                    TelemetryFilter::new("name", FilterOp::Eq, "process.spawn"),
                    TelemetryFilter::new("durationMs", FilterOp::Gt, "2000"),
                ],
                days: 7,
                query: String::new(),
            },
            Self {
                id: "interruptions".to_string(),
                label: "interruptions".to_string(),
                filters: vec![TelemetryFilter::new(
                    "message",
                    FilterOp::Contains,
                    "notify_needs_you",
                )],
                days: 7,
                query: String::new(),
            },
        ]
    }
}
/// One row in the Telemetry screen's Query tab: a name and the SQL it runs
/// over the event log (`tt_telemetry::query`'s `records`/`spans` schema).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", default)]
pub struct SavedQuery {
    pub id: String,
    pub label: String,
    pub sql: String,
}

impl SavedQuery {
    /// Questions the log exists to answer, each a working example of the schema:
    /// spans by outcome, the slow tail, focus churn, notifications that landed
    /// while the window had focus, the app's own model spend, agent status
    /// churn, and the warnings worth a look.
    pub fn defaults() -> Vec<Self> {
        vec![
            Self {
                id: "gh-failures-by-cwd".to_string(),
                label: "gh failures by cwd".to_string(),
                sql: DEFAULT_QUERY_GH_FAILURES.to_string(),
            },
            Self {
                id: "slow-spawns".to_string(),
                label: "slow spawns > 2 s".to_string(),
                sql: DEFAULT_QUERY_SLOW_SPAWNS.to_string(),
            },
            Self {
                id: "focus-flips-per-hour".to_string(),
                label: "focus flips per hour".to_string(),
                sql: DEFAULT_QUERY_FOCUS_FLIPS.to_string(),
            },
            Self {
                id: "interruptions-while-focused".to_string(),
                label: "interruptions while focused".to_string(),
                sql: DEFAULT_QUERY_INTERRUPTIONS.to_string(),
            },
            Self {
                id: "model-spend-by-day".to_string(),
                label: "model spend by day".to_string(),
                sql: DEFAULT_QUERY_MODEL_SPEND.to_string(),
            },
            Self {
                id: "agent-status-by-checkout".to_string(),
                label: "agent status moves by checkout".to_string(),
                sql: DEFAULT_QUERY_AGENT_STATUS.to_string(),
            },
            Self {
                id: "warnings-by-message".to_string(),
                label: "warnings and errors by message".to_string(),
                sql: DEFAULT_QUERY_PROBLEMS.to_string(),
            },
        ]
    }
}

pub const DEFAULT_QUERY_GH_FAILURES: &str = "\
select executable, working_directory as cwd, count(*) as n,
       sum(outcome != 'ok') as fails, round(avg(duration_ms)) as avg_ms
from spans where name = 'process.spawn' and day = date('now')
group by 1, 2 order by fails desc limit 20";

pub const DEFAULT_QUERY_SLOW_SPAWNS: &str = "\
select ts, executable, command_args, duration_ms, outcome, working_directory as cwd
from spans where name = 'process.spawn' and duration_ms > 2000
order by duration_ms desc limit 50";

pub const DEFAULT_QUERY_FOCUS_FLIPS: &str = "\
select strftime('%Y-%m-%d %H:00', ts, 'localtime') as hour,
       count(*) as flips, sum(json_extract(fields, '$.focused') = 1) as gained
from records where message = 'window.focus_changed'
group by 1 order by 1 desc limit 48";

pub const DEFAULT_QUERY_INTERRUPTIONS: &str = "\
select n.ts, json_extract(n.fields, '$.repo') as repo,
       json_extract(n.fields, '$.session') as session,
       json_extract(n.fields, '$.reason') as reason
from records n
where n.message = 'notify_needs_you: fired'
  and (select json_extract(f.fields, '$.focused') from records f
       where f.message = 'window.focus_changed' and f.ts < n.ts
       order by f.ts desc limit 1) = 1
order by n.ts desc limit 100";

pub const DEFAULT_QUERY_MODEL_SPEND: &str = "\
select day, message as source, count(*) as calls,
       round(sum(json_extract(fields, '$.cost_usd')), 4) as usd
from records where json_extract(fields, '$.cost_usd') is not null
group by 1, 2 order by day desc, usd desc limit 100";

pub const DEFAULT_QUERY_AGENT_STATUS: &str = "\
select day, json_extract(fields, '$.folder') as checkout,
       json_extract(fields, '$.to') as status, count(*) as moves
from records where message = 'agent.status_changed'
group by 1, 2, 3 order by day desc, moves desc limit 100";

pub const DEFAULT_QUERY_PROBLEMS: &str = "\
select level, coalesce(message, name) as what, target, count(*) as n, max(ts) as last
from records where level in ('WARN', 'ERROR')
group by 1, 2, 3 order by n desc limit 50";

/// `Share`: the percentage of `select` matches also matching `pass`, failing
/// *below* `threshold`. `Count`: the number of matches, failing *above* it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "lowercase")]
pub enum RuleKind {
    #[default]
    Share,
    Count,
}

/// A deterministic scorer over the event log (`tt-telemetry`'s `rules.rs`),
/// persisted beside [`SavedView`] for the same reason: it is settings.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", default)]
pub struct TelemetryRule {
    pub id: String,
    pub label: String,
    pub enabled: bool,
    pub kind: RuleKind,
    pub select: Vec<TelemetryFilter>,
    pub pass: Vec<TelemetryFilter>,
    /// A percentage for `Share`, a count for `Count`; the edge is inclusive.
    pub threshold: f64,
    pub days: u32,
}

impl TelemetryRule {
    /// `gh` exiting clean, no spawn hanging half a minute, and the noise floor.
    pub fn defaults() -> Vec<Self> {
        let spawn = TelemetryFilter::new("name", FilterOp::Eq, "process.spawn");
        vec![
            Self {
                id: "gh-exits-clean".to_string(),
                label: "gh exits clean".to_string(),
                enabled: true,
                kind: RuleKind::Share,
                select: vec![
                    spawn.clone(),
                    TelemetryFilter::new("process.executable.name", FilterOp::Eq, "gh"),
                ],
                pass: vec![TelemetryFilter::new("outcome", FilterOp::Eq, "ok")],
                threshold: 95.0,
                days: 1,
            },
            Self {
                id: "no-spawn-over-30s".to_string(),
                label: "No spawn over 30 s".to_string(),
                enabled: true,
                kind: RuleKind::Share,
                select: vec![spawn],
                pass: vec![TelemetryFilter::new("durationMs", FilterOp::Lt, "30000")],
                threshold: 100.0,
                days: 1,
            },
            Self {
                id: "needs-you-not-spammed".to_string(),
                label: "Needs-you not spammed".to_string(),
                enabled: true,
                kind: RuleKind::Count,
                select: vec![TelemetryFilter::new(
                    "message",
                    FilterOp::Eq,
                    "notify_needs_you: fired",
                )],
                pass: Vec::new(),
                threshold: 30.0,
                days: 1,
            },
            Self {
                id: "zero-warn".to_string(),
                label: "Zero WARN".to_string(),
                enabled: true,
                kind: RuleKind::Count,
                select: vec![TelemetryFilter::new("level", FilterOp::Eq, "WARN")],
                pass: Vec::new(),
                threshold: 0.0,
                days: 1,
            },
            Self {
                id: "zero-error".to_string(),
                label: "Zero ERROR".to_string(),
                enabled: true,
                kind: RuleKind::Count,
                select: vec![TelemetryFilter::new("level", FilterOp::Eq, "ERROR")],
                pass: Vec::new(),
                threshold: 0.0,
                days: 1,
            },
        ]
    }
}
