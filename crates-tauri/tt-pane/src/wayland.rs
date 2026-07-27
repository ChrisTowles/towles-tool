//! Wayland embedding: a `wl_subsurface` of the Tauri window's own toplevel.
//!
//! Ported from `tt-jarvis`'s `bench_gtk_cadence` harness, which measured this
//! exact arrangement — see that file for the experiment that justifies
//! [`Subsurface::set_desync`] being non-negotiable below.
//!
//! # Why we adopt GDK's connection instead of opening our own
//!
//! Subsurface parentage is **per-client**: a surface can only be made a child of
//! another surface on the same Wayland connection. GTK owns the toplevel, so we
//! must reach Wayland through GDK's existing `wl_display` rather than calling
//! `Connection::connect_to_env()`, which would give us a second client that
//! cannot see GTK's surface at all.
//!
//! # Threading
//!
//! Everything in this module is **main-thread only**. The surface is created,
//! moved and destroyed on the GTK main thread; the render thread receives only
//! the resulting handles (which is what `ForeignSurface`'s `Send` claim rests
//! on) and never touches these proxies.

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

// The only two GDK symbols needed. Declared by hand rather than adding a
// `gdk-wayland` binding crate: both live in libgdk-3, which `gtk` already links.
extern "C" {
    fn gdk_wayland_display_get_wl_display(display: *mut c_void) -> *mut c_void;
    fn gdk_wayland_window_get_wl_surface(window: *mut c_void) -> *mut c_void;
}

/// A subsurface pinned to a rectangle of the host window.
///
/// Main-thread only; the `Send` impl below explains what upholds that.
pub struct Subsurface {
    connection: Connection,
    parent: WlSurface,
    child: WlSurface,
    subsurface: WlSubsurface,
    display_ptr: *mut c_void,
    /// The host window, kept so the webview offset can be re-read on every move
    /// — see [`Subsurface::webview_offset`].
    gtk_window: gtk::ApplicationWindow,
    /// Where the pane belongs when shown. Kept because hiding *moves* it (see
    /// [`Subsurface::set_visible`]), so the real rect has to survive being
    /// off screen.
    rect: PaneRect,
    visible: bool,
}

/// Where a hidden pane is parked, in surface-local coordinates.
///
/// Far enough outside the toplevel that no output can intersect it, so the
/// compositor simply has nothing to draw. Deliberately not `i32::MAX` — the
/// position is added to the webview offset, and an overflow would wrap the pane
/// back onto the screen.
const OFFSCREEN: i32 = 1 << 20;

/// Offset from the toplevel surface's origin to the webview's.
///
/// The frontend measures with `getBoundingClientRect()`, relative to the
/// **webview**; `wl_subsurface.set_position` is relative to the **parent
/// surface**, which is the whole GTK toplevel — client-side decoration shadow,
/// title bar and all. Positioning by the raw DOM rect therefore lands the pane
/// up and to the left of its slot by exactly the decoration's extent.
///
/// Read fresh rather than cached: the offset changes when the window is
/// maximized or tiled (CSD shadows collapse), and a move is cheap.
///
/// **Known limit — correct only at scale 1.** This returns physical pixels to
/// match `PaneRect`, but `set_position` takes *surface-local* (logical) units,
/// and `wl_surface.set_buffer_scale` is never called either. Both are identity
/// on a scale-1 display and wrong on HiDPI. Fixing them is one job: separate
/// the renderer's physical rect from the compositor's logical one.
fn webview_offset(gtk_window: &gtk::ApplicationWindow, scale: i32) -> (i32, i32) {
    // Tauri nests the webview inside the window's single child container, so
    // that child's position in toplevel coordinates *is* the webview origin.
    let Some(child) = gtk_window.child() else {
        return (0, 0);
    };
    let (x, y) = child.translate_coordinates(gtk_window, 0, 0).unwrap_or((0, 0));
    (x * scale, y * scale)
}

