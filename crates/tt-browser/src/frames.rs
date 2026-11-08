//! Screencast frame source: start/stop and per-frame decode + ack.

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
