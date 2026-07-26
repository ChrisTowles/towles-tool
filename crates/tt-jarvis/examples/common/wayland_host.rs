//! A bare Wayland parent toplevel with a `wl_subsurface` for Bevy to draw into.
//!
//! Shared by `bench_subsurface` (which measures it) and `jarvis_demo` (which
//! shows it off), so the thing being demonstrated is exactly the thing that was
//! measured.
//!
//! Lives under `examples/common/` rather than `examples/` because cargo only
//! treats `examples/*.rs` and `examples/*/main.rs` as example binaries — a file
//! in a subdirectory is includable without cargo trying to build it as its own
//! binary with no `main`.
//!
//! This is **harness scaffolding, not the production path**. The real embedding
//! (`tt-pane`) reaches Wayland through GDK, using the Tauri window's existing
//! `wl_display` and toplevel surface rather than creating its own.

use std::sync::{Arc, Mutex};

use raw_window_handle::{
    RawDisplayHandle, RawWindowHandle, WaylandDisplayHandle, WaylandWindowHandle,
};
use wayland_client::protocol::{
    wl_buffer::WlBuffer,
    wl_compositor::WlCompositor,
    wl_registry::WlRegistry,
    wl_shm::{self, WlShm},
    wl_shm_pool::WlShmPool,
    wl_subcompositor::WlSubcompositor,
    wl_subsurface::WlSubsurface,
    wl_surface::WlSurface,
};
use wayland_client::{delegate_noop, Connection, Dispatch, Proxy, QueueHandle};
use wayland_protocols::xdg::shell::client::{
    xdg_surface::{self, XdgSurface},
    xdg_toplevel::{self, XdgToplevel},
    xdg_wm_base::{self, XdgWmBase},
};

use tt_jarvis::surface::{ForeignSurface, PaneRect};

pub struct WaylandHost {
    connection: Connection,
    queue: Mutex<wayland_client::EventQueue<State>>,
    state: Arc<Mutex<State>>,
    child: WlSurface,
    _subsurface: WlSubsurface,
    _parent: WlSurface,
    _toplevel: XdgToplevel,
}

#[derive(Default)]
pub struct State {
    compositor: Option<WlCompositor>,
    subcompositor: Option<WlSubcompositor>,
    shm: Option<WlShm>,
    wm_base: Option<XdgWmBase>,
    configured: bool,
    pub closed: bool,
}

impl WaylandHost {
    /// `inset` is the margin of parent surface left visible around the pane, so
    /// the subsurface is genuinely composited *over* another surface rather than
    /// exactly covering it — a compositor could optimize the covering case into
    /// a direct scanout and flatter the result.
    pub fn new(
        rect: PaneRect,
        inset: u32,
        title: &str,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let connection = Connection::connect_to_env()?;
        let mut queue = connection.new_event_queue::<State>();
        let qh = queue.handle();
        connection.display().get_registry(&qh, ());

        let state = Arc::new(Mutex::new(State::default()));
        {
            let mut guard = state.lock().unwrap();
            queue.roundtrip(&mut guard)?;
        }

        let (compositor, subcompositor, shm, wm_base) = {
            let guard = state.lock().unwrap();
            (
                guard.compositor.clone().ok_or("no wl_compositor")?,
                guard.subcompositor.clone().ok_or("no wl_subcompositor")?,
                guard.shm.clone().ok_or("no wl_shm")?,
                guard.wm_base.clone().ok_or("no xdg_wm_base")?,
            )
        };

        // Parent toplevel. It needs a real buffer or it never maps, and an
        // unmapped parent means the subsurface is never shown.
        let parent = compositor.create_surface(&qh, ());
        let xdg_surface = wm_base.get_xdg_surface(&parent, &qh, ());
        let toplevel = xdg_surface.get_toplevel(&qh, ());
        toplevel.set_title(title.into());
        parent.commit();

        {
            let mut guard = state.lock().unwrap();
            while !guard.configured {
                queue.blocking_dispatch(&mut guard)?;
            }
        }

        let parent_w = rect.width + inset * 2;
        let parent_h = rect.height + inset * 2;
        let buffer = solid_buffer(&shm, &qh, parent_w, parent_h)?;
        parent.attach(Some(&buffer), 0, 0);
        parent.damage_buffer(0, 0, parent_w as i32, parent_h as i32);
        parent.commit();

        // The child. Bevy attaches its own dmabuf buffers here via wgpu.
        let child = compositor.create_surface(&qh, ());
        let subsurface = subcompositor.get_subsurface(&child, &parent, &qh, ());
        subsurface.set_position(rect.x, rect.y);

        // The single most important call in this file: synchronized is the
        // default, and it clamps the child's framerate to the parent's commit
        // cadence. `bench_gtk_cadence` measures exactly that.
        subsurface.set_desync();

        // Subsurface placement is parent state: it only takes effect on the next
        // parent commit, regardless of desync.
        parent.commit();
        connection.flush()?;

        Ok(Self {
            connection,
            queue: Mutex::new(queue),
            state,
            child,
            _subsurface: subsurface,
            _parent: parent,
            _toplevel: toplevel,
        })
    }

