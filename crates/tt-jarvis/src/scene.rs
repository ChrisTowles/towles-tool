//! The benchmark scene and the frame-time recorder, shared verbatim by both
//! hosts.
//!
//! Both the standalone-window baseline and the embedded pane run *this* plugin,
//! unchanged. That is the point: if the two hosts ran even slightly different
//! scenes, the comparison would measure the scenes rather than the embedding.

use bevy::prelude::*;
use std::time::Instant;

use crate::stats::{FrameLog, FrameStats};

/// How the run identifies itself in the JSON the harness prints.
#[derive(Resource, Debug, Clone)]
pub struct BenchConfig {
    pub label: String,
    /// Frames to discard before recording — see `FrameLog::drop_warmup`.
    pub warmup_frames: usize,
    /// Frames to record before reporting. Both hosts must use the same count.
    pub measure_frames: usize,
    /// Cubes per axis. The scene is `grid.pow(3)` cubes, so this is the knob
    /// that moves the run from CPU-bound to GPU-bound.
    pub grid: u32,
}

impl Default for BenchConfig {
    fn default() -> Self {
        Self { label: "unlabeled".into(), warmup_frames: 120, measure_frames: 3_600, grid: 12 }
    }
}

/// Recording state. Separate from [`BenchConfig`] so the config stays read-only
/// once the app is built.
#[derive(Resource)]
struct BenchState {
    log: FrameLog,
    last_frame: Option<Instant>,
    warmup_remaining: usize,
    finished: bool,
}

/// Set once the run has collected `measure_frames`; the host loop polls this to
/// know when to stop.
#[derive(Resource, Debug, Default)]
pub struct BenchOutcome(pub Option<FrameStats>);

#[derive(Component)]
struct Spin(Vec3);

pub struct BenchScenePlugin;

impl Plugin for BenchScenePlugin {
    fn build(&self, app: &mut App) {
        let cfg = app.world().get_resource::<BenchConfig>().cloned().unwrap_or_default();
        app.insert_resource(BenchState {
            log: FrameLog::with_capacity(cfg.measure_frames),
            last_frame: None,
            warmup_remaining: cfg.warmup_frames,
            finished: false,
        })
        .init_resource::<BenchOutcome>()
        .add_systems(Startup, spawn_scene)
        .add_systems(Update, (spin, record_frame_time));
    }
}

fn spawn_scene(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    cfg: Res<BenchConfig>,
) {
    let mesh = meshes.add(Cuboid::new(0.6, 0.6, 0.6));
    let n = cfg.grid;
    let span = n as f32;

    // A distinct material per cube rather than one shared handle: sharing would
    // let Bevy batch the whole grid into a handful of draw calls, and a scene
    // that collapses to a few draws measures almost nothing about the surface.
    for x in 0..n {
        for y in 0..n {
            for z in 0..n {
                let t = (x + y * n + z * n * n) as f32 / (n * n * n) as f32;
                let material = materials.add(StandardMaterial {
                    base_color: Color::hsl(t * 360.0, 0.7, 0.5),
                    perceptual_roughness: 0.4,
                    metallic: 0.3,
                    ..default()
                });
                commands.spawn((
                    Mesh3d(mesh.clone()),
                    MeshMaterial3d(material),
                    Transform::from_xyz(
                        x as f32 - span / 2.0,
                        y as f32 - span / 2.0,
                        z as f32 - span / 2.0,
                    ),
                    Spin(Vec3::new(0.3 + t, 0.7 - t * 0.5, 0.5)),
                ));
            }
        }
    }

    commands.spawn((
        // Shadow maps off: they would make the scene's cost dominated by an
        // extra depth pass, and the run is meant to stress the surface's
        // present path, not Bevy's shadow pipeline.
        PointLight {
            intensity: 8_000_000.0,
            shadow_maps_enabled: false,
            range: 200.0,
            ..default()
        },
        Transform::from_xyz(span, span * 1.5, span * 2.0),
    ));
    commands.spawn((
        Camera3d::default(),
        Transform::from_xyz(0.0, 0.0, span * 2.2).looking_at(Vec3::ZERO, Vec3::Y),
    ));
}

fn spin(time: Res<Time>, mut q: Query<(&mut Transform, &Spin)>) {
    let dt = time.delta_secs();
    for (mut transform, spin) in &mut q {
        transform.rotate_x(spin.0.x * dt);
        transform.rotate_y(spin.0.y * dt);
        transform.rotate_z(spin.0.z * dt);
    }
}

/// Measures wall-clock between consecutive `Update` runs.
///
/// Wall-clock rather than Bevy's `Time::delta`: the question is what the *user*
/// would see, which includes swapchain acquire and present stalls. `Time::delta`
/// is the same measurement in practice, but going through `Instant` directly
/// keeps the recorder honest about measuring the whole frame rather than
/// whatever the time plugin decided to report.
fn record_frame_time(
    mut state: ResMut<BenchState>,
    cfg: Res<BenchConfig>,
    mut outcome: ResMut<BenchOutcome>,
) {
    let now = Instant::now();
    let Some(previous) = state.last_frame.replace(now) else {
        return; // First frame has no predecessor to measure against.
    };
    if state.finished {
        return;
    }

    if state.warmup_remaining > 0 {
        state.warmup_remaining -= 1;
        return;
    }

    let micros = now.duration_since(previous).as_micros().min(u128::from(u32::MAX)) as u32;
    state.log.record_us(micros);

    if state.log.len() >= cfg.measure_frames {
        state.finished = true;
        outcome.0 = state.log.stats();
    }
}
