//! Telemetry for the `tt` CLI and the desktop app: `tracing` instrumentation
//! plus an event-log sink that streams every span and event to disk as JSONL,
//! and the reader the Telemetry screen uses to read it back. One crate for both
//! halves so writer and reader can never disagree about the on-disk schema.
//!
//! The point is answering questions *later*: "which task spawned that `gh`
//! call, how long did it take, what did it exit with?" should be a `jq` away,
//! not a repro under a debugger. So the sink is always on, flushed, and local.
//!
//! - [`init`] installs the global subscriber — once, early, from a binary,
//!   never a library. Its `fmt` layer keeps the stderr output `-v`/`RUST_LOG`
//!   drive, and its `tracing-log` bridge captures the `log::` macros still in
//!   the tree; [`layer::EventLogLayer`] writes the structured record to
//!   `<data_dir>/telemetry/events-<date>.jsonl`, instance-scoped so each
//!   worktree gets its own log.
//! - **The unscoped path is a trap.** For a process run from a `towles-tool`
//!   checkout, `tt_config::state_scope()` always resolves `<data_dir>` to a
//!   *scoped* directory, never the bare `~/.local/share/towles-tool/telemetry/`
//!   — which exists but stays permanently empty, so checking it by eye reads as
//!   "telemetry is broken". Resolve with `tt_config::telemetry_dir()`.
//! - [`list_days`]/[`read_day`] read those files back for the viewer screen's
//!   Tauri bridge. No cache, and an actively-used checkout has been seen
//!   producing 75,000+ records in a day: the frontend caps *rendered* rows, but
//!   `read_day` still returns the whole file on every focus/refresh. Bounded
//!   reads would be the deeper fix if that cost bites.
//! - [`summarize`] and [`summarize_keyboard`]/[`keyboard_score`] reduce a day
//!   to the Attention and Keyboard tabs' aggregates. They run here rather than
//!   in the frontend precisely because of that size: a few hundred bytes
//!   instead of a day's records crossing IPC on every render.

mod attention;
mod event_log;
mod keyboard;
mod layer;
mod reader;
mod schema;
mod types;

/// Serializes every test in this crate that installs a subscriber to capture
/// records — `layer::tests::capture`, `disk_filter_tests::records_written`,
/// and `reader`'s span test.
///
/// `tracing::subscriber::with_default` is thread-local, but `tracing`'s
/// **callsite-interest cache is global**: the first thread to reach a callsite
/// decides, for every thread, whether it is worth recording. Two of these
/// tests running concurrently can therefore have one evaluate a callsite while
/// the other sits between `with_default` calls with no subscriber installed,
/// caching "never interested" and silently dropping the first one's span. The
/// same race was measured in `tt-exec` (see `spawn_records`): ~1 failure per
/// 60 runs, and zero under `--test-threads=1`.
///
/// One lock per test *binary* is what's needed, so it lives here at the crate
/// root rather than being duplicated per module. Poison-tolerant: one
/// panicking test must fail alone, not cascade.
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
pub use reader::{list_days, read_day};
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
/// `warn`.
///
/// The scoping is load-bearing, not tidiness. `tracing-subscriber` is built
/// with the `tracing-log` feature, so an unscoped `debug` sink would bridge in
/// every `log::debug!` from the dependency tree (hyper, tao, wry, rusqlite,
/// tokio-tungstenite) and write *and flush* each one. That is unbounded volume
/// uncorrelated with anything this log exists to answer, and it would falsify
/// the assumption [`EventLog`] relies on to justify flushing every record.
///
/// Third-party `warn`/`error` still lands, because a dependency complaining is
/// exactly the kind of thing worth having already captured.
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
///
/// `tt.task` is the load-bearing one: several checkouts of this repo run
/// concurrently, so a record is only interpretable if it says which one
/// produced it. `tt.build_sha` (from `build.rs`) is what makes a record
/// attributable to a commit — the same fix can be absent from one running
/// binary and present in another.
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
/// `default_level` is the stderr filter used when `RUST_LOG` is unset — the
/// `-v` count maps onto it. The disk sink is deliberately *not* filtered by
/// `RUST_LOG`: it always records our own crates at `DEBUG` (see
/// [`DISK_FILTER`]), because the whole value of an event log is having the
/// detail already captured when a question comes up. A quiet terminal should
/// not mean a useless log.
///
/// Returns [`Error::AlreadyInitialized`] rather than panicking if called twice.
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
        // The frontend action seam (`tt-app`'s `ui_action` command) emits at
        // info under tt-app's own target, which `tt_app=debug` covers by
        // prefix. Pinned because the sink's default is `warn`: an action seam
        // that moved to a non-`tt_*` target would be silently swallowed, and a
        // silent event log is worse than no event log.
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
