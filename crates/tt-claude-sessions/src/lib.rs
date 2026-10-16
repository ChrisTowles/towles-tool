//! Token-accounting library backing the desktop app's Claude Sessions screen. It
//! parses session JSONL once per scan ([`ledger`]) and derives all the screen
//! shows from that cached pass. [`breakdown`] is the only per-session re-parse, done
//! when a row is opened. Tauri-free, and every filesystem-touching function takes
//! explicit paths so tests never read the real `~/.claude`.
//!

use thiserror::Error;

pub mod analyzer;
pub mod breakdown;
pub mod by_dir;
pub mod cadence;
pub mod insights;
pub mod ledger;
pub mod next_prompt;
pub mod parser;
pub mod pricing;
#[cfg(test)]
mod test_support;
pub mod tools;
pub mod types;
pub mod usage_limits;

/// Errors surfaced by the library. JSONL parse failures are intentionally
/// *not* errors — malformed lines are skipped — so the only fallible surface is
/// filesystem access.
#[derive(Debug, Error)]
pub enum Error {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

pub use analyzer::{
    SessionAnalysis, aggregate_session_tools, analyze_session, extract_project_name,
    get_model_name, get_primary_model,
};
pub use breakdown::{SessionBreakdown, TurnBreakdown, build_session_breakdown, find_session_path};
pub use by_dir::{DirCost, cost_by_dir};
pub use cadence::{CadenceSummary, DayBucket, DayHourCell, build_cadence};
pub use insights::{Insight, InsightKind, build_insights};
pub use ledger::{
    LedgerTotals, SearchHit, SessionDetail, build_ledger_days, build_ledger_model_totals,
    build_ledger_project_totals, ledger_totals, normalize_repo_name, scan_sessions_detailed,
    search_sessions,
};
pub use parser::calculate_cutoff_ms;
pub use pricing::{ModelPricing, pricing_for};
pub use tools::{extract_tool_data, extract_tool_detail, sanitize_string, truncate_detail};
pub use tt_claude_code::{
    Content, Message, TranscriptEntry, Usage, parse_transcript, parse_transcript_file,
};
pub use types::{BarChartDay, ModelBar, ProjectBar, ToolData};
pub use usage_limits::{UsageLimitBar, UsageLimits, read_cached_usage_limits};
