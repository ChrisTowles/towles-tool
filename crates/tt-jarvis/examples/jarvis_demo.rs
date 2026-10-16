//! The looping demo: Jarvis rendering natively, forever, inside a `wl_subsurface`
//! of another window.

#[path = "common/wayland_host.rs"]
mod wayland_host;

use tt_jarvis::jarvis::JarvisScenePlugin;
use tt_jarvis::surface::PaneRect;
use tt_jarvis::PresentMode;
use wayland_host::WaylandHost;

fn main() {
    let (width, height) = size_from_args();
    let rect = PaneRect { x: 48, y: 48, width, height };

    let host = WaylandHost::new(rect, 48, "tt-jarvis — native Bevy in a subsurface")
        .expect("failed to set up the Wayland host");

    // SAFETY: `host` owns the surfaces and is dropped at the end of `main`,
    // strictly after `app`. The renderer keeps frames in flight, so that order
    // is load-bearing.
    let surface = unsafe { host.foreign_surface() };

    // Vsync by default. Measured on COSMIC/Wayland: committing faster than the compositor
    // accepts hangs up the connection, and only `AutoVsync` (FIFO, blocks on vblank)
    // survives — `AutoNoVsync` and `Mailbox` both flood and die in seconds. `--no-vsync`
    // exists anyway because a vsync'd surface is paced by frame callbacks that an occluded
    // window never receives, so the loop stalls on another workspace — useless for capture.
    let present = if has_flag("--no-vsync") {
        PresentMode::AutoNoVsync
    } else if has_flag("--mailbox") {
        PresentMode::Mailbox
    } else {
        PresentMode::AutoVsync
    };
    // SAFETY: `surface` borrows the host that owns the toplevel, the child
    // surface and the connection, and that host outlives `app` — the
    // frames-in-flight rule in `tt_jarvis::surface`.
    let mut app = unsafe { tt_jarvis::embedded_app(surface, rect, present) };
    app.add_plugins(JarvisScenePlugin);

    if let Some(path) = flag("--capture") {
        tt_jarvis::jarvis::capture_frame_after(&mut app, path, 3.0);
    }

    tt_jarvis::finalize_embedded_app(&mut app, || host.pump());

    println!("jarvis: {width}x{height} subsurface — close the window or ^C to stop");

    while !host.closed() {
        host.pump();
        app.update();
        if app.should_exit().is_some() {
            break;
        }
    }

    drop(app);
    drop(host);
}

fn has_flag(name: &str) -> bool {
    std::env::args().any(|a| a == name)
}

fn flag(name: &str) -> Option<String> {
    let argv: Vec<String> = std::env::args().collect();
    argv.iter().position(|a| a == name).and_then(|i| argv.get(i + 1)).cloned()
}

fn size_from_args() -> (u32, u32) {
    let num = |name: &str, default: u32| flag(name).and_then(|v| v.parse().ok()).unwrap_or(default);
    (num("--width", 900), num("--height", 700))
}
