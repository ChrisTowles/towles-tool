//! Chrome host for the browser pane: one supervised Chrome process on the
//! app-owned profile (`tt_config::browser_profile_dir`), one CDP target per
//! pane, frames streamed per-pane over a `tauri::ipc::Channel` as raw JPEG.
//!
//! Threading rules: the CDP event closure runs on the socket thread, where a
//! blocking `call()` deadlocks (only that thread reads responses) — frames
//! are handled inline (no calls) and everything else re-dispatches to a
//! worker thread. Commands that can block (launch, shutdown, screencast
//! restarts) are async so they never run on the GTK main thread.
//!
//! Shutdown must be CDP `Browser.close` first — the cookie DB flushes only
//! on graceful exit (spike-proven: a SIGTERM loses a just-set login).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use serde_json::{Value, json};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};
use tt_browser::frames::{SCREENCAST_EVENT, start_screencast, stop_screencast};
use tt_browser::{CdpConn, ChromeChild, ChromeConfig, find_chrome, handle_screencast_event};

use crate::ide::MAIN_WINDOW_LABEL;
use crate::instance_lock::InstanceLock;

pub const BROWSER_STATE_EVENT: &str = "browser://state";
const PROFILE_LOCK_NAME: &str = "browser-profile";
const DEFAULT_VIEW: (u32, u32) = (1280, 800);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStateEvent {
    pub pane_id: String,
    pub phase: &'static str,
    pub url: String,
    pub title: String,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub detail: Option<String>,
}

#[derive(Default)]
pub struct BrowserHost {
    instance: Mutex<Option<Instance>>,
    routes: Routes,
    generation: AtomicU64,
}

struct Instance {
    chrome: ChromeChild,
    conn: Arc<CdpConn>,
    headless: bool,
    _lock: InstanceLock,
}

impl Instance {
    fn shutdown_graceful(&mut self) {
        self.conn.send(None, "Browser.close", json!({}));
        if !self.chrome.wait_exit(Duration::from_secs(5)) {
            self.chrome.shutdown();
        }
    }
}

impl Drop for BrowserHost {
    fn drop(&mut self) {
        if let Ok(mut instance) = self.instance.lock()
            && let Some(inst) = instance.as_mut()
        {
            inst.shutdown_graceful();
        }
    }
}

type Routes = Arc<Mutex<HashMap<String, Route>>>;

struct Route {
    pane_id: String,
    target_id: String,
    channel: Channel<InvokeResponseBody>,
    url: String,
    title: String,
    visible: bool,
    view: (u32, u32),
}

fn emit_state(app: &AppHandle, event: BrowserStateEvent) {
    let _ = app.emit_to(MAIN_WINDOW_LABEL, BROWSER_STATE_EVENT, event);
}

fn state_of(route: &Route, phase: &'static str, detail: Option<String>) -> BrowserStateEvent {
    BrowserStateEvent {
        pane_id: route.pane_id.clone(),
        phase,
        url: route.url.clone(),
        title: route.title.clone(),
        can_go_back: false,
        can_go_forward: false,
        detail,
    }
}

fn bare_state(pane_id: String, phase: &'static str, url: String) -> BrowserStateEvent {
    BrowserStateEvent {
        pane_id,
        phase,
        url,
        title: String::new(),
        can_go_back: false,
        can_go_forward: false,
        detail: None,
    }
}

/// Chrome availability for the pane's empty/error states. Pure read.
#[tauri::command]
pub fn browser_status() -> Value {
    let found = find_chrome(None);
    json!({
        "chromeFound": found.is_some(),
        "chromePath": found.map(|p| p.display().to_string()),
    })
}

