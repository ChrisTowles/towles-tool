//! Closes the last Step 0 risk: does the **parent's** commit cadence clamp the embedded
//! pane's framerate? A `wl_subsurface` is **synchronized by default** (the child's commits
//! wait on the *parent's*), which would cap Bevy at GTK/WebKit's repaint rate. Run both
//! arms (`--features linux-harness --release`, with and without `--sync`).
//!
//! | arm              | parent observed | child            | outcome                  |
//! |------------------|-----------------|------------------|--------------------------|
//! | `--sync`         | 5 Hz            | —                | blocked, 0 frames in 90s |
//! | desync (default) | 7.3 Hz          | 60.06 fps median | 270 frames in 5.0s       |
//!
//! (2026-07-25, RTX 3060 / COSMIC, 1920x1080@60.) **Closed: `set_desync()` fully decouples
//! the pane.** In sync mode it blocks outright, so a missing call presents as a hang.

use std::ffi::c_void;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gtk::glib;
use gtk::prelude::*;
use raw_window_handle::{
    RawDisplayHandle, RawWindowHandle, WaylandDisplayHandle, WaylandWindowHandle,
};
use wayland_client::backend::{Backend, ObjectId};
use wayland_client::protocol::{
    wl_compositor::WlCompositor, wl_registry::WlRegistry, wl_subcompositor::WlSubcompositor,
    wl_subsurface::WlSubsurface, wl_surface::WlSurface,
};
use wayland_client::{delegate_noop, Connection, Dispatch, Proxy, QueueHandle};

use tt_jarvis::jarvis::JarvisScenePlugin;
use tt_jarvis::stats::FrameLog;
use tt_jarvis::surface::{ForeignSurface, PaneRect};
use tt_jarvis::PresentMode;

// Declared by hand rather than pulling in a `gdk-wayland` crate: these are the only two
// symbols needed, and libgdk-3 is already linked by `gtk`.
extern "C" {
    fn gdk_wayland_display_get_wl_display(display: *mut c_void) -> *mut c_void;
    fn gdk_wayland_window_get_wl_surface(window: *mut c_void) -> *mut c_void;
}

