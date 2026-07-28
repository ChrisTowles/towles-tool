//! `tt task nudge`: poke the app instance that owns this terminal into
//! refreshing a collector now.
//!
//! Collecting itself is the app's job — `crates-tauri/tt-app/src/scheduler.rs`
//! runs every collector on its own cadence while the app is open, and the app
//! is also where their health is read (`apps/client/src/lib/collector-health.ts`,
//! via the status bar and Settings).
//!
//! This survives as a CLI command because its caller *can't* be the app: the
//! `gh-pr-nudge.sh` PostToolUse hook is a shell script, so a process boundary is
//! the only way it can reach `tt_config`'s scope-aware nudge directory.

use tt_config::now_ms;

use crate::cli::NudgeArgs;
use crate::ui;

/// Touch `target`'s nudge file, naming the caller's session so only the app
/// instance that owns this terminal acts on it — every checkout's app watches
/// the same dir. See CLAUDE.md's `tt-cli` bullet for the routing.
///
/// Bypasses the store deliberately: this runs inside a Claude Code hook's
/// timeout budget, so it stays a filesystem touch rather than pay to open
/// (and migrate) tt.db.
pub fn run(args: NudgeArgs) -> i32 {
    let target = args.target.to_collect();
    let session = std::env::var(tt_agentboard::procenv::TT_SESSION_ENV).ok();
    let trigger = args.trigger.as_deref();

    let dir = match tt_config::nudge_dir_path() {
        Ok(dir) => dir,
        Err(e) => return fail(target, session.as_deref(), trigger, "resolve_dir_failed", &e),
    };
    match tt_collect::nudge::write(&dir, target, session.as_deref(), now_ms()) {
        Ok(()) => {
            tracing::info!(
                nudge_target = target.key(),
                session = session.as_deref().unwrap_or("-"),
                trigger,
                outcome = "ok",
                "hook.nudge"
            );
            0
        }
        Err(e) => fail(target, session.as_deref(), trigger, "write_failed", &e),
    }
}

/// Record a failed nudge and report it, returning the exit code.
///
/// One home for the failure shape so every arm emits the same `hook.nudge`
/// event: the hook discards this command's output entirely, which makes the
/// event log the only place a broken nudge is visible at all.
fn fail(
    target: tt_collect::NudgeTarget,
    session: Option<&str>,
    trigger: Option<&str>,
    outcome: &str,
    error: &dyn std::fmt::Display,
) -> i32 {
    tracing::info!(
        nudge_target = target.key(),
        session = session.unwrap_or("-"),
        trigger,
        outcome,
        error = %error,
        "hook.nudge"
    );
    ui::error(&format!("Failed to nudge {}: {error}", target.key()));
    1
}
