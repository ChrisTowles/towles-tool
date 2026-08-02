//! Phase-0 spike for the browser pane (plan Decision 02): launches headless
//! Chrome on a scratch profile and prints pass/fail for the checkpoints —
//! FrameSource A/B (screencast vs polling: fps + stalls across a resize and
//! a navigation), the cookie-persistence loop (set, kill, relaunch, read),
//! and the UA gate. Run: cargo run -p tt-browser --example spike [profile-dir]

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use serde_json::json;
use tt_browser::{
    BrowserFrame, CdpConn, ChromeChild, ChromeConfig, Poller, find_chrome,
    frames::{SCREENCAST_EVENT, start_screencast, stop_screencast},
    handle_screencast_event,
};

fn main() {
    let profile: std::path::PathBuf = std::env::args()
        .nth(1)
        .map(Into::into)
        .unwrap_or_else(|| std::env::temp_dir().join("tt-browser-spike-profile"));
    let binary = find_chrome(None).expect("no chrome binary found");
    println!("chrome: {}", binary.display());
    println!("profile: {}", profile.display());

    let cfg = ChromeConfig { binary, user_data_dir: profile, headless: true, start_url: None };

    // Round 1: frame sources + UA + cookie write.
    {
        let (chrome, conn, session) = boot(&cfg);
        println!("devtools: port {} ({})", chrome.port, chrome.ws_url);

        let ua = eval_string(&conn, &session, "navigator.userAgent");
        println!(
            "ua: {ua}\nua-gate: {}",
            if ua.contains("HeadlessChrome") { "NEEDS setUserAgentOverride" } else { "clean" }
        );

        navigate(&conn, &session, "https://example.com");
        measure_screencast(&conn, &session);
        measure_poller(&conn, &session);
        measure_animated(&conn, &session);

        // Back on a real origin — a data: URL's opaque origin drops cookies.
        navigate(&conn, &session, "https://example.com");
        eval_string(&conn, &session, "document.cookie = 'tt_spike=alive; max-age=86400'");
        let cookie = eval_string(&conn, &session, "document.cookie");
        println!("cookie-after-set: {cookie}");

        // Browser.close is the only exit that flushes the cookie DB — the
        // first spike run proved a SIGTERM loses a just-set cookie.
        let mut chrome = chrome;
        conn.send(None, "Browser.close", json!({}));
        let clean = chrome.wait_exit(Duration::from_secs(10));
        println!("graceful-exit: {}", if clean { "clean" } else { "TIMED OUT (killed)" });
    }

    // Round 2: fresh process, same profile — did the cookie survive?
    {
        let (_chrome, conn, session) = boot(&cfg);
        navigate(&conn, &session, "https://example.com");
        std::thread::sleep(Duration::from_millis(500));
        let cookie = eval_string(&conn, &session, "document.cookie");
        let persisted = cookie.contains("tt_spike=alive");
        println!("cookie-after-relaunch: {cookie}");
        println!("login-persistence: {}", if persisted { "PASS" } else { "FAIL" });
    }
}

fn boot(cfg: &ChromeConfig) -> (ChromeChild, Arc<CdpConn>, String) {
    let chrome = ChromeChild::launch(cfg).expect("launch failed");
    let (event_tx, event_rx) = mpsc::channel::<tt_browser::CdpEvent>();
    let frames: Arc<Mutex<Option<mpsc::Sender<BrowserFrame>>>> = Arc::default();
    let conn = Arc::new(
        CdpConn::connect(&chrome.ws_url, move |event| {
            let _ = event_tx.send(event);
        })
        .expect("cdp connect failed"),
    );

    // The event thread turns screencast events into frames for whoever holds
    // the current frame sender; everything else is dropped.
    {
        let conn = Arc::clone(&conn);
        let frames = Arc::clone(&frames);
        FRAME_SINK.lock().unwrap().replace(Arc::clone(&frames));
        std::thread::spawn(move || {
            while let Ok(event) = event_rx.recv() {
                if event.method == SCREENCAST_EVENT
                    && let Some(session) = event.session_id.as_deref()
                    && let Some(frame) = handle_screencast_event(&conn, session, &event.params)
                    && let Some(tx) = frames.lock().unwrap().clone()
                {
                    let _ = tx.send(frame);
                }
            }
        });
    }

    let target = conn
        .call(None, "Target.createTarget", json!({ "url": "about:blank" }))
        .expect("createTarget");
    let target_id = target["targetId"].as_str().expect("targetId").to_string();
    let attached = conn
        .call(None, "Target.attachToTarget", json!({ "targetId": target_id, "flatten": true }))
        .expect("attachToTarget");
    let session = attached["sessionId"].as_str().expect("sessionId").to_string();
    conn.call(Some(&session), "Page.enable", json!({})).expect("Page.enable");
    conn.call(Some(&session), "Runtime.enable", json!({})).expect("Runtime.enable");
    (chrome, conn, session)
}

