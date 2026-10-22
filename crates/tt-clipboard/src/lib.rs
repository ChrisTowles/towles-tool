//! Clipboard history for Wayland: a watcher that records every selection into a
//! SQLite store, search over it, and a picker that copies an entry back.
//!
//! Selection semantics (which mime to keep, password hints, dedup-to-front) follow
//! [Ringboard](https://github.com/SUPERCILEX/clipboard-history); see ATTRIBUTION.md.

pub mod cliphist;
pub mod mime;
#[cfg(target_os = "linux")]
pub mod picker;
pub mod query;
pub mod store;
pub mod thumb;
#[cfg(target_os = "linux")]
pub mod wayland;

pub use store::{Entry, Kind, Store, Summary};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Config(#[from] tt_config::Error),
    #[error(transparent)]
    Exec(#[from] tt_exec::Error),
    #[error("wayland: {0}")]
    Wayland(String),
    #[error("the compositor has no ext_data_control_manager_v1 (clipboard access)")]
    NoDataControl,
    #[error("another `tt-clip watch` is already running")]
    AlreadyRunning,
    #[error("no entry {0}")]
    NotFound(i64),
    #[error("picker: {0}")]
    Picker(String),
}

pub type Result<T> = std::result::Result<T, Error>;
