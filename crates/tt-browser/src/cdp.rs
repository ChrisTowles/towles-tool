//! Minimal CDP client over one sync WebSocket, thread-per-connection.
//!
//! Two threads share one TCP socket and both block, so an idle connection
//! costs no wakeups: the reader thread owns the handshaken tungstenite stream
//! and blocks in `read`; the writer thread owns a second tungstenite handle
//! over a cloned `TcpStream` and blocks on an mpsc channel of outgoing text.
//! Callers never wait on a poll tick. Dropping the connection shuts the
//! socket down, which unblocks the reader.
//! Flat-mode sessions (`Target.attachToTarget { flatten: true }`) mean every
//! message carries an optional `sessionId` and one connection drives the
//! browser target plus every page target.

use std::collections::HashMap;
use std::net::{Shutdown, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

use serde_json::{Value, json};
use tungstenite::protocol::Role;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use crate::BrowserError;

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
    stream: TcpStream,
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
        let MaybeTlsStream::Plain(tcp) = ws.get_ref() else {
            return Err(BrowserError::Cdp("devtools endpoint must be plain ws".into()));
        };
        let stream = tcp.try_clone()?;
        let mut writer = WebSocket::from_raw_socket(tcp.try_clone()?, Role::Client, None);
        let (out, out_rx) = mpsc::channel::<String>();
        let pending: Pending = Arc::default();
        let alive = Arc::new(AtomicBool::new(true));
        {
            let stream = stream.try_clone()?;
            std::thread::spawn(move || {
                while let Ok(text) = out_rx.recv() {
                    if writer.send(Message::Text(text.into())).is_err() {
                        break;
                    }
                }
                let _ = stream.shutdown(Shutdown::Both);
            });
        }
        {
            let pending = Arc::clone(&pending);
            let alive = Arc::clone(&alive);
            std::thread::spawn(move || {
                read_loop(&mut ws, &pending, &on_event);
                alive.store(false, Ordering::SeqCst);
                for (_, tx) in pending.lock().unwrap().drain() {
                    let _ = tx.send(Err("connection closed".into()));
                }
            });
        }
        Ok(Self { out, pending, next_id: AtomicU64::new(0), alive, stream })
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

fn read_loop(
    ws: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    pending: &Pending,
    on_event: &(impl Fn(CdpEvent) + Send + 'static),
) {
    loop {
        match ws.read() {
            Ok(Message::Text(text)) => dispatch(&text, pending, on_event),
            Ok(_) => {}
            Err(_) => return,
        }
    }
}

impl Drop for CdpConn {
    fn drop(&mut self) {
        let _ = self.stream.shutdown(Shutdown::Both);
    }
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
        dispatch(
            r#"{"method":"Page.frameNavigated","params":{},"sessionId":"S"}"#,
            &pending,
            &sink,
        );
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

    /// Loopback server that answers each request with `{"id", "result": {"echo": method}}`.
    fn echo_server() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let (tcp, _) = listener.accept().unwrap();
            let mut ws = tungstenite::accept(tcp).unwrap();
            while let Ok(Message::Text(text)) = ws.read() {
                let req: Value = serde_json::from_str(&text).unwrap();
                if req["method"] == "Test.hangUp" {
                    return;
                }
                let reply = json!({ "id": req["id"], "result": { "echo": req["method"] } });
                ws.send(Message::Text(reply.to_string().into())).unwrap();
            }
        });
        url
    }

    #[test]
    fn calls_round_trip_without_a_poll_tick() {
        let conn = CdpConn::connect(&echo_server(), |_| {}).unwrap();
        let started = std::time::Instant::now();
        for i in 0..20 {
            let method = format!("Test.m{i}");
            let result = conn.call(None, &method, json!({})).unwrap();
            assert_eq!(result["echo"], method);
        }
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn peer_close_fails_pending_calls_and_marks_dead() {
        let conn = CdpConn::connect(&echo_server(), |_| {}).unwrap();
        let err = conn.call(None, "Test.hangUp", json!({})).unwrap_err();
        assert!(matches!(err, BrowserError::Cdp(ref m) if m.contains("connection closed")));
        assert!(!conn.is_alive());
    }
}
