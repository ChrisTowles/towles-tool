//! A surface Bevy did not create, dressed up as something Bevy will accept.
//!
//! # Why this works without forking Bevy
//!
//! `bevy_render`'s `extract_windows` system queries
//! `(Entity, &Window, &RawHandleWrapper, Option<&PrimaryWindow>)`. It never
//! mentions winit. `WindowSurfaces`/`create_surfaces` then builds the
//! `wgpu::Surface` from whatever raw handle that component carries.
//!
//! So an entity carrying `Window` + [`RawHandleWrapper`] + `PrimaryWindow`, in
//! an app with **no `WinitPlugin`**, is a complete window as far as the renderer
//! is concerned. `RawHandleWrapper::new` accepts any
//! `HasWindowHandle + HasDisplayHandle + 'static` via `WindowWrapper`, and both
//! are public API — which is what [`ForeignSurface`] exists to satisfy.
//!
//! # Safety
//!
//! [`ForeignSurface`] is a pair of borrowed raw handles. It does not own the
//! surface and cannot keep it alive. **The platform code that created the
//! underlying surface must outlive every `ForeignSurface` derived from it**, and
//! outlive the Bevy app holding it — the renderer keeps frames in flight, so a
//! surface torn down mid-frame is a use-after-free, not a blank pane. The
//! embedding layer (`tt-pane`) owns that ordering: it must drop the Bevy app
//! before releasing the subsurface/`NSView`.

use raw_window_handle::{
    DisplayHandle, HandleError, HasDisplayHandle, HasWindowHandle, WindowHandle,
};

#[cfg(target_os = "macos")]
pub use raw_window_handle::{AppKitDisplayHandle, AppKitWindowHandle};
/// Handle types re-exported so embedders (`tt-pane`) build handles from *this*
/// crate's `raw-window-handle` instead of declaring their own dependency on it.
///
/// Same hazard as wgpu: two `raw-window-handle` majors in the tree are two
/// distinct `RawWindowHandle` types, and the handle would silently fail to
/// cross into Bevy. Depending on the re-export makes that mismatch unwritable.
pub use raw_window_handle::{RawDisplayHandle, RawWindowHandle};
pub use raw_window_handle::{WaylandDisplayHandle, WaylandWindowHandle};

/// Raw handles for a surface owned by someone else.
///
/// `Send + Sync` is asserted below rather than derived. The handles are bare
/// pointers, so this is a real claim about the platform layer: on both targets
/// the surface must be created on, and destroyed on, the main thread, while the
/// render thread only ever *presents* to it. That is the same contract winit
/// upholds for the handles it hands Bevy.
#[derive(Debug, Clone, Copy)]
pub struct ForeignSurface {
    window: RawWindowHandle,
    display: RawDisplayHandle,
}

impl ForeignSurface {
    /// # Safety
    ///
    /// Both handles must be valid, must refer to the same surface, and must
    /// remain valid for as long as this value and any Bevy app built from it.
    /// See the module-level safety notes for who guarantees that.
    pub unsafe fn new(window: RawWindowHandle, display: RawDisplayHandle) -> Self {
        Self { window, display }
    }

    pub fn raw_window_handle(&self) -> RawWindowHandle {
        self.window
    }

    pub fn raw_display_handle(&self) -> RawDisplayHandle {
        self.display
    }
}

// SAFETY: see the type-level note. The platform layer confines creation and
// destruction to the main thread; the handles are only read after that.
unsafe impl Send for ForeignSurface {}
unsafe impl Sync for ForeignSurface {}

impl HasWindowHandle for ForeignSurface {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        // SAFETY: the caller of `ForeignSurface::new` promised this handle
        // outlives `self`, and the borrow is tied to `&self` here.
        Ok(unsafe { WindowHandle::borrow_raw(self.window) })
    }
}

