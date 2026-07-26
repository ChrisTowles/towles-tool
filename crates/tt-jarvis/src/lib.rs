//! Bevy rendering into a surface it did not create.
//!
//! Two hosts build the *same* scene ([`scene::BenchScenePlugin`]):
//!
//! - [`standalone_app`] — an ordinary winit window. The benchmark baseline.
//! - [`embedded_app`] — a [`surface::ForeignSurface`] handed in by the platform
//!   layer, with `WinitPlugin` disabled entirely.
//!
//! The difference between them is deliberately tiny — one plugin and one
//! entity — because the whole question this crate answers is what that
//! difference costs. See [`surface`] for why Bevy tolerates it without a fork.
//!
//! This crate is Tauri-free by the workspace rule and knows nothing about
//! windows, GTK, AppKit or IPC. Acquiring the surface and keeping it glued to a
//! DOM rect is `tt-pane`'s job.

pub mod jarvis;
pub mod scene;
pub mod stats;
pub mod surface;

use bevy::prelude::*;
use bevy::window::{
    ExitCondition, PrimaryWindow, RawHandleWrapper, WindowResolution, WindowWrapper,
};
use bevy::winit::WinitPlugin;

use surface::{ForeignSurface, PaneRect};

/// Present mode for both hosts.
///
/// Exposed because the benchmark has to run it both ways: `AutoNoVsync` measures
/// raw throughput (does the embedding cost GPU time?) and `AutoVsync` measures
/// whether the pane can actually hold the refresh rate (does the compositor's
/// frame pacing fight the render loop?). A pane can pass the first and fail the
/// second, and the second is what a Jarvis animation would show.
pub use bevy::window::PresentMode;

/// Build the baseline host: a winit-created window, with no scene.
///
/// The caller adds its own scene plugin. Neither host picks a scene, because
/// both the benchmark and the Jarvis demo run through these functions and a
/// built-in scene would spawn a second camera under the demo's own — which Bevy
/// reports as a render-order ambiguity rather than an error.
pub fn standalone_app(width: u32, height: u32, present: PresentMode) -> App {
    let mut app = App::new();
    app.add_plugins(DefaultPlugins.set(WindowPlugin {
        primary_window: Some(Window {
            title: "tt-jarvis — standalone baseline".into(),
            resolution: WindowResolution::new(width, height),
            present_mode: present,
            ..default()
        }),
        ..default()
    }));
    app
}

/// Build the embedded host: an app rendering into `surface`, with no scene.
///
/// The caller adds its own scene plugin — see [`standalone_app`].
///
/// # Safety
///
/// `surface` must outlive the returned [`App`]: drop the `App` first. See
/// [`surface`]'s module docs for the frames-in-flight rule behind that.
pub unsafe fn embedded_app(surface: ForeignSurface, rect: PaneRect, present: PresentMode) -> App {
    let mut app = App::new();
    app.add_plugins(
        DefaultPlugins
            .set(WindowPlugin {
                // No primary window: winit is not here to make one, and Bevy
                // must not treat its absence as a reason to exit.
                primary_window: None,
                // No effect while `primary_window` is `None`, but the field is
                // required — Bevy only applies it to a window it spawns itself.
                primary_cursor_options: None,
                exit_condition: ExitCondition::DontExit,
                close_when_requested: false,
            })
            // The whole trick. Everything downstream of `extract_windows` is
            // indifferent to where the raw handle came from.
            .disable::<WinitPlugin>(),
    );

    let window = Window {
        resolution: WindowResolution::new(rect.width, rect.height),
        present_mode: present,
        ..default()
    };

    // SAFETY: the caller of this function promised the handles outlive the app,
    // and `WindowWrapper` holds our `ForeignSurface` (which is `Copy` and owns
    // nothing) alive for as long as the component exists.
    let handle = RawHandleWrapper::new(&WindowWrapper::new(surface))
        .expect("ForeignSurface always yields both handles infallibly");

    app.world_mut().spawn((window, handle, PrimaryWindow));
    app
}

/// Complete plugin setup for an app that will be driven by hand.
///
/// **Any host calling [`App::update`] directly must call this first.** `App::run`
/// waits for plugins to report ready and then runs their `finish`/`cleanup`
/// phases; `update` does neither. Skipping it does not fail loudly at startup —
/// the renderer still creates its adapter, so the log looks healthy — and then
/// every system taking `Res<RenderDevice>` panics on the first frame with
/// "Resource does not exist", because `RenderPlugin::finish` is what unpacks the
/// device into the main world.
///
/// GPU init is asynchronous, so this spins until the plugins report ready. The
/// `on_wait` callback runs each turn of that spin — hosts should use it to keep
/// servicing their platform event queue, since a compositor whose pings go
/// unanswered while we block here will kill the window.
pub fn finalize_embedded_app(app: &mut App, mut on_wait: impl FnMut()) {
    while app.plugins_state() != bevy::app::PluginsState::Ready {
        on_wait();
        bevy::tasks::tick_global_task_pools_on_main_thread();
    }
    app.finish();
    app.cleanup();
}

/// Resize the embedded surface's swapchain.
///
/// `extract_windows` reconfigures the swapchain whenever `Window.resolution`
/// changes, so a resize is a plain component write — there is no surface to
/// recreate and no GPU state to rebuild by hand. The platform layer moves the
/// real surface separately; this only tells Bevy how big it now is.
pub fn set_embedded_resolution(app: &mut App, rect: PaneRect) {
    let mut q = app.world_mut().query_filtered::<&mut Window, With<PrimaryWindow>>();
    if let Ok(mut window) = q.single_mut(app.world_mut()) {
        // `set_physical_resolution`, not `set`: `PaneRect` is already in
        // physical pixels (the scale conversion happened once at the IPC
        // boundary), and `set` would multiply by the scale factor a second time.
        window.resolution.set_physical_resolution(rect.width.max(1), rect.height.max(1));
    }
}
