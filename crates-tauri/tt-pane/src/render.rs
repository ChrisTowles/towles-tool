//! The render thread: owns the Bevy app and nothing else.
//!
//! It never touches GDK, never moves the surface, and never locks the pane
//! registry. Its whole contract is: draw into the surface it was given, and
//! resize when told. Everything about *where* the pane sits stays on the main
//! thread — see the module docs in `lib.rs` for why the split exists.

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
    let mut app = unsafe { tt_jarvis::embedded_app(surface, rect, PresentMode::AutoVsync) };
    app.add_plugins(JarvisScenePlugin);

    // Without this every `Res<RenderDevice>` system panics on the first frame —
    // `App::run` performs the plugins' finish phase and `App::update` does not.
    // Nothing to pump while waiting: the main thread owns the Wayland queue.
    tt_jarvis::finalize_embedded_app(&mut app, std::thread::yield_now);

    loop {
        match rx.try_recv() {
            Ok(RenderMsg::Stop) | Err(TryRecvError::Disconnected) => break,
            Ok(RenderMsg::Resize(rect)) => tt_jarvis::set_embedded_resolution(&mut app, rect),
            Err(TryRecvError::Empty) => {}
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
