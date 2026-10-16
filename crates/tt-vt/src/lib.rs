//! Terminal state on libghostty-vt.
//!
//! Building this crate compiles libghostty-vt from source at the Rust
//! binding's pinned ghostty commit and needs `zig` 0.15.x on PATH
//! (dotfiles `functions/18-zig.sh`).

pub mod engine;
pub mod frame;
pub mod keymap;
pub mod osc52;
pub mod osc_color;
pub mod osc_notify;
pub mod search;
pub mod session;
pub mod unwrap;

pub use engine::{
    Engine, EngineOptions, KeyAction, KeyEvent, MouseAction, MouseButton, MouseInput, PasteOutcome,
    Pointer, Select, Theme, VtError,
};
pub use frame::{Frame, Modes};
pub use search::SearchMatch;
pub use session::{Event, Input, Sender, Session, SpawnError};

/// The Zig optimize mode the linked libghostty-vt parser was compiled with, or
/// `"unknown"` if the query fails. A Debug parser is ~3 orders of magnitude
/// slower — it saturates a core at ~130 KB/s of PTY output — which the
/// `[profile.dev.package.libghostty-vt-sys]` override exists to prevent. Doctor
/// surfaces this so losing that override shows up as a warning rather than
/// months of mystery lag.
pub fn parser_optimize_mode() -> &'static str {
    use libghostty_vt::build_info::OptimizeMode;
    match libghostty_vt::build_info::optimize_mode() {
        Ok(OptimizeMode::Debug) => "Debug",
        Ok(OptimizeMode::ReleaseSafe) => "ReleaseSafe",
        Ok(OptimizeMode::ReleaseSmall) => "ReleaseSmall",
        Ok(OptimizeMode::ReleaseFast) => "ReleaseFast",
        Err(_) => "unknown",
    }
}

#[cfg(test)]
mod tests;
