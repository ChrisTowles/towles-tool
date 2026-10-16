use super::*;
use chrono::Duration;
use tt_store::{NoteDelivery, NoteSource};

const NOW: i64 = 1_700_000_000_000; // fixed epoch ms for deterministic tests
const TEST_VERSION: &str = "0.0.0-test";

/// The tracked repo every test dispatcher knows, seeded as the Agentboard poll loop would.
const REPO_DIR: &str = "/home/u/code/demo";
const REPO_SLUG: &str = "o/demo";

fn seeded_store() -> Store {
    let store = Store::open_in_memory().unwrap();
    store.add_task("open task", "backlog", None, None, NOW).unwrap();
    store
}

/// A dispatcher over a store with one reconciled tracked repo — never the real `repos.json`.
fn dispatcher() -> Dispatcher {
    let store = seeded_store();
    store.reconcile_repos(&[(REPO_DIR.to_string(), REPO_SLUG.to_string())], NOW).unwrap();
    Dispatcher::new(store, TEST_VERSION)
        .with_calendar_sources(vec!["google".to_string(), "outlook".to_string()])
}

/// Call a tool and return its result, checked against the contract on the way out.
fn call_tool(dispatcher: &mut Dispatcher, name: &str, args: Value) -> Value {
    let response = call_tool_raw(dispatcher, name, args);
    conformant_result(name, &response)
}

/// The `structuredContent` of a successful result, after every check a client may make:
/// it equals the text block, and it validates against the tool's own `outputSchema`.
fn conformant_result(name: &str, response: &Value) -> Value {
    let result = &response["result"];
    assert_eq!(result["isError"], Value::Null, "unexpected tool error: {response}");
    let text = result["content"][0]["text"].as_str().expect("a text block");
    let value = result["structuredContent"].clone();
    assert_eq!(serde_json::from_str::<Value>(text).unwrap(), value, "text ≠ structured");
    let schema = output::schema_for(name).expect("every tool declares an output schema");
    let validator = jsonschema::validator_for(&schema).expect("a valid schema");
    let errors: Vec<String> = validator.iter_errors(&value).map(|e| e.to_string()).collect();
    assert!(errors.is_empty(), "{name} result violates its outputSchema: {errors:?}\n{value}");
    value
}

/// Call a tool expecting an `isError` result; returns the error text.
fn call_tool_err(dispatcher: &mut Dispatcher, name: &str, args: Value) -> String {
    let response = call_tool_raw(dispatcher, name, args);
    assert_eq!(response["result"]["isError"], true, "expected a tool error: {response}");
    response["result"]["content"][0]["text"].as_str().unwrap().to_string()
}

/// [`call_tool`] from a caller the transport identified.
fn call_tool_as(
    dispatcher: &mut Dispatcher,
    name: &str,
    args: Value,
    ctx: &RequestContext,
) -> Value {
    let request = tool_call_request(name, args);
    let response =
        dispatcher.dispatch_at(&request, NOW, ctx).response.expect("tool call returns a response");
    let response: Value = serde_json::from_str(&response).unwrap();
    conformant_result(name, &response)
}

fn call_tool_raw(dispatcher: &mut Dispatcher, name: &str, args: Value) -> Value {
    let request = tool_call_request(name, args);
    let response = dispatcher.handle_at(&request, NOW).expect("tool call returns a response");
    serde_json::from_str(&response).unwrap()
}

fn tool_call_request(name: &str, args: Value) -> String {
    request(1, "tools/call", json!({ "name": name, "arguments": args }))
}

/// A request in the one shape the server accepts: 2026-07-28 `_meta` on it.
fn request(id: i64, method: &str, mut params: Value) -> String {
    params["_meta"] = json!({
        META_PROTOCOL_VERSION: PROTOCOL_VERSION,
        META_CLIENT_INFO: { "name": "claude-code", "version": "2.1" },
        META_CLIENT_CAPABILITIES: {},
    });
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string()
}

fn parsed(dispatcher: &mut Dispatcher, request: &str) -> Value {
    serde_json::from_str(&dispatcher.handle_at(request, NOW).unwrap()).unwrap()
}

#[test]
fn server_discover_names_the_one_version_and_the_tools_capability() {
    let mut dispatcher = dispatcher();
    let response = parsed(&mut dispatcher, &request(1, "server/discover", json!({})));
    let result = &response["result"];
    assert_eq!(result["supportedVersions"], json!([PROTOCOL_VERSION]));
    assert!(result["capabilities"]["tools"].is_object());
    assert_eq!(result["resultType"], "complete");
    assert_eq!(result["_meta"][META_SERVER_INFO]["name"], "towles-tool");
    assert_eq!(result["_meta"][META_SERVER_INFO]["version"], TEST_VERSION);
    assert!(result["instructions"].as_str().is_some_and(|i| i.contains("preview_file")));
    assert_eq!(result["ttlMs"], 0);
}

/// Both required `_meta` fields are checked, and a missing one is the 400 the spec wants.
#[test]
fn a_request_without_client_capabilities_is_malformed() {
    let mut dispatcher = dispatcher();
    let mut value: Value = serde_json::from_str(&request(1, "tools/list", json!({}))).unwrap();
    value["params"]["_meta"].as_object_mut().unwrap().remove(META_CLIENT_CAPABILITIES);
    let handled = dispatcher.dispatch_at(&value.to_string(), NOW, &RequestContext::none());
    let response: Value = serde_json::from_str(&handled.response.unwrap()).unwrap();
    assert_eq!(response["error"]["code"], INVALID_PARAMS);
    assert_eq!(handled.error_code, Some(INVALID_PARAMS));
    let message = response["error"]["message"].as_str().unwrap();
    assert!(message.contains(META_CLIENT_CAPABILITIES), "{message}");
}

/// A legacy client's `initialize` gets the version named — all it can show.
#[test]
fn a_legacy_initialize_is_refused_naming_the_version() {
    let mut dispatcher = dispatcher();
    let legacy = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": { "protocolVersion": "2025-06-18", "clientInfo": { "name": "old" } },
    })
    .to_string();

    // Over HTTP the missing header is what's refused.
    let ctx = RequestContext::none().with_headers(MirroredHeaders::default());
    let handled = dispatcher.dispatch_at(&legacy, NOW, &ctx);
    let response: Value = serde_json::from_str(&handled.response.unwrap()).unwrap();
    assert_eq!(response["error"]["code"], HEADER_MISMATCH);
    assert_eq!(handled.error_code, Some(HEADER_MISMATCH));
    let message = response["error"]["message"].as_str().unwrap();
    assert!(message.contains(PROTOCOL_VERSION) && message.contains("initialize"), "{message}");

    // With no header layer, the body's missing version is.
    let response = parsed(&mut dispatcher, &legacy);
    assert_eq!(response["error"]["code"], INVALID_PARAMS);
    assert!(response["error"]["message"].as_str().unwrap().contains(PROTOCOL_VERSION));
}

#[test]
fn an_unsupported_version_lists_the_supported_one() {
    let mut dispatcher = dispatcher();
    let mut value: Value = serde_json::from_str(&request(1, "tools/list", json!({}))).unwrap();
    value["params"]["_meta"][META_PROTOCOL_VERSION] = json!("2025-11-25");
    let response = parsed(&mut dispatcher, &value.to_string());
    assert_eq!(response["error"]["code"], UNSUPPORTED_PROTOCOL_VERSION);
    assert_eq!(response["error"]["data"]["supported"], json!([PROTOCOL_VERSION]));
    assert_eq!(response["error"]["data"]["requested"], "2025-11-25");
}

/// The HTTP binding mirrors body fields into headers; the two must agree.
#[test]
fn mirrored_headers_must_match_the_body() {
    let mut dispatcher = dispatcher();
    let call = tool_call_request("task_list", json!({}));
    let headers = |method: &str, name: Option<&str>| {
        RequestContext::none().with_headers(MirroredHeaders {
            protocol_version: Some(PROTOCOL_VERSION.to_string()),
            method: Some(method.to_string()),
            name: name.map(str::to_string),
        })
    };
    let codes = |dispatcher: &mut Dispatcher, ctx: &RequestContext| {
        let handled = dispatcher.dispatch_at(&call, NOW, ctx);
        let response: Value = serde_json::from_str(&handled.response.unwrap()).unwrap();
        (handled.error_code, response["error"]["code"].as_i64())
    };

    assert_eq!(codes(&mut dispatcher, &headers("tools/call", Some("task_list"))), (None, None));
    assert_eq!(
        codes(&mut dispatcher, &headers("tools/call", Some("=?base64?dGFza19saXN0?="))),
        (None, None),
        "an encoded name is decoded before the comparison"
    );
    for wrong in [
        headers("tools/list", Some("task_list")),
        headers("tools/call", Some("task_status")),
        headers("tools/call", None),
    ] {
        assert_eq!(
            codes(&mut dispatcher, &wrong),
            (Some(HEADER_MISMATCH), Some(HEADER_MISMATCH)),
            "{wrong:?}"
        );
    }
}

#[test]
fn notifications_get_no_response() {
    let mut dispatcher = dispatcher();
    let initialized =
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string();
    assert!(dispatcher.handle_at(&initialized, NOW).is_none());
    let other = json!({ "jsonrpc": "2.0", "method": "some/notification" }).to_string();
    assert!(dispatcher.handle_at(&other, NOW).is_none());
}

