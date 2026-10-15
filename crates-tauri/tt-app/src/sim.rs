//! `TT_SIM=<scenario.json>` (or `TT_SIM=gallery`, every state at once): the
//! board and the queue replayed from a scenario (`tt_agentboard::sim`) instead
//! of live agents, for watching how the rail moves. Times are moved onto the
//! wall clock, so ages read as they would have live. While it runs the live emit loop and the queue publisher stand down,
//! and every state read answers from the scenario's clock.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tt_agentboard::StatePayload;
use tt_agentboard::queue::TaskQueue;
use tt_agentboard::sim::{Scenario, frame_on_wall, gallery};

use crate::agentboard::{STATE_EVENT, now_ms};
use crate::queue::QUEUE_EVENT;

pub const SIM_EVENT: &str = "sim://clock";

pub struct Sim {
    scenario: Scenario,
    clock: Mutex<Clock>,
}

#[derive(Debug, Clone, Copy)]
struct Clock {
    wall_at: i64,
    sim_at: i64,
    speed: f64,
    playing: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimStatus {
    name: String,
    start_ms: i64,
    end_ms: i64,
    now_ms: i64,
    speed: f64,
    playing: bool,
}

impl Sim {
    /// The scenario named by `TT_SIM`, if any; a bad file is loud, never silent.
    pub fn from_env() -> Option<Sim> {
        let path = std::env::var("TT_SIM").ok().filter(|p| !p.is_empty())?;
        let loaded = if path == "gallery" {
            Ok(gallery(now_ms()))
        } else {
            std::fs::read_to_string(&path)
                .map_err(|e| e.to_string())
                .and_then(|s| serde_json::from_str::<Scenario>(&s).map_err(|e| e.to_string()))
        };
        let scenario = match loaded {
            Ok(s) => s,
            Err(error) => {
                tracing::error!(%path, %error, "sim.load_failed");
                return None;
            }
        };
        tracing::info!(name = scenario.name, checkouts = scenario.checkouts.len(), "sim.loaded");
        let clock =
            Clock { wall_at: now_ms(), sim_at: scenario.start_ms, speed: 1.0, playing: true };
        Some(Sim { scenario, clock: Mutex::new(clock) })
    }

    fn now(&self) -> i64 {
        let c = *self.clock.lock().unwrap();
        if !c.playing {
            return c.sim_at;
        }
        let t = c.sim_at + ((now_ms() - c.wall_at) as f64 * c.speed) as i64;
        t.min(self.scenario.end_ms)
    }

    fn status(&self) -> SimStatus {
        let c = *self.clock.lock().unwrap();
        SimStatus {
            name: self.scenario.name.clone(),
            start_ms: self.scenario.start_ms,
            end_ms: self.scenario.end_ms,
            now_ms: self.now(),
            speed: c.speed,
            playing: c.playing,
        }
    }

    fn set(&self, at: i64, speed: f64, playing: bool) {
        let at = at.clamp(self.scenario.start_ms, self.scenario.end_ms);
        *self.clock.lock().unwrap() = Clock { wall_at: now_ms(), sim_at: at, speed, playing };
    }

    pub fn frame(&self) -> (StatePayload, TaskQueue) {
        frame_on_wall(&self.scenario, self.now(), now_ms())
    }
}

pub fn active(app: &AppHandle) -> bool {
    app.try_state::<Sim>().is_some()
}

pub fn state(app: &AppHandle) -> Option<StatePayload> {
    Some(app.try_state::<Sim>()?.frame().0)
}

pub fn queue(app: &AppHandle) -> Option<TaskQueue> {
    Some(app.try_state::<Sim>()?.frame().1)
}

/// Emit a frame whenever it changed, at roughly the live loop's cadence.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut last: Option<(StatePayload, TaskQueue)> = None;
        loop {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let sim = app.state::<Sim>();
            let (mut state, queue) = sim.frame();
            let ts = std::mem::take(&mut state.ts);
            if last.as_ref().is_none_or(|(s, _)| *s != state) {
                state.ts = ts;
                let _ = app.emit(STATE_EVENT, &state);
                state.ts = 0;
            }
            if last.as_ref().is_none_or(|(_, q)| *q != queue) {
                let _ = app.emit(QUEUE_EVENT, &queue);
            }
            let _ = app.emit(SIM_EVENT, sim.status());
            last = Some((state, queue));
        }
    });
}

#[tauri::command]
pub fn sim_status(app: AppHandle) -> Option<SimStatus> {
    Some(app.try_state::<Sim>()?.status())
}

/// `play`, `pause`, `seek` (to `value` epoch ms) or `speed` (`value`×).
#[tauri::command]
pub fn sim_control(app: AppHandle, action: String, value: Option<f64>) -> Result<(), String> {
    let sim = app.try_state::<Sim>().ok_or("no scenario loaded")?;
    let SimStatus { now_ms: at, speed, playing, .. } = sim.status();
    match (action.as_str(), value) {
        ("play", _) => sim.set(at, speed, true),
        ("pause", _) => sim.set(at, speed, false),
        ("seek", Some(to)) => sim.set(to as i64, speed, playing),
        ("speed", Some(x)) if x > 0.0 => sim.set(at, x, playing),
        _ => return Err(format!("bad sim_control: {action} {value:?}")),
    }
    tracing::info!(action, value, "sim.control");
    Ok(())
}
