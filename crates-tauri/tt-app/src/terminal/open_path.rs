//! Turning a path clicked in a terminal into a file on disk, and opening it.
//!
//! Two things make this harder than joining strings. A pane's `cwd` is only the
//! right root until its shell `cd`s elsewhere, so the live directories a session
//! reports ([`TermState::open_base_dirs`]) are tried as fallbacks — after `cwd`,
//! never before, so a guess can only rescue a click `cwd` failed. And there is
//! no universal "open at line N" flag, so [`goto_style`] carries the syntax per
//! editor family and an unrecognized editor gets the bare path rather than a
//! guess it would reject.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use tauri::State;

use super::session::TermState;

/// Open a path in the preferred editor — a file Ctrl/⌘-clicked in a terminal,
/// or whatever the app's editor/diff context menus point at. Spawns without
/// waiting, so a non-forking editor (vim, `code --wait`) can't freeze the app.
#[tauri::command]
pub fn term_open_path(
    state: State<TermState>,
    path: String,
    cwd: Option<String>,
    line: Option<u32>,
    term_id: Option<String>,
) -> Result<(), String> {
    let settings = tt_config::load().map_err(|e| format!("failed to load settings: {e}"))?;
    let editor = settings.preferred_editor.trim();
    if editor.is_empty() {
        return Err("No preferred editor configured".into());
    }
    let full = resolve_open_target(&state, &path, cwd.as_deref(), term_id.as_deref()).ok_or_else(
        || format!("No such file: {}", resolve_clicked_path(&path, cwd.as_deref()).display()),
    )?;
    let editor_args = editor_open_args(editor, &full, line);
    let arg_strs: Vec<String> =
        editor_args.iter().map(|a| a.to_string_lossy().into_owned()).collect();
    tt_exec::record_detached_spawn(
        editor,
        &arg_strs.iter().map(String::as_str).collect::<Vec<_>>(),
        "editor",
    );
    std::process::Command::new(editor)
        .args(&editor_args)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to launch {editor}: {e}"))
}

/// [`resolve_open_target`] for the caller that routes a clicked link into the
/// app's own files pane rather than an editor.
#[tauri::command]
pub fn term_resolve_path(
    state: State<TermState>,
    path: String,
    cwd: Option<String>,
    term_id: Option<String>,
) -> Option<String> {
    resolve_open_target(&state, &path, cwd.as_deref(), term_id.as_deref())
        .map(|p| p.to_string_lossy().into_owned())
}

/// The existing file a clicked link names. `cwd` is tried first and is also the
/// only base the caller can map back into a files pane: `/proc` reports a
/// *canonical* dir, which lands outside a symlinked checkout.
fn resolve_open_target(
    state: &TermState,
    path: &str,
    cwd: Option<&str>,
    term_id: Option<&str>,
) -> Option<PathBuf> {
    let live = term_id.map(|id| state.open_base_dirs(id)).unwrap_or_default();
    std::iter::once(resolve_clicked_path(path, cwd))
        .chain(live.iter().map(|d| resolve_clicked_path_in(path, Some(d))))
        .find(|p| p.exists())
}

/// Resolve a clicked path against the pane's `cwd`: absolute paths as-is, a
/// leading `~/` to the home dir, everything else joined onto `cwd`.
fn resolve_clicked_path(path: &str, cwd: Option<&str>) -> PathBuf {
    resolve_clicked_path_in(path, cwd.filter(|c| !c.trim().is_empty()).map(Path::new))
}

/// [`resolve_clicked_path`] against a base directory that is already a path,
/// so a dir name the OS reported keeps its exact bytes.
fn resolve_clicked_path_in(path: &str, base: Option<&Path>) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/")
        && let Some(home) = dirs::home_dir()
    {
        return home.join(rest);
    }
    let p = Path::new(path);
    if p.is_absolute() {
        return p.to_path_buf();
    }
    match base {
        Some(dir) => dir.join(p),
        None => p.to_path_buf(),
    }
}

/// How a recognized editor's command wants "open this file at this line" on
/// its command line — there's no universal convention.
enum GotoStyle {
    /// `code --goto path:line`
    VsCodeGoto,
    /// `subl path:line` / `zed path:line`
    PathColonLine,
    /// `vim +line path`
    PlusLineFlag,
    /// `idea --line line path`
    LineFlag,
}