type FrameSinkSlot = Arc<Mutex<Option<mpsc::Sender<BrowserFrame>>>>;
static FRAME_SINK: Mutex<Option<FrameSinkSlot>> = Mutex::new(None);

fn subscribe_frames() -> mpsc::Receiver<BrowserFrame> {
    let (tx, rx) = mpsc::channel();
    if let Some(slot) = FRAME_SINK.lock().unwrap().as_ref() {
        slot.lock().unwrap().replace(tx);
    }
    rx
}

fn unsubscribe_frames() {
    if let Some(slot) = FRAME_SINK.lock().unwrap().as_ref() {
        slot.lock().unwrap().take();
    }
}

fn measure_screencast(conn: &Arc<CdpConn>, session: &str) {
    let rx = subscribe_frames();
    start_screencast(conn, session, 1280, 800).expect("startScreencast");
    let stats = collect_frames(&rx, Duration::from_secs(5), "screencast 5s steady");

    // Perturbations: a viewport change and a cross-site navigation are the
    // two known stall triggers for screencast.
    conn.call(
        Some(session),
        "Emulation.setDeviceMetricsOverride",
        json!({ "width": 900, "height": 600, "deviceScaleFactor": 1, "mobile": false }),
    )
    .expect("setDeviceMetricsOverride");
    collect_frames(&rx, Duration::from_secs(3), "screencast 3s after resize");
    navigate(conn, session, "https://www.rust-lang.org");
    collect_frames(&rx, Duration::from_secs(3), "screencast 3s after navigation");

    stop_screencast(conn, session);
    unsubscribe_frames();
    println!("screencast verdict: {} fps steady, worst gap {:?}", stats.0, stats.1);
}

/// Screencast is paint-driven — a static page yields one frame total (idle
/// pages are free). Sustained fps only means anything on animating content.
fn measure_animated(conn: &Arc<CdpConn>, session: &str) {
    let page = "data:text/html,<style>div{width:80px;height:80px;background:%23f43;\
                animation:s .5s linear infinite}@keyframes s{to{transform:rotate(1turn)}}\
                </style><div></div>";
    navigate(conn, session, page);
    let rx = subscribe_frames();
    start_screencast(conn, session, 1280, 800).expect("startScreencast");
    collect_frames(&rx, Duration::from_secs(5), "screencast 5s animated");
    stop_screencast(conn, session);
    unsubscribe_frames();
}

fn measure_poller(conn: &Arc<CdpConn>, session: &str) {
    let (tx, rx) = mpsc::channel();
    let poller = Poller::start(Arc::clone(conn), session.to_string(), 12, move |frame| {
        let _ = tx.send(frame);
    });
    collect_frames(&rx, Duration::from_secs(5), "poller 5s @12fps target");
    poller.stop();
}

fn collect_frames(
    rx: &mpsc::Receiver<BrowserFrame>,
    window: Duration,
    label: &str,
) -> (u64, Duration) {
    let count = AtomicU64::new(0);
    let mut bytes = 0usize;
    let mut worst_gap = Duration::ZERO;
    let mut last = Instant::now();
    let deadline = Instant::now() + window;
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(frame) => {
                count.fetch_add(1, Ordering::Relaxed);
                bytes += frame.data.len();
                worst_gap = worst_gap.max(last.elapsed());
                last = Instant::now();
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    let frames = count.load(Ordering::Relaxed);
    let fps = frames / window.as_secs().max(1);
    let avg_kb = if frames > 0 { bytes / frames as usize / 1024 } else { 0 };
    println!("{label}: {frames} frames (~{fps} fps), avg {avg_kb} KB, worst gap {worst_gap:?}");
    (fps, worst_gap)
}

fn navigate(conn: &CdpConn, session: &str, url: &str) {
    conn.call(Some(session), "Page.navigate", json!({ "url": url })).expect("navigate");
    std::thread::sleep(Duration::from_millis(1500));
}

fn eval_string(conn: &CdpConn, session: &str, expression: &str) -> String {
    conn.call(
        Some(session),
        "Runtime.evaluate",
        json!({ "expression": expression, "returnByValue": true }),
    )
    .ok()
    .and_then(|r| r["result"]["value"].as_str().map(String::from))
    .unwrap_or_default()
}
