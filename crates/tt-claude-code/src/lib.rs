//! The single Tauri-free home for reading Claude Code session transcripts
//! (`~/.claude/projects/**/<sessionId>.jsonl`): the canonical model of the internal,
//! version-volatile schema ([`TranscriptEntry`]) plus the projections both consumers
//! need:
//! - [`parse_transcript`] / [`parse_transcript_file`] — tolerant JSONL parsing.
//! - [`session_title`] — human session name (custom-title > ai-title).
//! - [`usage_totals`] — token accounting deduplicated by `message.id` +
//!   `requestId`, including cache-read/creation volume.
//! - Typed content accessors ([`Content::text_blocks`], [`Content::tool_uses`]).
//!
//! Read by `tt-claude-sessions` (batch analysis) and `tt-agentboard` (the live
//! engine); the live-gathering concerns stay there, only the schema/parse
//! knowledge is here. Everything is tolerant (all fields optional, malformed lines
//! skipped, unreadable files → empty) and deterministic — no clock, no `$HOME`.

pub mod cwd;
pub mod models;
pub mod parse;
pub mod prompts;
pub mod title;
pub mod types;
pub mod usage;

pub use cwd::{session_cwd, session_cwd_file, session_cwd_str};
pub use models::{
    CONTEXT_1M, CONTEXT_200K, ResolvedWindow, WindowSource, context_window, model_known,
    resolve_window,
};
pub use parse::{parse_transcript, parse_transcript_file};
pub use prompts::{UserPrompt, user_prompt_blob, user_prompts, user_prompts_with_timestamps};
pub use title::{session_title, session_title_file, session_title_str};
pub use types::{CacheCreation, Content, Message, ToolUse, TranscriptEntry, Usage};
pub use usage::{UsageTotals, usage_totals, usage_totals_file, usage_totals_str};