/// The goto syntax for `editor`'s command, matched by basename (case- and
/// extension-insensitive, so `Code.exe`/`/usr/bin/code` both match `code`).
/// `None` for anything we don't recognize.
fn goto_style(editor: &str) -> Option<GotoStyle> {
    let name = Path::new(editor)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(editor)
        .to_ascii_lowercase();
    match name.as_str() {
        "code" | "code-insiders" | "cursor" | "codium" | "vscodium" | "windsurf" => {
            Some(GotoStyle::VsCodeGoto)
        }
        "subl" | "sublime_text" | "zed" | "zeditor" | "hx" => Some(GotoStyle::PathColonLine),
        "vim" | "nvim" | "gvim" | "mvim" | "vi" | "nano" | "emacs" | "emacsclient" => {
            Some(GotoStyle::PlusLineFlag)
        }
        "idea" | "webstorm" | "pycharm" | "goland" | "rider" | "clion" | "rubymine"
        | "phpstorm" | "studio" => Some(GotoStyle::LineFlag),
        _ => None,
    }
}

/// Build the args to open `path` in `editor`. Without a `line`, or for an
/// editor command [`goto_style`] doesn't recognize, this is just the bare
/// path — guessing a goto syntax wrong would hand an unrecognized editor a
/// broken argument instead of the file it asked for.
fn editor_open_args(editor: &str, path: &Path, line: Option<u32>) -> Vec<OsString> {
    let Some(line) = line else {
        return vec![path.as_os_str().to_owned()];
    };
    match goto_style(editor) {
        Some(GotoStyle::VsCodeGoto) => {
            vec!["--goto".into(), format!("{}:{line}", path.display()).into()]
        }
        Some(GotoStyle::PathColonLine) => vec![format!("{}:{line}", path.display()).into()],
        Some(GotoStyle::PlusLineFlag) => {
            vec![format!("+{line}").into(), path.as_os_str().to_owned()]
        }
        Some(GotoStyle::LineFlag) => {
            vec![
                "--line".into(),
                line.to_string().into(),
                path.as_os_str().to_owned(),
            ]
        }
        None => vec![path.as_os_str().to_owned()],
    }
}

/// The directory an OSC 7 report (`file://<host>/<percent-encoded path>`)
/// names, if it exists here. The host is ignored rather than matched against
/// our own: `is_dir` already drops a remote's paths, and matching would only
/// add a way to be wrong about which of a machine's names is "ours".
pub(super) fn pwd_from_file_uri(uri: &str) -> Option<PathBuf> {
    let rest = uri.strip_prefix("file://")?;
    let raw = &rest[rest.find('/')?..];
    let dir = PathBuf::from(percent_decode(raw));
    dir.is_dir().then_some(dir)
}

