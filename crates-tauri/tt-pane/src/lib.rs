//! Embeds `tt-jarvis`'s Bevy renderer in a native surface inside the Tauri
//! window, glued to a rectangle the frontend measures.
//!
//! # Thread ownership
//!
//! **Bevy runs on its own thread, never the GTK main thread.** Under vsync,
//! `App::update()` blocks until the compositor's next frame callback — roughly
//! 16ms. Driving it from a GTK tick would spend the entire main loop inside the
//! renderer and starve the webview, so the app would render beautifully and
//! respond to nothing.
//!
//! That splits ownership, and the split is load-bearing:
//!
//! - **Main thread** owns the Wayland proxies ([`wayland::Subsurface`]):
//!   creation, position, visibility, teardown. GTK's own surface is only ever
//!   touched here.
//! - **Render thread** owns the Bevy `App` and the swapchain. It receives
//!   [`PaneRect`] updates over a channel and only ever *resizes*; it never moves
//!   the surface and never speaks to GDK.
//!
//! # Teardown order
//!
//! [`Pane::detach`] stops the render thread and *joins it* before dropping the
//! subsurface — the frames-in-flight rule in `tt_jarvis::surface`.

use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use serde::{Deserialize, Serialize};
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

/// A rect as the frontend measures it: CSS pixels, relative to the window's
/// client area.
///
/// Converted to physical pixels here rather than in the frontend, so the
/// rounding decision lives on one side of the wire. See [`PaneRect::from_css`].
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
enum RenderMsg {
    Resize(PaneRect),
    Stop,
}

/// One embedded pane.
pub struct Pane {
    #[cfg(target_os = "linux")]
    surface: wayland::Subsurface,
    tx: Sender<RenderMsg>,
    thread: Option<JoinHandle<()>>,
    rect: PaneRect,
}

impl Pane {
    /// Stop rendering, then release the surface — in that order.
    pub fn detach(mut self) {
        let _ = self.tx.send(RenderMsg::Stop);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        // `surface` drops here, after the renderer has stopped.
    }
}

impl Drop for Pane {
    fn drop(&mut self) {
        // Belt and braces for a `Pane` dropped without `detach` (e.g. the
        // registry being cleared on window close).
        let _ = self.tx.send(RenderMsg::Stop);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Process-wide pane registry, keyed by the frontend's pane id.
#[derive(Default)]
pub struct PaneHost {
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
    //! macOS/Windows are not wired yet.
    //!
    //! The macOS design is written down (an `NSView` with a `CAMetalLayer`
    //! added to the window's `contentView`, `addSubview:positioned:` above the
    //! `WKWebView`, Y-flipped rect, `contentsScale` tracking
    //! `backingScaleFactor`) but no code here has run on a Mac, and shipping an
    //! untested implementation that silently draws nothing would be worse than
    //! reporting honestly that it is missing.
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
    /// Create the pane's surface and start its renderer.
    ///
    /// Idempotent per id: re-attaching an existing pane just repositions it, so
    /// a React strict-mode double-mount or a screen remount cannot spawn two
    /// renderers against one rectangle.
    pub fn attach(
        &self,
        window: &tauri::WebviewWindow,
        id: &str,
        rect: CssRect,
        scale: f64,
    ) -> Result<PaneInfo, PaneError> {
        let rect = PaneRect::from_css(rect.x, rect.y, rect.width, rect.height, scale);

        let mut panes = self.panes.lock().unwrap();
        if let Some((_, pane)) = panes.iter_mut().find(|(k, _)| k == id) {
            pane.surface.set_rect(rect)?;
            let _ = pane.tx.send(RenderMsg::Resize(rect));
            pane.rect = rect;
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

        // SAFETY: `surface` is owned by the `Pane` we are about to build, and
        // `Pane`'s drop/detach joins the render thread before releasing it.
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

    pub fn set_visible(&self, id: &str, visible: bool) -> Result<(), PaneError> {
        let mut panes = self.panes.lock().unwrap();
        let (_, pane) = panes
            .iter_mut()
            .find(|(k, _)| k == id)
            .ok_or_else(|| PaneError::Unknown(id.to_string()))?;
        pane.surface.set_visible(visible)
    }

    pub fn detach(&self, id: &str) -> Result<(), PaneError> {
        let mut panes = self.panes.lock().unwrap();
        let Some(index) = panes.iter().position(|(k, _)| k == id) else {
            return Ok(()); // Detaching an absent pane is success, not an error.
        };
        let (_, pane) = panes.remove(index);
        drop(panes); // Don't hold the registry lock across the thread join.
        pane.detach();
        tracing::info!(pane.id = id, "pane.detach");
        Ok(())
    }
}

/// The Tauri command surface.
///
/// In their own module because `#[tauri::command]` generates helper macros
/// named after each function, and in a library's *root* module those collide
/// with the function items themselves (`__cmd__pane_attach is defined multiple
/// times`). Register them from `tt-app` as `tt_pane::commands::pane_attach`.
pub mod commands {
    use super::{CssRect, PaneError, PaneHost, PaneInfo};
    use std::sync::Arc;
    use tauri::Manager as _;

    type Host<'a> = tauri::State<'a, Arc<PaneHost>>;

    /// Run `f` on the GTK main thread and wait for its result.
    ///
    /// **Every entry point below must go through this.** Tauri commands execute
    /// on a worker pool, and `PaneHost`'s methods touch GTK and Wayland proxies,
    /// which are main-thread-only. Calling them directly from a command body
    /// would be a data race that happens to work most of the time — the worst
    /// kind. (The compiler flags it as a missing `Send`, which is a symptom;
    /// adding `unsafe impl Send` without this marshalling would silence the
    /// symptom and keep the bug.)
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