#[test]
fn tools_list_is_exactly_the_task_pane_attention_calendar_and_mod_families() {
    let mut dispatcher = dispatcher();
    let response = parsed(&mut dispatcher, &request(1, "tools/list", json!({})));
    let names: Vec<&str> = response["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        vec![
            "task_list",
            "task_status",
            "task_create",
            "task_summary",
            "task_sync",
            "task_delete",
            "task_done",
            "task_start",
            "preview_file",
            "file_open",
            "needs_you",
            "summon",
            "calendar_today",
            "calendar_next",
            "calendar_set",
            "inbox_take",
            "inbox_ack",
            "next_prompt",
            "next_prompt_taken",
        ]
    );
}

// preview_file

/// Every `(path, title, session)` a fake preview host was handed.
type Shown = std::sync::Arc<std::sync::Mutex<Vec<(String, String, Option<String>)>>>;

fn with_preview_host() -> (Dispatcher, Shown) {
    struct FakePreviewHost {
        shown: Shown,
    }
    impl PreviewHost for FakePreviewHost {
        fn show(&self, artifact: PreviewFile) -> Result<(), String> {
            self.shown.lock().unwrap().push((artifact.path, artifact.title, artifact.session));
            Ok(())
        }
    }
    let shown: Shown = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let host = FakePreviewHost { shown: std::sync::Arc::clone(&shown) };
    (dispatcher().with_preview_host(Box::new(host)), shown)
}

/// Canonical, since a macOS temp dir sits behind a symlink (`/var` → `/private/var`).
fn artifact_file(dir: &tempfile::TempDir, name: &str, body: &str) -> String {
    let path = dir.path().join(name);
    std::fs::write(&path, body).unwrap();
    std::fs::canonicalize(&path).unwrap().to_string_lossy().into_owned()
}

#[test]
fn preview_file_hands_the_artifact_to_the_host() {
    let (mut dispatcher, shown) = with_preview_host();
    let dir = tempfile::tempdir().unwrap();
    let path = artifact_file(&dir, "plan.html", "<h1>plan</h1>");

    let result =
        call_tool(&mut dispatcher, "preview_file", json!({ "path": path, "title": "The plan" }));

    assert_eq!(result["status"], "showing");
    assert_eq!(result["title"], "The plan");
    assert_eq!(&*shown.lock().unwrap(), &[(path, "The plan".to_string(), None)]);
}

#[test]
fn preview_file_routes_by_the_callers_session() {
    let (mut dispatcher, shown) = with_preview_host();
    let dir = tempfile::tempdir().unwrap();
    let path = artifact_file(&dir, "plan.html", "<h1>plan</h1>");

    let result = call_tool_as(
        &mut dispatcher,
        "preview_file",
        json!({ "path": path }),
        &RequestContext::for_session(Some("s64abebd44298447d")),
    );

    assert_eq!(result["routed"], "session");
    assert_eq!(shown.lock().unwrap()[0].2.as_deref(), Some("s64abebd44298447d"));
}

/// `${TT_SESSION_ID:-}` expands empty outside an app terminal: "didn't say", not a bad id.
#[test]
fn preview_file_treats_a_blank_session_as_absent() {
    let (mut dispatcher, shown) = with_preview_host();
    let dir = tempfile::tempdir().unwrap();
    let path = artifact_file(&dir, "plan.html", "<h1>plan</h1>");

    let result = call_tool_as(
        &mut dispatcher,
        "preview_file",
        json!({ "path": path }),
        &RequestContext::for_session(Some("   ")),
    );

    assert_eq!(result["routed"], "path");
    assert_eq!(shown.lock().unwrap()[0].2, None);
}

/// One dispatcher serves every session; identity must not leak between callers.
#[test]
fn a_session_never_leaks_into_the_next_request() {
    let (mut dispatcher, shown) = with_preview_host();
    let dir = tempfile::tempdir().unwrap();
    let path = artifact_file(&dir, "plan.html", "<h1>plan</h1>");

    call_tool_as(
        &mut dispatcher,
        "preview_file",
        json!({ "path": path }),
        &RequestContext::for_session(Some("s-first")),
    );
    call_tool(&mut dispatcher, "preview_file", json!({ "path": path }));

    let shown = shown.lock().unwrap();
    assert_eq!(shown[0].2.as_deref(), Some("s-first"));
    assert_eq!(shown[1].2, None, "the second caller named no session");
}

#[test]
fn preview_file_falls_back_to_the_file_name_as_the_title() {
    let (mut dispatcher, shown) = with_preview_host();
    let dir = tempfile::tempdir().unwrap();
    let path = artifact_file(&dir, "findings.html", "<p>hi</p>");

    let result = call_tool(&mut dispatcher, "preview_file", json!({ "path": path }));

    assert_eq!(result["title"], "findings.html");
    assert_eq!(shown.lock().unwrap()[0].1, "findings.html");
}

#[test]
fn preview_file_without_a_host_refuses() {
    let mut dispatcher = dispatcher();
    let message = call_tool_err(&mut dispatcher, "preview_file", json!({ "path": "/nope" }));
    assert!(message.contains("no preview host"), "{message}");
}

/// Each would otherwise be a blank pane and a cheerful success.
#[test]
fn preview_file_refuses_a_path_it_cannot_render() {
    let dir = tempfile::tempdir().unwrap();
    let html = artifact_file(&dir, "ok.html", "<p>ok</p>");
    let relative = "docs/plan.html";
    let missing = dir.path().join("gone.html").to_string_lossy().into_owned();
    let directory = dir.path().to_string_lossy().into_owned();

    for (path, expected) in [
        (relative, "must be absolute"),
        (missing.as_str(), "can't read"),
        (directory.as_str(), "is not a file"),
    ] {
        let (mut dispatcher, shown) = with_preview_host();
        let message = call_tool_err(&mut dispatcher, "preview_file", json!({ "path": path }));
        assert!(message.contains(expected), "for {path}: {message}");
        assert!(shown.lock().unwrap().is_empty(), "nothing should reach the host for {path}");
    }

    // …and the control: the valid one goes through.
    let (mut dispatcher, _) = with_preview_host();
    call_tool(&mut dispatcher, "preview_file", json!({ "path": html }));
}

#[test]
fn preview_file_accepts_markdown_and_plain_text() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["notes.md", "run.log", "Makefile"] {
        let (mut dispatcher, shown) = with_preview_host();
        let path = artifact_file(&dir, name, "hello");
        let result = call_tool(&mut dispatcher, "preview_file", json!({ "path": path }));
        assert_eq!(result["status"], "showing", "for {name}");
        assert_eq!(shown.lock().unwrap().len(), 1, "for {name}");
    }
}

#[test]
fn preview_file_refuses_an_oversized_file() {
    let (mut dispatcher, _) = with_preview_host();
    let dir = tempfile::tempdir().unwrap();
    let path = artifact_file(&dir, "huge.html", &"x".repeat(PREVIEW_MAX_BYTES as usize + 1));

    let message = call_tool_err(&mut dispatcher, "preview_file", json!({ "path": path }));
    assert!(message.contains("keep it under"), "{message}");
}

#[test]
fn preview_file_is_not_a_writing_tool() {
    assert!(!tool_writes("preview_file"));
}

// needs_you

/// Every `(reason, session, max_minutes)` a fake attention host was summoned with.
type Summoned = std::sync::Arc<std::sync::Mutex<Vec<(String, Option<String>, u32)>>>;

fn with_attention_host(waiting: &[(Option<&str>, &str)]) -> Dispatcher {
    with_attention_host_summoned(waiting).0
}

/// A fake host answering `(session, reason)` rows in the order given — the queue's.
fn with_attention_host_summoned(waiting: &[(Option<&str>, &str)]) -> (Dispatcher, Summoned) {
    struct FakeAttentionHost(Vec<(Option<String>, String)>, Summoned);
    impl AttentionHost for FakeAttentionHost {
        fn summon(&self, r: SummonRequest) -> Result<(), String> {
            self.1.lock().unwrap().push((r.reason, r.session, r.max_minutes));
            Ok(())
        }
        fn needs_you(&self) -> Vec<WaitingRow> {
            self.0
                .iter()
                .enumerate()
                .map(|(i, (session, reason))| WaitingRow {
                    session: session.clone(),
                    title: format!("row {i}"),
                    repo: "towles-tool".to_string(),
                    dir: format!("/r/{i}"),
                    reason: reason.clone(),
                    why: format!("{reason} words"),
                    also: Vec::new(),
                    since_ms: session.as_ref().map(|_| 100),
                })
                .collect()
        }
    }
    let waiting = waiting.iter().map(|(s, r)| (s.map(str::to_string), r.to_string())).collect();
    let summoned = Summoned::default();
    let host = FakeAttentionHost(waiting, summoned.clone());
    (dispatcher().with_attention_host(Box::new(host)), summoned)
}

#[test]
fn needs_you_lists_the_rest_of_the_queue_in_its_order_with_why() {
    let mut dispatcher = with_attention_host(&[
        (Some("a"), "answer"),
        (Some("me"), "review"),
        (None, "fix_ci"),
        (Some("b"), "land"),
    ]);
    let result = call_tool_as(
        &mut dispatcher,
        "needs_you",
        json!({}),
        &RequestContext::for_session(Some("me")),
    );
    let rows = result["waiting"].as_array().unwrap();
    let reasons: Vec<&str> = rows.iter().map(|r| r["reason"].as_str().unwrap()).collect();
    assert_eq!(reasons, ["answer", "fix_ci", "land"]);
    assert_eq!(rows[1]["session"], Value::Null);
    assert_eq!(rows[1]["sinceMs"], Value::Null);
    assert_eq!(rows[0]["why"], "answer words");
    assert_eq!(rows[0]["sinceMs"], 100);
}

