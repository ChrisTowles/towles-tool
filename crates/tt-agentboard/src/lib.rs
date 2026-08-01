//! Tauri-free core engine for agentboard: the in-memory agent state machine,
//! git-info, and port attribution.
//!
//! Deliberately transport-free: **no tmux, no broadcast, no fs watchers, no poll
//! loops, no UI** — that all belongs to the Tauri layer. Time is injected as an
//! explicit `now_ms`, so tests never touch a real clock.
//!
//! - [`types`] — shared serde types, camelCase so snapshots match what the React
//!   client consumes.
//! - [`tracker`] — [`tracker::AgentTracker`], the agent-instance state machine.
//! - [`git_info`] — branch/worktree/diff-stat computation with a short cache.

use thiserror::Error;

pub mod bridge;
pub mod claude_cli;
pub mod cleanup;
pub mod collapse;
pub mod engine;
pub mod env_drift;
pub mod folder_meta;
pub mod fs_notify;
pub mod git_info;
pub mod launch;
pub mod notify;
pub mod persist;
pub mod procenv;
pub mod pty_status;
pub mod repo_meta;
pub mod repos;
pub mod resume;
pub mod sessions;
pub mod task_removal;
pub mod task_status;
pub mod text;
pub mod tracker;
pub mod types;
pub mod watcher;
pub mod watchers;
pub mod windows;

/// Errors surfaced by the agentboard core. Filesystem access is the only
/// fallible surface; parse/subprocess failures are intentionally swallowed to
/// empty/false.
#[derive(Debug, Error)]
pub enum Error {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

// Re-export the externally-consumed surface (the app, the remaining CLI
// commands, and the collector/MCP/doctor crates). Everything else stays
// reachable through its module path; the 2026-07-19 CLI trim removed the
// last importer of the wider re-export list.
pub use bridge::StatePayload;
pub use engine::{RailRow, UnrecordedWorktree};
pub use env_drift::PortDrift;
pub use git_info::{
    CommitStat, DiffFile, DiffFiles, DiffMode, UntrackedCapInfo, base_file_content, commit_stats,
    compute_git_info, diff_files, prune_stale_worktree,
};
pub use launch::{LaunchConfig, port_listening, read_launch_file};
pub use notify::{NeedsYouEdge, NeedsYouWatch};
pub use repo_meta::{HexColor, RepoAccentStyle, RepoMeta};
pub use repos::{RepoEntry, default_repos_path, load_repos, remove_repo_persisted, repo_entries};
pub use sessions::SessionRecord;
pub use types::{
    AgentEvent, AgentEventDetails, AgentStatus, FolderData, LoopInfo, NeedsYouReason, RepoData,
    SessionData, SubagentInfo,
};
pub use windows::WindowsPayload;
