//! Put the automated window somewhere a compositor screenshot can find it.
//!
//! The webview screenshot every other drive verb takes (`drive.mjs shot`) is
//! blind to native panes: a `tt-pane` surface is a Wayland subsurface composited
//! *above* the webview, so it is simply absent from a WebDriver capture. Proving
//! the Jarvis pane actually paints therefore needs a compositor-level capture —
//! and that lands you with two problems this module exists to solve.
//!
//! **Which window is mine?** Several task checkouts run `tt-app` at once, so a
//! whole-desktop screenshot shows three or four near-identical windows. The
//! title bar disambiguates them for a human (`Towles Tool — <task>`), but
//! nothing crops an image by window title, and Wayland refuses a client its own
//! position, so the app cannot report a rect to crop to either
//! (`gtk_window_get_position` returns 0,0 there).
//!
//! **Fullscreen on a chosen output answers both at once.** The window then owns
//! an entire monitor, so the monitor's geometry *is* the window's rect — known,
//! stable, and expressible as a `convert -crop` against the desktop-wide PNG. It
//! also forces the window unoccluded, which matters more than it sounds: an
//! occluded Wayland surface receives no frame callbacks, so a vsync-paced pane
//! stalls rather than slowing, and a screenshot of it would show a stale frame
//! (or nothing) while the code under test is perfectly healthy.
//!
//! The output picked is the *test* monitor — the one whose geometry starts at
//! `x > 0`, i.e. not the primary Chris is working on. A run that took over the
//! primary would interrupt him once per screenshot. On a single-monitor machine
//! there is nothing to move to, so this fullscreens in place and says so via
//! [`MonitorRect::is_test_monitor`] rather than failing.
//!
//! Gated with the rest of the automation surface. The command stays in the
//! handler list unconditionally — `tauri::generate_handler!` parses a plain
//! path list and has nowhere to put a `#[cfg]` — so the *body* refuses without
//! the `wdio` feature, the same shape `preview_capture` uses to stub itself off
//! Linux. A release build therefore ships an inert name, not the behaviour.

use serde::Serialize;

/// Where the window ended up, in the compositor's global coordinate space —
/// exactly the `-crop <width>x<height>+<x>+<y>` a desktop-wide screenshot needs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    /// Connector name (`HDMI-A-2`), for the log line — matching `cosmic-randr`.
    pub monitor: String,
    /// False when the machine has only one monitor and the window had to
    /// fullscreen over the primary. The capture is still valid; the caller may
    /// want to say out loud that it covered the user's screen.
    pub is_test_monitor: bool,
    /// Whether the window is now fullscreen (false after a restore call).
    pub fullscreen: bool,
}

/// Fullscreen the automated window on the test monitor (or restore it).
///
/// Returns the rect to crop a desktop screenshot to. GTK is main-thread-only,
/// so the work is marshalled there the same way `tt_pane::commands` does it —
/// a command body runs on a worker pool.
#[tauri::command]
pub async fn wdio_place_on_test_monitor(
    window: tauri::WebviewWindow,
    fullscreen: bool,
) -> Result<MonitorRect, String> {
    if !cfg!(feature = "wdio") {
        return Err("wdio-only command — build the app with `--features wdio`".into());
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let target = window.clone();
    tauri::Manager::app_handle(&window)
        .run_on_main_thread(move || {
            let _ = tx.send(place(&target, fullscreen));
        })
        .map_err(|e| format!("cannot reach the main thread: {e}"))?;
    rx.recv().map_err(|_| "main thread dropped the placement request".to_string())?
}

#[cfg(target_os = "linux")]
fn place(window: &tauri::WebviewWindow, fullscreen: bool) -> Result<MonitorRect, String> {
    use gtk::prelude::*;

    let win = window.gtk_window().map_err(|e| format!("no GTK window: {e}"))?;
    let display = GtkWindowExt::screen(&win)
        .ok_or_else(|| "the GTK window has no screen".to_string())?
        .display();

    // The test monitor is the one that doesn't start at the origin. The primary
    // always does, so this is the same "x > 0" rule the benchmarks use, and it
    // degrades to the primary on a single-monitor machine rather than failing.
    let count = display.n_monitors();
    let mut chosen = 0;
    let mut is_test_monitor = false;
    for i in 0..count {
        let Some(m) = display.monitor(i) else {
            continue;
        };
        if m.geometry().x() > 0 {
            chosen = i;
            is_test_monitor = true;
            break;
        }
    }
    let monitor =
        display.monitor(chosen).ok_or_else(|| "the display reports no monitors".to_string())?;
    let geom = monitor.geometry();
    let name =
        monitor.model().map(|s| s.to_string()).unwrap_or_else(|| format!("monitor {chosen}"));

    if fullscreen {
        let screen =
            GtkWindowExt::screen(&win).ok_or_else(|| "the GTK window has no screen".to_string())?;
        // `fullscreen_on_monitor` is the only way a Wayland client reaches a
        // *chosen* output — it cannot position its own toplevel, and Tauri's
        // `set_fullscreen` targets whichever monitor the window is already on.
        win.fullscreen_on_monitor(&screen, chosen);
    } else {
        win.unfullscreen();
    }

    Ok(MonitorRect {
        x: geom.x(),
        y: geom.y(),
        width: geom.width(),
        height: geom.height(),
        monitor: name,
        is_test_monitor,
        fullscreen,
    })
}

#[cfg(not(target_os = "linux"))]
fn place(_window: &tauri::WebviewWindow, _fullscreen: bool) -> Result<MonitorRect, String> {
    Err("placing the window on a chosen monitor is implemented for Linux/GTK only".into())
}