#[test]
fn needs_you_from_outside_an_app_terminal_lists_everything() {
    let mut dispatcher = with_attention_host(&[(Some("a"), "answer"), (None, "cleanup")]);
    let rows = call_tool(&mut dispatcher, "needs_you", json!({}))["waiting"].clone();
    assert_eq!(rows.as_array().unwrap().len(), 2);
}

#[test]
fn needs_you_without_a_host_refuses() {
    let message = call_tool_err(&mut dispatcher(), "needs_you", json!({}));
    assert!(message.contains("no attention host"), "{message}");
    assert!(!tool_writes("needs_you"));
}

// summon

#[test]
fn summon_hands_the_caller_and_a_clamped_cap_to_the_host() {
    let (mut dispatcher, summoned) = with_attention_host_summoned(&[]);
    let result = call_tool_as(
        &mut dispatcher,
        "summon",
        json!({ "reason": "  approve the migration  ", "max_minutes": 500 }),
        &RequestContext::for_session(Some("me")),
    );
    assert_eq!(result["status"], "summoning");
    assert_eq!(result["session"], "me");
    assert_eq!(result["maxMinutes"], 60);
    let calls = summoned.lock().unwrap();
    assert_eq!(calls[0], ("approve the migration".to_string(), Some("me".to_string()), 60));
}

#[test]
fn summon_defaults_its_cap_and_allows_no_session() {
    let (mut dispatcher, summoned) = with_attention_host_summoned(&[]);
    let result = call_tool(&mut dispatcher, "summon", json!({ "reason": "x" }));
    assert_eq!(result["maxMinutes"], 15);
    assert!(result["session"].is_null());
    assert_eq!(summoned.lock().unwrap()[0].1, None);
}

#[test]
fn summon_refuses_a_blank_reason_and_a_missing_host() {
    let message = call_tool_err(&mut dispatcher(), "summon", json!({ "reason": "x" }));
    assert!(message.contains("no attention host"), "{message}");
    assert!(!tool_writes("summon"));
    let (mut with_host, summoned) = with_attention_host_summoned(&[]);
    let message = call_tool_err(&mut with_host, "summon", json!({ "reason": "  " }));
    assert!(message.contains("reason"), "{message}");
    assert!(summoned.lock().unwrap().is_empty());
}

// file_open

/// Every `(path, is_dir, line, session)` a fake editor host was handed.
type Opened = std::sync::Arc<std::sync::Mutex<Vec<(String, bool, Option<u32>, Option<String>)>>>;

fn with_editor_host() -> (Dispatcher, Opened) {
    struct FakeEditorHost {
        opened: Opened,
    }
    impl EditorHost for FakeEditorHost {
        fn open_file(&self, req: FileToOpen) -> Result<(), String> {
            self.opened.lock().unwrap().push((req.path, req.is_dir, req.line, req.session));
            Ok(())
        }
    }
    let opened: Opened = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let host = FakeEditorHost { opened: std::sync::Arc::clone(&opened) };
    (dispatcher().with_editor_host(Box::new(host)), opened)
}

#[test]
fn file_open_hands_the_file_to_the_host() {
    let (mut dispatcher, opened) = with_editor_host();
    let dir = tempfile::tempdir().unwrap();
    let path = artifact_file(&dir, "main.rs", "fn main() {}");

    let result = call_tool(&mut dispatcher, "file_open", json!({ "path": path, "line": 42 }));

    assert_eq!(result["status"], "opening");
    assert_eq!(result["routed"], "path");
    assert_eq!(&*opened.lock().unwrap(), &[(path, false, Some(42), None)]);
}

#[test]
fn file_open_routes_by_the_callers_session() {
    let (mut dispatcher, opened) = with_editor_host();
    let dir = tempfile::tempdir().unwrap();
    let path = artifact_file(&dir, "main.rs", "fn main() {}");

    let result = call_tool_as(
        &mut dispatcher,
        "file_open",
        json!({ "path": path }),
        &RequestContext::for_session(Some("s64abebd44298447d")),
    );

    assert_eq!(result["routed"], "session");
    assert_eq!(
        opened.lock().unwrap()[0].3.as_deref(),
        Some("s64abebd44298447d"),
        "the session travels with the request, not in the arguments"
    );
}

#[test]
fn file_open_marks_a_directory_as_one() {
    let (mut dispatcher, opened) = with_editor_host();
    let dir = tempfile::tempdir().unwrap();
    let path = std::fs::canonicalize(dir.path()).unwrap().to_string_lossy().into_owned();

    call_tool(&mut dispatcher, "file_open", json!({ "path": path }));

    assert!(opened.lock().unwrap()[0].1, "a directory opens the pane, it doesn't select a file");
}

#[test]
fn file_open_refuses_a_relative_or_missing_path() {
    let (mut dispatcher, _) = with_editor_host();
    let message = call_tool_err(&mut dispatcher, "file_open", json!({ "path": "src/main.rs" }));
    assert!(message.contains("must be absolute"), "{message}");

    let message = call_tool_err(&mut dispatcher, "file_open", json!({ "path": "/nope/gone.rs" }));
    assert!(message.contains("can't open"), "{message}");
}

#[test]
fn file_open_without_a_host_refuses() {
    let mut dispatcher = dispatcher();
    let message = call_tool_err(&mut dispatcher, "file_open", json!({ "path": "/nope" }));
    assert!(message.contains("no editor host"), "{message}");
}

#[test]
fn file_open_is_not_a_writing_tool() {
    assert!(!tool_writes("file_open"));
}

/// Epoch ms as the local RFC 3339 the tool speaks.
fn iso(ms: i64) -> String {
    Local.timestamp_millis_opt(ms).single().unwrap().to_rfc3339()
}

/// A `calendar_set` event payload, in the tool's wire shape.
fn event_json(external_id: &str, start_ts: i64, end_ts: i64) -> Value {
    json!({
        "externalId": external_id,
        "title": external_id,
        "start": iso(start_ts),
        "end": iso(end_ts),
    })
}

/// `calendar_set` one source's day, returning the tool result.
fn set_calendar(dispatcher: &mut Dispatcher, source: &str, events: Value) -> Value {
    call_tool(dispatcher, "calendar_set", json!({ "source": source, "events": events }))
}

#[test]
fn calendar_today_returns_only_the_local_day() {
    let (day_start, day_end) = Store::local_day_bounds(NOW);
    let mut dispatcher = dispatcher();
    // Neighbouring days are pushed as their own days — a day's push refuses events outside it.
    let day_of =
        |ms: i64| Local.timestamp_millis_opt(ms).single().unwrap().format("%Y-%m-%d").to_string();
    for (day_ms, event) in [
        (day_start - 3_600_000, event_json("yesterday", day_start - 3_600_000, day_start - 1)),
        (NOW, event_json("standup", day_start + 3_600_000, day_start + 5_400_000)),
        (day_end + 3_600_000, event_json("tomorrow", day_end + 3_600_000, day_end + 5_400_000)),
    ] {
        call_tool(
            &mut dispatcher,
            "calendar_set",
            json!({ "source": "google", "day": day_of(day_ms), "events": [event] }),
        );
    }

    let result = call_tool(&mut dispatcher, "calendar_today", json!({}));
    assert_eq!(result["now"], NOW);
    let ids: Vec<&str> = result["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|event| event["externalId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["standup"], "only today's event is in the window");
}

/// Reachable by neither the lane's next delete nor retention: a phantom meeting forever.
#[test]
fn calendar_set_refuses_an_event_outside_the_day_being_written() {
    let (_, day_end) = Store::local_day_bounds(NOW);
    let mut dispatcher = dispatcher();
    let message = call_tool_err(
        &mut dispatcher,
        "calendar_set",
        json!({
            "source": "google",
            "events": [event_json("next-week", day_end + 6 * 86_400_000, day_end + 6 * 86_400_000 + 1_800_000)],
        }),
    );
    assert!(message.contains("next-week"), "names the offending event: {message}");
    assert!(message.contains("outside the day"), "says why: {message}");
}

/// `end < start` shows in `calendar_today` but never in `calendar_next`.
#[test]
fn calendar_set_refuses_an_event_that_ends_before_it_starts() {
    let mut dispatcher = dispatcher();
    let message = call_tool_err(
        &mut dispatcher,
        "calendar_set",
        json!({
            "source": "google",
            "events": [event_json("backwards", NOW + 3_600_000, NOW - 3_600_000)],
        }),
    );
    assert!(message.contains("backwards"), "names the offending event: {message}");
    assert!(message.contains("ends before it starts"), "says why: {message}");
}

/// Truncating division would report `0` for a live meeting's first 59 seconds.
#[test]
fn calendar_next_minutes_until_is_negative_from_the_first_second() {
    let mut dispatcher = dispatcher();
    set_calendar(
        &mut dispatcher,
        "google",
        json!([event_json("live", NOW - 30_000, NOW + 1_800_000)]),
    );
    let result = call_tool(&mut dispatcher, "calendar_next", json!({}));
    assert_eq!(result["live"], true);
    assert_eq!(result["minutesUntil"], -1, "30s in is already negative, not 0");
}

