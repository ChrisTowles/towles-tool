//! Tauri bridge for the shared user settings (`tt_config`). The Settings screen
//! reads the typed model with `settings_get` and writes it back with
//! `settings_set`, which uses `tt_config::save_merge` so keys the shared
//! TypeScript CLI owns (but this model doesn't capture) survive the round-trip.
//!
//! Settings live in a file, so each command loads/saves fresh. The one piece of
//! state is `SettingsSignal`: the `Notify`s the collector scheduler and the
//! Slack Socket Mode task wait on so a `settings_set` re-reads the `collectors`
//! block live (cadence/enable/provider, and the Slack tokens) without a
//! relaunch. Each waiter gets its own `Notify` so `notify_one`'s stored permit
//! reliably reaches both, even one that isn't currently parked.

use std::sync::Arc;

use tauri::State;
use tokio::sync::Notify;

use tt_config::UserSettings;

/// Managed signals fired after a settings write so the background tasks re-read
/// config: one for the collector scheduler, one for the Slack socket loop.
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

/// Load the current settings (defaults written to disk if the file is missing).
#[tauri::command]
pub fn settings_get() -> Result<UserSettings, String> {
    tt_config::load().map_err(|e| format!("failed to load settings: {e}"))
}

/// The built-in prompt improvers, so the Settings screen's "Reset to defaults"
/// restores what `tt_config` ships instead of a second copy of these prompts.
#[tauri::command]
pub fn settings_default_prompt_improvers() -> Vec<tt_config::PromptImprover> {
    tracing::info!("settings.default_prompt_improvers");
    tt_config::PromptImprover::defaults()
}

/// The built-in telemetry rules, for the same reset button on the Rules list.
#[tauri::command]
pub fn settings_default_telemetry_rules() -> Vec<tt_config::TelemetryRule> {
    tracing::info!("settings.default_telemetry_rules");
    tt_config::TelemetryRule::defaults()
}

/// Persist edited settings, preserving any unknown keys already on disk, then
/// signal the scheduler to re-read collector cadence.
#[tauri::command]
pub fn settings_set(settings: UserSettings, signal: State<SettingsSignal>) -> Result<(), String> {
    tt_config::save_merge(&settings).map_err(|e| format!("failed to save settings: {e}"))?;
    tracing::info!("settings.saved");
    signal.scheduler.notify_one();
    signal.slack_socket.notify_one();
    Ok(())
}
