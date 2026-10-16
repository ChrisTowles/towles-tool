//! Tauri bridge for the shared user settings (`tt_config`). The Settings screen
//! reads the typed model with `settings_get` and writes it back with
//! `settings_set`, which uses `tt_config::save_merge` so keys the shared
//! TypeScript CLI owns (but this model doesn't capture) survive the round-trip.

use std::sync::Arc;

use tauri::State;
use tokio::sync::Notify;

use tt_config::UserSettings;

pub struct SettingsSignal {
    pub scheduler: Arc<Notify>,
    pub slack_socket: Arc<Notify>,
}

/// Whether a desktop notification of this kind may fire right now: the master
/// switch is on and the kind clears the user's urgency threshold
/// (`tt_config::AgentboardSettings::notifies`). The single gate every notify
/// site calls — settings live in a file, so this reads fresh, and an unreadable
/// file falls back to the built-in defaults rather than going silent.
pub fn notify_allowed(kind: tt_config::NotifyKind) -> bool {
    tt_config::load()
        .map(|s| s.agentboard.notifies(kind))
        .unwrap_or_else(|_| tt_config::AgentboardSettings::default().notifies(kind))
}

#[tauri::command]
pub fn settings_get() -> Result<UserSettings, String> {
    tt_config::load().map_err(|e| format!("failed to load settings: {e}"))
}

#[tauri::command]
pub fn settings_default_prompt_improvers() -> Vec<tt_config::PromptImprover> {
    tracing::info!("settings.default_prompt_improvers");
    tt_config::PromptImprover::defaults()
}

#[tauri::command]
pub fn settings_default_telemetry_rules() -> Vec<tt_config::TelemetryRule> {
    tracing::info!("settings.default_telemetry_rules");
    tt_config::TelemetryRule::defaults()
}

#[tauri::command]
pub fn settings_set(settings: UserSettings, signal: State<SettingsSignal>) -> Result<(), String> {
    tt_config::save_merge(&settings).map_err(|e| format!("failed to save settings: {e}"))?;
    tracing::info!("settings.saved");
    signal.scheduler.notify_one();
    signal.slack_socket.notify_one();
    Ok(())
}
