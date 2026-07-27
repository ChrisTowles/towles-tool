//! The looping demo: Jarvis rendering natively, forever, inside a
//! `wl_subsurface` of another window.
//!
//! This is the benchmark's embedding path with the measurement removed and no
//! exit condition — the same `ForeignSurface`, the same `WinitPlugin`-less app,
//! the same `set_desync()`ed subsurface. The inset border of parent surface
//! around the pane is visible on purpose: everything inside it is Bevy on the
//! GPU, everything outside is a different surface entirely.
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

    // Vsync by default: this is a demo, not a throughput test, and it keeps the
    // unthrottled-commit flood (which the compositor hangs up on) off the table.
    //
    // `--no-vsync` exists for one specific reason: a vsync'd surface is paced by
    // compositor frame callbacks, and an occluded window receives none — so the
    // render loop correctly stalls when the window is on another workspace. That
    // is right for a real pane and useless for `--capture`, which needs frames
    // to keep coming whether or not anyone is looking.
    // Present mode — the source of truth for how each behaves here. All three
    // measured on COSMIC/Wayland, because the answer is counter-intuitive: a
    // surface committing faster than the compositor accepts gets its Wayland
    // connection hung up. Call that **flooding**.
    //
    // - `AutoVsync` (FIFO): blocks on vblank, so commits arrive at refresh. The
    //   only mode that survives; runs indefinitely.
    // - `AutoNoVsync`: selects Immediate here, so commits arrive at the render
    //   rate — 1300+ fps for the bench scene. Floods, dies in seconds.
    // - `Mailbox`: triple-buffered and never blocks the renderer, which looked
    //   like fast-without-flooding. Vulkan mailbox still presents once per
    //   rendered frame, so the commit rate is again the render rate. Floods, dies
    //   the same way.
    //
    // So presentation is paced by the display, and a renderer with headroom spends
    // it per frame — more samples and rays, which is what Solari scales.
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
