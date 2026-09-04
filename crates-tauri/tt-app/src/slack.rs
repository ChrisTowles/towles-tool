//! Tauri bridge for the watched Slack DM conversation: on-demand history and
//! thread expansion for the chat panel, sending a reply (optionally into a
//! thread), and toggling an emoji reaction. Reads the same `slack`
//! collector settings the scheduler uses, but deliberately ignores `enabled` —
//! the chat panel works whenever credentials exist, even with the background
//! watcher switched off. After a successful write the `slack:dm` collector runs
//! once and the snapshot re-emits, so the banner clears without waiting for
//! the next scheduled tick.

use tauri::{AppHandle, Emitter};

use crate::store::SNAPSHOT_EVENT;

/// How much of the DM conversation the chat panel pulls per fetch.
const HISTORY_LIMIT: u32 = 50;

/// `configured` is false when the collector has no token/member id yet — the
/// panel then shows setup guidance instead of a conversation.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackDmView {
    pub configured: bool,
    pub watch_name: String,
    /// Resolves `<@id>` mentions in message text to the watched user's name.
    pub watch_user_id: String,
    pub messages: Vec<tt_collect::DmMessage>,
}

/// Base64 so the webview can render a `data:` URI; the private URL needs the
/// bearer token.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackFileData {
    pub mimetype: String,
    pub data_base64: String,
}

/// The configured Slack DM settings, or `None` when token/member id are blank.
fn dm_config() -> Option<tt_collect::SlackDmConfig> {
    let slack = tt_config::load().ok()?.collectors.slack;
    if slack.token.trim().is_empty() || slack.watch_user_id.trim().is_empty() {
        return None;
    }
    Some(tt_collect::SlackDmConfig {
        token: slack.token,
        watch_user_id: slack.watch_user_id,
        watch_name: slack.watch_name,
    })
}

/// Member id fallback, matching the collector.
fn display_name(config: &tt_collect::SlackDmConfig) -> String {
    if config.watch_name.trim().is_empty() {
        config.watch_user_id.clone()
    } else {
        config.watch_name.clone()
    }
}

/// Unconfigured is a clean `configured: false` view, not an error.
#[tauri::command]
pub async fn slack_dm_history() -> Result<SlackDmView, String> {
    let Some(config) = dm_config() else {
        return Ok(SlackDmView {
            configured: false,
            watch_name: String::new(),
            watch_user_id: String::new(),
            messages: Vec::new(),
        });
    };
    let watch_name = display_name(&config);
    let watch_user_id = config.watch_user_id.clone();
    let messages = tauri::async_runtime::spawn_blocking(move || {
        tt_collect::fetch_dm_history(&config, HISTORY_LIMIT)
    })
    .await
    .map_err(|e| format!("slack history task failed: {e}"))??;
    Ok(SlackDmView { configured: true, watch_name, watch_user_id, messages })
}

/// `url` must be a `url_private`/thumb URL from a [`tt_collect::DmFile`]; only
/// `*.slack.com` is honored. A missing `files:read` scope comes back as an error
/// the frontend maps to a placeholder rather than failing the whole panel.
#[tauri::command]
pub async fn slack_dm_file(url: String) -> Result<SlackFileData, String> {
    use base64::Engine;

    let config = dm_config().ok_or("Slack DM is not configured")?;
    let file =
        tauri::async_runtime::spawn_blocking(move || tt_collect::fetch_file(&config.token, &url))
            .await
            .map_err(|e| format!("slack file task failed: {e}"))??;
    let data_base64 = base64::engine::general_purpose::STANDARD.encode(&file.bytes);
    Ok(SlackFileData { mimetype: file.mimetype, data_base64 })
}

/// For the Settings watch-user picker. A blank token gives an empty list, not an
/// error, so the picker degrades to a plain text input.
#[tauri::command]
pub async fn slack_list_users() -> Result<Vec<tt_collect::SlackUser>, String> {
    let token = tt_config::load().map_err(|e| e.to_string())?.collectors.slack.token;
    if token.trim().is_empty() {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || tt_collect::list_users(&token))
        .await
        .map_err(|e| format!("slack users task failed: {e}"))?
}

/// Parent then replies, oldest first.
#[tauri::command]
pub async fn slack_dm_thread(thread_ts: String) -> Result<Vec<tt_collect::DmMessage>, String> {
    let config = dm_config().ok_or("Slack DM is not configured")?;
    tauri::async_runtime::spawn_blocking(move || tt_collect::fetch_thread(&config, &thread_ts))
        .await
        .map_err(|e| format!("slack thread task failed: {e}"))?
}

/// Post as me, then refresh the stored DM state so the attention banner clears
/// without waiting for a tick. A `threadTs` posts into that thread.
#[tauri::command]
pub async fn slack_dm_send(
    app: AppHandle,
    text: String,
    thread_ts: Option<String>,
) -> Result<(), String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("message text is required".into());
    }
    let thread_ts = thread_ts.unwrap_or_default();
    let config = dm_config()
        .ok_or("Slack DM is not configured — set the token and member id in Settings")?;

    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        tt_collect::send_dm(&config, &text, &thread_ts)?;
        // The action, not its content — the message text is deliberately absent
        // (the event log is plaintext; user content never lands in it).
        tracing::info!(threaded = !thread_ts.is_empty(), "slack.dm_sent");
        refresh_snapshot(&app, &config);
        Ok(())
    })
    .await
    .map_err(|e| format!("slack send task failed: {e}"))?
}

/// Toggle one of my reactions; `name` is a bare shortcode (`thumbsup`).
#[tauri::command]
pub async fn slack_dm_react(
    app: AppHandle,
    ts: String,
    name: String,
    add: bool,
) -> Result<(), String> {
    let config = dm_config().ok_or("Slack DM is not configured")?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        tt_collect::set_reaction(&config, &ts, &name, add)?;
        // The toggle direction, not which emoji — a custom workspace shortcode is
        // user content and the log is plaintext.
        tracing::info!(added = add, "slack.dm_reacted");
        refresh_snapshot(&app, &config);
        Ok(())
    })
    .await
    .map_err(|e| format!("slack react task failed: {e}"))?
}

/// Best-effort store refresh after a write: the Slack call already succeeded, so
/// a store hiccup must not fail the command — the next tick catches up.
fn refresh_snapshot(app: &AppHandle, config: &tt_collect::SlackDmConfig) {
    if let Ok(store) = tt_store::Store::open_default() {
        let now = chrono::Local::now().timestamp_millis();
        let _ = tt_collect::collect_slack_dm(&store, config, now);
        if let Ok(snapshot) = store.snapshot() {
            let _ = app.emit(SNAPSHOT_EVENT, snapshot);
        }
    }
}
