//! Personal Slack agents: named Claude Code sessions Chris addresses as `@name` in one
//! Slack conversation. Everything here is pure or plain file I/O — routing a message to
//! an agent, debouncing bursts, the locked-down `claude -p` argv, the reply contract and
//! the agent's folder. `tt-app` owns the sockets, processes and timers.
//!
//! The trust model, in one place: only Chris's own messages route ([`route`]), every
//! turn runs `claude --restricted` with prompts auto-denied and an explicit tool list
//! ([`Turn::argv`]), and the only things a turn can do outside its own folder are the
//! two fields of [`Reply`].

mod batch;
mod route;
mod run;
mod state;
mod turn;

pub use batch::Batcher;
pub use route::{Ignored, Inbound, Route, route};
pub use run::{Job, KEEP_ENV, execute};
pub use state::{memory_hash, read_memory, seed_state_dir, state_dir};
pub use turn::{
    BASE_TOOLS, Error, REPLY_SCHEMA, Remind, Reply, Turn, TurnInput, TurnResult, parse_turn,
    render_system_prompt, render_turn_prompt, slack_error, slack_text,
};
