//! The two interchangeable frame sources (plan Decision 02): screencast for
//! smoothness, screenshot-polling for dependability. Consumers receive the
//! same `BrowserFrame` either way and cannot tell the sources apart.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use base64::Engine as _;
use serde_json::{Value, json};

use crate::cdp::CdpConn;

#[derive(Clone)]
pub struct BrowserFrame {
    pub data: Vec<u8>,
    pub format: &'static str,
}

pub const SCREENCAST_EVENT: &str = "Page.screencastFrame";

pub fn start_screencast(
    conn: &CdpConn,
    session_id: &str,
    max_width: u32,
    max_height: u32,
) -> Result<(), crate::BrowserError> {
    conn.call(
        Some(session_id),
        "Page.startScreencast",
        json!({
            "format": "jpeg",
            "quality": 70,
            "maxWidth": max_width,
            "maxHeight": max_height,
            "everyNthFrame": 1,
        }),
    )
    .map(|_| ())
}

pub fn stop_screencast(conn: &CdpConn, session_id: &str) {
    conn.send(Some(session_id), "Page.stopScreencast", json!({}));
}

/// Decode one `Page.screencastFrame` event and ack it. Ack-on-decode is the
/// backpressure: Chromium won't encode the next frame until the ack lands,
/// so a slow consumer thread paces the stream instead of flooding it.
pub fn handle_screencast_event(
    conn: &CdpConn,
    session_id: &str,
    params: &Value,
) -> Option<BrowserFrame> {
    let frame_session = params.get("sessionId")?.clone();
    conn.send(Some(session_id), "Page.screencastFrameAck", json!({ "sessionId": frame_session }));
    let data = params.get("data")?.as_str()?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).ok()?;
    Some(BrowserFrame { data: bytes, format: "jpeg" })
}

pub struct Poller {
    stop: Arc<AtomicBool>,
}

impl Poller {
    /// Capture-loop fallback at a fixed rate; each tick is one
    /// `Page.captureScreenshot` round-trip, so real fps tops out at whatever
    /// the page's capture cost allows.
    pub fn start(
        conn: Arc<CdpConn>,
        session_id: String,
        fps: u32,
        sink: impl Fn(BrowserFrame) + Send + 'static,
    ) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let interval = Duration::from_millis(1000 / u64::from(fps.max(1)));
        {
            let stop = Arc::clone(&stop);
            std::thread::spawn(move || {
                while !stop.load(Ordering::SeqCst) && conn.is_alive() {
                    let started = std::time::Instant::now();
                    if let Ok(result) = conn.call(
                        Some(&session_id),
                        "Page.captureScreenshot",
                        json!({ "format": "jpeg", "quality": 70 }),
                    ) && let Some(frame) = decode_screenshot(&result)
                    {
                        sink(frame);
                    }
                    if let Some(rest) = interval.checked_sub(started.elapsed()) {
                        std::thread::sleep(rest);
                    }
                }
            });
        }
        Self { stop }
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl Drop for Poller {
    fn drop(&mut self) {
        self.stop();
    }
}

fn decode_screenshot(result: &Value) -> Option<BrowserFrame> {
    let data = result.get("data")?.as_str()?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).ok()?;
    Some(BrowserFrame { data: bytes, format: "jpeg" })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_a_screenshot_payload() {
        let png = base64::engine::general_purpose::STANDARD.encode([1u8, 2, 3]);
        let frame = decode_screenshot(&json!({ "data": png })).unwrap();
        assert_eq!(frame.data, vec![1, 2, 3]);
        assert!(decode_screenshot(&json!({})).is_none());
        assert!(decode_screenshot(&json!({ "data": "!!" })).is_none());
    }
}
