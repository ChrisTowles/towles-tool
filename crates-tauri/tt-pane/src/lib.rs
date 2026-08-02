//! Embeds `tt-jarvis`'s Bevy renderer in a native surface inside the Tauri window,
//! glued to a rectangle the frontend measures. **Bevy runs on its own thread, never the
//! GTK main thread**: under vsync `App::update()` blocks until the compositor's next
//! frame callback, so driving it from a GTK tick would starve the webview. That splits
//! ownership, load-bearingly: the **main thread** owns the Wayland proxies — creation,
//! position, visibility, teardown — while the **render thread** owns the Bevy `App` and
//! swapchain, taking [`PaneRect`](tt_jarvis::surface::PaneRect) over a channel.
//!
//! Teardown happens once, at exit: dropping a `Pane` stops the render thread and *joins
//! it* before releasing the subsurface (frames-in-flight). Nothing drops one while the
//! app runs — dropping a Bevy app takes the process with it — so panes are retired
//! ([`PaneHost::detach`]). Linux-only; elsewhere [`PaneHost`] is a stub.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

#[cfg(target_os = "linux")]
use std::sync::mpsc::{self, Sender};
#[cfg(target_os = "linux")]
use std::sync::Mutex;
#[cfg(target_os = "linux")]
use std::thread::JoinHandle;

#[cfg(target_os = "linux")]
use tt_jarvis::surface::PaneRect;

#[cfg(target_os = "linux")]
pub mod wayland;

#[cfg(target_os = "linux")]
mod render;

#[derive(Debug, thiserror::Error)]
pub enum PaneError {
    #[error("native pane is not supported here: {0}")]
    Unsupported(String),
    #[error("host window error: {0}")]
    Host(String),
    #[error("no pane with id {0}")]
    Unknown(String),
}

impl From<PaneError> for String {
    fn from(e: PaneError) -> String {
        e.to_string()
    }
}

/// A rect as the frontend measures it: CSS pixels, relative to the window's client
/// area. Converted to physical pixels here so the rounding decision lives on one side
/// of the wire — [`PaneRect::from_css`](tt_jarvis::surface::PaneRect::from_css).
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct CssRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PaneInfo {
    pub id: String,
    pub backend: &'static str,
    pub width: u32,
    pub height: u32,
}

/// What the main thread sends the render thread.
#[cfg(target_os = "linux")]
enum RenderMsg {
    Resize(PaneRect),
    /// Stop presenting and park until [`RenderMsg::Resume`]. Deliberately
    /// unacknowledged: waiting risks a permanent main-thread stall if the surface is
    /// occluded and gets no frame callbacks.
    Pause,
    Resume,
    Stop,
}

/// One embedded pane.
#[cfg(target_os = "linux")]
pub struct Pane {
    surface: wayland::Subsurface,
    tx: Sender<RenderMsg>,
    thread: Option<JoinHandle<()>>,
    rect: PaneRect,
}

#[cfg(target_os = "linux")]
impl Pane {
    /// The single home of the hide sequence: park the renderer first, then move the
    /// surface, or a mid-flight frame lands in the position being vacated.
    fn park(&mut self) -> Result<(), PaneError> {
        let _ = self.tx.send(RenderMsg::Pause);
        self.surface.set_visible(false)
    }

    /// The inverse of [`Pane::park`], and what makes a retired pane revivable.
    fn unpark(&mut self, rect: PaneRect) -> Result<(), PaneError> {
        self.surface.set_rect(rect)?;
        self.surface.set_visible(true)?;
        if self.rect != rect {
            let _ = self.tx.send(RenderMsg::Resize(rect));
            self.rect = rect;
        }
        let _ = self.tx.send(RenderMsg::Resume);
        Ok(())
    }
}

