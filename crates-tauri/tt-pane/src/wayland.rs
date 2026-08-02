//! Wayland embedding: a `wl_subsurface` of the Tauri window's own toplevel. Ported from
//! `tt-jarvis`'s `bench_gtk_cadence` harness.
//!
//! **Why we adopt GDK's connection rather than opening our own:** subsurface parentage
//! is **per-client**, so a surface can only be made a child of another on the same
//! Wayland connection. `Connection::connect_to_env()` would give a second client that
//! cannot see GTK's surface at all.
//!
//! **Threading:** everything here is **main-thread only**. The surface is created, moved
//! and destroyed on the GTK main thread; the render thread receives only the resulting
//! handles (what `ForeignSurface`'s `Send` claim rests on) and never touches the proxies.

use std::ffi::c_void;

use gtk::prelude::*;
use tt_jarvis::surface::{ForeignSurface, PaneRect};
use wayland_client::backend::{Backend, ObjectId};
use wayland_client::protocol::{
    wl_compositor::WlCompositor, wl_region::WlRegion, wl_registry::WlRegistry,
    wl_subcompositor::WlSubcompositor, wl_subsurface::WlSubsurface, wl_surface::WlSurface,
};
use wayland_client::{delegate_noop, Connection, Dispatch, Proxy, QueueHandle};

use crate::PaneError;

// Hand-declared rather than a `gdk-wayland` crate: both live in libgdk-3, which `gtk` links.
extern "C" {
    fn gdk_wayland_display_get_wl_display(display: *mut c_void) -> *mut c_void;
    fn gdk_wayland_window_get_wl_surface(window: *mut c_void) -> *mut c_void;
}

/// A subsurface pinned to a rectangle of the host window. Main-thread only.
pub struct Subsurface {
    connection: Connection,
    parent: WlSurface,
    child: WlSurface,
    subsurface: WlSubsurface,
    display_ptr: *mut c_void,
    gtk_window: gtk::ApplicationWindow,
    /// Where the pane belongs when shown — hiding *moves* it, so this survives.
    rect: PaneRect,
    visible: bool,
}

/// Where a hidden pane is parked, in surface-local coordinates. Not `i32::MAX` — it is
/// added to the webview offset, and an overflow would wrap it back onto the screen.
const OFFSCREEN: i32 = 1 << 20;

/// Offset from the toplevel surface's origin to the webview's: the frontend measures
/// relative to the webview, `set_position` relative to the whole GTK toplevel — CSD
/// shadow and title bar included. Correct only at scale 1 (`set_position` is logical).
fn webview_offset(gtk_window: &gtk::ApplicationWindow, scale: i32) -> (i32, i32) {
    let Some(child) = gtk_window.child() else {
        return (0, 0);
    };
    let (x, y) = child.translate_coordinates(gtk_window, 0, 0).unwrap_or((0, 0));
    (x * scale, y * scale)
}

// SAFETY: not thread-safe — sound only because every method is invoked from the GTK
// main thread, via `lib.rs`'s `run_on_main_thread`.
unsafe impl Send for Subsurface {}

