//! Step 0 baseline: the benchmark scene in an ordinary winit window.
//!
//! Prints one JSON object on stdout so the two runs can be diffed mechanically
//! rather than by eye.
//!
//! ```sh
//! cargo run -p tt-jarvis --example bench_standalone -- --width 800 --height 600 --no-vsync
//! ```

use bevy::prelude::*;
use tt_jarvis::scene::{BenchConfig, BenchOutcome, BenchScenePlugin};
use tt_jarvis::{standalone_app, PresentMode};

fn main() {
    let args = bench_args();
    let mut app = standalone_app(args.width, args.height, args.present);
    app.insert_resource(BenchConfig {
        label: format!("standalone/{}x{}/{}", args.width, args.height, args.present_label),
        warmup_frames: args.warmup,
        measure_frames: args.frames,
        grid: args.grid,
    })
    .add_plugins(BenchScenePlugin)
    .add_systems(Update, report_when_finished);
    app.run();
}

/// Emits the JSON and asks Bevy to exit once the run has its sample count.
fn report_when_finished(
    outcome: Res<BenchOutcome>,
    cfg: Res<BenchConfig>,
    mut exit: MessageWriter<AppExit>,
    mut done: Local<bool>,
) {
    if *done {
        return;
    }
    let Some(stats) = &outcome.0 else { return };
    *done = true;
    println!("{}", serde_json::json!({ "label": cfg.label, "stats": stats }));
    exit.write(AppExit::Success);
}

pub struct BenchArgs {
    pub width: u32,
    pub height: u32,
    pub present: PresentMode,
    pub present_label: &'static str,
    pub warmup: usize,
    pub frames: usize,
    pub grid: u32,
}

/// Deliberately hand-rolled rather than pulling `clap` into this crate — the
/// harness is throwaway scaffolding for the Step 0 gate, and `clap` here would
/// outlive its usefulness.
pub fn bench_args() -> BenchArgs {
    let argv: Vec<String> = std::env::args().collect();
    let flag = |name: &str| -> Option<String> {
        argv.iter().position(|a| a == name).and_then(|i| argv.get(i + 1)).cloned()
    };
    let num = |name: &str, default: u32| -> u32 {
        flag(name).and_then(|v| v.parse().ok()).unwrap_or(default)
    };
    let no_vsync = argv.iter().any(|a| a == "--no-vsync");

    BenchArgs {
        width: num("--width", 800),
        height: num("--height", 600),
        present: if no_vsync { PresentMode::AutoNoVsync } else { PresentMode::AutoVsync },
        present_label: if no_vsync { "novsync" } else { "vsync" },
        warmup: num("--warmup", 120) as usize,
        frames: num("--frames", 3600) as usize,
        grid: num("--grid", 12),
    }
}
