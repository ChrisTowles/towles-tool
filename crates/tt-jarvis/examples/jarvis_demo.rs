//! The looping demo: Jarvis rendering natively, forever, inside a `wl_subsurface`
//! of another window.
//!
//! The benchmark's embedding path with the measurement removed and no exit condition
//! — same `ForeignSurface`, same `WinitPlugin`-less app, same `set_desync()`ed
//! subsurface. The inset border of parent surface around the pane is visible on
//! purpose: inside it is Bevy on the GPU, outside is a different surface entirely.
//!
//! ```sh
//! cargo run -p tt-jarvis --features linux-harness --example jarvis_demo --release
//! cargo run -p tt-jarvis --features linux-harness --example jarvis_demo --release -- --width 1280 --height 800
//! ```
//!
//! Runs until the window is closed or the process is killed.

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

    // Vsync by default: a demo, not a throughput test, and it keeps the
    // unthrottled-commit flood (which the compositor hangs up on) off the table.
    // `--no-vsync` exists because a vsync'd surface is paced by frame callbacks and
    // an occluded window receives none, so the loop stalls on another workspace —
    // right for a real pane, useless for `--capture`.
    //
    // Present modes, measured on COSMIC/Wayland. Committing faster than the
    // compositor accepts gets the Wayland connection hung up — **flooding**:
    // `AutoVsync` (FIFO) blocks on vblank and survives; `AutoNoVsync` (Immediate)
    // commits at the render rate, 1300+ fps, and dies in seconds; `Mailbox` never
    // blocks the renderer but still presents once per rendered frame, so it floods
    // the same way. Presentation is therefore paced by the display, and a renderer
    // with headroom spends it per frame — more samples and rays, which Solari scales.
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

    // `--capture <path>` grabs one frame off the pane's own swapchain a few
    // seconds in, so the scene can be inspected even when the host window is on
    // another workspace.
    if let Some(path) = flag("--capture") {
        tt_jarvis::jarvis::capture_frame_after(&mut app, path, 3.0);
    }

    // Without this, every `Res<RenderDevice>` system panics on frame one — see
    // the docs on `finalize_embedded_app`.
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