#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    host: State<'_, BrowserHost>,
    pane_id: String,
    url: Option<String>,
    on_frame: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    emit_state(&app, bare_state(pane_id.clone(), "launching", url.clone().unwrap_or_default()));
    let conn = ensure_instance(&app, &host, true)?;

    // A relaunch for the same pane replaces its route; drop the stale one.
    host.routes.lock().unwrap().retain(|_, r| r.pane_id != pane_id);

    let target = conn
        .call(None, "Target.createTarget", json!({ "url": "about:blank" }))
        .map_err(|e| e.to_string())?;
    let target_id =
        target["targetId"].as_str().ok_or("createTarget returned no targetId")?.to_string();
    let attached = conn
        .call(None, "Target.attachToTarget", json!({ "targetId": target_id, "flatten": true }))
        .map_err(|e| e.to_string())?;
    let session = attached["sessionId"].as_str().ok_or("attach returned no sessionId")?.to_string();

    conn.call(Some(&session), "Page.enable", json!({})).map_err(|e| e.to_string())?;
    conn.send(None, "Target.setDiscoverTargets", json!({ "discover": true }));
    if let Ok(version) = conn.call(None, "Browser.getVersion", json!({}))
        && let Some(ua) = version["userAgent"].as_str()
    {
        let clean = strip_headless(ua);
        conn.send(Some(&session), "Emulation.setUserAgentOverride", json!({ "userAgent": clean }));
    }

    host.routes.lock().unwrap().insert(
        session.clone(),
        Route {
            pane_id: pane_id.clone(),
            target_id,
            channel: on_frame,
            url: String::new(),
            title: String::new(),
            visible: true,
            view: DEFAULT_VIEW,
        },
    );
    start_screencast(&conn, &session, DEFAULT_VIEW.0, DEFAULT_VIEW.1).map_err(|e| e.to_string())?;
    if let Some(url) = url {
        conn.send(Some(&session), "Page.navigate", json!({ "url": url }));
    }
    if let Some(route) = host.routes.lock().unwrap().get(&session) {
        emit_state(&app, state_of(route, "live", None));
    }
    tracing::info!(outcome = "opened", "browser.pane_opened");
    Ok(())
}

#[tauri::command]
pub async fn browser_navigate(
    host: State<'_, BrowserHost>,
    pane_id: String,
    url: Option<String>,
    action: Option<String>,
) -> Result<(), String> {
    let (conn, session) = pane_session(&host, &pane_id)?;
    let outcome = match (url, action.as_deref()) {
        (Some(url), _) => {
            conn.send(Some(&session), "Page.navigate", json!({ "url": url }));
            "navigate"
        }
        (None, Some("reload")) => {
            conn.send(Some(&session), "Page.reload", json!({}));
            "reload"
        }
        (None, Some(step @ ("back" | "forward"))) => {
            let history = conn
                .call(Some(&session), "Page.getNavigationHistory", json!({}))
                .map_err(|e| e.to_string())?;
            let index = history["currentIndex"].as_i64().unwrap_or(0);
            let entries = history["entries"].as_array().map(Vec::len).unwrap_or(0) as i64;
            let target = if step == "back" { index - 1 } else { index + 1 };
            if (0..entries).contains(&target)
                && let Some(id) = history["entries"][target as usize]["id"].as_i64()
            {
                conn.send(Some(&session), "Page.navigateToHistoryEntry", json!({ "entryId": id }));
            }
            step
        }
        _ => return Err("browser_navigate needs a url or an action".into()),
    };
    tracing::info!(outcome, "browser.navigate");
    Ok(())
}

