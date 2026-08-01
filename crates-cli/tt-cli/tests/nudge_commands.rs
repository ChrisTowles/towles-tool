//! Black-box tests for `tt task nudge` (assert_cmd).

mod common;

use common::cli_cmd;
use predicates::prelude::*;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

/// A sandboxed `tt task nudge <target>`, with the caller's session either stamped
/// or explicitly absent. `env_remove` is load-bearing: these tests inherit the
/// environment of whatever ran them, and a session started from an app terminal
/// already has a real `TT_SESSION_ID` that would leak into the "no session" cases.
fn nudge(home: &Path, target: &str, session: Option<&str>) -> assert_cmd::Command {
    let mut cmd = cli_cmd(&home.join(".config").join("towles-tool"));
    cmd.env("HOME", home)
        .env("XDG_DATA_HOME", home.join("data"))
        .env("XDG_CONFIG_HOME", home.join(".config"));
    match session {
        Some(id) => cmd.env("TT_SESSION_ID", id),
        None => cmd.env_remove("TT_SESSION_ID"),
    };
    cmd.args(["task", "nudge", target]);
    cmd
}

fn nudge_dir(home: &Path) -> PathBuf {
    home.join("data").join(tt_config::TOOL_NAME).join("nudge")
}

#[test]
fn task_help_lists_nudge_and_collect_is_gone() {
    // Pinned so the group can't drift back: `collect` was retired, and a
    // renamed subcommand fails *silently* in the hook that calls it.
    let dir = TempDir::new().unwrap();
    cli_cmd(dir.path())
        .args(["task", "--help"])
        .assert()
        .success()
        .stdout(predicate::str::contains("nudge"));
    cli_cmd(dir.path()).args(["collect", "nudge", "prs"]).assert().failure();
}

#[test]
fn nudge_prs_writes_only_the_prs_note() {
    let home = TempDir::new().unwrap();
    nudge(home.path(), "prs", Some("sess-1")).assert().success();

    assert!(nudge_dir(home.path()).join("prs").exists());
    assert!(!nudge_dir(home.path()).join("issues").exists());
}

#[test]
fn nudge_issues_writes_a_separate_file_from_prs() {
    let home = TempDir::new().unwrap();
    nudge(home.path(), "issues", Some("sess-1")).assert().success();

    assert!(nudge_dir(home.path()).join("issues").exists());
    assert!(!nudge_dir(home.path()).join("prs").exists());
}

#[test]
fn a_nudge_names_the_calling_session() {
    // The whole point of the routing: the app instance that owns this terminal
    // acts, and the others leave the `gh` sweep alone.
    let home = TempDir::new().unwrap();
    nudge(home.path(), "prs", Some("sess-abc")).assert().success();

    let note = std::fs::read_to_string(nudge_dir(home.path()).join("prs")).unwrap();
    assert_eq!(tt_collect::nudge::session_in(&note), Some("sess-abc"));
}

#[test]
fn a_nudge_from_outside_an_app_terminal_names_nobody() {
    // Claude Code started outside the app has no `TT_SESSION_ID`; the note must
    // still be written, and must read as "every instance acts".
    let home = TempDir::new().unwrap();
    nudge(home.path(), "prs", None).assert().success();

    let note = std::fs::read_to_string(nudge_dir(home.path()).join("prs")).unwrap();
    assert_eq!(tt_collect::nudge::session_in(&note), None);
}

#[test]
fn nudge_without_a_target_fails() {
    let dir = TempDir::new().unwrap();
    cli_cmd(dir.path()).args(["task", "nudge"]).assert().failure();
}

#[test]
fn a_nudge_from_inside_a_checkout_still_lands_in_the_machine_global_dir() {
    // The regression that ate real nudges: the writer runs wherever the `gh`
    // mutation happened while the app watches a single dir, so any cwd-derived
    // scoping splits the two. `env_remove` (not the forced-empty scope `cli_cmd`
    // sets) is the point: this exercises the ambient-cwd path from inside a fake
    // checkout that would previously have derived a scope.
    let home = TempDir::new().unwrap();
    let checkout = home.path().join("repo");
    std::fs::create_dir_all(checkout.join("crates").join("tt-config")).unwrap();

    let mut cmd = nudge(home.path(), "prs", Some("sess-1"));
    cmd.env_remove(tt_config::STATE_SCOPE_ENV).current_dir(&checkout);
    cmd.assert().success();

    assert!(nudge_dir(home.path()).join("prs").exists());
    let scoped = home
        .path()
        .join("data")
        .join(tt_config::TOOL_NAME)
        .join("tasks")
        .join("repo")
        .join("nudge");
    assert!(!scoped.exists(), "a cwd-derived scope would split writer from watchers");
}

#[test]
fn a_forced_scope_still_isolates_the_nudge_dir() {
    // e2e runs force `TT_STATE_SCOPE` so their nudges never wake the real app.
    let home = TempDir::new().unwrap();
    let mut cmd = nudge(home.path(), "prs", Some("sess-1"));
    cmd.env(tt_config::STATE_SCOPE_ENV, "e2e-sandbox");
    cmd.assert().success();

    let forced = home
        .path()
        .join("data")
        .join(tt_config::TOOL_NAME)
        .join("tasks")
        .join("e2e-sandbox")
        .join("nudge");
    assert!(forced.join("prs").exists());
    assert!(!nudge_dir(home.path()).exists());
}
