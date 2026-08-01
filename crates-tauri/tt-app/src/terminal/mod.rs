//! Embedded terminals: shells in PTYs (portable-pty), terminal state in tt-vt, rendered
//! by the app's canvas terminal view. Many live at once, keyed by a frontend-supplied
//! `term_id`. PTY bytes feed a per-terminal tt-vt engine thread; the frontend receives
//! `terminal://frame` events tagged with `termId`, and input/resize/scroll come back as
//! commands. Shells are owned by the app process — closing it kills them, nothing
//! persists across a restart.
//!
//! Concurrency contract: the [`TermState`] map lock is only ever held for map
//! surgery, never across a PTY write, a subprocess, or a kill/wait. Input goes
//! through a per-terminal channel + writer thread, and every reader/exit path is
//! generation-checked so a replaced PTY's exit can't close its successor.
//!
//! Split by the direction a byte travels: [`spawn`] → [`input`] → [`view`], over
//! [`session`], which is **the only module that locks the map**. The modules are
//! `pub` because `lib.rs` names each command by its full path.

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

/// Terminal events are addressed to the one window rather than broadcast.
const MAIN_WINDOW_LABEL: &str = "main";
