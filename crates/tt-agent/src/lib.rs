//! Drive a local Claude Code agent over its `stream-json` protocol and render
//! the result as UI instead of as terminal scrollback.
//!
//! The app already hands work *to* agents precisely (Agentboard's PTY panes).
//! What it can't do is show what came back in any form richer than a scroll
//! buffer. This crate is the other half of that channel: a structured event
//! feed — tool calls, results, thinking, cost — that a React screen can
//! render, diff, and link.
//!
//! Two modules, split so that everything except the subprocess is testable
//! without one:
//!
//! - [`protocol`] — pure JSONL ⇄ [`protocol::AgentEvent`] translation, tested
//!   against a recorded transcript.
//! - [`control`] — the *other* protocol on the same pipe: requests the CLI
//!   blocks on until the client answers (permission prompts, and the question
//!   tools that reach a human through the same door).
//! - [`session`] — the `claude` subprocess and its reader threads.
//!
//! Tauri-free by the workspace rule, so the app owns event emission and the
//! session registry.

pub mod control;
mod json;
pub mod protocol;
pub mod session;

pub use control::{PermissionDecision, PermissionRequest, Verdict, encode_decision, encode_error};
pub use protocol::{AgentEvent, SlashCommand, encode_user_message, parse_line};
pub use session::{AgentError, AgentOptions, AgentSession, build_args};
