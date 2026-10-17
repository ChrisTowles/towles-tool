#[test]
fn expand_tilde_only_expands_a_leading_home_marker() {
    let home = Path::new("/home/u");
    assert_eq!(expand_tilde_with("~", Some(home)), PathBuf::from("/home/u"));
    assert_eq!(expand_tilde_with(" ~/code/p ", Some(home)), PathBuf::from("/home/u/code/p"));
    assert_eq!(expand_tilde_with("~other/x", Some(home)), PathBuf::from("~other/x"));
    assert_eq!(expand_tilde_with("/abs", Some(home)), PathBuf::from("/abs"));
    assert_eq!(expand_tilde_with("~/x", None), PathBuf::from("~/x"));
}

use super::*;
use tempfile::TempDir;

/// The drift guard for a struct whose field names leave `camelCase`.
fn json_schema() -> serde_json::Value {
    let schema = schemars::schema_for!(UserSettings);
    serde_json::to_value(schema).expect("settings JSON schema should serialize")
}

#[test]
fn telemetry_retention_is_clamped_and_lenient() {
    assert_eq!(TelemetrySettings::default().retain_days(), 14);
    assert_eq!(TelemetrySettings { retain_days: 0 }.retain_days(), 1);
    assert_eq!(TelemetrySettings { retain_days: 9_999 }.retain_days(), 365);
    let parsed: UserSettings =
        serde_json::from_str(r#"{"telemetry": {"retainDays": "lots"}}"#).unwrap();
    assert_eq!(parsed.telemetry, TelemetrySettings::default());
    let parsed: UserSettings =
        serde_json::from_str(r#"{"telemetry": {"retainDays": 30}}"#).unwrap();
    assert_eq!(parsed.telemetry.retain_days(), 30);
}

#[test]
fn defaults_match_ts_cli() {
    let settings = UserSettings::default();
    assert_eq!(settings.preferred_editor, "code");
    assert!(settings.journal_settings.daily_path_template.contains("daily-notes"));
}

#[test]
fn save_then_load_round_trips() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("towles-tool.settings.json");

    let settings = UserSettings { preferred_editor: "nvim".to_string(), ..Default::default() };
    save_to(&path, &settings).unwrap();

    let loaded = load_from(&path).unwrap();
    assert_eq!(loaded, settings);
}

/// The file holds Slack tokens; neither write path may widen it.
#[cfg(unix)]
#[test]
fn saves_are_owner_only() {
    use std::os::unix::fs::PermissionsExt;

    let dir = TempDir::new().unwrap();
    let settings = UserSettings::default();

    for path in [
        dir.path().join("fresh.json"),
        dir.path().join("merged.json"),
    ] {
        // Tightened on an existing file, not inherited at creation.
        std::fs::write(&path, "{}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        if path.ends_with("fresh.json") {
            save_to(&path, &settings).unwrap();
        } else {
            save_merge_to(&path, &settings).unwrap();
        }

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "{} left at {mode:o}", path.display());
    }
}

#[test]
fn load_from_missing_creates_defaults() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("nested").join("towles-tool.settings.json");

    assert!(!path.exists());
    let loaded = load_from(&path).unwrap();
    assert!(path.exists());
    assert_eq!(loaded, UserSettings::default());
}

#[test]
fn tolerates_unknown_fields_and_fills_defaults() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("towles-tool.settings.json");
    std::fs::write(
        &path,
        r#"{"preferredEditor":"vim","futureFlag":true,"journalSettings":{"baseFolder":"/tmp/j"}}"#,
    )
    .unwrap();

    let loaded = load_from(&path).unwrap();
    assert_eq!(loaded.preferred_editor, "vim");
    assert_eq!(loaded.journal_settings.base_folder, "/tmp/j");
    assert!(loaded.journal_settings.daily_path_template.contains("daily-notes"));
}