impl Subsurface {
    /// Create the pane surface as a child of `gtk_window`'s toplevel.
    pub fn new(gtk_window: &gtk::ApplicationWindow, rect: PaneRect) -> Result<Self, PaneError> {
        let gdk_window = gtk_window
            .window()
            .ok_or_else(|| PaneError::Host("host window is not realized yet".into()))?;

        // SAFETY: both pointers are GDK-owned, borrowed, and live as long as the window.
        let (display_ptr, parent_ptr) = unsafe {
            (
                gdk_wayland_display_get_wl_display(gdk_window.display().as_ptr() as *mut c_void),
                gdk_wayland_window_get_wl_surface(gdk_window.as_ptr() as *mut c_void),
            )
        };
        if display_ptr.is_null() || parent_ptr.is_null() {
            return Err(PaneError::Unsupported(
                "GDK is not on its Wayland backend (GDK_BACKEND=x11?)".into(),
            ));
        }

        // SAFETY: the display belongs to GDK, outlives this backend, and is never closed here.
        let backend = unsafe { Backend::from_foreign_display(display_ptr as *mut _) };
        let connection = Connection::from_backend(backend);
        let mut queue = connection.new_event_queue::<Globals>();
        let qh = queue.handle();
        connection.display().get_registry(&qh, ());

        let mut globals = Globals::default();
        queue
            .roundtrip(&mut globals)
            .map_err(|e| PaneError::Host(format!("wayland roundtrip failed: {e}")))?;

        let compositor =
            globals.compositor.ok_or_else(|| PaneError::Unsupported("no wl_compositor".into()))?;
        let subcompositor = globals
            .subcompositor
            .ok_or_else(|| PaneError::Unsupported("no wl_subcompositor".into()))?;

        // SAFETY: a live GTK-owned `wl_surface` on the connection this backend wraps.
        let parent = unsafe {
            let id = ObjectId::from_ptr(WlSurface::interface(), parent_ptr as *mut _)
                .map_err(|e| PaneError::Host(format!("bad wl_surface pointer: {e}")))?;
            WlSurface::from_id(&connection, id)
                .map_err(|e| PaneError::Host(format!("cannot adopt GTK's wl_surface: {e}")))?
        };

        let child = compositor.create_surface(&qh, ());
        let subsurface = subcompositor.get_subsurface(&child, &parent, &qh, ());

        let scale = gdk_window.scale_factor();
        let (ox, oy) = webview_offset(gtk_window, scale);
        subsurface.set_position(rect.x + ox, rect.y + oy);

        // (0, 0) means the offset was read before GTK allocated the widget.
        tracing::info!(
            pane.offset_x = ox,
            pane.offset_y = oy,
            pane.scale = scale,
            "pane.webview_offset"
        );

        // Measured, load-bearing: in the default *synchronized* mode the child's commits
        // wait on the parent's and the render loop starves — 0.65 fps against 60 desynced.
        subsurface.set_desync();

        // Empty input region: events pass through to the webview underneath.
        let region = compositor.create_region(&qh, ());
        child.set_input_region(Some(&region));
        region.destroy();

        // Placement is parent state — it lands on the parent's next commit.
        parent.commit();
        connection.flush().map_err(|e| PaneError::Host(format!("wayland flush failed: {e}")))?;

        Ok(Self {
            connection,
            parent,
            child,
            subsurface,
            display_ptr,
            gtk_window: gtk_window.clone(),
            rect,
            visible: true,
        })
    }

    /// # Safety
    ///
    /// The result borrows surfaces owned by `self`, so `self` must outlive it and the
    /// Bevy app built from it — frames-in-flight, see `tt_jarvis::surface`.
    pub unsafe fn foreign_surface(&self) -> ForeignSurface {
        use tt_jarvis::surface::{RawDisplayHandle, RawWindowHandle};
        use tt_jarvis::surface::{WaylandDisplayHandle, WaylandWindowHandle};

        ForeignSurface::new(
            RawWindowHandle::Wayland(WaylandWindowHandle::new(
                std::ptr::NonNull::new(self.child.id().as_ptr() as *mut c_void)
                    .expect("wl_surface pointer is never null"),
            )),
            RawDisplayHandle::Wayland(WaylandDisplayHandle::new(
                std::ptr::NonNull::new(self.display_ptr).expect("wl_display pointer is never null"),
            )),
        )
    }

    /// Move the pane. Size changes are the renderer's business, not ours.
    pub fn set_rect(&mut self, rect: PaneRect) -> Result<(), PaneError> {
        self.rect = rect;
        self.reposition()
    }

    /// Show or hide the pane by *moving* it. Both alternatives were tried and failed: a
    /// null buffer left the surface on screen, and detaching tore down the wgpu device
    /// and the process with it. Pair with pausing the renderer, so hiding costs no GPU.
    pub fn set_visible(&mut self, visible: bool) -> Result<(), PaneError> {
        if visible == self.visible {
            return Ok(());
        }
        self.visible = visible;
        self.reposition()
    }

    /// Both callers go through here so a move while hidden can't drag the pane into view.
    fn reposition(&mut self) -> Result<(), PaneError> {
        let (x, y) = if self.visible {
            let scale = self.gtk_window.window().map(|w| w.scale_factor()).unwrap_or(1);
            let (ox, oy) = webview_offset(&self.gtk_window, scale);
            (self.rect.x + ox, self.rect.y + oy)
        } else {
            (OFFSCREEN, OFFSCREEN)
        };
        self.subsurface.set_position(x, y);
        self.parent.commit();
        self.connection.flush().map_err(|e| PaneError::Host(format!("wayland flush failed: {e}")))
    }
}

impl Drop for Subsurface {
    fn drop(&mut self) {
        // Role before the surface it applies to; `parent` is GTK's and stays.
        self.subsurface.destroy();
        self.child.destroy();
        let _ = self.connection.flush();
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
delegate_noop!(Globals: ignore WlRegion);
