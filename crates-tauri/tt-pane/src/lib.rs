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
//! - **Main thread** owns the Wayland proxies (`wayland::Subsurface`):
//!   creation, position, visibility, teardown. GTK's own surface is only ever
//!   touched here.
//! - **Render thread** owns the Bevy `App` and the swapchain. It receives
//!   [`PaneRect`](tt_jarvis::surface::PaneRect) updates over a channel and only
//!   ever *resizes*; it never moves the surface and never speaks to GDK.
//!
//! # Teardown happens once, at exit
//!
//! Dropping a `Pane` stops the render thread and *joins it* before releasing
//! the subsurface — the frames-in-flight rule in `tt_jarvis::surface`. Nothing
//! drops one while the app is running: dropping a Bevy app takes the process
//! with it (see [`PaneHost::detach`]), so panes are retired and reused instead,
//! and this path runs only when the registry is dropped at shutdown.
//!
//! # Hiding moves the pane; it does not unmap or destroy it
//!
//! [`PaneHost::set_visible`] parks the renderer and slides the subsurface
//! outside every output. Both of the mechanisms you would reach for first were
//! implemented here and rejected *against a compositor screenshot* — a null
//! buffer never took the surface off screen, and a full detach did but exited
//! the process on the way — so treat the indirection as load-bearing and read
//! `wayland::Subsurface::set_visible` before changing it.
//!
//! # Everything above is Linux-only
//!
//! The surface, the renderer and the registry that holds them are gated on
//! Linux; elsewhere [`PaneHost`] is an empty stub that reports the pane as
//! unsupported. The machinery is cut rather than left compiled-but-unused,
//! because there is no shape here a second platform would inherit — an
//! `NSView`/`CAMetalLayer` host has its own message type and its own teardown
//! rule, so keeping this one alive on macOS buys nothing and costs four
//! dead-code warnings.

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

/// A rect as the frontend measures it: CSS pixels, relative to the window's
/// client area.
///
/// Converted to physical pixels here rather than in the frontend, so the
/// rounding decision lives on one side of the wire. See
/// [`PaneRect::from_css`](tt_jarvis::surface::PaneRect::from_css).
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
    /// Stop presenting and park until [`RenderMsg::Resume`]. Sent when a pane is
    /// hidden: it is off screen by then, so every further frame is pure waste —
    /// and under vsync each one still blocks a thread until the compositor says
    /// so.
    ///
    /// Deliberately unacknowledged. Hiding is done the moment the surface moves
    /// off screen, which the main thread has already handled itself, so waiting
    /// for the renderer would trade a guaranteed main-thread stall (a vsync
    /// frame at best, forever if the surface is occluded and gets no frame
    /// callbacks) for nothing.
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
    /// Take the pane off screen and stop its renderer.
    ///
    /// The single home of the hide sequence — both hiding and retiring are this
    /// — so the ordering rule below is stated once. Park the renderer first,
    /// then move the surface: the other order lets a mid-flight frame land in
    /// the position being vacated.
    fn park(&mut self) -> Result<(), PaneError> {
        let _ = self.tx.send(RenderMsg::Pause);
        self.surface.set_visible(false)
    }

    /// Put the pane back at `rect` and start it rendering again — the inverse
    /// of [`Pane::park`], and what makes a retired pane revivable.
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
        // The one real teardown path, and it runs only at shutdown (the
        // registry being cleared on window close) — see `PaneHost::detach` for
        // why nothing tears a pane down while the app is alive. A parked
        // renderer is blocked on `recv`, so `Stop` reaches it either way.
        let _ = self.tx.send(RenderMsg::Stop);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Process-wide pane registry, keyed by the frontend's pane id.
///
/// Fieldless off Linux: there is nothing to register when [`PaneHost::attach`]
/// can only fail.
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
    /// Idempotent per id: re-attaching an existing pane repositions and revives
    /// it, so a React strict-mode double-mount or a screen remount cannot spawn
    /// two renderers against one rectangle — and reopening a pane that was
    /// closed earlier reuses the renderer it already has (see
    /// [`PaneHost::detach`], which retires rather than destroys).
    pub fn attach(
        &self,
        window: &tauri::WebviewWindow,
        id: &str,
        rect: CssRect,
        scale: f64,
    ) -> Result<PaneInfo, PaneError> {
        let rect = PaneRect::from_css(rect.x, rect.y, rect.width, rect.height, scale);

        let mut panes = self.panes.lock().unwrap();
        // Also the revival path for a retired pane (see `detach`), which is why
        // it unparks rather than only repositioning.
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

    /// Show or hide the pane — [`Pane::park`]/[`Pane::unpark`], which own the
    /// ordering rule.
    ///
    /// See [`wayland::Subsurface::set_visible`] for why hiding is a move rather
    /// than an unmap.
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
    /// It reads like a leak and is the opposite — the destructor is what's
    /// dangerous. Dropping the Bevy app tears down a wgpu device built on GDK's
    /// own Wayland display, and doing that mid-session ended the *process*:
    /// closing a pane exited the app within seconds, every time, cleanly enough
    /// that the last log line was "pane render thread stopped". Nothing in a
    /// teardown *order* fixes that, because the resource being torn down is
    /// shared with the host toolkit.
    ///
    /// So a live pane outlives its UI. Re-attaching the same id revives it
    /// ([`PaneHost::attach`]), which makes reopening a pane instant, and real
    /// teardown happens once — at process exit, where `Pane::drop` can't hurt
    /// anything that isn't already going away.
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
