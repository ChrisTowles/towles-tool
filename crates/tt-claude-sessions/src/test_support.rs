//! Test-only fixtures shared across this crate's `mod tests`.

use crate::ledger::SessionDetail;
use std::path::PathBuf;
use tt_claude_code::UsageTotals;

/// A zeroed [`SessionDetail`]. Tests build on it with struct-update syntax so
/// each one names only the fields it actually exercises:
///
/// ```ignore
/// SessionDetail { user_turns: 3, ..session_detail() }
/// ```
pub(crate) fn session_detail() -> SessionDetail {
    SessionDetail {
        session_id: "s".into(),
        path: PathBuf::from("/x.jsonl"),
        project: "demo".into(),
        date: "2026-07-17".into(),
        mtime: 0,
        title: None,
        cwd: None,
        usage: UsageTotals::default(),
        opus_tokens: 0,
        sonnet_tokens: 0,
        haiku_tokens: 0,
        fable_tokens: 0,
        repeated_reads: 0,
        cost_usd: 0.0,
        cost_by_model: [0.0; 4],
        user_turns: 0,
        prompt_blob: String::new(),
        prompt_times_ms: Vec::new(),
    }
}
