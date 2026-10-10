//! The app half of the `summon` MCP tool: one notification, then a chime every few seconds until
//! the user types into the caller's terminal. Answering is read off the PTY input stamps the
//! keystroke path already keeps, so nothing here touches that path.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tt_agentboard::summon::{Stopped, Summons};

use crate::agentboard::now_ms;
use crate::terminal::TermState;

/// Consumed by `apps/client/src/lib/summon.ts`.
pub const SUMMON_EVENT: &str = "summon://changed";

const TICK: Duration = Duration::from_millis(500);
const CHIME_EVERY_MS: i64 = 4_000;

static SUMMONS: LazyLock<Mutex<Summons>> = LazyLock::new(|| Mutex::new(Summons::new()));
/// Whether the one ticker thread is running.
static TICKING: AtomicBool = AtomicBool::new(false);
/// Set once no player could be spawned, so a missing `paplay` warns once, not every chime.
static CHIME_MISSING: AtomicBool = AtomicBool::new(false);

/// `reason` crosses IPC for display only; it is never logged.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SummonPayload {
    id: u64,
    session: Option<String>,
    reason: Option<String>,
    active: bool,
}

pub fn start(app: &AppHandle, req: tt_mcp::SummonRequest) -> Result<(), String> {
    let (id, replaced) =
        SUMMONS.lock().unwrap().start(req.session.clone(), req.max_minutes, now_ms());
    if let Some(old) = replaced {
        stopped(app, &old);
    }
    tracing::info!(
        session = req.session.as_deref().unwrap_or("-"),
        max_minutes = req.max_minutes,
        reason_len = req.reason.chars().count(),
        "summon.started"
    );
    let _ = app.emit(
        SUMMON_EVENT,
        SummonPayload {
            id,
            session: req.session.clone(),
            reason: Some(req.reason.clone()),
            active: true,
        },
    );
    notify(app, &req.reason);
    if !TICKING.swap(true, Ordering::SeqCst) {
        let app = app.clone();
        std::thread::Builder::new()
            .name("summon".into())
            .spawn(move || tick_loop(&app))
            .map_err(|e| format!("couldn't start the chime: {e}"))?;
    }
    Ok(())
}

/// Ticks fast so an answer silences it within half a second; chimes on its own slower clock.
fn tick_loop(app: &AppHandle) {
    let mut last_chime = i64::MIN;
    loop {
        let stamps = app.state::<TermState>().input_stamps();
        let now = now_ms();
        let (ended, empty) = {
            let mut summons = SUMMONS.lock().unwrap();
            let ended = summons.tick(now, &stamps);
            (ended, summons.is_empty())
        };
        for s in &ended {
            stopped(app, s);
        }
        if empty {
            TICKING.store(false, Ordering::SeqCst);
            // A summon that landed between the tick and the store found TICKING set and left
            // it to us; take it back unless another thread already has.
            if SUMMONS.lock().unwrap().is_empty() || TICKING.swap(true, Ordering::SeqCst) {
                return;
            }
        }
        if now.saturating_sub(last_chime) >= CHIME_EVERY_MS {
            last_chime = now;
            std::thread::spawn(chime);
        }
        std::thread::sleep(TICK);
    }
}

fn stopped(app: &AppHandle, s: &Stopped) {
    tracing::info!(
        session = s.session.as_deref().unwrap_or("-"),
        cause = s.cause.as_str(),
        after_ms = s.after_ms,
        "summon.stopped"
    );
    let _ = app.emit(
        SUMMON_EVENT,
        SummonPayload { id: s.id, session: s.session.clone(), reason: None, active: false },
    );
}

/// Shown even with the window focused: being asked for is the point.
fn notify(app: &AppHandle, reason: &str) {
    use tauri_plugin_notification::NotificationExt;
    if !crate::settings::notify_allowed(tt_config::NotifyKind::NeedsYou) {
        tracing::debug!("summon: notification skipped, notifications off");
        return;
    }
    let _ = app.notification().builder().title("An agent needs you").body(reason).show();
}

#[cfg(target_os = "macos")]
const PLAYER: (&str, &[&str]) = ("afplay", &["/System/Library/Sounds/Glass.aiff"]);
#[cfg(not(target_os = "macos"))]
const PLAYER: (&str, &[&str]) = ("paplay", &["/usr/share/sounds/freedesktop/stereo/complete.oga"]);

fn chime() {
    if CHIME_MISSING.load(Ordering::Relaxed) {
        return;
    }
    let (cmd, args) = PLAYER;
    if let Err(error) = tt_exec::run_with_timeout(cmd, args, Duration::from_secs(5)) {
        CHIME_MISSING.store(true, Ordering::Relaxed);
        tracing::warn!(%error, "summon: no chime player; notification only");
    }
}