#[test]
fn calendar_next_flags_a_meeting_in_progress() {
    let mut dispatcher = dispatcher();
    // Started 10 minutes ago, runs for another 20.
    set_calendar(
        &mut dispatcher,
        "google",
        json!([event_json("in-progress", NOW - 600_000, NOW + 1_200_000)]),
    );

    let result = call_tool(&mut dispatcher, "calendar_next", json!({}));
    assert_eq!(result["event"]["externalId"], "in-progress");
    assert_eq!(result["live"], true);
    assert_eq!(result["minutesUntil"], -10, "minutes go negative while live");
    assert_eq!(result["now"], NOW);
}

#[test]
fn calendar_next_counts_down_to_the_next_meeting() {
    let mut dispatcher = dispatcher();
    set_calendar(
        &mut dispatcher,
        "google",
        json!([event_json("upcoming", NOW + 1_800_000, NOW + 3_600_000)]),
    );

    let result = call_tool(&mut dispatcher, "calendar_next", json!({}));
    assert_eq!(result["event"]["externalId"], "upcoming");
    assert_eq!(result["live"], false);
    assert_eq!(result["minutesUntil"], 30);
}

#[test]
fn calendar_next_on_an_empty_calendar_is_null() {
    let mut dispatcher = dispatcher();
    let result = call_tool(&mut dispatcher, "calendar_next", json!({}));
    assert_eq!(result["event"], Value::Null);
}

#[test]
fn calendar_set_replaces_one_source_and_leaves_the_others() {
    let (day_start, _) = Store::local_day_bounds(NOW);
    let mut dispatcher = dispatcher();
    set_calendar(
        &mut dispatcher,
        "outlook",
        json!([event_json(
            "work-sync",
            day_start + 3_600_000,
            day_start + 5_400_000
        )]),
    );
    set_calendar(
        &mut dispatcher,
        "google",
        json!([event_json(
            "dentist",
            day_start + 7_200_000,
            day_start + 9_000_000
        )]),
    );

    // Re-pushing google replaces only google's rows for the day.
    let result = set_calendar(
        &mut dispatcher,
        "google",
        json!([event_json(
            "school-run",
            day_start + 10_800_000,
            day_start + 12_600_000
        )]),
    );
    assert_eq!(result["source"], "google");
    assert_eq!(result["written"], 1);
    assert_eq!(result["dayStart"], iso(day_start));

    let today = call_tool(&mut dispatcher, "calendar_today", json!({}));
    let ids: Vec<&str> = today["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|event| event["externalId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["work-sync", "school-run"], "outlook's row survived");
}

#[test]
fn calendar_set_accepts_an_explicit_day() {
    let mut dispatcher = dispatcher();
    let day = Local.timestamp_millis_opt(NOW).single().unwrap().date_naive();
    let tomorrow = (day + Duration::days(1)).format("%Y-%m-%d").to_string();
    let tomorrow_start = Store::local_day_bounds(day_reference_ms(&tomorrow).unwrap()).0;

    let result = call_tool(
        &mut dispatcher,
        "calendar_set",
        json!({
            "source": "google",
            "day": tomorrow,
            "events": [event_json("offsite", tomorrow_start + 3_600_000, tomorrow_start + 7_200_000)],
        }),
    );
    assert_eq!(result["dayStart"], iso(tomorrow_start));

    // It is tomorrow's, so today's read does not see it.
    let today = call_tool(&mut dispatcher, "calendar_today", json!({}));
    assert!(today["events"].as_array().unwrap().is_empty(), "{today}");
}

#[test]
fn calendar_set_clears_a_day_with_an_empty_array() {
    let (day_start, _) = Store::local_day_bounds(NOW);
    let mut dispatcher = dispatcher();
    set_calendar(
        &mut dispatcher,
        "google",
        json!([event_json(
            "cancelled",
            day_start + 3_600_000,
            day_start + 5_400_000
        )]),
    );
    let result = set_calendar(&mut dispatcher, "google", json!([]));
    assert_eq!(result["written"], 0);
    let today = call_tool(&mut dispatcher, "calendar_today", json!({}));
    assert!(today["events"].as_array().unwrap().is_empty(), "{today}");
}

#[test]
fn calendar_set_validates_its_arguments() {
    let mut dispatcher = dispatcher();
    let message = call_tool_err(&mut dispatcher, "calendar_set", json!({ "events": [] }));
    assert!(message.contains("source"), "{message}");
    let message = call_tool_err(&mut dispatcher, "calendar_set", json!({ "source": "google" }));
    assert!(message.contains("events"), "{message}");
    let message = call_tool_err(
        &mut dispatcher,
        "calendar_set",
        json!({ "source": "google", "events": [{ "title": "no id" }] }),
    );
    assert!(message.contains("invalid events payload"), "{message}");
    let message = call_tool_err(
        &mut dispatcher,
        "calendar_set",
        json!({ "source": "google", "day": "not-a-date", "events": [] }),
    );
    assert!(message.contains("invalid day"), "{message}");
}

#[test]
fn calendar_set_ignores_a_source_field_smuggled_into_an_event() {
    // `source` is caller-assigned: an event's own `source` must not write into another lane.
    let (day_start, _) = Store::local_day_bounds(NOW);
    let mut dispatcher = dispatcher();
    set_calendar(
        &mut dispatcher,
        "outlook",
        json!([event_json(
            "work-sync",
            day_start + 3_600_000,
            day_start + 5_400_000
        )]),
    );
    call_tool(
        &mut dispatcher,
        "calendar_set",
        json!({
            "source": "google",
            "events": [{
                "source": "outlook",
                "externalId": "work-sync",
                "title": "hijacked",
                "start": iso(day_start + 3_600_000),
            }],
        }),
    );

    let today = call_tool(&mut dispatcher, "calendar_today", json!({}));
    let events = today["events"].as_array().unwrap();
    assert_eq!(events.len(), 2, "the outlook row was not overwritten: {today}");
    let outlook = events.iter().find(|e| e["source"] == "outlook").unwrap();
    assert_eq!(outlook["title"], "work-sync");
}

#[test]
fn task_list_returns_seeded_task() {
    let mut dispatcher = dispatcher();
    let result = call_tool(&mut dispatcher, "task_list", json!({}));
    let tasks = result["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0]["text"], "open task");
}

#[test]
fn task_status_returns_one_task_including_done() {
    let store = seeded_store();
    let done = store.add_task("shipped", "done", None, None, NOW).unwrap();
    let mut dispatcher = Dispatcher::new(store, TEST_VERSION);
    let result = call_tool(&mut dispatcher, "task_status", json!({ "id": done.id }));
    assert_eq!(result["task"]["text"], "shipped");
    assert_eq!(result["task"]["status"], "done");
}

#[test]
fn task_status_requires_a_known_id() {
    let mut dispatcher = dispatcher();
    let message = call_tool_err(&mut dispatcher, "task_status", json!({}));
    assert!(message.contains("id"), "error should name the missing arg: {message}");
    let message = call_tool_err(&mut dispatcher, "task_status", json!({ "id": 9999 }));
    assert!(message.contains("9999"), "error should name the unknown id: {message}");
}

#[test]
fn task_summary_records_the_report_on_the_card() {
    let store = seeded_store();
    let task = store.add_task("switch the files pane", "doing", Some("mine"), None, NOW).unwrap();
    let mut dispatcher = Dispatcher::new(store, TEST_VERSION);
    let result = call_tool(
        &mut dispatcher,
        "task_summary",
        json!({ "id": task.id, "summary": "PR #510 merged as 9a550d9. CI green." }),
    );
    assert_eq!(result["task"]["summary"], "PR #510 merged as 9a550d9. CI green.");
    assert_eq!(result["task"]["summaryAt"], NOW);
    // It records, it does not close — status and worktree binding stay the user's.
    assert_eq!(result["task"]["status"], "doing");
    assert_eq!(result["task"]["closed"], false);
    // The user's notes stay theirs: a summary there would return as instructions.
    assert_eq!(result["task"]["notes"], "mine");
    let read = call_tool(&mut dispatcher, "task_status", json!({ "id": task.id }));
    assert_eq!(read["task"]["summary"], "PR #510 merged as 9a550d9. CI green.");
}

#[test]
fn task_summary_requires_both_args_and_a_known_id() {
    let store = seeded_store();
    let task = store.add_task("x", "doing", None, None, NOW).unwrap();
    let mut dispatcher = Dispatcher::new(store, TEST_VERSION);
    let message = call_tool_err(&mut dispatcher, "task_summary", json!({ "summary": "done" }));
    assert!(message.contains("id"), "error should name the missing arg: {message}");
    let message = call_tool_err(&mut dispatcher, "task_summary", json!({ "id": task.id }));
    assert!(message.contains("summary"), "error should name the missing arg: {message}");
    let message =
        call_tool_err(&mut dispatcher, "task_summary", json!({ "id": 9999, "summary": "done" }));
    assert!(message.contains("9999"), "error should name the unknown id: {message}");
}

fn git(dir: &std::path::Path, args: &[&str]) {
    tt_git::testing::git(dir, args);
}

/// A checkout on `main` with a task worktree on `feat/old`, bound to a fresh row.
fn drifting_task() -> (tempfile::TempDir, std::path::PathBuf, Dispatcher, i64) {
    let tmp = tempfile::tempdir().unwrap();
    let checkout = tmp.path().join("repo");
    std::fs::create_dir_all(&checkout).unwrap();
    git(&checkout, &["init", "-q", "-b", "main"]);
    git(&checkout, &["commit", "-q", "--allow-empty", "-m", "x"]);
    let dir = checkout.join(".claude/worktrees/feat-old");
    git(
        &checkout,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feat/old",
            dir.to_str().unwrap(),
        ],
    );
    let store = seeded_store();
    let task = store.add_task("drifting", "doing", None, None, NOW).unwrap();
    let (root, dir_s) = (checkout.to_str().unwrap(), dir.to_str().unwrap());
    store.set_task_worktree(task.id, root, None, Some("feat/old"), Some(dir_s)).unwrap();
    (tmp, dir, Dispatcher::new(store, TEST_VERSION), task.id)
}

