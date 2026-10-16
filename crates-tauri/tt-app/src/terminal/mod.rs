//! Embedded terminals: shells in PTYs (portable-pty), terminal state in tt-vt, rendered
//! by the app's canvas terminal view. Many live at once, keyed by a frontend-supplied
//! `term_id`; input, resize and scroll come back as commands. Shells die with the app.
//!
//! Concurrency contract: the [`TermState`] map lock is only ever held for map
//! surgery, never across a PTY write, a subprocess, or a kill/wait. Input goes
//! through a per-terminal channel + writer thread, and every reader/exit path is
//! generation-checked so a replaced PTY's exit can't close its successor.
//! [`session`] is the only module that locks the map.

pub mod input;
pub mod open_path;
pub mod session;
pub mod shell;
pub mod spawn;
pub mod view;

pub use session::{PtyEmitState, TermState};
pub use spawn::on_window_destroyed;

pub const FRAME_EVENT: &str = "terminal://frame";
pub const EXIT_EVENT: &str = "terminal://exit";
pub const NOTIFY_EVENT: &str = "terminal://notify";

const MAIN_WINDOW_LABEL: &str = "main";
