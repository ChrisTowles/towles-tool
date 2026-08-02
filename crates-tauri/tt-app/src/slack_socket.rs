//! Slack Socket Mode driver: the WebSocket loop that turns the 60s DM poll into real-time
//! delivery when an app-level token (`xapp-…`) is configured. All protocol decisions live
//! in the Tauri-free `tt_collect::slack_socket` and are unit-tested there; this is the
//! I/O shell. The poll stays on as fallback; the socket just makes it instant. Absence
//! of an app token is a clean no-op — the task parks on the reload signal.
//!
//! Settings (and so the token) are shared across every open worktree, so spawning this
//! unconditionally would have each task's process connect on the same token — duplicate
//! `wss://` connections and duplicate notifications for one message (#227). Only one
//! process proceeds past the [`instance_lock::InstanceLock`] gate; the rest park and
//! retry, so a closed instance's task is picked up without a relaunch.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::Message;
use tt_collect::{Backoff, Envelope, SlackDmConfig};

use crate::instance_lock::InstanceLock;
use crate::store::SNAPSHOT_EVENT;

/// How often a non-primary instance rechecks whether the lock has freed up.
const LOCK_RETRY: Duration = Duration::from_secs(30);

struct SocketConfig {
    dm: SlackDmConfig,
    app_token: String,
}

/// `None` when Socket Mode is off — a disabled collector or a missing token/watch id.
/// Absence keeps the task idle rather than erroring.
fn read_config() -> Option<SocketConfig> {
    let slack = tt_config::load().ok()?.collectors.slack;
    if !slack.enabled
        || slack.token.trim().is_empty()
        || slack.app_token.trim().is_empty()
        || slack.watch_user_id.trim().is_empty()
    {
        return None;
    }
    Some(SocketConfig {
        dm: SlackDmConfig {
            token: slack.token,
            watch_user_id: slack.watch_user_id,
            watch_name: slack.watch_name,
        },
        app_token: slack.app_token,
    })
}

/// How a connection attempt ended, deciding the loop's next move.
enum Outcome {
    /// Settings changed mid-connection — re-read config immediately.
    Reload,
    /// Slack closes the socket cleanly every few minutes by design — reconnect promptly.
    Disconnected,
    /// The connection failed or dropped with an error — back off before retry.
    Error,
}

/// Spawn the Socket Mode loop. Re-reads settings whenever `reload` fires, so changing
/// tokens takes effect without a relaunch.
pub fn spawn(app: AppHandle, reload: Arc<Notify>) {
    tauri::async_runtime::spawn(async move {
        let mut backoff = Backoff::new();
        let mut lock: Option<InstanceLock> = None;
        loop {
            if lock.is_none() {
                lock = InstanceLock::try_acquire("slack-socket");
                if lock.is_none() {
                    eprintln!(
                        "slack socket: another instance already holds the singleton lock, \
                         parking (retry in {}s)",
                        LOCK_RETRY.as_secs()
                    );
                    tokio::select! {
                        _ = tokio::time::sleep(LOCK_RETRY) => {}
                        _ = reload.notified() => {}
                    }
                    continue;
                }
            }
            let Some(config) = read_config() else {
                // Socket Mode off: park until settings change, then re-evaluate.
                reload.notified().await;
                backoff.reset();
                continue;
            };
            match run_connection(&app, &config, &reload, &mut backoff).await {
                Outcome::Reload | Outcome::Disconnected => backoff.reset(),
                Outcome::Error => {
                    let delay = backoff.next_delay();
                    // Sleep before reconnecting, but wake early if settings change.
                    tokio::select! {
                        _ = tokio::time::sleep(delay) => {}
                        _ = reload.notified() => backoff.reset(),
                    }
                }
            }
        }
    });
}