#[test]
fn task_sync_records_the_branch_the_worktree_moved_to() {
    let (_tmp, dir, mut dispatcher, id) = drifting_task();
    git(&dir, &["switch", "-q", "-c", "feat/new"]);

    let result = call_tool(&mut dispatcher, "task_sync", json!({ "id": id }));
    assert_eq!(result["previous"], "feat/old");
    assert_eq!(result["current"], "feat/new");
    assert_eq!(result["changed"], true);
    assert_eq!(result["task"]["worktree"]["branch"], "feat/new");

    let again = call_tool(&mut dispatcher, "task_sync", json!({ "id": id }));
    assert_eq!(again["changed"], false);
}

#[test]
fn task_sync_needs_a_task_with_a_worktree() {
    let mut dispatcher = dispatcher();
    let open = call_tool(&mut dispatcher, "task_list", json!({}))["tasks"][0]["id"].clone();
    let error = call_tool_err(&mut dispatcher, "task_sync", json!({ "id": open }));
    assert!(error.contains("has no worktree"), "{error}");
    let error = call_tool_err(&mut dispatcher, "task_sync", json!({ "id": 9999 }));
    assert!(error.contains("no task with id 9999"), "{error}");
}

#[test]
fn task_create_lands_in_the_repo_swimlane() {
    let mut dispatcher = dispatcher();
    let result = call_tool(
        &mut dispatcher,
        "task_create",
        json!({ "repo": REPO_SLUG, "title": "port the CLI", "notes": "start with doctor" }),
    );
    assert_eq!(result["task"]["text"], "port the CLI");
    assert_eq!(result["task"]["status"], "backlog");
    assert_eq!(result["task"]["notes"], "start with doctor");
    assert_eq!(result["task"]["createdAt"], NOW);
    // The repo binding is what puts the task in a Board swimlane.
    assert_eq!(result["task"]["worktree"]["repoRoot"], REPO_DIR);
    assert_eq!(result["task"]["worktree"]["repo"], REPO_SLUG);

    let open = call_tool(&mut dispatcher, "task_list", json!({}));
    let texts: Vec<&str> =
        open["tasks"].as_array().unwrap().iter().map(|t| t["text"].as_str().unwrap()).collect();
    assert!(texts.contains(&"port the CLI"), "created task missing: {texts:?}");
}

/// Wrong-cased slugs must land in the one real swimlane: an exact match against a case-folded
/// cache rejected `gh`'s own casing and stamped the accepted one verbatim, splitting the lane.
#[test]
fn task_create_normalizes_the_repo_slug_casing() {
    let mut dispatcher = dispatcher();
    let result = call_tool(
        &mut dispatcher,
        "task_create",
        json!({ "repo": REPO_SLUG.to_uppercase(), "title": "shouty repo arg" }),
    );
    // Stamped with the tracked repo's spelling, not the caller's.
    assert_eq!(result["task"]["worktree"]["repo"], REPO_SLUG);
    assert_eq!(result["task"]["worktree"]["repoRoot"], REPO_DIR);
}

#[test]
fn task_create_accepts_a_status() {
    let mut dispatcher = dispatcher();
    let result = call_tool(
        &mut dispatcher,
        "task_create",
        json!({ "repo": REPO_SLUG, "title": "already underway", "status": "doing" }),
    );
    assert_eq!(result["task"]["status"], "doing");
    assert_eq!(result["task"]["worktree"]["repoRoot"], REPO_DIR);
}

/// Each `(id, force, outcome)` a fake host was called with; the real host tears down worktrees,
/// which has no place in a unit test of the tool's shape.
type HostCalls = std::sync::Arc<std::sync::Mutex<Vec<(i64, bool, Option<tt_store::TaskOutcome>)>>>;

/// Each start request the host was handed — only the fields a test asserts on.
type StartCalls =
    std::sync::Arc<std::sync::Mutex<Vec<(i64, String, String, Option<String>, String)>>>;

struct FakeHost {
    answer: std::sync::Mutex<Option<Result<TaskDeletion, String>>>,
    calls: HostCalls,
    starts: StartCalls,
}

impl TaskHost for FakeHost {
    fn delete_task(
        &self,
        id: i64,
        force: bool,
        outcome: Option<tt_store::TaskOutcome>,
    ) -> Result<TaskDeletion, String> {
        self.calls.lock().unwrap().push((id, force, outcome));
        self.answer.lock().unwrap().take().expect("one delete per test")
    }

    fn start_task(&self, req: TaskStartRequest) -> Result<(), String> {
        self.starts.lock().unwrap().push((req.id, req.repo_root, req.branch, req.base, req.prompt));
        Ok(())
    }
}

fn with_host(answer: Result<TaskDeletion, String>) -> (Dispatcher, HostCalls) {
    let (dispatcher, calls, _) = with_host_recording(answer);
    (dispatcher, calls)
}

fn with_host_recording(
    answer: Result<TaskDeletion, String>,
) -> (Dispatcher, HostCalls, StartCalls) {
    let calls: HostCalls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let starts: StartCalls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let host = FakeHost {
        answer: std::sync::Mutex::new(Some(answer)),
        calls: std::sync::Arc::clone(&calls),
        starts: std::sync::Arc::clone(&starts),
    };
    (dispatcher().with_task_host(Box::new(host)), calls, starts)
}

fn deleted(name: &str, messages: Vec<String>) -> Result<TaskDeletion, String> {
    Ok(TaskDeletion::Deleted { name: name.to_string(), messages })
}

// task_start

/// As with `task_delete`: without a host, refuse rather than half-do the job.
#[test]
fn task_start_without_a_host_refuses() {
    let mut dispatcher = dispatcher();
    let message = call_tool_err(&mut dispatcher, "task_start", json!({ "id": 1 }));
    assert!(message.contains("no task host"), "{message}");
}

/// Everything comes from the row, so the host reads nothing.
#[test]
fn task_start_resolves_branch_repo_and_prompt_from_the_row() {
    let (mut dispatcher, _, starts) = with_host_recording(deleted("unused", vec![]));
    let created = call_tool(
        &mut dispatcher,
        "task_create",
        json!({
            "repo": REPO_SLUG,
            "title": "Collapse git_info's eight spawns",
            "goal": "Cut the per-folder git subprocess count from ~8 to 1.",
            "notes": "Work in git_info.rs only.",
        }),
    );
    let id = created["task"]["id"].as_i64().unwrap();

    let result = call_tool(&mut dispatcher, "task_start", json!({ "id": id }));
    assert_eq!(result["status"], "starting");
    assert_eq!(result["id"], id);
    assert_eq!(result["branch"], "collapse-git_info-s-eight-spawns");

    let starts = starts.lock().unwrap();
    assert_eq!(starts.len(), 1);
    let (got_id, repo_root, branch, base, prompt) = &starts[0];
    assert_eq!(*got_id, id);
    assert_eq!(repo_root, REPO_DIR);
    assert_eq!(branch, "collapse-git_info-s-eight-spawns");
    assert_eq!(*base, None);
    // Goal leads, notes follow — the title is not the instruction.
    assert!(prompt.starts_with("Cut the per-folder git subprocess count"), "{prompt}");
    assert!(prompt.contains("Work in git_info.rs only."), "{prompt}");
}

#[test]
fn task_start_passes_an_explicit_branch_and_base_through() {
    let (mut dispatcher, _, starts) = with_host_recording(deleted("unused", vec![]));
    let created =
        call_tool(&mut dispatcher, "task_create", json!({ "repo": REPO_SLUG, "title": "x" }));
    let id = created["task"]["id"].as_i64().unwrap();

    call_tool(
        &mut dispatcher,
        "task_start",
        json!({ "id": id, "branch": "fix/thing", "base": "develop" }),
    );

    let starts = starts.lock().unwrap();
    let (_, _, branch, base, _) = &starts[0];
    assert_eq!(branch, "fix/thing");
    assert_eq!(base.as_deref(), Some("develop"));
}

/// A second worktree would orphan the running one.
#[test]
fn task_start_refuses_a_task_that_already_has_a_worktree() {
    let (mut dispatcher, _, starts) = with_host_recording(deleted("unused", vec![]));
    let created =
        call_tool(&mut dispatcher, "task_create", json!({ "repo": REPO_SLUG, "title": "x" }));
    let id = created["task"]["id"].as_i64().unwrap();
    dispatcher
        .store
        .set_task_worktree(id, REPO_DIR, None, Some("feat/x"), Some("/w/feat-x"))
        .unwrap();

    let message = call_tool_err(&mut dispatcher, "task_start", json!({ "id": id }));
    assert!(message.contains("already has a worktree"), "{message}");
    assert!(starts.lock().unwrap().is_empty(), "host must not be called");
}