#[cfg(target_os = "linux")]
impl Drop for Pane {
    fn drop(&mut self) {
        // The one real teardown path, and it runs only at shutdown — see
        // `PaneHost::detach` for why.
        let _ = self.tx.send(RenderMsg::Stop);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Process-wide pane registry, keyed by the frontend's pane id. Fieldless off Linux,
/// where [`PaneHost::attach`] can only fail.
#[derive(Default)]
pub struct PaneHost {
    #[cfg(target_os = "linux")]
    panes: Mutex<Vec<(String, Pane)>>,
}

impl PaneHost {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn shared() -> Arc<Self> {
        Arc::new(Self::new())
    }
}

#[cfg(not(target_os = "linux"))]
mod unsupported {
    //! macOS/Windows are not wired yet. The macOS design (an `NSView` with a
    //! `CAMetalLayer` above the `WKWebView`) has never run on a Mac, and drawing
    //! nothing silently would be worse than reporting it missing.
    use super::*;

    impl PaneHost {
        pub fn attach(
            &self,
            _window: &tauri::WebviewWindow,
            _id: &str,
            _rect: CssRect,
            _scale: f64,
        ) -> Result<PaneInfo, PaneError> {
            Err(PaneError::Unsupported(
                "the native Bevy pane is currently Linux/Wayland only".into(),
            ))
        }

        pub fn set_rect(&self, _id: &str, _rect: CssRect, _scale: f64) -> Result<(), PaneError> {
            Ok(())
        }
        pub fn set_visible(&self, _id: &str, _visible: bool) -> Result<(), PaneError> {
            Ok(())
        }
        pub fn detach(&self, _id: &str) -> Result<(), PaneError> {
            Ok(())
        }
    }
}

#[cfg(target_os = "linux")]
impl PaneHost {
    /// Create the pane's surface and start its renderer. Idempotent per id: a
    /// strict-mode double-mount cannot spawn two renderers against one rectangle, and
    /// reopening a closed pane reuses the renderer it still has ([`PaneHost::detach`]).
    pub fn attach(
        &self,
        window: &tauri::WebviewWindow,
        id: &str,
        rect: CssRect,
        scale: f64,
    ) -> Result<PaneInfo, PaneError> {
        let rect = PaneRect::from_css(rect.x, rect.y, rect.width, rect.height, scale);

        let mut panes = self.panes.lock().unwrap();
        // Also the revival path for a retired pane, hence unpark, not reposition.
        if let Some((_, pane)) = panes.iter_mut().find(|(k, _)| k == id) {
            pane.unpark(rect)?;
            return Ok(PaneInfo {
                id: id.to_string(),
                backend: "wayland",
                width: rect.width,
                height: rect.height,
            });
        }

        let gtk_window =
            window.gtk_window().map_err(|e| PaneError::Host(format!("no gtk window: {e}")))?;
        let surface = wayland::Subsurface::new(&gtk_window, rect)?;

        // SAFETY: `surface` is owned by the `Pane` about to be built, whose drop joins
        // the render thread before releasing it.
        let foreign = unsafe { surface.foreign_surface() };

        let (tx, rx) = mpsc::channel();
        let thread = render::spawn(foreign, rect, rx);

        panes.push((id.to_string(), Pane { surface, tx, thread: Some(thread), rect }));

        tracing::info!(
            pane.id = id,
            pane.width = rect.width,
            pane.height = rect.height,
            "pane.attach"
        );
        Ok(PaneInfo {
            id: id.to_string(),
            backend: "wayland",
            width: rect.width,
            height: rect.height,
        })
    }

    pub fn set_rect(&self, id: &str, rect: CssRect, scale: f64) -> Result<(), PaneError> {
        let rect = PaneRect::from_css(rect.x, rect.y, rect.width, rect.height, scale);
        let mut panes = self.panes.lock().unwrap();
        let (_, pane) = panes
            .iter_mut()
            .find(|(k, _)| k == id)
            .ok_or_else(|| PaneError::Unknown(id.to_string()))?;

        if pane.rect == rect {
            return Ok(()); // The frontend re-measures far more often than it moves.
        }
        pane.surface.set_rect(rect)?;
        if pane.rect.width != rect.width || pane.rect.height != rect.height {
            let _ = pane.tx.send(RenderMsg::Resize(rect));
        }
        pane.rect = rect;
        Ok(())
    }

    /// Show or hide the pane — [`Pane::park`]/[`Pane::unpark`] own the ordering rule,
    /// and [`wayland::Subsurface::set_visible`] why hiding is a move, not an unmap.
    pub fn set_visible(&self, id: &str, visible: bool) -> Result<(), PaneError> {
        let mut panes = self.panes.lock().unwrap();
        let (_, pane) = panes
            .iter_mut()
            .find(|(k, _)| k == id)
            .ok_or_else(|| PaneError::Unknown(id.to_string()))?;
        if visible {
            let rect = pane.rect;
            return pane.unpark(rect);
        }
        pane.park()
    }

    /// Retire a pane: take it off screen and stop its renderer, but **keep it**.
    ///
    /// It reads like a leak and is the opposite — the destructor is what's dangerous.
    /// Dropping the Bevy app tears down a wgpu device built on GDK's own Wayland display,
    /// which mid-session ended the *process*. Real teardown happens once, at exit.
    pub fn detach(&self, id: &str) -> Result<(), PaneError> {
        let mut panes = self.panes.lock().unwrap();
        let Some((_, pane)) = panes.iter_mut().find(|(k, _)| k == id) else {
            return Ok(()); // Detaching an absent pane is success, not an error.
        };
        pane.park()?;
        tracing::info!(pane.id = id, "pane.retired");
        Ok(())
    }
}

/// The Tauri command surface. In its own module because `#[tauri::command]`'s generated
/// helper macros collide with the function items themselves in a library's *root*
/// module. Register from `tt-app` as `tt_pane::commands::pane_attach`.
pub mod commands {
    use super::{CssRect, PaneError, PaneHost, PaneInfo};
    use std::sync::Arc;
    use tauri::Manager as _;

    type Host<'a> = tauri::State<'a, Arc<PaneHost>>;

    /// Run `f` on the GTK main thread and wait for its result. **Every entry point
    /// below must go through this**: Tauri commands run on a worker pool, and
    /// `PaneHost`'s methods touch main-thread-only GTK and Wayland proxies.
    fn on_main<T, F>(window: &tauri::WebviewWindow, f: F) -> Result<T, PaneError>
    where
        T: Send + 'static,
        F: FnOnce() -> Result<T, PaneError> + Send + 'static,
    {
        let (tx, rx) = std::sync::mpsc::channel();
        window
            .app_handle()
            .run_on_main_thread(move || {
                let _ = tx.send(f());
            })
            .map_err(|e| PaneError::Host(format!("cannot reach the main thread: {e}")))?;
        rx.recv().map_err(|_| PaneError::Host("main thread dropped the pane request".into()))?
    }

    #[tauri::command]
    pub async fn pane_attach(
        window: tauri::WebviewWindow,
        host: Host<'_>,
        id: String,
        rect: CssRect,
        scale: f64,
    ) -> Result<PaneInfo, String> {
        let host = Arc::clone(&host);
        let target = window.clone();
        on_main(&window, move || host.attach(&target, &id, rect, scale)).map_err(Into::into)
    }

    #[tauri::command]
    pub async fn pane_set_rect(
        window: tauri::WebviewWindow,
        host: Host<'_>,
        id: String,
        rect: CssRect,
        scale: f64,
    ) -> Result<(), String> {
        let host = Arc::clone(&host);
        on_main(&window, move || host.set_rect(&id, rect, scale)).map_err(Into::into)
    }

    #[tauri::command]
    pub async fn pane_set_visible(
        window: tauri::WebviewWindow,
        host: Host<'_>,
        id: String,
        visible: bool,
    ) -> Result<(), String> {
        let host = Arc::clone(&host);
        on_main(&window, move || host.set_visible(&id, visible)).map_err(Into::into)
    }

    #[tauri::command]
    pub async fn pane_detach(
        window: tauri::WebviewWindow,
        host: Host<'_>,
        id: String,
    ) -> Result<(), String> {
        let host = Arc::clone(&host);
        on_main(&window, move || host.detach(&id)).map_err(Into::into)
    }
}