/// Open one connection and pump envelopes until it ends, returning how it ended so the
/// caller can pick a reconnect cadence.
async fn run_connection(
    app: &AppHandle,
    config: &SocketConfig,
    reload: &Notify,
    backoff: &mut Backoff,
) -> Outcome {
    // `apps.connections.open` is a blocking HTTP call (ureq).
    let app_token = config.app_token.clone();
    let url = match tauri::async_runtime::spawn_blocking(move || {
        tt_collect::open_socket_connection(&app_token)
    })
    .await
    {
        Ok(Ok(url)) => url,
        Ok(Err(e)) => {
            eprintln!("slack socket: open connection failed: {e}");
            return Outcome::Error;
        }
        Err(e) => {
            eprintln!("slack socket: open task failed: {e}");
            return Outcome::Error;
        }
    };

    // native-tls verifies against the OS trust store — required for networks that
    // TLS-inspect with a corporate root CA, which `connect_async`'s bundled
    // webpki-roots never sees.
    let connector = match native_tls::TlsConnector::new() {
        Ok(c) => tokio_tungstenite::Connector::NativeTls(c),
        Err(e) => {
            eprintln!("slack socket: failed to initialize native TLS: {e}");
            return Outcome::Error;
        }
    };
    let mut ws =
        match tokio_tungstenite::connect_async_tls_with_config(&url, None, false, Some(connector))
            .await
        {
            Ok((ws, _resp)) => ws,
            Err(e) => {
                eprintln!("slack socket: websocket connect failed: {e}");
                return Outcome::Error;
            }
        };

    // Resolved once so events match the exact conversation; on failure
    // `is_watched_message` falls back to sender-matching.
    let dm = config.dm.clone();
    let watched_channel =
        tauri::async_runtime::spawn_blocking(move || tt_collect::dm_channel_id(&dm))
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default();

    loop {
        tokio::select! {
            _ = reload.notified() => return Outcome::Reload,
            frame = ws.next() => {
                let Some(frame) = frame else {
                    // Stream ended without a disconnect envelope.
                    return Outcome::Error;
                };
                let text = match frame {
                    Ok(Message::Text(t)) => t.as_str().to_string(),
                    Ok(Message::Close(_)) => return Outcome::Error,
                    Ok(_) => continue, // ping/pong/binary — tungstenite auto-pongs.
                    Err(e) => {
                        eprintln!("slack socket: read error: {e}");
                        return Outcome::Error;
                    }
                };
                match tt_collect::parse_envelope(&text) {
                    // Live: a later error shouldn't inherit an inflated backoff.
                    Envelope::Hello => backoff.reset(),
                    Envelope::Disconnect { reason } => {
                        eprintln!("slack socket: server disconnect ({reason}); reconnecting");
                        return Outcome::Disconnected;
                    }
                    Envelope::Event { envelope_id, message } => {
                        // Ack first — Slack drops the socket on an unacked envelope.
                        if let Err(e) =
                            ws.send(Message::Text(tt_collect::ack_json(&envelope_id).into())).await
                        {
                            eprintln!("slack socket: ack failed: {e}");
                            return Outcome::Error;
                        }
                        if let Some(msg) = message
                            && tt_collect::is_watched_message(
                                &msg,
                                &watched_channel,
                                &config.dm.watch_user_id,
                            )
                        {
                            refresh_dm(app, &config.dm).await;
                        }
                    }
                    Envelope::Ignore => {}
                }
            }
        }
    }
}

/// The same refresh path `slack_dm_send` uses. Best-effort: a store hiccup just leaves
/// the next poll to catch up.
async fn refresh_dm(app: &AppHandle, config: &SlackDmConfig) {
    if main_window_minimized(app) {
        return;
    }
    let app = app.clone();
    let config = config.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        if let Ok(store) = tt_store::Store::open_default() {
            let now = chrono::Local::now().timestamp_millis();
            let _ = tt_collect::collect_slack_dm(&store, &config, now);
            if let Ok(snapshot) = store.snapshot() {
                let _ = app.emit(SNAPSHOT_EVENT, snapshot);
            }
        }
    })
    .await;
}

/// Mirrors the scheduler's guard so a backgrounded app doesn't churn the store on every
/// incoming message. Unknown states count as visible.
fn main_window_minimized(app: &AppHandle) -> bool {
    app.get_webview_window("main").map(|w| w.is_minimized().unwrap_or(false)).unwrap_or(false)
}