impl HasDisplayHandle for ForeignSurface {
    fn display_handle(&self) -> Result<DisplayHandle<'_>, HandleError> {
        // SAFETY: as above.
        Ok(unsafe { DisplayHandle::borrow_raw(self.display) })
    }
}

/// Physical pixels, origin at the top-left of the host window's client area.
///
/// Physical, not CSS/logical: the frontend measures in CSS pixels and the
/// conversion by scale factor happens once, in Rust, at the IPC boundary. Doing
/// it in the frontend would put a rounding decision on the wrong side of the
/// wire and desync the surface from its placeholder by a pixel on fractional
/// scaling — which COSMIC does by default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PaneRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl PaneRect {
    /// Convert a CSS-pixel rect from the frontend into physical pixels.
    ///
    /// Width and height are floored to at least 1: a zero-sized swapchain is a
    /// validation error in wgpu, and a pane can legitimately measure 0 for a
    /// frame while its container is still laying out.
    pub fn from_css(x: f64, y: f64, width: f64, height: f64, scale: f64) -> Self {
        Self {
            x: (x * scale).round() as i32,
            y: (y * scale).round() as i32,
            width: ((width * scale).round() as i64).max(1) as u32,
            height: ((height * scale).round() as i64).max(1) as u32,
        }
    }

    /// Flip to AppKit's bottom-left origin, given the host content view's height
    /// in the same units.
    ///
    /// Kept here, next to the top-left definition, rather than inside the macOS
    /// backend — it is pure arithmetic and this is the one place both origins
    /// are written down together.
    pub fn to_bottom_left_origin(self, host_height: u32) -> Self {
        Self { y: host_height as i32 - self.y - self.height as i32, ..self }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn css_to_physical_at_1x_is_identity() {
        let r = PaneRect::from_css(10.0, 20.0, 300.0, 400.0, 1.0);
        assert_eq!(r, PaneRect { x: 10, y: 20, width: 300, height: 400 });
    }

    #[test]
    fn css_to_physical_scales_and_rounds() {
        let r = PaneRect::from_css(10.5, 20.5, 100.25, 50.75, 2.0);
        assert_eq!(r, PaneRect { x: 21, y: 41, width: 201, height: 102 });
    }

    #[test]
    fn fractional_scaling_rounds_rather_than_truncates() {
        // COSMIC's default fractional scale. Truncating here drifts the surface
        // off its DOM placeholder by a pixel, which is visible as a seam.
        let r = PaneRect::from_css(0.0, 0.0, 100.0, 100.0, 1.25);
        assert_eq!(r.width, 125);
        assert_eq!(r.height, 125);
    }

    #[test]
    fn zero_sized_rect_is_clamped_to_one_pixel() {
        // A container mid-layout legitimately measures zero; wgpu rejects a
        // zero-sized swapchain outright.
        let r = PaneRect::from_css(0.0, 0.0, 0.0, 0.0, 1.0);
        assert_eq!(r.width, 1);
        assert_eq!(r.height, 1);
    }

    #[test]
    fn negative_position_is_preserved() {
        // A pane scrolled partly above its container has a negative y; the
        // platform layer decides what to do, this type must not silently clamp.
        let r = PaneRect::from_css(-50.0, -30.0, 100.0, 100.0, 1.0);
        assert_eq!(r.x, -50);
        assert_eq!(r.y, -30);
    }

    #[test]
    fn y_flip_moves_the_origin_to_the_bottom() {
        // A 100-tall pane at y=10 in an 800-tall host sits 690 from the bottom.
        let r = PaneRect { x: 0, y: 10, width: 200, height: 100 };
        assert_eq!(r.to_bottom_left_origin(800).y, 690);
    }

    #[test]
    fn y_flip_round_trips() {
        let r = PaneRect { x: 5, y: 120, width: 60, height: 40 };
        assert_eq!(r.to_bottom_left_origin(600).to_bottom_left_origin(600), r);
    }
}
