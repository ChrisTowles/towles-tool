//! `tt collect nudge`: poke a running app instance to refresh a collector now.
//!
//! Collecting itself is the app's job — `crates-tauri/tt-app/src/scheduler.rs`
//! runs every collector on its own cadence while the app is open, and the app
//! is also where their health is read (`apps/client/src/lib/collector-health.ts`,
//! via the status bar and Settings). The headless runners that used to live here
//! duplicated that scheduler and had no caller.
//!
//! `nudge` survives because its caller *can't* be the app: the `gh-pr-nudge.sh`
//! PostToolUse hook is a shell script, so a process boundary is the only way it
//! can reach `tt_config`'s scope-aware nudge directory.

use std::path::Path;

use tt_config::now_ms;

use crate::cli::{CollectCommands, NudgeTarget};
use crate::ui;

pub fn run(command: CollectCommands) -> i32 {
    match command {
        CollectCommands::Nudge(args) => run_nudge(args.target, args.trigger.as_deref()),
    }
}

/// Touch one collector's nudge file (creating the dir if needed). The app's
/// scheduler watches this directory and collects `target` immediately on a
/// change — see `crates-tauri/tt-app/src/scheduler.rs`. Content is the
/// timestamp for debuggability; only existence/mtime is ever read.
///
/// Bypasses the store deliberately: this runs inside a Claude Code hook's
/// timeout budget, so it stays a filesystem touch rather than pay to open
/// (and migrate) tt.db.
///
/// Emits `hook.nudge` either way — the only record a `gh pr`/`gh issue`
/// mutation leaves, since those never reach `tt-exec`.
fn run_nudge(target: NudgeTarget, trigger: Option<&str>) -> i32 {
    let dir = match tt_config::nudge_dir_path() {
        Ok(dir) => dir,
        Err(e) => return fail(target, trigger, "resolve_dir_failed", "resolve nudge dir", &e),
    };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return fail(target, trigger, "create_dir_failed", "create nudge dir", &e);
    }
    match std::fs::write(nudge_file(&dir, target), now_ms().to_string()) {
        Ok(()) => {
            tracing::info!(
                nudge_target = target.to_collect().key(),
                trigger,
                outcome = "ok",
                "hook.nudge"
            );
            0
        }
        Err(e) => fail(target, trigger, "write_failed", "write nudge file", &e),
    }
}

/// The file whose mtime the app's scheduler watches for `target`.
fn nudge_file(dir: &Path, target: NudgeTarget) -> std::path::PathBuf {
    dir.join(target.to_collect().file_name())
}

/// Record a failed nudge and report it, returning the exit code.
///
/// One home for the failure shape so every arm emits the same `hook.nudge`
/// event: the hook discards this command's output entirely, which makes the
/// event log the only place a broken nudge is visible at all.
fn fail(
    target: NudgeTarget,
    trigger: Option<&str>,
    outcome: &str,
    action: &str,
    error: &dyn std::fmt::Display,
) -> i32 {
    tracing::info!(
        nudge_target = target.to_collect().key(),
        trigger,
        outcome,
        error = %error,
        "hook.nudge"
    );
    ui::error(&format!("Failed to {action}: {error}"));
    1
}