/// Decode a URI path's `%XX` escapes. Byte-wise, since a multi-byte character
/// arrives one escape per byte; anything that doesn't decode passes through.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = (i + 2 < bytes.len())
            .then(|| std::str::from_utf8(&bytes[i + 1..i + 3]).ok())
            .flatten()
            .filter(|_| bytes[i] == b'%')
            // Both digits, or `from_str_radix` would read `%+A` as a byte.
            .filter(|h| h.bytes().all(|b| b.is_ascii_hexdigit()))
            .and_then(|h| u8::from_str_radix(h, 16).ok());
        match hex {
            Some(byte) => {
                out.push(byte);
                i += 3;
            }
            None => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A running process's working directory. Linux only — macOS has no equivalent
/// that works without extra entitlements, so it relies on OSC 7 alone.
#[cfg(target_os = "linux")]
pub(super) fn process_cwd(pid: u32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/cwd")).ok().filter(|p| p.is_dir())
}

#[cfg(not(target_os = "linux"))]
pub(super) fn process_cwd(_pid: u32) -> Option<PathBuf> {
    None
}

#[cfg(test)]
mod tests {
    use super::{editor_open_args, percent_decode, pwd_from_file_uri, resolve_clicked_path};
    use std::ffi::OsString;
    use std::path::PathBuf;

    #[test]
    fn resolve_clicked_path_joins_relative_onto_cwd() {
        assert_eq!(
            resolve_clicked_path("crates/tt-vt/src/search.rs", Some("/repo")),
            PathBuf::from("/repo/crates/tt-vt/src/search.rs"),
        );
    }

    #[test]
    fn resolve_clicked_path_keeps_absolute_and_ignores_cwd() {
        assert_eq!(
            resolve_clicked_path("/home/ctowles/app.tsx", Some("/repo")),
            PathBuf::from("/home/ctowles/app.tsx"),
        );
    }

    #[test]
    fn resolve_clicked_path_expands_leading_tilde() {
        let home = dirs::home_dir().expect("home dir");
        assert_eq!(resolve_clicked_path("~/src/a.rs", Some("/repo")), home.join("src/a.rs"));
    }

    #[test]
    fn resolve_clicked_path_relative_without_cwd_stays_relative() {
        assert_eq!(resolve_clicked_path("src/a.rs", None), PathBuf::from("src/a.rs"));
        assert_eq!(resolve_clicked_path("src/a.rs", Some("  ")), PathBuf::from("src/a.rs"));
    }

    #[test]
    fn percent_decode_handles_escapes_multibyte_and_junk() {
        assert_eq!(percent_decode("/a%20b/c"), "/a b/c");
        // One escape per *byte* of a multi-byte character.
        assert_eq!(percent_decode("/caf%C3%A9"), "/café");
        // A bare `%`, a truncated escape at the end, and a non-hex pair that
        // `from_str_radix` would otherwise accept, all pass through.
        assert_eq!(percent_decode("/100%/x%2"), "/100%/x%2");
        assert_eq!(percent_decode("/a%+Ab"), "/a%+Ab");
    }

    #[test]
    fn pwd_from_file_uri_reads_a_real_dir_with_and_without_a_host() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("has space");
        std::fs::create_dir(&dir).unwrap();
        let encoded = dir.to_string_lossy().replace(' ', "%20");
        assert_eq!(pwd_from_file_uri(&format!("file://{encoded}")), Some(dir.clone()));
        assert_eq!(pwd_from_file_uri(&format!("file://localhost{encoded}")), Some(dir));
    }

    #[test]
    fn pwd_from_file_uri_rejects_non_dirs_and_non_file_uris() {
        // A path that doesn't exist here — including anything a remote shell
        // reported — is no better than the fallback candidates.
        assert_eq!(pwd_from_file_uri("file:///no/such/dir/xyz"), None);
        assert_eq!(pwd_from_file_uri("http://example.com/x"), None);
        assert_eq!(pwd_from_file_uri("file://hostonly"), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn process_cwd_reads_our_own_working_dir() {
        use super::process_cwd;
        assert_eq!(process_cwd(std::process::id()), std::env::current_dir().ok());
        // A pid that can't be read is absent, not a wrong answer.
        assert_eq!(process_cwd(0), None);
    }

    #[test]
    fn editor_open_args_without_line_is_just_the_path() {
        let path = PathBuf::from("/repo/src/a.rs");
        assert_eq!(editor_open_args("code", &path, None), vec![OsString::from(&path)]);
    }

    #[test]
    fn editor_open_args_vscode_family_uses_goto() {
        let path = PathBuf::from("/repo/src/a.rs");
        for editor in [
            "code",
            "code-insiders",
            "cursor",
            "codium",
            "vscodium",
            "windsurf",
        ] {
            assert_eq!(
                editor_open_args(editor, &path, Some(42)),
                vec![
                    OsString::from("--goto"),
                    OsString::from("/repo/src/a.rs:42")
                ],
                "editor: {editor}",
            );
        }
    }

    #[test]
    fn editor_open_args_recognizes_editor_by_basename_and_extension() {
        let path = PathBuf::from("/repo/src/a.rs");
        assert_eq!(
            editor_open_args("/usr/bin/code", &path, Some(42)),
            vec![
                OsString::from("--goto"),
                OsString::from("/repo/src/a.rs:42")
            ],
        );
        assert_eq!(
            editor_open_args("Code.exe", &path, Some(42)),
            vec![
                OsString::from("--goto"),
                OsString::from("/repo/src/a.rs:42")
            ],
        );
    }

    #[test]
    fn editor_open_args_sublime_and_zed_use_path_colon_line() {
        let path = PathBuf::from("/repo/src/a.rs");
        for editor in ["subl", "sublime_text", "zed", "hx"] {
            assert_eq!(
                editor_open_args(editor, &path, Some(7)),
                vec![OsString::from("/repo/src/a.rs:7")],
                "editor: {editor}",
            );
        }
    }

    #[test]
    fn editor_open_args_vim_family_uses_plus_line_flag() {
        let path = PathBuf::from("/repo/src/a.rs");
        for editor in [
            "vim",
            "nvim",
            "gvim",
            "mvim",
            "vi",
            "nano",
            "emacs",
            "emacsclient",
        ] {
            assert_eq!(
                editor_open_args(editor, &path, Some(3)),
                vec![OsString::from("+3"), OsString::from(&path)],
                "editor: {editor}",
            );
        }
    }

    #[test]
    fn editor_open_args_jetbrains_family_uses_line_flag() {
        let path = PathBuf::from("/repo/src/a.rs");
        for editor in ["idea", "webstorm", "pycharm", "goland", "rider", "clion"] {
            assert_eq!(
                editor_open_args(editor, &path, Some(9)),
                vec![
                    OsString::from("--line"),
                    OsString::from("9"),
                    OsString::from(&path)
                ],
                "editor: {editor}",
            );
        }
    }

    #[test]
    fn editor_open_args_unrecognized_editor_falls_back_to_bare_path() {
        let path = PathBuf::from("/repo/src/a.rs");
        assert_eq!(
            editor_open_args("some-custom-editor", &path, Some(5)),
            vec![OsString::from(&path)]
        );
    }
}