// SAFETY: this is a claim about *where* a `Subsurface` is used, not about it
// being thread-safe — it holds GDK's raw `wl_display` and Wayland proxies, and
// GTK is main-thread-only.
//
// `Send` is required because the pane registry lives in Tauri's managed state,
// which must be `Send + Sync`. The invariant that makes it sound: **every
// method on this type is invoked from the GTK main thread**, because
// `PaneHost`'s callers marshal through `run_on_main_thread` (see `lib.rs`).
// Tauri commands run on a worker pool, so calling these directly from a command
// body would violate this — that is exactly the bug the compiler caught when
// this impl was absent, and the reason the marshalling exists rather than this
// impl alone.
unsafe impl Send for Subsurface {}

impl Subsurface {
    /// Create the pane surface as a child of `gtk_window`'s toplevel.
    pub fn new(gtk_window: &gtk::ApplicationWindow, rect: PaneRect) -> Result<Self, PaneError> {
        let gdk_window = gtk_window
            .window()
            .ok_or_else(|| PaneError::Host("host window is not realized yet".into()))?;

        // SAFETY: both pointers are GDK-owned and live as long as the window.
        // These accessors borrow; there is nothing to free.
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

        // SAFETY: the display belongs to GDK and outlives this backend; we never
        // close it, and `Connection` here is a borrow of GDK's client.
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

        // SAFETY: a live `wl_surface` proxy on the connection this backend
        // wraps. GTK owns it; we borrow it and leave its lifetime to GTK.
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

        // Logged because the pane is often on a workspace nobody is looking at,
        // and (0, 0) here is the signature of the offset being read before GTK
        // has allocated the widget — which looks identical to "no decorations".
        tracing::info!(
            pane.offset_x = ox,
            pane.offset_y = oy,
            pane.scale = scale,
            "pane.webview_offset"
        );

        // Load-bearing, and measured: with the default *synchronized* mode the
        // child's commits wait on the parent's, and the render loop does not
        // merely slow down — it starves. The GTK cadence harness recorded
        // 0.65 fps and 1-second frames in sync mode against 60 fps desynced.
        subsurface.set_desync();

        // Empty input region: pointer and keyboard events pass straight through
        // to the webview, so the DOM underneath keeps its hover states and the
        // pane never steals a click it cannot use.
        let region = compositor.create_region(&qh, ());
        child.set_input_region(Some(&region));
        region.destroy();

        // Subsurface placement is parent state — it lands on the parent's next
        // commit, which GTK performs on its own schedule.
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

    /// Handles for the renderer.
    ///
    /// # Safety
    ///
    /// The result borrows surfaces owned by `self`, so `self` must outlive it
    /// and the Bevy app built from it — frames-in-flight rule, see
    /// `tt_jarvis::surface`.
    ///
    /// # Panics
    ///
    /// If the `wl_surface` or `wl_display` pointer is null, which would mean
    /// GTK handed us a surface it never finished realizing.
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

    /// Show or hide the pane by *moving* it, not by unmapping it.
    ///
    /// Two more obvious mechanisms were tried against a compositor screenshot
    /// and both failed, which is why this one looks indirect:
    ///
    /// - **Attach a null buffer** (`wl_surface.attach(None)` + commit, the
    ///   textbook unmap) left the surface on screen unchanged — even with the
    ///   render thread stopped first, so nothing could have re-attached one.
    /// - **Detach the pane entirely** does remove it, but tearing down the Bevy
    ///   app and its wgpu device took the whole process with it (the app exited
    ///   moments after "pane render thread stopped"), which is not a risk a
    ///   screen switch may take.
    ///
    /// Parking it outside every output has neither problem: the compositor has
    /// nothing to intersect, the swapchain and the Bevy app stay intact, and
    /// coming back is one more `set_position`. Pair it with pausing the
    /// renderer ([`crate::PaneHost::set_visible`]) so a hidden pane costs no
    /// GPU either.
    pub fn set_visible(&mut self, visible: bool) -> Result<(), PaneError> {
        if visible == self.visible {
            return Ok(());
        }
        self.visible = visible;
        self.reposition()
    }

    /// Push the current position — the real rect when shown, [`OFFSCREEN`] when
    /// hidden. Both callers go through here so a move while hidden can't drag
    /// the pane back into view.
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
        // Order matters: the subsurface role goes before the surface it applies
        // to. `parent` is GTK's and is deliberately not destroyed.
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
