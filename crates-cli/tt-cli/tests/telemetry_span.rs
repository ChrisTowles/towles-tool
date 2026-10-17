//! Every `tt` invocation must leave a `cli.command` record in the event log.

mod common;

use common::{cli_cmd_in, data_home};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// A sandboxed home for one test, plus the data directory a child of it logs under.
fn sandbox() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let guard = tempfile::tempdir().unwrap();
    let home = guard.path().join("home");
    let data = data_home(&home);
    (guard, home, data)
}

/// Every `cli.command` record written under `data_home`, oldest first.
fn cli_records(data_home: &Path) -> Vec<Value> {
    let dir = data_home.join(tt_config::TOOL_NAME).join("telemetry");
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("no telemetry dir at {}: {e}", dir.display()))
        .flatten()
        .map(|entry| entry.path())
        .collect();
    files.sort();
    files
        .iter()
        .flat_map(|path| {
            std::fs::read_to_string(path)
                .unwrap_or_default()
                .lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .filter(|record| record["name"] == "cli.command")
                .collect::<Vec<_>>()
        })
        .collect()
}

#[test]
fn a_successful_command_is_recorded() {
    let (sandbox, home, data_home) = sandbox();
    let config_dir = sandbox.path().join("config");

    cli_cmd_in(&config_dir, &home).args(["journal", "list"]).assert().success();

    let records = cli_records(&data_home);
    let record = records.first().expect("the invocation must leave a record");
    assert_eq!(record["cli.group"], "journal");
    assert_eq!(record["cli.subcommand"], "list");
    assert_eq!(record["outcome"], "ok");
    assert_eq!(record["exit_code"], 0);
    assert!(record["duration_ms"].is_number(), "a closed span carries its duration");
}

#[test]
fn a_failing_command_is_recorded_too() {
    // The regression this pins: a non-zero exit leaves `main` through
    // `process::exit`, which runs no destructors. Open the span across that call
    // and every *failing* command goes unlogged — the half of the record that
    // matters most for "which surface is giving trouble?".
    let (sandbox, home, data_home) = sandbox();
    let config_dir = sandbox.path().join("config");
    let not_a_repo = sandbox.path().join("not-a-repo");
    std::fs::create_dir_all(&not_a_repo).unwrap();

    cli_cmd_in(&config_dir, &home)
        .args(["task", "env", "some-task", "--root"])
        .arg(&not_a_repo)
        .assert()
        .failure();

    let records = cli_records(&data_home);
    let record = records.first().expect("a failing invocation must leave a record too");
    assert_eq!(record["cli.group"], "task");
    assert_eq!(record["cli.subcommand"], "env");
    assert_eq!(record["outcome"], "error");
    assert_ne!(record["exit_code"], 0);
}

#[test]
fn operands_never_reach_the_log() {
    // The event log is plaintext and excludes user content by rule, so the
    // record names the command and nothing the user typed after it.
    let (sandbox, home, data_home) = sandbox();
    let config_dir = sandbox.path().join("config");
    let secret = "moondust-rutabaga-77";

    cli_cmd_in(&config_dir, &home).args(["journal", "search", secret]).assert().success();

    let dir = data_home.join(tt_config::TOOL_NAME).join("telemetry");
    let logged: String = std::fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .map(|entry| std::fs::read_to_string(entry.path()).unwrap_or_default())
        .collect();
    assert!(logged.contains("cli.command"), "the invocation must still be recorded");
    assert!(!logged.contains(secret), "the search term must not reach the event log");
}
