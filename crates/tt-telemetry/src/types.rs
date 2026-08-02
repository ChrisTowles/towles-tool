use serde::Serialize;
use serde_json::Value;

/// One parsed line from an `events-<date>.jsonl` file, as read back by
/// [`crate::read_day`]. The fields every record carries are pulled out for
/// filtering and display; whatever else a span/event recorded rides along in
/// `fields` for drill-down and free-text search, and `raw` keeps the original
/// line verbatim.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryRecord {
    pub ts: String,
    /// `"event"` or `"span"`.
    pub kind: String,
    pub level: String,
    pub target: String,
    pub name: String,
    /// The worktree/task scope that produced this record, if any (the
    /// `tt.task` resource attribute).
    pub tt_task: Option<String>,
    /// The git commit SHA the running binary was built from (the
    /// `tt.build_sha` resource attribute), `"unknown"` if `build.rs` could
    /// not resolve it.
    pub tt_build_sha: Option<String>,
    /// Present only on `kind: "span"` records.
    pub duration_ms: Option<i64>,
    /// Every other field on the line (resource attributes already pulled out
    /// above are stripped from this).
    pub fields: Value,
    pub raw: String,
}
