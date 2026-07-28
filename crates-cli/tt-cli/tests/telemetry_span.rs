//! Every `tt` invocation must leave a `cli.command` record in the event log.
//!
//! Linux-only: the isolation relies on `dirs::data_dir()` honouring
//! `XDG_DATA_HOME`, which it does on XDG platforms but not on macOS — where the
//! test would write into the real data directory instead of the sandbox.
#![cfg(target_os = "linux")]

mod common;

use common::cli_cmd;
use serde_json::Value;
use std::path::Path;

/// Point a `tt` command at a sandboxed data directory, so its event log is the
/// only one this test can see or write.
fn cmd_with_log(config_dir: &Path, data_home: &Path) -> assert_cmd::Command {
    let mut cmd = cli_cmd(config_dir);
    cmd.env("XDG_DATA_HOME", data_home);
    cmd
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
    let sandbox = tempfile::tempdir().unwrap();
    let config_dir = sandbox.path().join("config");
    let data_home = sandbox.path().join("data");

    cmd_with_log(&config_dir, &data_home).args(["journal", "list"]).assert().success();

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
    let sandbox = tempfile::tempdir().unwrap();
    let config_dir = sandbox.path().join("config");
    let data_home = sandbox.path().join("data");
    let not_a_repo = sandbox.path().join("not-a-repo");
    std::fs::create_dir_all(&not_a_repo).unwrap();

    cmd_with_log(&config_dir, &data_home)
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
    let sandbox = tempfile::tempdir().unwrap();
    let config_dir = sandbox.path().join("config");
    let data_home = sandbox.path().join("data");
    let secret = "moondust-rutabaga-77";

    cmd_with_log(&config_dir, &data_home).args(["journal", "search", secret]).assert().success();

    let dir = data_home.join(tt_config::TOOL_NAME).join("telemetry");
    let logged: String = std::fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .map(|entry| std::fs::read_to_string(entry.path()).unwrap_or_default())
        .collect();
    assert!(logged.contains("cli.command"), "the invocation must still be recorded");
    assert!(!logged.contains(secret), "the search term must not reach the event log");
}
