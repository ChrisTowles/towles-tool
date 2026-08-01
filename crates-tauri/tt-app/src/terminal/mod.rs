//! Embedded terminals: shells in PTYs (portable-pty), terminal state in tt-vt, rendered
//! by the app's canvas terminal view. Many live at once, keyed by a frontend-supplied
//! `term_id`. PTY bytes feed a per-terminal tt-vt engine thread; the frontend receives
//! `terminal://frame` events tagged with `termId`, and input/resize/scroll come back as
//! commands. Shells are owned by the app process — closing it kills them, nothing
//! persists across a restart.
//!
//! Concurrency contract: the [`TermState`] map lock is only ever held for map surgery,
//! never across a PTY write, a subprocess, or a kill/wait. Input goes through a
//! per-terminal channel + writer thread, so a shell that stops reading can only back up
//! its own terminal, and every reader/exit path is generation-checked so a replaced PTY's
//! exit can never close its successor. The tt-vt engine thread is owned by the PTY reader
//! thread; the map holds only a cloneable input sender.
//!
//! The split follows the direction a byte travels, and the modules are `pub` because
//! `lib.rs` names each `#[tauri::command]` by its full path:
//!
//! - [`session`] — the registry, and **the only module that locks the map**. Every
//!   command below reaches a PTY through one of its accessors.
//! - [`spawn`] — standing a PTY up and tearing it down, including the vt event sink
//!   that turns engine events into `terminal://*` events.
//! - [`shell`] — which program to run, and where.
//! - [`input`] — keystrokes, pointer events and pastes, heading toward the shell.
//! - [`view`] — the screen coming back: resize, scroll, selection, search, theme.
//! - [`open_path`] — resolving a path clicked in a terminal, and opening it.

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
