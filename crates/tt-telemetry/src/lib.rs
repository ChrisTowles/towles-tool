//! Telemetry for the `tt` CLI and the desktop app: `tracing` instrumentation, an
//! event-log sink streaming every span and event to disk as JSONL, and the reader the
//! Telemetry screen uses — one crate, so writer and reader can't disagree about the
//! on-disk schema. Always on and local, so questions are answerable *later*.
//!
//! - [`init`] installs the global subscriber, once, early, from a binary; its `fmt`
//!   layer keeps stderr `-v`/`RUST_LOG`-driven and [`layer::EventLogLayer`] writes to
//!   `<data_dir>/telemetry/events-<date>.jsonl`, instance-scoped per worktree.
//! - **The unscoped path is a trap.** From a checkout `<data_dir>` always resolves to a
//!   *scoped* directory; the bare `~/.local/share/towles-tool/telemetry/` exists but
//!   stays empty, so checking it by eye reads as "telemetry is broken". Use
//!   `telemetry_dir()`.
//! - [`list_days`]/[`read_day`]/[`read_days`] read them back uncached; [`summarize`] and
//!   [`keyboard_score`] aggregate in Rust, since a day can hold 75,000+ records, and
//!   [`query`] answers ad-hoc SQL over a fortnight of them.

mod attention;
mod event_log;
mod keyboard;
mod layer;
pub mod query;
mod reader;
mod schema;
mod types;

/// Serializes every test in this crate that installs a subscriber to capture
/// records. `with_default` is thread-local, but `tracing`'s **callsite-interest
/// cache is global**: run two concurrently and one caches "never interested"
/// while the other has no subscriber installed, dropping the first's span. One
/// lock per test *binary* is needed, hence the crate root; poison-tolerant.
#[cfg(test)]
pub(crate) fn serialize_subscriber_tests() -> std::sync::MutexGuard<'static, ()> {
    static SUBSCRIBER: std::sync::Mutex<()> = std::sync::Mutex::new(());
    SUBSCRIBER.lock().unwrap_or_else(|e| e.into_inner())
}

pub use attention::{
    ActionSummary, AttentionSummary, Count, ExecutableStat, FocusSession, FocusSummary, HourBucket,
    MachineSummary, NotificationSummary, summarize,
};
pub use event_log::EventLog;
pub use keyboard::{
    GOAL_MIN_ACTIONS, GOAL_SHARE, KeyboardDay, KeyboardScore, ShortcutSplit, keyboard_score,
    summarize_keyboard,
};
pub use layer::EventLogLayer;
pub use reader::{list_days, read_day, read_days, recent_days};
pub use types::TelemetryRecord;

use serde_json::{Map, Value};
use thiserror::Error;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::prelude::*;

/// Days of event-log history kept before rotation prunes a file.
const RETAIN_DAYS: usize = 14;

/// Set to `0`/`false` to skip the disk sink entirely (stderr logging still
/// works). For contexts that must not write state at all.
const DISABLE_ENV: &str = "TT_TELEMETRY";

/// Filter for the disk sink: our own crates at `debug`, everything else at
/// `warn`. The scoping is load-bearing — with the `tracing-log` feature on, an
/// unscoped `debug` sink bridges in every dependency's `log::debug!` and
/// flushes each one, falsifying the assumption [`EventLog`] relies on.
const DISK_FILTER: &str = "warn,tt=debug,tt_agentboard=debug,tt_app=debug,tt_cli=debug,\
                           tt_collect=debug,tt_config=debug,tt_exec=debug,tt_git=debug,\
                           tt_ide=debug,tt_journal=debug,tt_mcp=debug,tt_telemetry=debug,\
                           tt_tasks=debug,tt_store=debug,tt_update=debug,tt_vt=debug";

