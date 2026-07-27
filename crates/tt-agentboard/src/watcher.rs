//! Agent-watcher contract, framed for an externally-driven scan tick.
//!
//! The 2s tick is **driven externally**: the bridge calls [`AgentWatcher::scan`]
//! with an explicit `now_ms` on whatever schedule it owns. This keeps the watcher
//! deterministic and unit-testable without timers or tokio. An optional
//! `notify`-based accelerant lives in [`crate::fs_notify`], isolated from this core.

use crate::types::AgentEvent;

pub const JSONL_SUFFIX: &str = ".jsonl";

/// Callback context the bridge provides to a watcher.
pub trait WatcherContext {
    /// Resolve a project directory to a session name, or `None` if unmatched.
    ///
    /// The watcher passes the **raw encoded** project-dir name; the
    /// implementation re-encodes known repo paths and prefix-matches.
    fn resolve_session(&self, project_dir: &str) -> Option<String>;

    /// Emit an event (the bridge applies it to the tracker and broadcasts).
    fn emit(&mut self, event: AgentEvent);
}

/// A source that detects agent status by watching external data, with the scan
/// tick driven by the caller instead of an internal timer.
pub trait AgentWatcher {
    /// Perform one full scan at logical time `now_ms`, emitting via `ctx`. The
    /// caller drives this on an interval (and may call it eagerly on fs events).
    fn scan(&mut self, ctx: &mut dyn WatcherContext, now_ms: i64);
}
