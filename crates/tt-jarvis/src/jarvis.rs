//! The Jarvis scene: a continuously looping arc-reactor style HUD.
//!
//! Unlike [`crate::scene`] — which exists only to be a heavy, measurable load —
//! this is the scene the pane is actually *for*. It runs forever, has no frame
//! budget and no exit condition, and is written to look like something worth
//! putting in a window.
//!
//! Everything animates off [`Time::elapsed_secs`] rather than accumulating
//! per-frame deltas, so the loop is a pure function of elapsed time. A dropped
//! or long frame changes nothing about where the rings are — which matters here,
//! because this scene will eventually run at whatever cadence the compositor
//! gives it, not at a fixed step.

use bevy::camera::Hdr;
use bevy::color::palettes::basic::WHITE;
use bevy::core_pipeline::tonemapping::Tonemapping;
use bevy::post_process::bloom::Bloom;
use bevy::prelude::*;
use std::f32::consts::TAU;

/// Cyan, well past 1.0 so bloom has something to bleed. Emissive colors are
/// HDR: a value inside the 0..1 range would light up but never glow.
const CYAN: Color = Color::linear_rgb(0.0, 4.5, 6.0);
const AMBER: Color = Color::linear_rgb(6.0, 2.2, 0.2);

pub struct JarvisScenePlugin;

impl Plugin for JarvisScenePlugin {
    fn build(&self, app: &mut App) {
        app.insert_resource(ClearColor(Color::linear_rgb(0.004, 0.008, 0.014)))
            .add_systems(Startup, spawn)
            .add_systems(Update, (spin_rings, pulse_core, drift_motes));
    }
}

/// Ask the renderer to write the next frame to `path`, once, after `after_secs`.
///
/// This captures what the *pane itself* renders, straight off its own swapchain
/// — which is the only way to see the scene when the host window is on another
/// workspace or otherwise not on screen. It is evidence about the scene, not
/// about compositing: proving the surface is genuinely composited into its
/// parent needs a desktop screenshot instead.
pub fn capture_frame_after(app: &mut App, path: impl Into<String>, after_secs: f32) {
    use bevy::render::view::window::screenshot::{save_to_disk, Screenshot};

    let path = path.into();
    app.add_systems(
        Update,
        move |mut commands: Commands, time: Res<Time>, mut done: Local<bool>| {
            if *done || time.elapsed_secs() < after_secs {
                return;
            }
            *done = true;
            commands.spawn(Screenshot::primary_window()).observe(save_to_disk(path.clone()));
        },
    );
}

/// Independent rotation rates per axis, in radians/sec.
#[derive(Component)]
struct Ring {
    rate: Vec3,
    /// Phase offset so the rings don't all pass through alignment together.
    phase: f32,
}

#[derive(Component)]
struct Core;

#[derive(Component)]
struct Mote {
    radius: f32,
    speed: f32,
    phase: f32,
    tilt: f32,
}

fn spawn(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    // Black base + HDR emissive is the glow recipe. Note `unlit` stays FALSE:
    // an unlit StandardMaterial draws `base_color` and nothing else, so with a
    // black base it renders the geometry perfectly — and perfectly black.
    // Emissive is what survives, and it needs the lit path.
    let glow = |color: Color| StandardMaterial {
        base_color: Color::BLACK,
        emissive: color.to_linear(),
        ..default()
    };

    let cyan = materials.add(glow(CYAN));
    let amber = materials.add(glow(AMBER));

    // Three concentric torus rings on different axes.
    let ring_specs = [
        (1.90, 0.012, Vec3::new(0.00, 0.55, 0.00), 0.0),
        (1.45, 0.016, Vec3::new(0.42, 0.00, 0.18), 1.1),
        (1.05, 0.010, Vec3::new(0.00, -0.85, 0.30), 2.3),
    ];
    for (radius, thickness, rate, phase) in ring_specs {
        commands.spawn((
            Mesh3d(meshes.add(Torus { minor_radius: thickness, major_radius: radius })),
            MeshMaterial3d(cyan.clone()),
            Transform::default(),
            Ring { rate, phase },
        ));
    }

    // A broken outer ring — four arcs, drawn as thin boxes on a circle. Reads as
    // a HUD bracket rather than another solid ring.
    let arc = meshes.add(Cuboid::new(0.30, 0.022, 0.022));
    for i in 0..4 {
        let angle = i as f32 * TAU / 4.0 + TAU / 8.0;
        commands.spawn((
            Mesh3d(arc.clone()),
            MeshMaterial3d(amber.clone()),
            Transform::from_xyz(angle.cos() * 2.35, angle.sin() * 2.35, 0.0)
                .with_rotation(Quat::from_rotation_z(angle + TAU / 4.0)),
            Ring { rate: Vec3::new(0.0, 0.0, -0.22), phase: 0.0 },
        ));
    }

    // The core.
    commands.spawn((
        Mesh3d(meshes.add(Sphere::new(0.42))),
        MeshMaterial3d(cyan.clone()),
        Transform::default(),
        Core,
    ));

    // Motes orbiting on tilted planes.
    let mote = meshes.add(Sphere::new(0.028));
    for i in 0..28 {
        let t = i as f32 / 28.0;
        commands.spawn((
            Mesh3d(mote.clone()),
            MeshMaterial3d(if i % 5 == 0 { amber.clone() } else { cyan.clone() }),
            Transform::default(),
            Mote {
                radius: 1.15 + t * 1.35,
                speed: 0.75 + (1.0 - t) * 0.85,
                phase: t * TAU * 3.0,
                tilt: (t - 0.5) * 1.4,
            },
        ));
    }

    commands.spawn((
        PointLight { intensity: 900_000.0, range: 40.0, color: WHITE.into(), ..default() },
        Transform::from_xyz(3.0, 4.0, 6.0),
    ));

    commands.spawn((
        Camera3d::default(),
        // HDR is a hard requirement for bloom — without it the emissive values
        // clamp at 1.0 during tonemapping and nothing ever glows. In Bevy 0.19
        // this is a marker component, not a `Camera` field.
        Hdr,
        Tonemapping::TonyMcMapface,
        Bloom { intensity: 0.28, ..Bloom::NATURAL },
        Transform::from_xyz(0.0, 0.6, 6.4).looking_at(Vec3::ZERO, Vec3::Y),
    ));
}

fn spin_rings(time: Res<Time>, mut q: Query<(&mut Transform, &Ring)>) {
    let t = time.elapsed_secs();
    for (mut transform, ring) in &mut q {
        transform.rotation = Quat::from_euler(
            EulerRot::XYZ,
            ring.rate.x * t + ring.phase,
            ring.rate.y * t + ring.phase,
            ring.rate.z * t,
        );
    }
}

/// Two out-of-phase sines so the core breathes irregularly rather than
/// metronomically — a single sine reads as a loading spinner.
fn pulse_core(time: Res<Time>, mut q: Query<&mut Transform, With<Core>>) {
    let t = time.elapsed_secs();
    let pulse = 1.0 + (t * 1.9).sin() * 0.055 + (t * 0.7).sin() * 0.03;
    for mut transform in &mut q {
        transform.scale = Vec3::splat(pulse);
    }
}

fn drift_motes(time: Res<Time>, mut q: Query<(&mut Transform, &Mote)>) {
    let t = time.elapsed_secs();
    for (mut transform, mote) in &mut q {
        let angle = t * mote.speed + mote.phase;
        transform.translation = Vec3::new(
            angle.cos() * mote.radius,
            (angle * 0.8).sin() * mote.tilt,
            angle.sin() * mote.radius,
        );
    }
}