fn main() {
    let args = Args::parse();

    gtk::init().expect("gtk init failed — is this a Wayland/X11 session?");

    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    window.set_title(if args.sync {
        "tt-jarvis — GTK cadence (SYNC control)"
    } else {
        "tt-jarvis — GTK cadence (desync)"
    });
    window.set_default_size(
        (args.width + args.inset * 2) as i32,
        (args.height + args.inset * 2) as i32,
    );

    // A parent that actually paints, so "the parent commits slowly" is measured, not assumed.
    let repaints = Arc::new(Mutex::new(0u64));
    let area = gtk::DrawingArea::new();
    {
        let repaints = Arc::clone(&repaints);
        area.connect_draw(move |widget, cr| {
            *repaints.lock().unwrap() += 1;
            let w = widget.allocated_width() as f64;
            let h = widget.allocated_height() as f64;
            cr.set_source_rgb(0.09, 0.086, 0.10);
            let _ = cr.paint();
            cr.set_source_rgb(0.45, 0.42, 0.40);
            cr.rectangle(2.0, 2.0, w - 4.0, h - 4.0);
            let _ = cr.stroke();
            glib::Propagation::Proceed
        });
    }
    window.add(&area);
    window.show_all();

    // Keep the test window off the monitor being worked on. Wayland clients cannot position
    // their own toplevels, so fullscreening on a chosen output is the only way to target one.
    // It moves the vsync ceiling with it, so vsync arms on different outputs don't compare.
    if let Some(monitor) = pick_monitor(&window, args.monitor) {
        if let Some(screen) = WidgetExt::screen(&window) {
            window.fullscreen_on_monitor(&screen, monitor);
        }
    }

    // Drive the parent's repaints at a fixed, deliberately slow rate.
    let interval = Duration::from_millis(1000 / args.parent_hz.max(1) as u64);
    {
        let area = area.clone();
        glib::timeout_add_local(interval, move || {
            area.queue_draw();
            glib::ControlFlow::Continue
        });
    }

    // GTK must have realized the window before it has a wl_surface to hand out.
    pump_gtk();
    let gdk_window = window.window().expect("window has no GdkWindow after show_all");

    // SAFETY: both pointers are GDK-owned and live as long as the window, which outlives
    // everything below. No ownership transfer, nothing to free.
    let (wl_display_ptr, parent_surface_ptr) = unsafe {
        let display_ptr: *mut c_void = gdk_window.display().as_ptr() as *mut c_void;
        let window_ptr: *mut c_void = gdk_window.as_ptr() as *mut c_void;
        (
            gdk_wayland_display_get_wl_display(display_ptr),
            gdk_wayland_window_get_wl_surface(window_ptr),
        )
    };
    assert!(!wl_display_ptr.is_null(), "not a Wayland GDK backend (GDK_BACKEND=x11?)");
    assert!(!parent_surface_ptr.is_null(), "GdkWindow has no wl_surface");

    // Adopt GDK's existing Wayland connection rather than opening our own: subsurface
    // parentage is per-client, so a second connection could not parent to GTK's surface.
    //
    // SAFETY: the display pointer belongs to GDK, outlives this backend, and is never closed.
    let backend = unsafe { Backend::from_foreign_display(wl_display_ptr as *mut _) };
    let connection = Connection::from_backend(backend);
    let mut queue = connection.new_event_queue::<Globals>();
    let qh = queue.handle();
    connection.display().get_registry(&qh, ());

    let mut globals = Globals::default();
    queue.roundtrip(&mut globals).expect("registry roundtrip failed");
    let compositor = globals.compositor.clone().expect("no wl_compositor");
    let subcompositor = globals.subcompositor.clone().expect("no wl_subcompositor");

    // Borrowed, not owned — we must never destroy it.
    //
    // SAFETY: a live `wl_surface` proxy from the same connection this backend wraps.
    let parent_surface = unsafe {
        let id = ObjectId::from_ptr(WlSurface::interface(), parent_surface_ptr as *mut _)
            .expect("wl_surface pointer is not a valid proxy");
        WlSurface::from_id(&connection, id).expect("cannot adopt GTK's wl_surface")
    };

    let rect = PaneRect {
        x: args.inset as i32,
        y: args.inset as i32,
        width: args.width,
        height: args.height,
    };

    let child = compositor.create_surface(&qh, ());
    let subsurface = subcompositor.get_subsurface(&child, &parent_surface, &qh, ());
    subsurface.set_position(rect.x, rect.y);

    if args.sync {
        // The control arm. Synchronized is the DEFAULT; spelled out so the contrast shows.
        subsurface.set_sync();
    } else {
        subsurface.set_desync();
    }

    // Placement is parent state: it lands on the parent's next commit, on GTK's schedule.
    parent_surface.commit();
    connection.flush().expect("flush failed");

    // SAFETY: `connection`/`child` outlive the app, which is dropped first.
    let surface = unsafe {
        ForeignSurface::new(
            RawWindowHandle::Wayland(WaylandWindowHandle::new(
                std::ptr::NonNull::new(child.id().as_ptr() as *mut c_void).unwrap(),
            )),
            RawDisplayHandle::Wayland(WaylandDisplayHandle::new(
                std::ptr::NonNull::new(wl_display_ptr).unwrap(),
            )),
        )
    };

    // SAFETY: `surface` holds raw handles into `child` and `connection`, both
    // owned by `main` and dropped after `app` — the frames-in-flight rule.
    let mut app = unsafe { tt_jarvis::embedded_app(surface, rect, args.present) };
    app.add_plugins(JarvisScenePlugin);

    let pump = || {
        pump_gtk();
        let _ = connection.flush();
    };
    tt_jarvis::finalize_embedded_app(&mut app, pump);

    eprintln!(
        "gtk cadence: mode={} parent={}Hz present={} — measuring {} frames",
        if args.sync { "SYNC" } else { "desync" },
        args.parent_hz,
        if matches!(args.present, PresentMode::AutoNoVsync) { "novsync" } else { "vsync" },
        args.frames
    );

    let mut log = FrameLog::with_capacity(args.frames);
    let mut last: Option<Instant> = None;
    let started = Instant::now();
    let repaints_at_start = *repaints.lock().unwrap();

    // A sync-mode run advances a handful of frames per second, so without a wall-clock
    // escape hatch the control arm looks like a hang instead of a demonstrated clamp.
    let deadline = Duration::from_secs(args.max_secs);

    while log.len() < args.frames && started.elapsed() < deadline {
        pump_gtk();
        let _ = connection.flush();
        app.update();

        let now = Instant::now();
        if let Some(previous) = last.replace(now) {
            // Clamp to `u32::MAX`, not `u128::MAX` — the latter is a no-op and lets the cast
            // wrap. The sync arm really does produce frames over a second long.
            let micros = now.duration_since(previous).as_micros().min(u128::from(u32::MAX));
            log.record_us(micros as u32);
        }
    }

    let elapsed = started.elapsed().as_secs_f64();
    let parent_repaints = *repaints.lock().unwrap() - repaints_at_start;
    log.drop_warmup(args.warmup.min(log.len().saturating_sub(1)));

    let stats = log.stats().expect("no frames recorded at all");
    println!(
        "{}",
        serde_json::json!({
            "label": format!(
                "gtk/{}/{}Hz-parent",
                if args.sync { "sync" } else { "desync" },
                args.parent_hz
            ),
            "mode": if args.sync { "sync" } else { "desync" },
            "parent_hz_requested": args.parent_hz,
            "parent_repaints_observed": parent_repaints,
            "parent_hz_observed": parent_repaints as f64 / elapsed,
            "child_fps_observed": stats.frames as f64 / elapsed,
            "elapsed_secs": elapsed,
            "stats": stats,
        })
    );
}

