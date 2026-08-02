//! A surface Bevy did not create, dressed up as something Bevy will accept.
//!
//! **Why this works unforked:** `bevy_render`'s `extract_windows` queries `(Entity,
//! &Window, &RawHandleWrapper, Option<&PrimaryWindow>)` and never mentions winit;
//! `create_surfaces` then builds the `wgpu::Surface` from whatever raw handle it carries.
//! So an entity with `Window` + [`RawHandleWrapper`] + `PrimaryWindow`, in an app with
//! **no `WinitPlugin`**, is a complete window to the renderer.
//!
//! **Safety:** [`ForeignSurface`] is a pair of borrowed raw handles and owns nothing. The
//! platform code that created it must outlive it *and* the Bevy app holding it — the
//! renderer keeps frames in flight, so a surface torn down mid-frame is a use-after-free,
//! not a blank pane.

use raw_window_handle::{
    DisplayHandle, HandleError, HasDisplayHandle, HasWindowHandle, WindowHandle,
};

#[cfg(target_os = "macos")]
pub use raw_window_handle::{AppKitDisplayHandle, AppKitWindowHandle};
/// Re-exported so embedders (`tt-pane`) build handles from *this* crate's
/// `raw-window-handle`: two majors in the tree are two distinct `RawWindowHandle` types,
/// and the handle would silently fail to cross into Bevy.
pub use raw_window_handle::{RawDisplayHandle, RawWindowHandle};
pub use raw_window_handle::{WaylandDisplayHandle, WaylandWindowHandle};

/// Raw handles for a surface owned by someone else. The `Send + Sync` asserted below is a
/// real claim about the platform layer: the surface is created and destroyed on the main
/// thread, and the render thread only ever *presents* to it.
#[derive(Debug, Clone, Copy)]
pub struct ForeignSurface {
    window: RawWindowHandle,
    display: RawDisplayHandle,
}

impl ForeignSurface {
    /// # Safety
    ///
    /// Both handles must be valid, must refer to the same surface, and must outlive this
    /// value and any Bevy app built from it. See the module docs for who guarantees that.
    pub unsafe fn new(window: RawWindowHandle, display: RawDisplayHandle) -> Self {
        Self { window, display }
    }
}

// SAFETY: the platform layer confines creation and destruction to the main thread.
unsafe impl Send for ForeignSurface {}
// SAFETY: shared access is read-only, so `&ForeignSurface` cannot race the handles.
unsafe impl Sync for ForeignSurface {}

impl HasWindowHandle for ForeignSurface {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        // SAFETY: `ForeignSurface::new`'s caller promised this handle outlives `self`.
        Ok(unsafe { WindowHandle::borrow_raw(self.window) })
    }
}

impl HasDisplayHandle for ForeignSurface {
    fn display_handle(&self) -> Result<DisplayHandle<'_>, HandleError> {
        // SAFETY: as above.
        Ok(unsafe { DisplayHandle::borrow_raw(self.display) })
    }
}

/// Physical pixels, origin at the top-left of the host window's client area. The scale
/// conversion happens once, in Rust, at the IPC boundary — rounding in the frontend
/// desyncs the surface from its placeholder by a pixel under fractional scaling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PaneRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl PaneRect {
    /// Convert a CSS-pixel rect from the frontend into physical pixels. Width and height
    /// clamp to 1: wgpu rejects a zero-sized swapchain, and a pane mid-layout measures 0.
    pub fn from_css(x: f64, y: f64, width: f64, height: f64, scale: f64) -> Self {
        Self {
            x: (x * scale).round() as i32,
            y: (y * scale).round() as i32,
            width: ((width * scale).round() as i64).max(1) as u32,
            height: ((height * scale).round() as i64).max(1) as u32,
        }
    }

    /// Flip to AppKit's bottom-left origin, given the host content view's height in the
    /// same units. Kept here so both origins are written down in one place.
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
        // COSMIC's default fractional scale; truncating here shows up as a seam.
        let r = PaneRect::from_css(0.0, 0.0, 100.0, 100.0, 1.25);
        assert_eq!(r.width, 125);
        assert_eq!(r.height, 125);
    }

    #[test]
    fn zero_sized_rect_is_clamped_to_one_pixel() {
        let r = PaneRect::from_css(0.0, 0.0, 0.0, 0.0, 1.0);
        assert_eq!(r.width, 1);
        assert_eq!(r.height, 1);
    }

    #[test]
    fn negative_position_is_preserved() {
        // A pane scrolled above its container has negative y; clamping is the caller's call.
        let r = PaneRect::from_css(-50.0, -30.0, 100.0, 100.0, 1.0);
        assert_eq!(r.x, -50);
        assert_eq!(r.y, -30);
    }

    #[test]
    fn y_flip_moves_the_origin_to_the_bottom() {
        let r = PaneRect { x: 0, y: 10, width: 200, height: 100 };
        assert_eq!(r.to_bottom_left_origin(800).y, 690);
    }

    #[test]
    fn y_flip_round_trips() {
        let r = PaneRect { x: 5, y: 120, width: 60, height: 40 };
        assert_eq!(r.to_bottom_left_origin(600).to_bottom_left_origin(600), r);
    }
}
