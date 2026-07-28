//! Step 0 comparison: the benchmark scene rendering into a `wl_subsurface`. Same
//! scene, size and present mode as `bench_standalone` — the only difference is that
//! Bevy draws into a subsurface of a parent toplevel instead of its own, which is the
//! entire question the gate asks: does output the compositor must blend into a
//! parent, rather than potentially scan out directly, cost frames?
//!
//! ```sh
//! cargo run -p tt-jarvis --features linux-harness --example bench_subsurface -- --width 800 --height 600 --no-vsync
//! ```
//!
//! The parent is a bare `xdg_toplevel` this file creates — no GTK, no WebKit — so a
//! regression can only be the subsurface. Commit *cadence* is a separate question,
//! answered by `bench_gtk_cadence`. Result on an RTX 3060: within noise of the
//! standalone baseline (median −1.1%, −1.7% at two sizes).

// Shares the baseline's argument parsing verbatim so the two hosts can never
// drift on what `--frames`/`--grid` mean. Pulling the file in as a module also
// pulls in its `main`/reporting systems, which this binary does not call.
#[path = "bench_standalone.rs"]
#[allow(dead_code)]
mod harness;

// The same host the `jarvis_demo` runs on, so what was measured here and what
// is demonstrated there are the same embedding.
#[path = "common/wayland_host.rs"]
#[allow(dead_code)]
mod wayland_host;

use tt_jarvis::scene::{BenchConfig, BenchOutcome, BenchScenePlugin};
use tt_jarvis::surface::PaneRect;
use wayland_host::WaylandHost;

fn main() {
    let args = harness::bench_args();
    let rect = PaneRect { x: 40, y: 40, width: args.width, height: args.height };

    let host = WaylandHost::new(rect, 80, "tt-jarvis — subsurface benchmark host")
        .expect("failed to set up the Wayland host");

    // SAFETY: `host` owns the parent toplevel, the child surface and the
    // connection, and is dropped at the end of `main` — strictly after `app`.
    // The renderer keeps frames in flight, so that order is load-bearing.
    let surface = unsafe { host.foreign_surface() };

    // SAFETY: `surface` borrows `host`, which is dropped at the end of `main` —
    // strictly after `app`, as the frames-in-flight rule requires.
    let mut app = unsafe { tt_jarvis::embedded_app(surface, rect, args.present) };
    app.insert_resource(BenchConfig {
        label: format!("subsurface/{}x{}/{}", args.width, args.height, args.present_label),
        warmup_frames: args.warmup,
        measure_frames: args.frames,
        grid: args.grid,
    })
    .add_plugins(BenchScenePlugin);

    // Driving `app.update()` by hand rather than `app.run()`: with `WinitPlugin`
    // disabled there is no event loop to hand control to, and the Wayland queue
    // still has to be pumped between frames or the compositor's pings go
    // unanswered and the parent gets killed as unresponsive. That also means
    // nothing runs the plugins' `finish` phase for us — see the docs on
    // `finalize_embedded_app`, without which every `Res<RenderDevice>` system
    // panics on frame one.
    tt_jarvis::finalize_embedded_app(&mut app, || host.pump());

    loop {
        host.pump();
        app.update();

        if let Some(stats) = &app.world().resource::<BenchOutcome>().0 {
            let label = &app.world().resource::<BenchConfig>().label;
            println!("{}", serde_json::json!({ "label": label, "stats": stats }));
            break;
        }
        if app.should_exit().is_some() {
            eprintln!("app exited before the run completed");
            break;
        }
    }

    drop(app);
    drop(host);
}
