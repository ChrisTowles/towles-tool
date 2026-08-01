//! Which program a terminal runs, and where it starts. Pure functions over the
//! environment, so every branch is unit-testable without a PTY.

use std::path::{Path, PathBuf};

/// Env var that names the user's preferred shell: `$SHELL` on Unix,
/// `%COMSPEC%` on Windows (there's no `$SHELL` equivalent there).
#[cfg(windows)]
pub(super) const SHELL_ENV_VAR: &str = "COMSPEC";
#[cfg(not(windows))]
pub(super) const SHELL_ENV_VAR: &str = "SHELL";

pub(super) fn default_shell(shell_env: Option<String>) -> String {
    shell_env.filter(|s| !s.trim().is_empty()).unwrap_or_else(fallback_shell)
}

/// `powershell.exe` on Windows (resolved via PATH; ships on every supported
/// Windows version), `/bin/bash` elsewhere.
#[cfg(windows)]
fn fallback_shell() -> String {
    "powershell.exe".to_string()
}
#[cfg(not(windows))]
fn fallback_shell() -> String {
    "/bin/bash".to_string()
}

/// The shell's display name from its resolved program path — `/usr/bin/zsh`
/// -> "zsh", `powershell.exe` -> "powershell".
pub(super) fn shell_kind_from_path(shell: &str) -> String {
    let base = Path::new(shell).file_name().and_then(|s| s.to_str()).unwrap_or(shell);
    base.strip_suffix(".exe").unwrap_or(base).to_string()
}

/// Resolve the shell's working directory: the requested `cwd` if it exists,
/// otherwise the user's home. `None` lets portable-pty inherit the app's cwd.
pub(super) fn start_dir(cwd: Option<String>) -> Option<PathBuf> {
    if let Some(dir) = cwd.filter(|d| !d.trim().is_empty())
        && Path::new(&dir).is_dir()
    {
        return Some(dir.into());
    }
    dirs::home_dir()
}

#[cfg(test)]
mod tests {
    use super::{default_shell, shell_kind_from_path, start_dir};

    #[test]
    fn prefers_shell_env() {
        assert_eq!(default_shell(Some("/usr/bin/zsh".into())), "/usr/bin/zsh");
    }

    #[test]
    fn shell_kind_strips_dir_and_exe_suffix() {
        assert_eq!(shell_kind_from_path("/usr/bin/zsh"), "zsh");
        assert_eq!(shell_kind_from_path("/bin/bash"), "bash");
        assert_eq!(shell_kind_from_path("powershell.exe"), "powershell");
        assert_eq!(shell_kind_from_path("fish"), "fish");
    }

    #[test]
    fn falls_back_to_platform_default() {
        let expected = super::fallback_shell();
        assert_eq!(default_shell(None), expected);
        assert_eq!(default_shell(Some("  ".into())), expected);
    }

    #[test]
    fn start_dir_uses_existing_path() {
        let tmp = std::env::temp_dir();
        assert_eq!(start_dir(Some(tmp.to_string_lossy().into_owned())), Some(tmp));
    }

    #[test]
    fn start_dir_falls_back_to_home_for_missing_path() {
        // A path that does not exist must not be used; we fall back to home.
        assert_eq!(start_dir(Some("/no/such/dir/xyz".into())), dirs::home_dir());
        assert_eq!(start_dir(Some("   ".into())), dirs::home_dir());
        assert_eq!(start_dir(None), dirs::home_dir());
    }
}