#[test]
fn tolerates_unknown_fields_at_every_nesting_level() {
    // Shared with the TS CLI: never reject an unmodeled key, at any depth.
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("towles-tool.settings.json");
    std::fs::write(
        &path,
        r#"{
            "preferredEditor": "hx",
            "rootTsOnly": {"any": "shape"},
            "journalSettings": {"baseFolder": "/j", "journalTsOnly": 1},
            "agentboard": {"mux": "tmux", "agentboardTsOnly": true},
            "mcp": {"port": 9191, "mcpTsOnly": [1, 2, 3]},
            "collectors": {
                "collectorsTsOnly": "x",
                "prs": {"enabled": false, "prsTsOnly": 7},
                "calendar": {
                    "enabled": true,
                    "calendarTsOnly": {"nested": "too"},
                    "sources": [
                        {"id": "google", "label": "G", "enabled": true, "prompt": "p", "sourceTsOnly": 9}
                    ]
                }
            }
        }"#,
    )
    .unwrap();

    let loaded = load_from(&path).unwrap();
    assert_eq!(loaded.preferred_editor, "hx");
    assert_eq!(loaded.journal_settings.base_folder, "/j");
    assert_eq!(loaded.mcp.port, 9191);
    assert!(!loaded.collectors.prs.enabled);
    assert!(loaded.collectors.calendar.enabled);
    assert_eq!(loaded.collectors.calendar.sources.len(), 1);
    assert_eq!(loaded.collectors.calendar.sources[0].id, "google");
    assert!(loaded.journal_settings.daily_path_template.contains("daily-notes"));
    assert_eq!(loaded.collectors.issues.refresh_minutes, 15);

    let mut edited = loaded;
    edited.preferred_editor = "code".to_string();
    save_merge_to(&path, &edited).unwrap();
    let raw: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(raw["preferredEditor"], "code", "known edit wins");
    assert_eq!(raw["rootTsOnly"]["any"], "shape", "root unknown survives");
    assert_eq!(raw["journalSettings"]["journalTsOnly"], 1);
    assert_eq!(raw["agentboard"]["agentboardTsOnly"], true);
    assert_eq!(raw["mcp"]["mcpTsOnly"][0], 1);
    assert_eq!(raw["collectors"]["collectorsTsOnly"], "x");
    assert_eq!(raw["collectors"]["prs"]["prsTsOnly"], 7);
    assert_eq!(raw["collectors"]["calendar"]["calendarTsOnly"]["nested"], "too");
}

