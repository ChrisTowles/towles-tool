//! Chrome as a supervised child process for the browser pane: find the
//! binary, launch it headless on a persistent app-owned profile, drive it
//! over CDP. Tauri-free per the workspace rule.
//!
//! The pane never touches platform windowing — pixels arrive as CDP frames
//! (`frames`), input goes back as CDP dispatch calls — so one implementation
//! serves Linux and macOS. The profile is the app's own and starts empty:
//! the feature is login *persistence*, never an import of the user's
//! personal Chrome profile (docs/BROWSER-PANE.md).

pub mod cdp;
pub mod frames;
pub mod launch;

pub use cdp::{CdpConn, CdpEvent};
pub use frames::{BrowserFrame, Poller, handle_screencast_event};
pub use launch::{ChromeChild, ChromeConfig, find_chrome};

#[derive(Debug, thiserror::Error)]
pub enum BrowserError {
    #[error("no Chrome or Chromium binary found (set a path in Settings → Agentboard)")]
    NoBinary,
    #[error("chrome exited during startup: {0}")]
    StartupExit(String),
    #[error("devtools endpoint never appeared: {0}")]
    Startup(String),
    #[error("cdp: {0}")]
    Cdp(String),
    #[error("cdp connection closed")]
    Closed,
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}