/// Continuous input — deliberately unlogged, like `term_*` writes, and sync:
/// it only queues fire-and-forget sends.
#[tauri::command]
pub fn browser_input(
    host: State<'_, BrowserHost>,
    pane_id: String,
    events: Vec<Value>,
) -> Result<(), String> {
    let (conn, session) = pane_session(&host, &pane_id)?;
    for event in events {
        if let Some((method, params)) = translate_input(&event) {
            conn.send(Some(&session), method, params);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_set_viewport(
    host: State<'_, BrowserHost>,
    pane_id: String,
    width: f64,
    height: f64,
    dpr: f64,
) -> Result<(), String> {
    let (conn, session) = pane_session(&host, &pane_id)?;
    let (w, h) = (width.round().max(1.0) as u32, height.round().max(1.0) as u32);
    conn.send(
        Some(&session),
        "Emulation.setDeviceMetricsOverride",
        json!({ "width": w, "height": h, "deviceScaleFactor": dpr, "mobile": false }),
    );
    let physical = ((width * dpr) as u32, (height * dpr) as u32);
    let visible = {
        let mut routes = host.routes.lock().unwrap();
        let route = routes.get_mut(&session).ok_or("pane vanished")?;
        route.view = physical;
        route.visible
    };
    if visible {
        stop_screencast(&conn, &session);
        start_screencast(&conn, &session, physical.0, physical.1).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_set_visible(
    host: State<'_, BrowserHost>,
    pane_id: String,
    visible: bool,
) -> Result<(), String> {
    let (conn, session) = pane_session(&host, &pane_id)?;
    let view = {
        let mut routes = host.routes.lock().unwrap();
        let route = routes.get_mut(&session).ok_or("pane vanished")?;
        route.visible = visible;
        route.view
    };
    if visible {
        start_screencast(&conn, &session, view.0, view.1).map_err(|e| e.to_string())?;
    } else {
        stop_screencast(&conn, &session);
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_capture(
    host: State<'_, BrowserHost>,
    pane_id: String,
) -> Result<String, String> {
    let (conn, session) = pane_session(&host, &pane_id)?;
    let shot = conn
        .call(Some(&session), "Page.captureScreenshot", json!({ "format": "png" }))
        .map_err(|e| e.to_string())?;
    tracing::info!(outcome = "ok", "browser.capture");
    shot["data"].as_str().map(String::from).ok_or_else(|| "no screenshot data".into())
}

#[tauri::command]
pub async fn browser_close(host: State<'_, BrowserHost>, pane_id: String) -> Result<(), String> {
    let removed = {
        let mut routes = host.routes.lock().unwrap();
        let session = routes.iter().find(|(_, r)| r.pane_id == pane_id).map(|(s, _)| s.clone());
        session.and_then(|s| routes.remove(&s).map(|r| (s, r.target_id)))
    };
    let mut instance = host.instance.lock().unwrap();
    let Some(inst) = instance.as_mut() else {
        return Ok(());
    };
    if let Some((_, target_id)) = removed {
        inst.conn.send(None, "Target.closeTarget", json!({ "targetId": target_id }));
    }
    if host.routes.lock().unwrap().is_empty() {
        host.generation.fetch_add(1, Ordering::SeqCst);
        inst.shutdown_graceful();
        *instance = None;
        tracing::info!(outcome = "last_pane_shutdown", "browser.pane_closed");
    } else {
        tracing::info!(outcome = "closed", "browser.pane_closed");
    }
    Ok(())
}

/// Swap the whole instance to a headful window on the same profile at the
/// pane's current URL. Single-pane only: the profile backs one process, so a
/// pop-out necessarily takes every embedded target with it.
#[tauri::command]
pub async fn browser_popout(
    app: AppHandle,
    host: State<'_, BrowserHost>,
    pane_id: String,
) -> Result<(), String> {
    let url = {
        let routes = host.routes.lock().unwrap();
        if routes.len() != 1 {
            return Err("close other Chrome panes before popping out".into());
        }
        routes.values().find(|r| r.pane_id == pane_id).ok_or("unknown pane")?.url.clone()
    };
    host.routes.lock().unwrap().clear();
    host.generation.fetch_add(1, Ordering::SeqCst);
    {
        let mut instance = host.instance.lock().unwrap();
        if let Some(inst) = instance.as_mut() {
            inst.shutdown_graceful();
        }
        *instance = None;
    }
    launch_instance(&app, &host, false, Some(url.clone()))?;
    emit_state(&app, bare_state(pane_id, "poppedOut", url));
    tracing::info!(outcome = "popped_out", "browser.popout");
    Ok(())
}

fn pane_session(host: &BrowserHost, pane_id: &str) -> Result<(Arc<CdpConn>, String), String> {
    let session = host
        .routes
        .lock()
        .unwrap()
        .iter()
        .find(|(_, r)| r.pane_id == pane_id)
        .map(|(s, _)| s.clone())
        .ok_or("no Chrome target for this pane")?;
    let conn = host
        .instance
        .lock()
        .unwrap()
        .as_ref()
        .filter(|i| i.conn.is_alive())
        .map(|i| Arc::clone(&i.conn))
        .ok_or("Chrome is not running")?;
    Ok((conn, session))
}

fn ensure_instance(
    app: &AppHandle,
    host: &BrowserHost,
    headless: bool,
) -> Result<Arc<CdpConn>, String> {
    {
        let instance = host.instance.lock().unwrap();
        if let Some(inst) = instance.as_ref()
            && inst.conn.is_alive()
            && inst.headless == headless
        {
            tracing::info!(outcome = "already_running", "browser.launch");
            return Ok(Arc::clone(&inst.conn));
        }
    }
    // Wrong mode (a popped-out headful being folded back in) or a dead
    // instance: close it out, then start fresh. Dropping the old Instance
    // releases its profile lock before the relaunch reacquires it.
    {
        let mut instance = host.instance.lock().unwrap();
        if let Some(inst) = instance.as_mut() {
            host.generation.fetch_add(1, Ordering::SeqCst);
            inst.shutdown_graceful();
        }
        *instance = None;
    }
    launch_instance(app, host, headless, None)
}

fn launch_instance(
    app: &AppHandle,
    host: &BrowserHost,
    headless: bool,
    start_url: Option<String>,
) -> Result<Arc<CdpConn>, String> {
    let lock = InstanceLock::try_acquire(PROFILE_LOCK_NAME).ok_or_else(|| {
        tracing::info!(outcome = "blocked", "browser.launch");
        "the Chrome profile is in use by another towles-tool instance".to_string()
    })?;
    let binary = find_chrome(None).ok_or_else(|| {
        tracing::info!(outcome = "no_binary", "browser.launch");
        "no Chrome or Chromium binary found".to_string()
    })?;
    let profile = tt_config::browser_profile_dir().map_err(|e| e.to_string())?;
    let cfg = ChromeConfig { binary, user_data_dir: profile, headless, start_url };
    let chrome = ChromeChild::launch(&cfg).map_err(|e| {
        tracing::info!(outcome = "failed", "browser.launch");
        e.to_string()
    })?;

    let generation = host.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let routes = Arc::clone(&host.routes);
    let conn_slot: Arc<Mutex<Option<Arc<CdpConn>>>> = Arc::default();
    let (event_tx, event_rx) = mpsc::channel::<tt_browser::CdpEvent>();
    let conn = Arc::new(
        CdpConn::connect(&chrome.ws_url, {
            let routes = Arc::clone(&routes);
            let conn_slot = Arc::clone(&conn_slot);
            move |event| {
                if event.method == SCREENCAST_EVENT {
                    let Some(session) = event.session_id.as_deref() else {
                        return;
                    };
                    let Some(conn) = conn_slot.lock().unwrap().clone() else {
                        return;
                    };
                    if let Some(frame) = handle_screencast_event(&conn, session, &event.params)
                        && let Some(route) = routes.lock().unwrap().get(session)
                        && route.visible
                    {
                        let _ = route.channel.send(InvokeResponseBody::Raw(frame.data));
                    }
                    return;
                }
                let _ = event_tx.send(event);
            }
        })
        .map_err(|e| e.to_string())?,
    );
    conn_slot.lock().unwrap().replace(Arc::clone(&conn));

    spawn_dispatcher(app.clone(), Arc::clone(&conn), event_rx, generation);
    *host.instance.lock().unwrap() =
        Some(Instance { chrome, conn: Arc::clone(&conn), headless, _lock: lock });
    tracing::info!(outcome = "started", headless, "browser.launch");
    Ok(conn)
}

fn spawn_dispatcher(
    app: AppHandle,
    conn: Arc<CdpConn>,
    events: mpsc::Receiver<tt_browser::CdpEvent>,
    generation: u64,
) {
    std::thread::spawn(move || {
        while let Ok(event) = events.recv() {
            let host = app.state::<BrowserHost>();
            if host.generation.load(Ordering::SeqCst) != generation {
                return;
            }
            handle_event(&app, &host, &conn, event);
        }
        // Socket gone. If this generation is still current, Chrome died out
        // from under the panes rather than being replaced — say so.
        let host = app.state::<BrowserHost>();
        if host.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        for route in host.routes.lock().unwrap().values() {
            emit_state(&app, state_of(route, "crashed", Some("Chrome exited".into())));
        }
    });
}

fn handle_event(
    app: &AppHandle,
    host: &BrowserHost,
    conn: &Arc<CdpConn>,
    event: tt_browser::CdpEvent,
) {
    match event.method.as_str() {
        "Page.frameNavigated" => {
            let Some(session) = event.session_id else {
                return;
            };
            if event.params["frame"]["parentId"].is_string() {
                return;
            }
            let url = event.params["frame"]["url"].as_str().unwrap_or_default().to_string();
            let (can_back, can_fwd) = history_bounds(conn, &session);
            let mut routes = host.routes.lock().unwrap();
            if let Some(route) = routes.get_mut(&session) {
                route.url = url;
                let mut state = state_of(route, "live", None);
                state.can_go_back = can_back;
                state.can_go_forward = can_fwd;
                emit_state(app, state);
            }
        }
        "Target.targetInfoChanged" => {
            let info = &event.params["targetInfo"];
            let target_id = info["targetId"].as_str().unwrap_or_default();
            let mut routes = host.routes.lock().unwrap();
            if let Some(route) = routes.values_mut().find(|r| r.target_id == target_id) {
                route.title = info["title"].as_str().unwrap_or_default().to_string();
                if let Some(url) = info["url"].as_str() {
                    route.url = url.to_string();
                }
                emit_state(app, state_of(route, "live", None));
            }
        }
        "Inspector.targetCrashed" => {
            let Some(session) = event.session_id else {
                return;
            };
            if let Some(route) = host.routes.lock().unwrap().get(&session) {
                emit_state(app, state_of(route, "crashed", Some("page crashed".into())));
            }
        }
        _ => {}
    }
}

fn history_bounds(conn: &Arc<CdpConn>, session: &str) -> (bool, bool) {
    conn.call(Some(session), "Page.getNavigationHistory", json!({}))
        .ok()
        .map(|h| {
            let index = h["currentIndex"].as_i64().unwrap_or(0);
            let len = h["entries"].as_array().map(Vec::len).unwrap_or(0) as i64;
            (index > 0, index + 1 < len)
        })
        .unwrap_or((false, false))
}

/// The pane's input events, allowlisted and reshaped into CDP dispatch calls.
pub fn translate_input(event: &Value) -> Option<(&'static str, Value)> {
    match event["kind"].as_str()? {
        "mouse" => {
            let kind = event["type"].as_str()?;
            if !["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"].contains(&kind) {
                return None;
            }
            let mut params = json!({
                "type": kind,
                "x": event["x"].as_f64()?,
                "y": event["y"].as_f64()?,
                "modifiers": event["modifiers"].as_i64().unwrap_or(0),
            });
            if let Some(button) = event["button"].as_str() {
                params["button"] = json!(button);
                params["clickCount"] = json!(event["clickCount"].as_i64().unwrap_or(1));
            }
            if kind == "mouseWheel" {
                params["deltaX"] = json!(event["deltaX"].as_f64().unwrap_or(0.0));
                params["deltaY"] = json!(event["deltaY"].as_f64().unwrap_or(0.0));
            }
            Some(("Input.dispatchMouseEvent", params))
        }
        "key" => {
            let kind = event["type"].as_str()?;
            if !["keyDown", "keyUp", "char", "rawKeyDown"].contains(&kind) {
                return None;
            }
            let mut params = json!({
                "type": kind,
                "modifiers": event["modifiers"].as_i64().unwrap_or(0),
            });
            for field in ["key", "code", "text"] {
                if let Some(v) = event[field].as_str() {
                    params[field] = json!(v);
                }
            }
            for field in ["windowsVirtualKeyCode", "nativeVirtualKeyCode"] {
                if let Some(v) = event[field].as_i64() {
                    params[field] = json!(v);
                }
            }
            Some(("Input.dispatchKeyEvent", params))
        }
        _ => None,
    }
}

pub fn strip_headless(ua: &str) -> String {
    ua.replace("HeadlessChrome", "Chrome")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_the_headless_marker() {
        let ua = "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/149.0.0.0 Safari/537.36";
        assert!(!strip_headless(ua).contains("Headless"));
        assert!(strip_headless(ua).contains("Chrome/149.0.0.0"));
    }

    #[test]
    fn translates_mouse_and_key_events_and_rejects_junk() {
        let (method, params) = translate_input(&json!({
            "kind": "mouse", "type": "mousePressed", "x": 10.0, "y": 20.0,
            "button": "left", "clickCount": 2, "modifiers": 2
        }))
        .unwrap();
        assert_eq!(method, "Input.dispatchMouseEvent");
        assert_eq!(params["clickCount"], 2);
        let (method, params) = translate_input(&json!({
            "kind": "key", "type": "char", "text": "a", "key": "a", "modifiers": 0
        }))
        .unwrap();
        assert_eq!(method, "Input.dispatchKeyEvent");
        assert_eq!(params["text"], "a");
        assert!(translate_input(&json!({ "kind": "mouse", "type": "contextmenu" })).is_none());
        assert!(translate_input(&json!({ "kind": "gamepad" })).is_none());
    }
}
