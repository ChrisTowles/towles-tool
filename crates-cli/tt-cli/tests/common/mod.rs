#![allow(dead_code)]

use assert_cmd::Command;
use std::ops::{Deref, DerefMut};
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

/// A `tt` child whose `HOME` and XDG dirs are all inside a sandbox, so nothing it
/// writes (state, config, its own `cli.command` telemetry span) reaches the real
/// machine. A command that owns its sandbox keeps the directory alive for as long
/// as the command, which is why callers get this wrapper and not a bare `Command`.
pub struct Tt {
    cmd: Command,
    _home: Option<TempDir>,
}

impl Deref for Tt {
    type Target = Command;
    fn deref(&self) -> &Command {
        &self.cmd
    }
}

impl DerefMut for Tt {
    fn deref_mut(&mut self) -> &mut Command {
        &mut self.cmd
    }
}

/// `tt` with every home pointed inside `home`, and `TT_STATE_SCOPE` forced empty
/// so state paths stay *unscoped* even though the test binary runs from inside a
/// task checkout, whose cwd would otherwise auto-derive a task scope. `HOME` is
/// redirected as well as the XDG vars because macOS ignores the latter.
pub fn tt_in(home: &Path) -> Tt {
    let mut cmd = Command::cargo_bin("tt").expect("binary `tt` should build");
    cmd.env("HOME", home)
        .env("XDG_DATA_HOME", home.join(".local").join("share"))
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .env("XDG_STATE_HOME", home.join(".local").join("state"))
        .env("XDG_CACHE_HOME", home.join(".cache"))
        .env(tt_config::STATE_SCOPE_ENV, "");
    Tt { cmd, _home: None }
}

/// [`tt_in`] with a throwaway home of its own, for tests that never look inside it.
pub fn tt_sandboxed() -> Tt {
    let home = TempDir::new().unwrap();
    let mut tt = tt_in(home.path());
    tt._home = Some(home);
    tt
}

/// [`tt_in`] with `--config-dir` pointed at an isolated config directory.
pub fn cli_cmd_in(config_dir: &Path, home: &Path) -> Tt {
    let mut tt = tt_in(home);
    tt.arg("--config-dir").arg(config_dir);
    tt
}

/// [`tt_sandboxed`] with `--config-dir` pointed at an isolated config directory.
pub fn cli_cmd(config_dir: &Path) -> Tt {
    let mut tt = tt_sandboxed();
    tt.arg("--config-dir").arg(config_dir);
    tt
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
