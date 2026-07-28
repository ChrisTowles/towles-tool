//! Black-box tests for `tt collect` (assert_cmd).

mod common;

use common::cli_cmd;
use predicates::prelude::*;
use tempfile::TempDir;

#[test]
fn collect_help_offers_only_nudge() {
    // Pinned so a headless collector can't quietly come back: running the
    // collectors is the app scheduler's job, and a second implementation here
    // is what the 2026-07 trim removed.
    let dir = TempDir::new().unwrap();
    cli_cmd(dir.path()).args(["collect", "--help"]).assert().success().stdout(
        predicate::str::contains("nudge")
            .and(predicate::str::contains("calendar").not())
            .and(predicate::str::contains("issues").not())
            .and(predicate::str::contains("status").not()),
    );
}

#[test]
fn collect_nudge_prs_writes_the_prs_nudge_file() {
    let home = TempDir::new().unwrap();
    let config_dir = home.path().join(".config").join("towles-tool");

    cli_cmd(&config_dir)
        .env("HOME", home.path())
        .env("XDG_DATA_HOME", home.path().join("data"))
        .env("XDG_CONFIG_HOME", home.path().join(".config"))
        .args(["collect", "nudge", "prs"])
        .assert()
        .success();

    let nudge_dir = home.path().join("data").join(tt_config::TOOL_NAME).join("nudge");
    assert!(nudge_dir.join("prs").exists());
    assert!(!nudge_dir.join("issues").exists());
}

#[test]
fn collect_nudge_issues_writes_a_separate_file_from_prs() {
    let home = TempDir::new().unwrap();
    let config_dir = home.path().join(".config").join("towles-tool");

    cli_cmd(&config_dir)
        .env("HOME", home.path())
        .env("XDG_DATA_HOME", home.path().join("data"))
        .env("XDG_CONFIG_HOME", home.path().join(".config"))
        .args(["collect", "nudge", "issues"])
        .assert()
        .success();

    let nudge_dir = home.path().join("data").join(tt_config::TOOL_NAME).join("nudge");
    assert!(nudge_dir.join("issues").exists());
    assert!(!nudge_dir.join("prs").exists());
}

#[test]
fn collect_nudge_without_a_target_fails() {
    let dir = TempDir::new().unwrap();
    cli_cmd(dir.path()).args(["collect", "nudge"]).assert().failure();
}