#[test]
fn malformed_mcp_block_falls_back_to_default_without_failing_the_file() {
    // Hand-editing is invited, so a slip must not brick every consumer.
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("towles-tool.settings.json");
    for bad_block in [
        r#"null"#,
        r#"{"port":"47870"}"#, // string, not integer
        r#"[9999]"#,           // array: must not set the port positionally
    ] {
        std::fs::write(&path, format!(r#"{{"preferredEditor":"vim","mcp":{bad_block}}}"#)).unwrap();
        let loaded = load_from(&path).unwrap();
        assert_eq!(loaded.preferred_editor, "vim", "rest of the file still loads");
        assert_eq!(loaded.mcp.port, DEFAULT_MCP_PORT, "falls back for {bad_block}");
    }

    std::fs::write(&path, r#"{"mcp":{"port":9123}}"#).unwrap();
    assert_eq!(load_from(&path).unwrap().mcp.port, 9123);
}

#[test]
fn update_channel_defaults_stable_and_tolerates_junk() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("towles-tool.settings.json");
    assert_eq!(UserSettings::default().updates.channel, UpdateChannel::Stable);
    for bad in [r#"null"#, r#"{"channel":"beta"}"#, r#""main""#] {
        std::fs::write(&path, format!(r#"{{"preferredEditor":"vim","updates":{bad}}}"#)).unwrap();
        let loaded = load_from(&path).unwrap();
        assert_eq!(loaded.preferred_editor, "vim", "rest of the file still loads");
        assert_eq!(loaded.updates.channel, UpdateChannel::Stable, "falls back for {bad}");
    }
    std::fs::write(&path, r#"{"updates":{"channel":"main"}}"#).unwrap();
    assert_eq!(load_from(&path).unwrap().updates.channel, UpdateChannel::Main);
}

#[test]
fn save_merge_preserves_unknown_keys() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("towles-tool.settings.json");
    std::fs::write(
        &path,
        r#"{"preferredEditor":"vim","futureFlag":true,"journalSettings":{"baseFolder":"/old","tsOnly":42}}"#,
    )
    .unwrap();

    let mut settings = load_from(&path).unwrap();
    settings.preferred_editor = "code".to_string();
    settings.journal_settings.base_folder = "/new".to_string();
    save_merge_to(&path, &settings).unwrap();

    let raw: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(raw["preferredEditor"], "code");
    assert_eq!(raw["journalSettings"]["baseFolder"], "/new");
    assert_eq!(raw["futureFlag"], true);
    assert_eq!(raw["journalSettings"]["tsOnly"], 42);
}

#[test]
fn serializes_camel_case() {
    let json = serde_json::to_string(&UserSettings::default()).unwrap();
    assert!(json.contains("\"preferredEditor\""));
    assert!(json.contains("\"journalSettings\""));
    assert!(json.contains("\"dailyPathTemplate\""));
    assert!(json.contains("\"collectors\""));
    assert!(json.contains("\"refreshMinutes\""));
}

#[test]
fn collectors_defaults() {
    let c = UserSettings::default().collectors;
    assert!(!c.calendar.enabled);
    assert_eq!(c.calendar.refresh_minutes, 15);
    let ids: Vec<&str> = c.calendar.sources.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, vec!["google", "outlook"]);
    assert!(c.calendar.sources[0].enabled, "google on by default");
    assert!(!c.calendar.sources[1].enabled, "outlook opt-in");
    assert_eq!(c.calendar.sources[0].prompt, DEFAULT_CALENDAR_PROMPT_GOOGLE);
    assert_eq!(c.calendar.sources[1].prompt, DEFAULT_CALENDAR_PROMPT_OUTLOOK);
    assert!(c.calendar.quiet_hours.enabled);
    assert_eq!(c.calendar.quiet_hours.start_hour, 8);
    assert_eq!(c.calendar.quiet_hours.end_hour, 18);
    assert_eq!(c.calendar.quiet_hours.weekdays, vec![0, 1, 2, 3, 4]);
    assert!(c.prs.enabled);
    assert_eq!(c.prs.refresh_seconds, 1200);
    assert_eq!(c.prs.merged_refresh_minutes, 60);
    assert!(c.issues.enabled);
    assert_eq!(c.issues.refresh_minutes, 15);
    assert!(!c.slack.enabled);
    assert!(c.slack.token.is_empty());
    assert!(c.slack.app_token.is_empty());
    assert_eq!(c.slack.refresh_seconds, 60);
}

#[test]
fn prompt_improver_defaults() {
    let s = UserSettings::default();
    let ids: Vec<&str> = s.prompt_improvers.iter().map(|g| g.id.as_str()).collect();
    assert_eq!(ids, vec!["direct", "clarify", "brainstorm", "interview"]);
    assert!(s.prompt_improvers.iter().all(|g| g.enabled));
    let preferred: Vec<&str> =
        s.prompt_improvers.iter().filter(|g| g.preferred).map(|g| g.id.as_str()).collect();
    assert_eq!(preferred, vec!["direct"]);
    // Instructions *about* the task, never templates containing it.
    assert!(s.prompt_improvers.iter().all(|g| !g.prompt.trim().is_empty()));
    assert!(!s.prompt_improvers.iter().any(|g| g.prompt.contains("{goal}")));
    let json = serde_json::to_string(&s).unwrap();
    assert!(json.contains("\"promptImprovers\""));
}

#[test]
fn saved_view_defaults() {
    let s = UserSettings::default();
    let ids: Vec<&str> = s.saved_views.iter().map(|v| v.id.as_str()).collect();
    assert_eq!(ids, vec!["gh-failures", "slow-spawns", "interruptions"]);
    assert!(s.saved_views.iter().all(|v| v.days >= 1 && !v.filters.is_empty()));
    let json = serde_json::to_string(&s).unwrap();
    assert!(json.contains("\"savedViews\""));
    // The op spelling is the frontend's contract; a rename breaks every stored view.
    assert!(json.contains("\"op\":\"neq\""));
    assert!(json.contains("\"op\":\"contains\""));
}

#[test]
fn saved_query_defaults() {
    let s = UserSettings::default();
    let ids: Vec<&str> = s.saved_queries.iter().map(|q| q.id.as_str()).collect();
    assert_eq!(
        ids,
        vec![
            "gh-failures-by-cwd",
            "slow-spawns",
            "focus-flips-per-hour",
            "interruptions-while-focused",
            "model-spend-by-day",
            "agent-status-by-checkout",
            "warnings-by-message"
        ]
    );
    assert!(s.saved_queries.iter().all(|q| !q.label.trim().is_empty()));
    // One read-only statement each; `tt-telemetry`'s tests prove they run.
    assert!(s.saved_queries.iter().all(|q| q.sql.trim_start().starts_with("select")));
    assert!(s.saved_queries.iter().all(|q| !q.sql.contains(';')));
    let json = serde_json::to_string(&s).unwrap();
    assert!(json.contains("\"savedQueries\""));
}

#[test]
fn telemetry_rule_defaults() {
    let s = UserSettings::default();
    let ids: Vec<&str> = s.telemetry_rules.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(
        ids,
        vec![
            "gh-exits-clean",
            "no-spawn-over-30s",
            "needs-you-not-spammed",
            "zero-warn",
            "zero-error"
        ]
    );
    assert!(s.telemetry_rules.iter().all(|r| r.enabled && r.days >= 1 && !r.select.is_empty()));
    for rule in &s.telemetry_rules {
        match rule.kind {
            RuleKind::Share => assert!(!rule.pass.is_empty(), "{}", rule.id),
            RuleKind::Count => assert!(rule.pass.is_empty(), "{}", rule.id),
        }
    }
    let json = serde_json::to_string(&s).unwrap();
    assert!(json.contains("\"telemetryRules\""));
    assert!(json.contains("\"kind\":\"share\""));
    assert!(json.contains("\"kind\":\"count\""));
}

#[test]
fn notify_defaults_unset_and_everything_on() {
    let s = UserSettings::default();
    assert!(s.agentboard.notify.is_none());
    assert!(s.agentboard.notify_threshold.is_none());
    // The keys, not the word: a default saved query mentions `notify_needs_you`.
    let json = serde_json::to_string(&s).unwrap();
    assert!(!json.contains("\"notify\""));
    assert!(!json.contains("\"notifyThreshold\""));
    assert!(
        [
            NotifyKind::NeedsYou,
            NotifyKind::MeetingStart,
            NotifyKind::ChecksFailed,
            NotifyKind::ReviewRequested,
            NotifyKind::StaleCollector,
        ]
        .into_iter()
        .all(|k| s.agentboard.notifies(k))
    );
}

#[test]
fn notify_threshold_filters_by_level() {
    let mut ab =
        AgentboardSettings { notify_threshold: Some(NotifyLevel::Important), ..Default::default() };
    assert!(ab.notifies(NotifyKind::MeetingStart), "urgent clears an important threshold");
    assert!(ab.notifies(NotifyKind::ChecksFailed), "at the threshold still fires");
    assert!(!ab.notifies(NotifyKind::ReviewRequested), "routine is below it");
    assert!(!ab.notifies(NotifyKind::StaleCollector));

    ab.notify_threshold = Some(NotifyLevel::Urgent);
    assert!(ab.notifies(NotifyKind::NeedsYou));
    assert!(!ab.notifies(NotifyKind::ChecksFailed));
}

#[test]
fn notify_off_silences_even_the_most_urgent_kind() {
    let ab = AgentboardSettings {
        notify: Some(false),
        notify_threshold: Some(NotifyLevel::Routine),
        ..Default::default()
    };
    assert!(!ab.notifies(NotifyKind::MeetingStart));
    assert!(!ab.notifies(NotifyKind::NeedsYou));
}

#[test]
fn notify_threshold_round_trips_camel_case_and_tolerates_junk() {
    let json = r#"{"agentboard":{"notify":false,"notifyThreshold":"important"}}"#;
    let s: UserSettings = serde_json::from_str(json).unwrap();
    assert_eq!(s.agentboard.notify, Some(false));
    assert_eq!(s.agentboard.notify_threshold, Some(NotifyLevel::Important));
    assert!(serde_json::to_string(&s).unwrap().contains("\"notifyThreshold\":\"important\""));

    // A newer build's level defaults rather than failing the whole file.
    let odd = r#"{"agentboard":{"notifyThreshold":"apocalyptic"}}"#;
    let s: UserSettings = serde_json::from_str(odd).unwrap();
    assert!(s.agentboard.notify_threshold.is_none());
    assert!(s.agentboard.notifies(NotifyKind::StaleCollector));
}

#[test]
fn copy_on_select_defaults_unset_and_on() {
    let s = UserSettings::default();
    assert!(s.agentboard.copy_on_select.is_none());
    let json = serde_json::to_string(&s).unwrap();
    assert!(!json.contains("copyOnSelect"));
    assert!(s.agentboard.copy_on_select.unwrap_or(true));
}

#[test]
fn auto_resume_and_advance_default_unset_and_round_trip() {
    let s = UserSettings::default();
    assert!(s.agentboard.auto_resume.is_none() && s.agentboard.advance_after_submit.is_none());
    let json = serde_json::to_string(&s).unwrap();
    assert!(!json.contains("autoResume") && !json.contains("advanceAfterSubmit"));
    let off: UserSettings =
        serde_json::from_str(r#"{"agentboard":{"autoResume":false,"advanceAfterSubmit":false}}"#)
            .unwrap();
    assert_eq!(off.agentboard.auto_resume, Some(false));
    assert_eq!(off.agentboard.advance_after_submit, Some(false));
}

#[test]
fn shortcuts_work_in_terminal_defaults_unset_and_on() {
    let s = UserSettings::default();
    assert!(s.agentboard.shortcuts_work_in_terminal.is_none());
    let json = serde_json::to_string(&s).unwrap();
    assert!(!json.contains("shortcutsWorkInTerminal"));
    assert!(s.agentboard.shortcuts_work_in_terminal.unwrap_or(true));
}

#[test]
fn pc_keybindings_defaults_unset_and_off() {
    let s = UserSettings::default();
    assert!(s.agentboard.pc_keybindings.is_none());
    assert!(!serde_json::to_string(&s).unwrap().contains("pcKeybindings"));
    let on: AgentboardSettings = serde_json::from_str(r#"{"pcKeybindings":true}"#).unwrap();
    assert_eq!(on.pc_keybindings, Some(true));
}

#[test]
fn shortcut_coach_defaults_unset_and_on() {
    let s = UserSettings::default();
    assert!(s.agentboard.shortcut_coach.is_none());
    let json = serde_json::to_string(&s).unwrap();
    assert!(!json.contains("shortcutCoach"));
    assert!(s.agentboard.shortcut_coach.unwrap_or(true));
}

#[test]
fn terminal_font_size_defaults_unset_and_thirteen() {
    let s = UserSettings::default();
    assert!(s.agentboard.terminal_font_size.is_none());
    let json = serde_json::to_string(&s).unwrap();
    assert!(!json.contains("terminalFontSize"));
    assert_eq!(s.agentboard.terminal_font_size.unwrap_or(13), 13);
}

#[test]
fn terminal_font_size_tolerates_unknown_and_roundtrips() {
    let json = r#"{"agentboard":{"terminalFontSize":17,"someFutureKey":true}}"#;
    let s: UserSettings = serde_json::from_str(json).unwrap();
    assert_eq!(s.agentboard.terminal_font_size, Some(17));
    let out = serde_json::to_string(&s).unwrap();
    assert!(out.contains("\"terminalFontSize\":17"));
}

#[test]
fn json_schema_has_properties() {
    let schema = json_schema();
    let props = &schema["properties"];
    assert!(props.get("preferredEditor").is_some());
    assert!(props.get("journalSettings").is_some());
    assert!(props.get("agentboard").is_some());
}

/// The TS CLI expects `camelCase`; an underscore here is a break waiting.
#[test]
fn json_schema_property_names_are_camel_case() {
    fn walk(node: &serde_json::Value, offenders: &mut Vec<String>) {
        match node {
            serde_json::Value::Object(map) => {
                if let Some(serde_json::Value::Object(props)) = map.get("properties") {
                    for name in props.keys() {
                        if name.contains('_') {
                            offenders.push(name.clone());
                        }
                    }
                }
                for value in map.values() {
                    walk(value, offenders);
                }
            }
            serde_json::Value::Array(items) => {
                for item in items {
                    walk(item, offenders);
                }
            }
            _ => {}
        }
    }

    let schema = json_schema();
    let mut offenders = Vec::new();
    walk(&schema, &mut offenders);
    assert!(
        offenders.is_empty(),
        "schema has non-camelCase property names (would break the shared TS-CLI file): {offenders:?}",
    );
}

/// The schema must reach the nested collector tree, not just the top level.
#[test]
fn json_schema_covers_nested_collectors() {
    let schema = json_schema();
    let defs = &schema["definitions"];
    assert!(defs.get("CollectorsSettings").is_some());
    let cal = &defs["CalendarCollector"]["properties"];
    assert!(cal.get("refreshMinutes").is_some());
    assert!(cal.get("sources").is_some());
    // The user-facing escape hatch; absent, the settings UI can't offer it.
    let src = &defs["CalendarSource"]["properties"];
    assert!(src.get("prompt").is_some());
    assert!(src.get("enabled").is_some());
    let prs = &defs["PrCollector"]["properties"];
    assert!(prs.get("refreshSeconds").is_some());
    assert!(prs.get("mergedRefreshMinutes").is_some());
}

/// [`save_to`] drops unmodeled TS keys where [`save_merge_to`] keeps them;
/// a refactor making them agree must be deliberate.
#[test]
fn save_to_drops_unknown_keys() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("towles-tool.settings.json");
    std::fs::write(
        &path,
        r#"{"preferredEditor":"vim","futureFlag":true,"journalSettings":{"baseFolder":"/old","tsOnly":42}}"#,
    )
    .unwrap();

    let settings = load_from(&path).unwrap();
    save_to(&path, &settings).unwrap();

    let raw: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(raw["preferredEditor"], "vim");
    assert_eq!(raw["journalSettings"]["baseFolder"], "/old");
    assert!(raw.get("futureFlag").is_none());
    assert!(raw["journalSettings"].get("tsOnly").is_none());
}

static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The one `unsafe` env seam in these tests; every caller holds ENV_LOCK.
fn set_scope_env(value: Option<&str>) {
    // SAFETY: guarded by ENV_LOCK.
    unsafe {
        match value {
            Some(v) => std::env::set_var(STATE_SCOPE_ENV, v),
            None => std::env::remove_var(STATE_SCOPE_ENV),
        }
    }
}

/// A task-checkout layout, plus a nested crate dir for subdir detection.
fn task_checkout(root_name: &str) -> TempDir {
    let dir = TempDir::new().unwrap();
    let root = dir.path().join(root_name);
    std::fs::create_dir_all(root.join("crates").join("tt-config")).unwrap();
    std::fs::create_dir_all(root.join("crates").join("tt-store").join("src")).unwrap();
    dir
}

#[test]
fn task_checkout_dir_derives_scope() {
    let dir = task_checkout("towles-tool");
    let root = dir.path().join("towles-tool");
    assert_eq!(task_scope_from_dir(&root), Some("towles-tool".to_string()));
    assert_eq!(
        task_scope_from_dir(&root.join("crates").join("tt-store").join("src")),
        Some("towles-tool".to_string())
    );
}

#[test]
fn nested_worktree_checkout_is_repo_qualified() {
    // Carries the main checkout's name, so same-named tasks of different
    // repos never share state.
    let dir = TempDir::new().unwrap();
    let task = dir.path().join("towles-tool").join(".claude").join("worktrees").join("migrate");
    std::fs::create_dir_all(task.join("crates").join("tt-config")).unwrap();
    assert_eq!(task_scope_from_dir(&task), Some("towles-tool-migrate".to_string()));
}

#[test]
fn worktrees_dir_outside_claude_is_not_qualified() {
    let dir = TempDir::new().unwrap();
    let checkout = dir.path().join("worktrees").join("thing");
    std::fs::create_dir_all(checkout.join("crates").join("tt-config")).unwrap();
    assert_eq!(task_scope_from_dir(&checkout), Some("thing".to_string()));
}

#[test]
fn non_repo_dir_is_unscoped() {
    let dir = TempDir::new().unwrap();
    assert_eq!(task_scope_from_dir(dir.path()), None);
}

#[test]
fn arbitrary_git_repo_is_unscoped() {
    let dir = TempDir::new().unwrap();
    let root = dir.path().join("some-other-project");
    std::fs::create_dir_all(root.join(".git")).unwrap();
    std::fs::create_dir_all(root.join("crates").join("their-crate")).unwrap();
    std::fs::write(root.join("Cargo.toml"), "[workspace]\n").unwrap();
    assert_eq!(task_scope_from_dir(&root), None);
}

#[test]
fn sanitize_scope_keeps_scope_names_and_strips_others() {
    assert_eq!(sanitize_scope("towles-tool-task-2"), "towles-tool-task-2");
    assert_eq!(sanitize_scope("  weird/name space "), "weird-name-space");
}

#[test]
fn env_override_forces_scope_and_empty_forces_unscoped() {
    let _guard = ENV_LOCK.lock().unwrap();
    let base = PathBuf::from("/home/x/.config/towles-tool");

    // A FORCED scope nests shared stores too, so tests stay off real files.
    set_scope_env(Some("my-scope"));
    assert_eq!(state_scope(), Some("my-scope".to_string()));
    assert_eq!(instance_under(base.clone()), base.join("tasks").join("my-scope"));
    assert_eq!(shared_under(base.clone()), base.join("tasks").join("my-scope"));

    set_scope_env(Some(""));
    assert_eq!(state_scope(), None);
    assert_eq!(instance_under(base.clone()), base);
    assert_eq!(shared_under(base.clone()), base);

    set_scope_env(None);
}

/// Pure resolvers with a hand-built Scope: auto-detection reads the cwd.
#[test]
fn auto_scope_nests_instance_but_not_shared() {
    let base = PathBuf::from("/home/x/.config/towles-tool");
    let auto = Scope::Auto("towles-tool-thing".into());
    assert_eq!(nest(base.clone(), &auto, true), base.join("tasks").join("towles-tool-thing"));
    assert_eq!(nest(base.clone(), &auto, false), base);
}

#[test]
fn config_dir_override_wins_via_env_but_scoped_paths_nest() {
    let _guard = ENV_LOCK.lock().unwrap();
    set_scope_env(Some("task-9"));
    let cfg = config_dir().unwrap();
    assert!(cfg.ends_with("towles-tool/tasks/task-9"), "got {}", cfg.display());
    assert!(config_path().unwrap().ends_with("task-9/towles-tool.settings.json"));
    assert!(store_db_path().unwrap().ends_with("towles-tool/tasks/task-9/tt.db"));
    assert!(agentboard_dir().unwrap().ends_with("tasks/task-9/agentboard"));
    set_scope_env(None);
}

/// Machine-wide even when auto-scoped; a forced scope sandboxes them.
#[test]
fn instance_state_bases_ignore_auto_but_honor_forced_scope() {
    let _guard = ENV_LOCK.lock().unwrap();

    set_scope_env(Some(""));
    let bases = instance_state_bases().unwrap();
    assert!(bases.data.ends_with("towles-tool"), "got {}", bases.data.display());
    assert!(bases.config.ends_with(".config/towles-tool"), "got {}", bases.config.display());
    let [data_tasks, config_tasks] = bases.scope_parents();
    assert!(data_tasks.ends_with("towles-tool/tasks"));
    assert!(config_tasks.ends_with(".config/towles-tool/tasks"));
    assert!(bases.agentboard_dir(None).ends_with("towles-tool/agentboard"));
    assert!(
        bases
            .agentboard_dir(Some("repo-thing"))
            .ends_with("towles-tool/tasks/repo-thing/agentboard")
    );

    set_scope_env(Some("sandbox"));
    let bases = instance_state_bases().unwrap();
    assert!(bases.data.ends_with("towles-tool/tasks/sandbox"));
    assert!(bases.config.ends_with(".config/towles-tool/tasks/sandbox"));

    set_scope_env(None);
}

#[test]
fn instance_state_dirs_target_the_named_scope_not_the_ambient_one() {
    let _guard = ENV_LOCK.lock().unwrap();
    set_scope_env(Some(""));
    let dirs = instance_state_dirs_for_scope("towles-tool-thing");
    assert!(!dirs.is_empty());
    for dir in &dirs {
        assert!(dir.ends_with("towles-tool/tasks/towles-tool-thing"), "got {}", dir.display());
    }
    assert!(instance_state_dirs_for_scope("  ").is_empty());

    // A FORCED scope nests the targets too, off the real machine paths.
    set_scope_env(Some("test-world"));
    for dir in instance_state_dirs_for_scope("towles-tool-thing") {
        assert!(dir.ends_with("tasks/test-world/tasks/towles-tool-thing"), "got {}", dir.display());
    }
    set_scope_env(None);
}

#[test]
fn unscoped_paths_match_historic_defaults() {
    let _guard = ENV_LOCK.lock().unwrap();
    set_scope_env(Some(""));
    assert!(config_dir().unwrap().ends_with(".config/towles-tool"));
    assert!(config_path().unwrap().ends_with("towles-tool/towles-tool.settings.json"));
    assert!(store_db_path().unwrap().ends_with("towles-tool/tt.db"));
    assert!(agentboard_dir().unwrap().ends_with("towles-tool/agentboard"));
    set_scope_env(None);
}
