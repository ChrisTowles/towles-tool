//! The two hosts, and the only difference between them.
//!
//! Both build the *same* scene ([`crate::scene::BenchScenePlugin`]): [`standalone_app`]
//! is an ordinary winit window (the benchmark baseline), and [`embedded_app`] takes a
//! [`ForeignSurface`] handed in by the platform layer, with `WinitPlugin` disabled
//! entirely.
//!
//! The difference is deliberately tiny — one plugin and one entity — because the whole
//! question this crate answers is what that difference costs. See [`crate::surface`]
//! for why Bevy tolerates it without a fork.

use bevy::prelude::*;
use bevy::window::{
    ExitCondition, PrimaryWindow, RawHandleWrapper, WindowResolution, WindowWrapper,
};
use bevy::winit::WinitPlugin;

use crate::surface::{ForeignSurface, PaneRect};

/// Present mode for both hosts; the benchmark runs it both ways (throughput vs. pacing).
pub use bevy::window::PresentMode;

/// Build the baseline host: a winit-created window, with no scene. The caller adds its
/// own — a built-in scene would spawn a second camera under the Jarvis demo's own.
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

/// # Safety
///
/// `surface` must outlive the returned [`App`]: drop the `App` first. See [`surface`]'s
/// module docs for the frames-in-flight rule behind that.
pub unsafe fn embedded_app(surface: ForeignSurface, rect: PaneRect, present: PresentMode) -> App {
    let mut app = App::new();
    app.add_plugins(
        DefaultPlugins
            .set(WindowPlugin {
                // No winit to make one, and its absence must not be an exit reason.
                primary_window: None,
                primary_cursor_options: None,
                exit_condition: ExitCondition::DontExit,
                close_when_requested: false,
            })
            .disable::<WinitPlugin>(),
    );

    let window = Window {
        resolution: WindowResolution::new(rect.width, rect.height),
        present_mode: present,
        ..default()
    };

    // SAFETY: the caller promised the handles outlive the app, and `WindowWrapper` holds
    // the `ForeignSurface` (`Copy`, owns nothing) alive as long as the component exists.
    let handle = RawHandleWrapper::new(&WindowWrapper::new(surface))
        .expect("ForeignSurface always yields both handles infallibly");

    app.world_mut().spawn((window, handle, PrimaryWindow));
    app
}

/// Complete plugin setup for an app driven by hand. **A host calling [`App::update`]
/// directly must call this first**: `update` skips the plugin `finish`/`cleanup` that
/// `App::run` does, and frame one then panics with "Resource does not exist". `on_wait`
/// runs each turn of the async GPU-init spin — service platform events there, or the
/// compositor kills the window over unanswered pings.
pub fn finalize_embedded_app(app: &mut App, mut on_wait: impl FnMut()) {
    while app.plugins_state() != bevy::app::PluginsState::Ready {
        on_wait();
        bevy::tasks::tick_global_task_pools_on_main_thread();
    }
    app.finish();
    app.cleanup();
}

/// Resize the embedded surface's swapchain. `extract_windows` reconfigures on any
/// `Window.resolution` change, so a resize is a plain component write.
pub fn set_embedded_resolution(app: &mut App, rect: PaneRect) {
    let mut q = app.world_mut().query_filtered::<&mut Window, With<PrimaryWindow>>();
    if let Ok(mut window) = q.single_mut(app.world_mut()) {
        // Already physical pixels; `set` would apply the scale factor a second time.
        window.resolution.set_physical_resolution(rect.width.max(1), rect.height.max(1));
    }
}