/// Choose which monitor to fullscreen on. `requested` is an explicit GDK index; otherwise
/// the left-most-*after*-the-origin output, i.e. a secondary monitor if one exists. Picked
/// by geometry rather than connector name so it doesn't hardcode this desk.
fn pick_monitor(window: &gtk::Window, requested: Option<i32>) -> Option<i32> {
    let display = WidgetExt::display(window);
    let count = display.n_monitors();
    if let Some(index) = requested {
        return (index >= 0 && index < count).then_some(index);
    }
    if count < 2 {
        return None; // Single monitor: leave it alone, don't force fullscreen.
    }
    (0..count)
        .filter(|&i| display.monitor(i).map(|m| m.geometry().x() > 0).unwrap_or(false))
        .min_by_key(|&i| display.monitor(i).map(|m| m.geometry().x()).unwrap_or(i32::MAX))
}

/// Run GTK's pending work without blocking. The real app inverts this (Tauri owns the GTK
/// loop), but for measuring who clamps whom, which side hosts the loop does not matter.
fn pump_gtk() {
    while gtk::events_pending() {
        gtk::main_iteration_do(false);
    }
}

#[derive(Default)]
struct Globals {
    compositor: Option<WlCompositor>,
    subcompositor: Option<WlSubcompositor>,
}

impl Dispatch<WlRegistry, ()> for Globals {
    fn event(
        state: &mut Self,
        registry: &WlRegistry,
        event: <WlRegistry as Proxy>::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        let wayland_client::protocol::wl_registry::Event::Global { name, interface, version } =
            event
        else {
            return;
        };
        match interface.as_str() {
            "wl_compositor" => state.compositor = Some(registry.bind(name, version.min(4), qh, ())),
            "wl_subcompositor" => {
                state.subcompositor = Some(registry.bind(name, version.min(1), qh, ()));
            }
            _ => {}
        }
    }
}

delegate_noop!(Globals: ignore WlCompositor);
delegate_noop!(Globals: ignore WlSubcompositor);
delegate_noop!(Globals: ignore WlSubsurface);
delegate_noop!(Globals: ignore WlSurface);

struct Args {
    width: u32,
    height: u32,
    inset: u32,
    parent_hz: u32,
    frames: usize,
    warmup: usize,
    max_secs: u64,
    sync: bool,
    present: PresentMode,
    /// Explicit GDK monitor index; `None` auto-picks a secondary output.
    monitor: Option<i32>,
}

impl Args {
    fn parse() -> Self {
        let argv: Vec<String> = std::env::args().collect();
        let val = |name: &str| -> Option<String> {
            argv.iter().position(|a| a == name).and_then(|i| argv.get(i + 1)).cloned()
        };
        let num = |name: &str, default: u64| -> u64 {
            val(name).and_then(|v| v.parse().ok()).unwrap_or(default)
        };
        let has = |name: &str| argv.iter().any(|a| a == name);

        Self {
            width: num("--width", 640) as u32,
            height: num("--height", 480) as u32,
            inset: num("--inset", 40) as u32,
            // Slow enough that a clamped child is unmistakable, fast enough to finish.
            parent_hz: num("--parent-hz", 5) as u32,
            frames: num("--frames", 400) as usize,
            warmup: num("--warmup", 30) as usize,
            max_secs: num("--max-secs", 40),
            sync: has("--sync"),
            monitor: val("--monitor").and_then(|v| v.parse().ok()),
            present: if has("--no-vsync") {
                PresentMode::AutoNoVsync
            } else {
                PresentMode::AutoVsync
            },
        }
    }
}