#[test]
fn task_start_refuses_a_closed_task() {
    let (mut dispatcher, _, starts) = with_host_recording(deleted("unused", vec![]));
    let created =
        call_tool(&mut dispatcher, "task_create", json!({ "repo": REPO_SLUG, "title": "x" }));
    let id = created["task"]["id"].as_i64().unwrap();
    dispatcher.store.close_task(id, tt_store::TaskOutcome::Done, NOW).unwrap();

    let message = call_tool_err(&mut dispatcher, "task_start", json!({ "id": id }));
    assert!(message.contains("closed"), "{message}");
    assert!(starts.lock().unwrap().is_empty(), "host must not be called");
}

#[test]
fn task_start_refuses_a_task_with_no_repo_binding() {
    let (mut dispatcher, _, starts) = with_host_recording(deleted("unused", vec![]));
    let message = call_tool_err(&mut dispatcher, "task_start", json!({ "id": 1 }));
    assert!(message.contains("isn't bound to a repo"), "{message}");
    assert!(starts.lock().unwrap().is_empty(), "host must not be called");
}

#[test]
fn task_start_reports_an_unknown_id() {
    let (mut dispatcher, _, _) = with_host_recording(deleted("unused", vec![]));
    let message = call_tool_err(&mut dispatcher, "task_start", json!({ "id": 9999 }));
    assert!(message.to_lowercase().contains("task"), "{message}");
}

#[test]
fn start_prompt_prefers_goal_then_falls_back_to_the_title() {
    // A real row, so the fixture can't drift from what the store hands the dispatcher.
    let store = Store::open_in_memory().unwrap();
    let mut task = store.add_task("Card title", "backlog", None, None, NOW).unwrap();

    // Nothing but a title: it's all the agent can be told.
    assert_eq!(task_start_prompt(&task), "Card title");

    task.goal = Some("  Do the thing.  ".into());
    assert_eq!(task_start_prompt(&task), "Do the thing.");

    task.notes = Some("Context here.".into());
    assert_eq!(task_start_prompt(&task), "Do the thing.\n\n## Notes\n\nContext here.");

    // Blank strings are absent, not content.
    task.goal = Some("   ".into());
    assert_eq!(task_start_prompt(&task), "Card title\n\n## Notes\n\nContext here.");
}

/// Without a host, refuse — deleting only the row would strand the worktree on disk.
#[test]
fn task_delete_without_a_host_refuses() {
    let mut dispatcher = dispatcher();
    let message = call_tool_err(&mut dispatcher, "task_delete", json!({ "id": 1 }));
    assert!(message.contains("no task host"), "{message}");
    // And the row it declined to delete is still there.
    let open = call_tool(&mut dispatcher, "task_list", json!({}));
    assert_eq!(open["tasks"].as_array().unwrap().len(), 1);
}

#[test]
fn task_delete_passes_the_id_force_and_outcome_through_and_names_what_it_deleted() {
    let (mut dispatcher, calls) =
        with_host(deleted("open task", vec!["removed the worktree".into()]));
    let result = call_tool(
        &mut dispatcher,
        "task_delete",
        json!({ "id": 1, "force": true, "outcome": "abandoned" }),
    );
    assert_eq!(result["status"], "deleted");
    assert_eq!(result["id"], 1);
    // The name comes from the host, which resolved the row anyway.
    assert_eq!(result["text"], "open task");
    assert_eq!(result["messages"][0], "removed the worktree");
    assert_eq!(*calls.lock().unwrap(), vec![(1, true, Some(tt_store::TaskOutcome::Abandoned))]);
}

/// A bad outcome is rejected before the host acts; an omitted one reaches it as `None`.
#[test]
fn task_delete_validates_the_outcome_and_defaults_it_to_inference() {
    let (mut dispatcher, calls) = with_host(deleted("open task", vec![]));
    let message =
        call_tool_err(&mut dispatcher, "task_delete", json!({ "id": 1, "outcome": "exploded" }));
    assert!(message.contains("unknown outcome"), "{message}");
    assert!(calls.lock().unwrap().is_empty(), "rejected before the host ran");

    let result = call_tool(&mut dispatcher, "task_delete", json!({ "id": 1 }));
    assert_eq!(result["status"], "deleted");
    assert_eq!(*calls.lock().unwrap(), vec![(1, false, None)]);
}

// task_done

/// A task bound to `/w/feat-x` — gone from disk, so the git/gh gate has nothing to read.
fn task_in_worktree(dispatcher: &mut Dispatcher) -> i64 {
    let created = call_tool(dispatcher, "task_create", json!({ "repo": REPO_SLUG, "title": "x" }));
    let id = created["task"]["id"].as_i64().unwrap();
    dispatcher
        .store
        .set_task_worktree(id, REPO_DIR, None, Some("feat/x"), Some("/w/feat-x"))
        .unwrap();
    id
}

