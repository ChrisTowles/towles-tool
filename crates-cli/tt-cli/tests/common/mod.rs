#![allow(dead_code)]

use assert_cmd::Command;
use std::path::{Path, PathBuf};
use tempfile::TempDir;

/// A sandbox root spelled the way the tool reports it back. macOS puts tempdirs
/// under `/var`, a symlink to `/private/var`, and both a child's resolved cwd
/// and anything git prints come back resolved — an artifact of the fixture, not
/// of any real checkout, but a path assertion has to compare like with like.
/// The guard comes first: dropping it deletes the directory.
pub fn canonical_temp() -> (TempDir, PathBuf) {
    let guard = TempDir::new().unwrap();
    let path = std::fs::canonicalize(guard.path()).unwrap();
    (guard, path)
}

/// Build a `tt` command pointed at an isolated config directory, with
/// `TT_STATE_SCOPE` forced empty so state paths stay *unscoped* even though the
/// test binary runs from inside a task checkout, whose cwd would otherwise
/// auto-derive a task scope.
pub fn cli_cmd(config_dir: &Path) -> Command {
    let mut cmd = Command::cargo_bin("tt").expect("binary `tt` should build");
    cmd.arg("--config-dir").arg(config_dir);
    cmd.env(tt_config::STATE_SCOPE_ENV, "");
    cmd
}

/// Where a sandboxed child actually writes state. `tt-config` resolves it
/// through `dirs::data_dir`, which follows Apple's layout on macOS and XDG
/// everywhere else, so a fixture that hands over `XDG_DATA_HOME` still has to
/// look where the platform put it.
pub fn data_home(home: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        home.join("Library").join("Application Support")
    } else {
        home.join(".local").join("share")
    }
}

/// Point journal `baseFolder`/`templateDir` inside the sandbox, so journal tests
/// never touch the real home directory.
pub fn write_journal_settings(config_dir: &Path, base_folder: &Path, template_dir: &Path) {
    std::fs::create_dir_all(config_dir).unwrap();
    let settings = serde_json::json!({
        "preferredEditor": "true",
        "journalSettings": {
            "baseFolder": base_folder.to_string_lossy(),
            "templateDir": template_dir.to_string_lossy(),
        },
    });
    let path = config_dir.join(format!("{}.settings.json", tt_config::TOOL_NAME));
    std::fs::write(path, serde_json::to_string_pretty(&settings).unwrap()).unwrap();
}
