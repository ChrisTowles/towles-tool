//! `tt task nudge`: poke the app instance that owns this terminal into
//! refreshing a collector now.
//! This survives as a CLI command because its caller *can't* be the app: the
//! `gh-pr-nudge.sh` PostToolUse hook is a shell script, so a process boundary is
//! the only way it can reach `tt_config`'s shared nudge directory.

use tt_config::now_ms;

use crate::cli::NudgeArgs;
use crate::ui;

/// Touch `target`'s nudge file, naming the caller's session so only the app
/// instance that owns this terminal acts on it — every instance watches the same
/// machine-global dir — plus the cwd and trigger, so it sweeps only what changed. Bypasses the store deliberately: this runs inside a Claude
/// Code hook's timeout budget, so it stays a filesystem touch rather than pay to
/// open (and migrate) tt.db.
pub fn run(args: NudgeArgs) -> i32 {
    let target = args.target.to_collect();
    let session = std::env::var(tt_agentboard::procenv::TT_SESSION_ENV).ok();
    let trigger = args.trigger.as_deref();

    if args.only_if_tracked && !admits(session.as_deref()) {
        tracing::info!(
            nudge_target = target.key(),
            session = "-",
            trigger,
            outcome = "not_tracked",
            "hook.nudge"
        );
        return 0;
    }

    let dir = match tt_config::nudge_dir_path() {
        Ok(dir) => dir,
        Err(e) => return fail(target, session.as_deref(), trigger, "resolve_dir_failed", &e),
    };
    let note = tt_collect::nudge::Note {
        session: session.clone(),
        origin: std::env::current_dir().ok(),
        trigger: trigger.map(str::to_string),
    };
    match tt_collect::nudge::write(&dir, target, &note, now_ms()) {
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

/// Whether any app instance would act on a nudge from here: the terminal was
/// spawned by one, or the cwd sits under a repo on the rail (longest-prefix, so
/// a worktree resolves to its owner). The hook calling this is enabled globally
/// and the nudge dir is machine-global, so without it one `gh pr create` in an
/// unrelated project makes every open window sweep `gh`.
fn admits(session: Option<&str>) -> bool {
    if session.is_some() {
        return true;
    }
    let Ok(cwd) = std::env::current_dir() else {
        return false;
    };
    let repos = tt_agentboard::repos::load_repos(&tt_agentboard::repos::default_repos_path());
    let entries = tt_agentboard::repos::repo_entries(&repos);
    tt_agentboard::repos::resolve_repo_dir(&cwd.to_string_lossy(), &entries).is_some()
}

/// Record a failed nudge and report it, returning the exit code.
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