/// A merge moves the card to done while the worktree lives on, so `task_list` no longer
/// shows it.
#[test]
fn task_done_finds_a_closed_task_from_below_its_worktree_and_deletes_it_as_done() {
    let (mut dispatcher, calls) = with_host(deleted("x", vec!["removed".to_string()]));
    let id = task_in_worktree(&mut dispatcher);
    dispatcher.store.set_task_status(id, "done", NOW).unwrap();
    assert!(
        call_tool(&mut dispatcher, "task_list", json!({}))["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .all(|t| t["id"] != id)
    );

    let result = call_tool(
        &mut dispatcher,
        "task_done",
        json!({ "dir": "/w/feat-x/crates", "summary": "shipped #1" }),
    );
    assert_eq!(result["status"], "deleted");
    assert_eq!(result["messages"], json!(["removed"]));
    assert_eq!(*calls.lock().unwrap(), vec![(id, false, Some(tt_store::TaskOutcome::Done))]);
    let row = dispatcher.store.task_by_id(id).unwrap();
    assert_eq!(row.summary.as_deref(), Some("shipped #1"), "summary lands before the delete");
}

#[test]
fn task_done_refuses_a_checkout_no_task_is_bound_to() {
    let (mut dispatcher, calls) = with_host(deleted("unused", vec![]));
    task_in_worktree(&mut dispatcher);
    let message = call_tool_err(
        &mut dispatcher,
        "task_done",
        json!({ "dir": "/home/me/toolbox", "summary": "s" }),
    );
    assert!(message.contains("no board task is bound to /home/me/toolbox"), "{message}");
    assert!(calls.lock().unwrap().is_empty());
}

#[test]
fn task_done_needs_an_absolute_dir_and_a_summary() {
    let (mut dispatcher, calls) = with_host(deleted("unused", vec![]));
    task_in_worktree(&mut dispatcher);
    let no_summary = json!({ "dir": "/w/feat-x" });
    let message = call_tool_err(&mut dispatcher, "task_done", no_summary);
    assert!(message.contains("missing required argument: summary"), "{message}");
    let relative = json!({ "dir": "feat-x", "summary": "s" });
    let message = call_tool_err(&mut dispatcher, "task_done", relative);
    assert!(message.contains("absolute"), "{message}");
    assert!(calls.lock().unwrap().is_empty());
}

/// The removal guard's refusal passes through, under the same shape as the gate's own.
#[test]
fn task_done_reports_the_hosts_refusal() {
    let (mut dispatcher, _) = with_host(Ok(TaskDeletion::Refused {
        name: "x".to_string(),
        blockers: vec![json!({ "kind": "dirtyTree", "losesWork": true })],
        messages: vec![],
    }));
    task_in_worktree(&mut dispatcher);
    let args = json!({ "dir": "/w/feat-x", "summary": "s" });
    let result = call_tool(&mut dispatcher, "task_done", args);
    assert_eq!(result["status"], "refused");
    assert_eq!(result["blockers"][0]["kind"], "dirtyTree");
}

/// A guarded refusal is a result, not an error — an error would invite a retry with force.
#[test]
fn task_delete_reports_a_refusal_as_a_normal_result() {
    let (mut dispatcher, calls) = with_host(Ok(TaskDeletion::Refused {
        name: "open task".to_string(),
        blockers: vec![json!({
            "kind": "dirtyTree",
            "message": "2 uncommitted files",
            "remedy": "commit or stash them",
            "losesWork": true,
        })],
        messages: vec![],
    }));
    let result = call_tool(&mut dispatcher, "task_delete", json!({ "id": 1 }));
    assert_eq!(result["status"], "refused");
    assert_eq!(result["blockers"][0]["kind"], "dirtyTree");
    assert_eq!(result["blockers"][0]["losesWork"], true);
    // Force defaults off — a refusal must be reachable without asking for one.
    assert_eq!(*calls.lock().unwrap(), vec![(1, false, None)]);
}

#[test]
fn task_delete_requires_an_id() {
    let (mut dispatcher, calls) = with_host(deleted("open task", vec![]));
    let message = call_tool_err(&mut dispatcher, "task_delete", json!({}));
    assert!(message.contains("missing required argument: id"), "{message}");
    // Rejected before the host could touch anything.
    assert!(calls.lock().unwrap().is_empty());
}

/// An unknown id is the host's answer: it resolves the row anyway.
#[test]
fn task_delete_surfaces_the_hosts_unknown_id_error() {
    let (mut dispatcher, calls) = with_host(Err("no board task #9999".to_string()));
    let message = call_tool_err(&mut dispatcher, "task_delete", json!({ "id": 9999 }));
    assert!(message.contains("no board task #9999"), "{message}");
    assert_eq!(*calls.lock().unwrap(), vec![(9999, false, None)]);
}

#[test]
fn task_create_rejects_an_untracked_repo() {
    let mut dispatcher = dispatcher();
    let message =
        call_tool_err(&mut dispatcher, "task_create", json!({ "repo": "nope/nope", "title": "x" }));
    assert!(message.contains("unknown repo: nope/nope"), "{message}");
    assert!(message.contains(REPO_SLUG), "error should list tracked repos: {message}");

    let mut empty = Dispatcher::new(seeded_store(), TEST_VERSION);
    let message =
        call_tool_err(&mut empty, "task_create", json!({ "repo": REPO_SLUG, "title": "x" }));
    assert!(message.contains("no repos are tracked"), "{message}");
}

#[test]
fn task_create_requires_title_and_repo() {
    let mut dispatcher = dispatcher();
    let message = call_tool_err(&mut dispatcher, "task_create", json!({ "repo": REPO_SLUG }));
    assert!(message.contains("title"), "error should name the missing arg: {message}");
    let message =
        call_tool_err(&mut dispatcher, "task_create", json!({ "repo": REPO_SLUG, "title": " " }));
    assert!(message.contains("title"), "blank title should be rejected: {message}");
    let message = call_tool_err(&mut dispatcher, "task_create", json!({ "title": "x" }));
    assert!(message.contains("repo"), "error should name the missing arg: {message}");
}

#[test]
fn task_create_rejects_a_bogus_status() {
    let mut dispatcher = dispatcher();
    let message = call_tool_err(
        &mut dispatcher,
        "task_create",
        json!({ "repo": REPO_SLUG, "title": "x", "status": "bogus" }),
    );
    assert!(message.contains("bogus"), "{message}");
    // Nothing was created.
    let open = call_tool(&mut dispatcher, "task_list", json!({}));
    assert_eq!(open["tasks"].as_array().unwrap().len(), 1, "only the seeded task remains");
}

/// The lane check stops a typo minting a calendar nothing writes again — the orphan-lane failure
/// the v9 migration destroyed data to avoid, so it must hold at runtime too.
#[test]
fn calendar_set_refuses_an_unconfigured_source() {
    let mut dispatcher = dispatcher();
    let message =
        call_tool_err(&mut dispatcher, "calendar_set", json!({ "source": "gcal", "events": [] }));
    assert!(message.contains("unknown calendar source: gcal"), "{message}");
    assert!(message.contains("google"), "refusal lists configured lanes: {message}");
}

/// Fails closed: nothing configured means every push is refused.
#[test]
fn calendar_set_refuses_everything_when_no_calendars_are_configured() {
    let mut dispatcher =
        Dispatcher::new(seeded_store(), TEST_VERSION).with_calendar_sources(vec![]);
    let message =
        call_tool_err(&mut dispatcher, "calendar_set", json!({ "source": "google", "events": [] }));
    assert!(message.contains("no calendars are configured"), "{message}");
}

/// A configured lane still works, including the empty-array clear.
#[test]
fn calendar_set_accepts_a_configured_source() {
    let mut dispatcher = dispatcher();
    let result =
        call_tool(&mut dispatcher, "calendar_set", json!({ "source": "google", "events": [] }));
    assert_eq!(result["source"], "google");
    assert_eq!(result["written"], 0);
}

/// Writes are flagged in the contract, not inferred from a description: the UI's write warning
/// is the only signal a human gets before a mutation, so it must not hinge on an adjective.
#[test]
fn every_tool_states_all_four_hints_and_no_writer_claims_read_only() {
    let tools = tool_definitions();
    let tools = tools.as_array().unwrap();
    let hint = |name: &str, key: &str| {
        tools.iter().find(|t| t["name"] == name).and_then(|t| t["annotations"][key].as_bool())
    };
    assert_eq!(hint("task_delete", "destructiveHint"), Some(true));
    assert_eq!(hint("task_create", "destructiveHint"), Some(false));
    assert_eq!(hint("task_summary", "idempotentHint"), Some(true));
    assert_eq!(hint("calendar_set", "idempotentHint"), Some(true));
    // Mints a worktree and launches an agent: not read-only, whatever the transport repaints.
    assert_eq!(hint("task_start", "readOnlyHint"), Some(false));
    assert_eq!(hint("preview_file", "readOnlyHint"), Some(true));

    for tool in tools {
        let name = tool["name"].as_str().unwrap();
        let hints = &tool["annotations"];
        for key in [
            "readOnlyHint",
            "destructiveHint",
            "idempotentHint",
            "openWorldHint",
        ] {
            assert!(hints[key].is_boolean(), "{name} omits {key}");
        }
        assert_eq!(hints["openWorldHint"], false, "{name} never leaves the machine");
        assert_eq!(hints["title"], tool["title"], "{name}: one title, stated twice");
        if tool_writes(name) {
            assert_eq!(hints["readOnlyHint"], false, "{name} writes the store");
        }
    }
    assert_eq!(TOOL_HINTS.len(), tools.len(), "a hint for a tool that no longer exists");
}

/// Inlined and dialect-free, so a client's 2020-12 validator reads it without a resolver.
#[test]
fn every_tool_declares_a_valid_output_schema() {
    for tool in tool_definitions().as_array().unwrap() {
        let name = tool["name"].as_str().unwrap();
        let schema = &tool["outputSchema"];
        assert_eq!(schema["type"], "object", "{name}");
        assert!(!schema.to_string().contains("$ref"), "{name} leaves a $ref to resolve");
        assert!(schema.get("$schema").is_none(), "{name} names a dialect");
        jsonschema::validator_for(schema).unwrap_or_else(|e| panic!("{name}: {e}"));
        for format in formats(schema) {
            assert!(["int64", "date-time"].contains(&format.as_str()), "{name}: {format}");
        }
    }
}

/// Every `format` a schema carries — Claude Code's validator warns aloud on one it
/// doesn't know (`uint64`), on every `tools/list`.
fn formats(schema: &Value) -> Vec<String> {
    match schema {
        Value::Object(map) => map
            .iter()
            .flat_map(|(key, value)| match (key.as_str(), value.as_str()) {
                ("format", Some(format)) => vec![format.to_string()],
                _ => formats(value),
            })
            .collect(),
        Value::Array(items) => items.iter().flat_map(formats).collect(),
        _ => Vec::new(),
    }
}

#[test]
fn removed_tools_are_unknown() {
    // Removed in the 2026-07 tool-surface review; a straggler gets the spec's protocol
    // error, not an `isError` result — and not a refusal at the door, so still a 200.
    let mut dispatcher = dispatcher();
    for tool in [
        "todo_create",
        "journal_append",
        "collect_refresh",
        "agent_sessions",
        "tasks_open",
        "issues_open",
        "prs_status",
        "dm_status",
        "day_brief",
        "snapshot",
        "collect_status",
    ] {
        let request = tool_call_request(tool, json!({}));
        let handled = dispatcher.dispatch_at(&request, NOW, &RequestContext::none());
        let response: Value = serde_json::from_str(&handled.response.unwrap()).unwrap();
        assert_eq!(response["error"]["code"], INVALID_PARAMS, "{tool}: {response}");
        assert!(response["error"]["message"].as_str().unwrap().contains(tool));
        assert_eq!(handled.error_code, None, "{tool}");
    }
}

#[test]
fn unknown_method_returns_method_not_found() {
    let mut dispatcher = dispatcher();
    // `ping` and `initialize` went with the handshake; nothing special about them.
    for method in ["no/such", "ping", "initialize"] {
        let response = parsed(&mut dispatcher, &request(3, method, json!({})));
        assert_eq!(response["id"], 3);
        assert_eq!(response["error"]["code"], METHOD_NOT_FOUND, "{method}");
    }
}

#[test]
fn broken_json_returns_parse_error_with_null_id() {
    let mut dispatcher = dispatcher();
    let response: Value =
        serde_json::from_str(&dispatcher.handle_at("{ not json", NOW).unwrap()).unwrap();
    assert_eq!(response["id"], Value::Null);
    assert_eq!(response["error"]["code"], -32700);
}

#[test]
fn batch_array_returns_invalid_request() {
    // Batching is gone since 2025-06-18: one Invalid Request, not a silent drop.
    let mut dispatcher = dispatcher();
    let batch = r#"[{"jsonrpc":"2.0","id":1,"method":"ping"}]"#;
    let response: Value = serde_json::from_str(&dispatcher.handle_at(batch, NOW).unwrap()).unwrap();
    assert_eq!(response["id"], Value::Null);
    assert_eq!(response["error"]["code"], -32600);
}

#[test]
fn request_with_id_but_no_method_is_invalid_request() {
    let mut dispatcher = dispatcher();
    let request = json!({ "jsonrpc": "2.0", "id": 5 }).to_string();
    let response: Value =
        serde_json::from_str(&dispatcher.handle_at(&request, NOW).unwrap()).unwrap();
    assert_eq!(response["id"], 5);
    assert_eq!(response["error"]["code"], -32600);
}

/// Drive a raw request line through the dispatcher, discarding its response.
fn drive(dispatcher: &mut Dispatcher, request: impl ToString) {
    dispatcher.handle_at(&request.to_string(), NOW);
}

#[test]
fn dispatch_records_each_requests_own_client() {
    let mut dispatcher = dispatcher();

    drive(&mut dispatcher, tool_call_request("task_list", json!({ "why": "ship it" })));
    drive(&mut dispatcher, tool_call_request("does_not_exist", json!({})));
    // A caller that sent no `clientInfo` is recorded as nobody, not as the last one.
    let mut anonymous: Value =
        serde_json::from_str(&request(3, "server/discover", json!({}))).unwrap();
    anonymous["params"]["_meta"].as_object_mut().unwrap().remove(META_CLIENT_INFO);
    drive(&mut dispatcher, anonymous);

    let calls = dispatcher.store.mcp_calls(10).unwrap();
    assert_eq!(calls.len(), 3, "one row per handled request: {calls:?}");

    // Newest first: the anonymous discover.
    assert_eq!(calls[0].method, "server/discover");
    assert!(calls[0].ok);
    assert_eq!(calls[0].client, None);

    // The failing unknown-tool call.
    assert_eq!(calls[1].method, "tools/call");
    assert_eq!(calls[1].tool.as_deref(), Some("does_not_exist"));
    assert!(!calls[1].ok);
    assert!(calls[1].error.is_some(), "failed call records an error");
    assert!(calls[1].duration_ms.is_some());
    assert_eq!(calls[1].client.as_deref(), Some("claude-code 2.1"));

    // The successful task_list call, with its compacted args and ts.
    assert_eq!(calls[2].tool.as_deref(), Some("task_list"));
    assert!(calls[2].ok);
    assert_eq!(calls[2].error, None);
    assert_eq!(calls[2].ts, NOW);
    assert!(
        calls[2].args.as_deref().is_some_and(|a| a.contains("ship it")),
        "args should carry the payload: {:?}",
        calls[2].args
    );
    assert_eq!(calls[2].client.as_deref(), Some("claude-code 2.1"));
}

#[test]
fn dispatch_records_unknown_method_as_error() {
    let mut dispatcher = dispatcher();
    drive(&mut dispatcher, request(1, "bogus/method", json!({})));
    let calls = dispatcher.store.mcp_calls(10).unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].method, "bogus/method");
    assert!(!calls[0].ok);
    assert_eq!(calls[0].error.as_deref(), Some("Method not found"));
}

