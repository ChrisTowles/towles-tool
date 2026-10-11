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
