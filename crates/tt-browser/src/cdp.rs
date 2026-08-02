//! Minimal CDP client over one sync WebSocket, thread-per-connection.
//!
//! The socket thread owns the tungstenite stream outright: outgoing text
//! arrives over an mpsc channel and reads run under a short TcpStream read
//! timeout, so one loop serves both directions without splitting the socket.
//! Flat-mode sessions (`Target.attachToTarget { flatten: true }`) mean every
//! message carries an optional `sessionId` and one connection drives the
//! browser target plus every page target.

use std::collections::HashMap;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use serde_json::{Value, json};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use crate::BrowserError;

const READ_TICK: Duration = Duration::from_millis(5);
const CALL_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone)]
pub struct CdpEvent {
    pub session_id: Option<String>,
    pub method: String,
    pub params: Value,
}

type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>>;

pub struct CdpConn {
    out: mpsc::Sender<String>,
    pending: Pending,
    next_id: AtomicU64,
    alive: Arc<AtomicBool>,
}

impl CdpConn {
    /// Connect and start the socket thread. `on_event` fires on that thread —
    /// keep it cheap and re-dispatch anything heavy.
    pub fn connect(
        ws_url: &str,
        on_event: impl Fn(CdpEvent) + Send + 'static,
    ) -> Result<Self, BrowserError> {
        let (mut ws, _) =
            tungstenite::connect(ws_url).map_err(|e| BrowserError::Cdp(e.to_string()))?;
        if let MaybeTlsStream::Plain(stream) = ws.get_ref() {
            stream.set_read_timeout(Some(READ_TICK))?;
        }
        let (out, out_rx) = mpsc::channel::<String>();
        let pending: Pending = Arc::default();
        let alive = Arc::new(AtomicBool::new(true));
        {
            let pending = Arc::clone(&pending);
            let alive = Arc::clone(&alive);
            std::thread::spawn(move || {
                socket_loop(&mut ws, &out_rx, &pending, &on_event);
                alive.store(false, Ordering::SeqCst);
                for (_, tx) in pending.lock().unwrap().drain() {
                    let _ = tx.send(Err("connection closed".into()));
                }
            });
        }
        Ok(Self { out, pending, next_id: AtomicU64::new(0), alive })
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Call a method and wait for its result.
    pub fn call(
        &self,
        session_id: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<Value, BrowserError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.send_raw(build_message(id, session_id, method, params));
        match rx.recv_timeout(CALL_TIMEOUT) {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(message)) => Err(BrowserError::Cdp(format!("{method}: {message}"))),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                if self.is_alive() {
                    Err(BrowserError::Cdp(format!("{method}: timed out")))
                } else {
                    Err(BrowserError::Closed)
                }
            }
        }
    }

    /// Fire-and-forget — input dispatch and frame acks, where waiting for a
    /// result would serialize the pane's pointer stream on round-trips.
    pub fn send(&self, session_id: Option<&str>, method: &str, params: Value) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        self.send_raw(build_message(id, session_id, method, params));
    }

    fn send_raw(&self, message: String) {
        let _ = self.out.send(message);
    }
}

fn build_message(id: u64, session_id: Option<&str>, method: &str, params: Value) -> String {
    let mut msg = json!({ "id": id, "method": method, "params": params });
    if let Some(session) = session_id {
        msg["sessionId"] = json!(session);
    }
    msg.to_string()
}

fn socket_loop(
    ws: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    out_rx: &mpsc::Receiver<String>,
    pending: &Pending,
    on_event: &(impl Fn(CdpEvent) + Send + 'static),
) {
    loop {
        while let Ok(text) = out_rx.try_recv() {
            if ws.send(Message::Text(text.into())).is_err() && flush_blocking(ws).is_err() {
                return;
            }
        }
        match ws.read() {
            Ok(Message::Text(text)) => dispatch(&text, pending, on_event),
            Ok(_) => {}
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => return,
        }
    }
}

fn flush_blocking(ws: &mut WebSocket<MaybeTlsStream<TcpStream>>) -> Result<(), ()> {
    for _ in 0..1000 {
        match ws.flush() {
            Ok(()) => return Ok(()),
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => return Err(()),
        }
    }
    Err(())
}

fn dispatch(text: &str, pending: &Pending, on_event: &impl Fn(CdpEvent)) {
    let Ok(msg) = serde_json::from_str::<Value>(text) else {
        return;
    };
    if let Some(id) = msg.get("id").and_then(Value::as_u64) {
        if let Some(tx) = pending.lock().unwrap().remove(&id) {
            let outcome = match msg.get("error") {
                Some(err) => Err(err
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown cdp error")
                    .to_string()),
                None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
            };
            let _ = tx.send(outcome);
        }
        return;
    }
    let Some(method) = msg.get("method").and_then(Value::as_str) else {
        return;
    };
    on_event(CdpEvent {
        session_id: msg.get("sessionId").and_then(Value::as_str).map(String::from),
        method: method.to_string(),
        params: msg.get("params").cloned().unwrap_or(Value::Null),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_shape_matches_cdp() {
        let msg = build_message(7, Some("SESS"), "Page.navigate", json!({"url": "about:blank"}));
        let parsed: Value = serde_json::from_str(&msg).unwrap();
        assert_eq!(parsed["id"], 7);
        assert_eq!(parsed["sessionId"], "SESS");
        assert_eq!(parsed["method"], "Page.navigate");
        assert_eq!(parsed["params"]["url"], "about:blank");
        let bare = build_message(1, None, "Browser.close", json!({}));
        assert!(!bare.contains("sessionId"));
    }

    #[test]
    fn dispatch_routes_responses_and_events() {
        let pending: Pending = Arc::default();
        let (tx, rx) = mpsc::channel();
        pending.lock().unwrap().insert(3, tx);
        let events: Arc<Mutex<Vec<CdpEvent>>> = Arc::default();
        let sink = {
            let events = Arc::clone(&events);
            move |e: CdpEvent| events.lock().unwrap().push(e)
        };
        dispatch(r#"{"id":3,"result":{"ok":true}}"#, &pending, &sink);
        assert_eq!(rx.recv().unwrap().unwrap()["ok"], true);
        dispatch(r#"{"method":"Page.frameNavigated","params":{},"sessionId":"S"}"#, &pending, &sink);
        dispatch("not json", &pending, &sink);
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].method, "Page.frameNavigated");
        assert_eq!(events[0].session_id.as_deref(), Some("S"));
    }

    #[test]
    fn dispatch_surfaces_cdp_errors() {
        let pending: Pending = Arc::default();
        let (tx, rx) = mpsc::channel();
        pending.lock().unwrap().insert(9, tx);
        dispatch(r#"{"id":9,"error":{"message":"no such frame"}}"#, &pending, &|_| {});
        assert_eq!(rx.recv().unwrap().unwrap_err(), "no such frame");
    }
}
