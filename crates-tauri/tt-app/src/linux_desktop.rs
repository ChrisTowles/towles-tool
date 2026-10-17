//! Self-registers a `.desktop` entry + icon per task so each checkout shows up as its own
//! entry in the launcher/search, with the right icon and an `Exec` pointing at that task's
//! binary. `tauri build` normally writes both in its Linux packaging step, but the
//! daily-driver flow (`bun start`) runs `--no-bundle` and execs the raw binary, so nothing
//! installs them. Idempotent — only touches disk when the content differs.
//!
//! `StartupWMClass` is deliberately the constant binary name (`tt-app`), not `app_id`:
//! `enableGTKAppId` is off (see `lib.rs`'s `app_identifier`), so a running window's actual
//! WM_CLASS is GTK's default and matching `app_id` here would never resolve. The
//! dock/taskbar can still find *an* icon for the window, just not a per-task one.

use std::path::Path;

const ICON_BYTES: &[u8] = include_bytes!("../icons/icon.png");
const WM_CLASS: &str = "tt-app";

pub fn ensure_installed(app_id: &str) {
    let Some(paths) = tt_config::host_paths(app_id) else {
        return;
    };

    write_if_changed(&paths.icon, ICON_BYTES);

    let entry = format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Towles Tool\n\
         Comment=Personal dev tools: agentboard, PRs\n\
         Exec={}\n\
         Icon={app_id}\n\
         Terminal=false\n\
         Categories=Development;Utility;\n\
         StartupWMClass={WM_CLASS}\n",
        std::env::current_exe().unwrap_or_default().display(),
    );
    write_if_changed(&paths.launcher, entry.as_bytes());
}

fn write_if_changed(path: &Path, contents: &[u8]) {
    if std::fs::read(path).is_ok_and(|existing| existing == contents) {
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, contents);
}