#[test]
fn notifications_are_not_recorded() {
    let mut dispatcher = dispatcher();
    // A notification (no id) gets no response and no call-log row.
    drive(&mut dispatcher, json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
    assert!(dispatcher.store.mcp_calls(10).unwrap().is_empty());
}

#[test]
fn compact_args_truncates_on_char_boundary() {
    let short = json!({ "title": "x" });
    assert_eq!(compact_args(&short), r#"{"title":"x"}"#);

    let big = json!({ "notes": "é".repeat(CALL_LOG_ARGS_MAX) });
    let out = compact_args(&big);
    assert!(out.ends_with('…'), "oversized args end with an ellipsis: {out}");
    assert_eq!(out.chars().count(), CALL_LOG_ARGS_MAX + 1);
}

fn session(id: &str) -> RequestContext {
    RequestContext::for_session(Some(id))
}

#[test]
fn inbox_take_leases_the_callers_notes_and_ack_marks_them_delivered() {
    let mut dispatcher = dispatcher();
    let id = dispatcher.store.add_note("me", "band only", NoteSource::Note, &[], NOW).unwrap();
    dispatcher.store.add_note("other", "not yours", NoteSource::Note, &[], NOW).unwrap();

    let taken = call_tool_as(&mut dispatcher, "inbox_take", json!({}), &session("me"));
    assert_eq!(taken["pollMs"], inbox::POLL_MS);
    assert_eq!(taken["notes"].as_array().unwrap().len(), 1);
    assert_eq!(taken["notes"][0]["body"], "band only");
    let again = call_tool_as(&mut dispatcher, "inbox_take", json!({}), &session("me"));
    assert_eq!(again["notes"], json!([]), "a leased note is not offered twice");

    let acked = call_tool_as(
        &mut dispatcher,
        "inbox_ack",
        json!({ "ids": [id], "how": "midTurn" }),
        &session("me"),
    );
    assert_eq!(acked["acked"], 1);
    let twice = call_tool_as(
        &mut dispatcher,
        "inbox_ack",
        json!({ "ids": [id], "how": "midTurn" }),
        &session("me"),
    );
    assert_eq!(twice["acked"], 0, "acking is idempotent");
}

#[test]
fn inbox_take_without_a_session_tells_the_mod_to_stop_polling() {
    let mut dispatcher = dispatcher();
    let taken = call_tool(&mut dispatcher, "inbox_take", json!({}));
    assert_eq!(taken, json!({ "notes": [], "pollMs": 0 }));
    let err = call_tool_err(&mut dispatcher, "inbox_ack", json!({ "ids": [1], "how": "prompt" }));
    assert!(err.contains("session"), "{err}");
}

#[test]
fn an_empty_inbox_poll_leaves_no_call_log_row() {
    let mut dispatcher = dispatcher();
    call_tool_as(&mut dispatcher, "inbox_take", json!({}), &session("me"));
    assert!(dispatcher.store.mcp_calls(10).unwrap().is_empty());
    dispatcher.store.add_note("me", "x", NoteSource::Note, &[], NOW).unwrap();
    call_tool_as(&mut dispatcher, "inbox_take", json!({}), &session("me"));
    assert_eq!(dispatcher.store.mcp_calls(10).unwrap().len(), 1);
}

#[test]
fn delivery_reaches_the_host_once() {
    use std::sync::{Arc, Mutex};
    type Seen = Arc<Mutex<Vec<(String, usize)>>>;
    struct FakeInbox(Seen);
    impl InboxHost for FakeInbox {
        fn took(&self, _: &str, _: i64) {}
        fn delivered(&self, session: &str, notes: &[tt_store::AgentNote], _: NoteDelivery, _: i64) {
            self.0.lock().unwrap().push((session.to_string(), notes.len()));
        }
    }
    let seen: Seen = Arc::default();
    let mut dispatcher = dispatcher().with_inbox_host(Box::new(FakeInbox(seen.clone())));
    let id = dispatcher.store.add_note("me", "x", NoteSource::Note, &[], NOW).unwrap();
    for _ in 0..2 {
        call_tool_as(
            &mut dispatcher,
            "inbox_ack",
            json!({ "ids": [id], "how": "prompt" }),
            &session("me"),
        );
    }
    assert_eq!(*seen.lock().unwrap(), [("me".to_string(), 1)]);
}

struct FakeSuggest(f64);
impl SuggestHost for FakeSuggest {
    fn suggest(&self, request: SuggestRequest) -> Result<SuggestAnswer, String> {
        Ok(SuggestAnswer {
            prompt: Some(format!("{} / {}", request.answer, request.goal.unwrap_or_default())),
            confidence: 0.5,
            cost_usd: Some(self.0),
        })
    }
}

fn budgeted(cost: f64, budget: f64) -> Dispatcher {
    dispatcher().with_suggest_host(Box::new(FakeSuggest(cost))).with_next_prompt_settings(
        tt_config::NextPromptSettings { daily_budget_usd: budget, ..Default::default() },
    )
}

#[test]
fn next_prompt_asks_with_the_tasks_goal_and_counts_the_spend() {
    let mut dispatcher = budgeted(0.25, 1.0);
    let task = dispatcher.store.add_task("t", "doing", None, Some("ship it"), NOW).unwrap();
    let args = json!({ "tools": [], "commands": [], "answer": "done", "taskId": task.id });
    let first = call_tool(&mut dispatcher, "next_prompt", args.clone());
    assert_eq!(first["prompt"], "done / ship it");
    assert_eq!(first["budgetLeftUsd"], 0.75);
    call_tool(&mut dispatcher, "next_prompt", args.clone());
    call_tool(&mut dispatcher, "next_prompt", args.clone());
    call_tool(&mut dispatcher, "next_prompt", args.clone());
    let over = call_tool(&mut dispatcher, "next_prompt", args);
    assert_eq!(over["prompt"], Value::Null, "today's budget is spent");
    assert_eq!(over["budgetLeftUsd"], 0.0);
}

#[test]
fn next_prompt_without_a_host_refuses() {
    let mut dispatcher = dispatcher();
    let args = json!({ "tools": [], "commands": [], "answer": "" });
    assert!(call_tool_err(&mut dispatcher, "next_prompt", args).contains("unavailable"));
}

#[test]
fn task_create_resolves_a_dir_to_its_tracked_repo() {
    let mut dispatcher = dispatcher();
    let dir = format!("{REPO_DIR}/.claude/worktrees/feat");
    let created = call_tool(
        &mut dispatcher,
        "task_create",
        json!({ "dir": dir, "title": "cap the inbox", "origin": "park" }),
    );
    assert_eq!(created["task"]["worktree"]["repo"], REPO_SLUG);
    let err = call_tool_err(&mut dispatcher, "task_create", json!({ "title": "x" }));
    assert!(err.contains("repo (or dir)"), "{err}");
    let err = call_tool_err(
        &mut dispatcher,
        "task_create",
        json!({ "repo": REPO_SLUG, "title": "x", "origin": "model" }),
    );
    assert!(err.contains("unknown origin"), "{err}");
}
