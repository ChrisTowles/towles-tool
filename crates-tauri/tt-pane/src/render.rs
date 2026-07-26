//! The render thread: owns the Bevy app and nothing else.
//!
//! It never touches GDK, never moves the surface, and never locks the pane
//! registry. Its whole contract is: draw into the surface it was given, resize
//! when told, and park when told (a hidden pane is moved off screen by the main
//! thread, so its frames are pure waste — see [`crate::RenderMsg::Pause`]).
//! Everything about *where* the pane sits stays on the main thread — see the
//! module docs in `lib.rs` for why the split exists.

use std::sync::mpsc::{Receiver, TryRecvError};
use std::thread::JoinHandle;

use tt_jarvis::jarvis::JarvisScenePlugin;
use tt_jarvis::surface::{ForeignSurface, PaneRect};
use tt_jarvis::PresentMode;

use crate::RenderMsg;

/// Start rendering `surface`.
pub fn spawn(surface: ForeignSurface, rect: PaneRect, rx: Receiver<RenderMsg>) -> JoinHandle<()> {
    std::thread::Builder::new()
        .name("tt-pane-render".into())
        .spawn(move || run(surface, rect, rx))
        .expect("failed to spawn the pane render thread")
}

fn run(surface: ForeignSurface, rect: PaneRect, rx: Receiver<RenderMsg>) {
    // SAFETY: the `Pane` holding this surface joins this thread before dropping
    // it, so the surface outlives every frame in flight.
    // Paced by the display deliberately: both faster present modes were measured
    // and both flood the compositor, losing the Wayland connection within seconds
    // (`tt-jarvis/examples/jarvis_demo.rs` holds the per-mode numbers). This paces
    // presentation only — per-frame work stays uncapped, which is where a fast
    // renderer's headroom belongs.
    let mut app = unsafe { tt_jarvis::embedded_app(surface, rect, PresentMode::AutoVsync) };
    app.add_plugins(JarvisScenePlugin);

    // Without this every `Res<RenderDevice>` system panics on the first frame —
    // `App::run` performs the plugins' finish phase and `App::update` does not.
    // Nothing to pump while waiting: the main thread owns the Wayland queue.
    tt_jarvis::finalize_embedded_app(&mut app, std::thread::yield_now);

    // Parked = hidden: the pane has been moved off every output, so the app
    // stays alive but stops presenting — under vsync each frame blocks this
    // thread on a compositor callback for something nobody can see. Blocking on
    // `recv` while parked is the point; it costs nothing until there is
    // something to do. Resizes still apply, because the pane's tile keeps moving
    // underneath it and the first frame after resuming should already be right.
    let mut paused = false;

    loop {
        // Parked, so wait for work; running, so take whatever has arrived. A
        // dropped sender is terminal either way — the pane is gone.
        let msg = if paused {
            match rx.recv() {
                Ok(msg) => Some(msg),
                Err(_) => break,
            }
        } else {
            match rx.try_recv() {
                Ok(msg) => Some(msg),
                Err(TryRecvError::Empty) => None,
                Err(TryRecvError::Disconnected) => break,
            }
        };
        match msg {
            Some(RenderMsg::Stop) => break,
            Some(RenderMsg::Resize(rect)) => tt_jarvis::set_embedded_resolution(&mut app, rect),
            Some(RenderMsg::Pause) => paused = true,
            Some(RenderMsg::Resume) => paused = false,
            None => {}
        }
        if paused {
            continue;
        }

        // Blocks until the compositor's next frame callback under vsync. That
        // is exactly why this is not on the GTK main thread.
        app.update();

        if app.should_exit().is_some() {
            break;
        }
    }

    tracing::debug!("pane render thread stopped");
}