#[derive(Debug, Error)]
pub enum Error {
    #[error("Failed to resolve the telemetry directory: {0}")]
    Dir(#[from] tt_config::Error),

    #[error("A global tracing subscriber is already installed")]
    AlreadyInitialized,

    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Whether the disk sink is switched off by [`DISABLE_ENV`].
fn disk_sink_disabled() -> bool {
    std::env::var(DISABLE_ENV).is_ok_and(|value| matches!(value.trim(), "0" | "false"))
}

/// Resource attributes stamped on every record, in OpenTelemetry naming.
/// `tt.task` and `tt.build_sha` are the load-bearing pair: several checkouts
/// run concurrently at different commits, so a record is only interpretable if
/// it names which binary produced it.
fn resource(service: &str) -> Map<String, Value> {
    let mut attrs = Map::new();
    let [service_name, service_version, process_pid] = schema::RESOURCE_KEYS else {
        unreachable!("RESOURCE_KEYS is a fixed 3-element array")
    };
    attrs.insert(service_name.to_string(), Value::from(service));
    attrs.insert(service_version.to_string(), Value::from(env!("CARGO_PKG_VERSION")));
    attrs.insert(process_pid.to_string(), Value::from(std::process::id()));
    attrs.insert(
        schema::FIELD_TT_TASK.into(),
        match tt_config::state_scope() {
            Some(scope) => Value::from(scope),
            None => Value::Null,
        },
    );
    attrs.insert(schema::FIELD_TT_BUILD_SHA.into(), Value::from(env!("TT_BUILD_SHA")));
    attrs
}

/// Install the global subscriber for `service` (`"tt"`, `"tt-app"`, …).
///
/// `default_level` is the stderr filter used when `RUST_LOG` is unset. The disk
/// sink is deliberately *not* filtered by `RUST_LOG` (see [`DISK_FILTER`]): a
/// quiet terminal should not mean a useless log. Returns
/// [`Error::AlreadyInitialized`] rather than panicking if called twice.
pub fn init(service: &str, default_level: &str) -> Result<()> {
    let stderr_filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(default_level));

    let disk = if disk_sink_disabled() {
        None
    } else {
        let dir = tt_config::telemetry_dir()?;
        Some(
            EventLogLayer::new(EventLog::new(dir, RETAIN_DAYS), resource(service))
                .with_filter(EnvFilter::new(DISK_FILTER)),
        )
    };

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(std::io::stderr)
                .with_filter(stderr_filter),
        )
        .with(disk)
        .try_init()
        .map_err(|_| Error::AlreadyInitialized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_names_the_service_and_process() {
        let attrs = resource("tt");
        assert_eq!(attrs["service.name"], "tt");
        assert_eq!(attrs["process.pid"], Value::from(std::process::id()));
        assert!(attrs.contains_key("tt.task"), "every record must be attributable to a task");
        assert!(
            attrs.contains_key("tt.build_sha"),
            "every record must be attributable to the commit it was built from"
        );
    }
}

#[cfg(test)]
mod disk_filter_tests {
    use super::*;
    use tracing_subscriber::Layer;

    /// Run `body` under a `DISK_FILTER`-scoped EventLogLayer; return the number
    /// of records that reached disk.
    fn records_written(body: impl FnOnce()) -> usize {
        let _serialized = crate::serialize_subscriber_tests();
        let dir = tempfile::tempdir().unwrap();
        let layer = EventLogLayer::new(EventLog::new(dir.path(), 7), Map::new())
            .with_filter(EnvFilter::new(DISK_FILTER));
        tracing::subscriber::with_default(tracing_subscriber::registry().with(layer), body);
        std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| std::fs::read_to_string(e.path()).unwrap_or_default().lines().count())
            .sum()
    }

    #[test]
    fn first_party_debug_reaches_disk() {
        let n = records_written(|| tracing::debug!(target: "tt_exec", "a subprocess span"));
        assert_eq!(n, 1, "our own crates must be recorded at debug");
    }

    #[test]
    fn third_party_debug_is_dropped() {
        // The whole reason the filter is scoped: an unscoped debug sink bridges
        // in every dependency's log::debug! and writes+flushes each one.
        let n = records_written(|| {
            tracing::debug!(target: "hyper::client", "connection reused");
            tracing::debug!(target: "tao::platform_impl", "event loop tick");
        });
        assert_eq!(n, 0, "dependency debug chatter must never reach the event log");
    }

    #[test]
    fn ui_action_events_reach_disk() {
        // Pinned because the sink's default is `warn`: an action seam that moved
        // to a non-`tt_*` target would be silently swallowed.
        let n = records_written(|| {
            tracing::info!(target: "tt_app_lib", action = "repo.icon_set", screen = "settings", "ui.action");
        });
        assert_eq!(n, 1, "user actions must reach the event log");
    }

    #[test]
    fn third_party_warnings_still_reach_disk() {
        let n = records_written(|| tracing::warn!(target: "hyper::client", "pool exhausted"));
        assert_eq!(n, 1, "a dependency complaining is worth having captured");
    }
}
