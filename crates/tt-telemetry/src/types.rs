use serde::Serialize;
use serde_json::Value;

/// One parsed line from an `events-<date>.jsonl` file ([`crate::read_day`]):
/// the base fields typed, everything else in `fields`, the line itself in `raw`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryRecord {
    pub ts: String,
    /// `"event"` or `"span"`.
    pub kind: String,
    pub level: String,
    pub target: String,
    pub name: String,
    /// The `tt.task` resource attribute: which checkout wrote this.
    pub tt_task: Option<String>,
    /// The `tt.build_sha` resource attribute, `"unknown"` if `build.rs` couldn't resolve it.
    pub tt_build_sha: Option<String>,
    /// Present only on `kind: "span"` records.
    pub duration_ms: Option<i64>,
    /// `process.pid`: the only way to group a span with what it wrote ([`crate::children_of`]).
    pub pid: Option<i64>,
    /// Every other field on the line, resource attributes stripped.
    pub fields: Value,
    pub raw: String,
}

impl TelemetryRecord {
    /// The UTC calendar day this record was written on (`YYYY-MM-DD`), which is
    /// also the log file it came from. Taken from `ts`, which is RFC 3339 and
    /// always in UTC, so the first ten bytes are the date.
    pub fn day(&self) -> &str {
        self.ts.get(..10).unwrap_or(&self.ts)
    }
}