    /// Service the Wayland queue without blocking the render loop.
    ///
    /// Errors are fatal, not ignorable. A run that keeps rendering after the
    /// compositor has hung up still produces perfectly plausible output — a
    /// *better*-looking benchmark number, since nothing is being composited any
    /// more — and it is worthless. Swallowing these errors once already produced
    /// a "pass" from a dead connection.
    pub fn pump(&self) {
        let mut queue = self.queue.lock().unwrap();
        let mut guard = self.state.lock().unwrap();

        if let Err(e) = queue.dispatch_pending(&mut guard) {
            panic!("wayland dispatch failed — any result from here is meaningless: {e}");
        }
        if let Err(e) = self.connection.flush() {
            let transient = matches!(
                &e,
                wayland_client::backend::WaylandError::Io(io)
                    if io.kind() == std::io::ErrorKind::WouldBlock
            );
            if !transient {
                panic!("wayland flush failed — any result from here is meaningless: {e}");
            }
        }
        if let Some(err) = self.connection.protocol_error() {
            panic!(
                "wayland protocol error on {} (code {}): {}",
                err.object_interface, err.code, err.message
            );
        }
    }

    /// True once the compositor has told the toplevel to close.
    pub fn closed(&self) -> bool {
        self.state.lock().unwrap().closed
    }

    /// # Safety
    ///
    /// The returned handles borrow surfaces owned by `self`. `self` must outlive
    /// the returned value and any Bevy app built from it — the renderer keeps
    /// frames in flight, so tearing the surface down first is a use-after-free,
    /// not a blank pane.
    pub unsafe fn foreign_surface(&self) -> ForeignSurface {
        let window = RawWindowHandle::Wayland(WaylandWindowHandle::new(
            std::ptr::NonNull::new(self.child.id().as_ptr() as *mut std::ffi::c_void)
                .expect("wl_surface pointer is never null"),
        ));
        let display =
            RawDisplayHandle::Wayland(WaylandDisplayHandle::new(
                std::ptr::NonNull::new(
                    self.connection.backend().display_ptr() as *mut std::ffi::c_void
                )
                .expect("wl_display pointer is never null"),
            ));
        ForeignSurface::new(window, display)
    }
}

/// An opaque shm buffer for the parent, so it maps and has something to
/// composite the child against.
fn solid_buffer(
    shm: &WlShm,
    qh: &QueueHandle<State>,
    width: u32,
    height: u32,
) -> Result<WlBuffer, Box<dyn std::error::Error>> {
    use std::io::Write;
    use std::os::fd::AsFd;

    let stride = width * 4;
    let len = (stride * height) as usize;

    let mut file = tempfile()?;
    // Opaque near-black, so the pane's edges are obvious if placement is wrong.
    let pixel = [0x18u8, 0x16, 0x1a, 0xff];
    let row: Vec<u8> = pixel.iter().copied().cycle().take(stride as usize).collect();
    for _ in 0..height {
        file.write_all(&row)?;
    }
    file.flush()?;

    let pool = shm.create_pool(file.as_fd(), len as i32, qh, ());
    let buffer = pool.create_buffer(
        0,
        width as i32,
        height as i32,
        stride as i32,
        wl_shm::Format::Xrgb8888,
        qh,
        (),
    );
    pool.destroy();
    Ok(buffer)
}

/// A file for the shm pool, unlinked immediately so nothing is left behind.
///
/// Hand-rolled rather than pulling in `tempfile`: this is harness scaffolding
/// and the crate should not gain a dependency for it.
fn tempfile() -> std::io::Result<std::fs::File> {
    let dir = std::env::var_os("XDG_RUNTIME_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("/tmp"));
    let path = dir.join(format!("tt-jarvis-{}", std::process::id()));

    let file = std::fs::OpenOptions::new().read(true).write(true).create_new(true).open(&path)?;
    std::fs::remove_file(&path)?; // The fd keeps the mapping alive.
    Ok(file)
}

impl Dispatch<WlRegistry, ()> for State {
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
            "wl_shm" => state.shm = Some(registry.bind(name, version.min(1), qh, ())),
            "xdg_wm_base" => state.wm_base = Some(registry.bind(name, version.min(1), qh, ())),
            _ => {}
        }
    }
}

impl Dispatch<XdgWmBase, ()> for State {
    fn event(
        _: &mut Self,
        wm_base: &XdgWmBase,
        event: <XdgWmBase as Proxy>::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        // Unanswered pings get the client killed as unresponsive — which, during
        // a long run, would look exactly like a performance collapse.
        if let xdg_wm_base::Event::Ping { serial } = event {
            wm_base.pong(serial);
        }
    }
}

impl Dispatch<XdgSurface, ()> for State {
    fn event(
        state: &mut Self,
        xdg_surface: &XdgSurface,
        event: <XdgSurface as Proxy>::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let xdg_surface::Event::Configure { serial } = event {
            xdg_surface.ack_configure(serial);
            state.configured = true;
        }
    }
}

impl Dispatch<XdgToplevel, ()> for State {
    fn event(
        state: &mut Self,
        _: &XdgToplevel,
        event: <XdgToplevel as Proxy>::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let xdg_toplevel::Event::Close = event {
            state.closed = true;
        }
    }
}

delegate_noop!(State: ignore WlCompositor);
delegate_noop!(State: ignore WlSubcompositor);
delegate_noop!(State: ignore WlSubsurface);
delegate_noop!(State: ignore WlSurface);
delegate_noop!(State: ignore WlShm);
delegate_noop!(State: ignore WlShmPool);
delegate_noop!(State: ignore WlBuffer);
