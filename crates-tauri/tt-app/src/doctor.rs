//! Tauri bridge for the doctor checks (`tt-doctor`). One async command; the
//! ~10 subprocess probes run on a blocking worker so the UI stays live while
//! they spin.

#[tauri::command]
pub async fn doctor_run(
    store: tauri::State<'_, crate::store::StoreState>,
) -> Result<tt_doctor::DoctorReport, String> {
    tracing::info!("doctor.run");
    let store_failure = store.unavailable_reason();
    tauri::async_runtime::spawn_blocking(move || {
        let mut report = tt_doctor::run_report(crate::mcp_http::serving_port());
        // App-only check: it inspects the VT parser linked into *this*
        // process, so it can't live inside run_report (the `tt` CLI has no
        // VT engine and would report nothing meaningful).
        report.result.tools.push(tt_doctor::check_vt_parser(tt_vt::parser_optimize_mode()));
        report.result.tools.push(tt_doctor::check_store(store_failure.as_deref()));
        report
    })
    .await
    .map_err(|e| format!("doctor task failed: {e}"))
}

/// How far back the Doctor screen's crash panel looks.
const CRASH_WINDOW_DAYS: usize = 7;
const CRASH_LIMIT: usize = 20;

/// This checkout's crashes over the last week, newest first.
#[tauri::command]
pub async fn doctor_recent_crashes() -> Result<Vec<tt_telemetry::CrashRecord>, String> {
    let dir = tt_config::telemetry_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        tt_telemetry::read_crashes(&dir, CRASH_WINDOW_DAYS, CRASH_LIMIT).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("crash read task failed: {e}"))?
}

/// The WebView's half of crash capture: an uncaught error or unhandled
/// rejection, written as the same `app.crash` event a Rust panic is.
#[tauri::command]
pub fn crash_report(
    kind: String,
    message: String,
    location: Option<String>,
    stack: Option<String>,
) {
    let kind = match kind.as_str() {
        "webview-error" | "unhandled-rejection" => kind,
        _ => "webview-unknown".to_string(),
    };
    let message = tt_telemetry::cap_crash_text(message);
    let location = location.map(tt_telemetry::cap_crash_text).unwrap_or_default();
    let stack = stack.map(tt_telemetry::cap_crash_text).unwrap_or_default();
    tracing::error!(
        crash.kind = kind.as_str(),
        crash.message = message.as_str(),
        crash.location = location.as_str(),
        crash.stack = stack.as_str(),
        "app.crash"
    );
}
