//! Slack Socket Mode: the pure protocol logic for real-time DM delivery.
//!
//! Socket Mode replaces the 60s poll with an event stream. An app-level token
//! (`xapp-…`) opens a connection via `apps.connections.open`, which returns a
//! short-lived `wss://` URL; the app connects and receives *envelopes*:
//!
//! - `hello` — the connection is live (resets reconnect backoff).
//! - `events_api` — an Events API payload (`message.im` plus the reaction
//!   events, which carry no channel type of their own); **must be
//!   acked** within a few seconds by echoing its `envelope_id`.
//! - `disconnect` — Slack is closing this socket (every few minutes, by design);
//!   reconnect with a *fresh* `apps.connections.open`.
//!
//! Everything here is pure and unit-tested; the WebSocket I/O lives in the app
//! shell (`crates-tauri/tt-app/src/slack_socket.rs`), keeping this crate Tauri-free.

use std::time::Duration;

/// Per-call HTTP cap for `apps.connections.open` (mirrors the DM client's cap).
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

/// A decoded envelope, narrowed to what the DM watcher acts on. Anything
/// unrecognized (or needing no ack) is [`Envelope::Ignore`].
#[derive(Debug, Clone, PartialEq)]
pub enum Envelope {
    /// Connection acknowledged — the socket is live.
    Hello,
    /// Slack is closing this connection; reconnect fresh.
    Disconnect { reason: String },
    /// Ack-required (`events_api`/`slash_commands`/`interactive`), carrying an
    /// event when it was one the watcher acts on.
    Event {
        envelope_id: String,
        event: Option<SlackEvent>,
    },
    /// Junk, or a type we neither ack nor act on.
    Ignore,
}

/// What the watcher acts on; everything else acks and is dropped.
#[derive(Debug, Clone, PartialEq)]
pub enum SlackEvent {
    /// Top-level or a thread reply — identical but for the reply's `thread_ts`.
    Message(MessageEvent),
    /// A reaction added *or* removed: both refresh the same way.
    Reaction(ReactionEvent),
}

/// Enough of a `message` event to decide whether it is the watched DM's.
#[derive(Debug, Clone, PartialEq)]
pub struct MessageEvent {
    /// A DM is a `D…` id.
    pub channel: String,
    /// `"im"` for a direct message.
    pub channel_type: String,
    pub user: String,
    /// `file_share` on a shared image, `thread_broadcast` on a reply also sent
    /// to the conversation; anything else is an edit or a delete.
    pub subtype: Option<String>,
    pub ts: String,
    /// The parent's ts when this is a reply, else empty.
    pub thread_ts: String,
}

/// A `reaction_added`/`reaction_removed` event. These carry no `channel_type`,
/// so the reacted-to item's channel is the only routing signal.
#[derive(Debug, Clone, PartialEq)]
pub struct ReactionEvent {
    pub user: String,
    pub item_channel: String,
}

#[derive(serde::Deserialize)]
struct RawEnvelope {
    #[serde(rename = "type")]
    kind: String,
    envelope_id: Option<String>,
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    payload: Option<RawPayload>,
}

#[derive(serde::Deserialize)]
struct RawPayload {
    #[serde(default)]
    event: Option<RawEvent>,
}

#[derive(serde::Deserialize)]
struct RawEvent {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    channel: Option<String>,
    #[serde(default)]
    channel_type: Option<String>,
    #[serde(default)]
    user: Option<String>,
    #[serde(default)]
    subtype: Option<String>,
    #[serde(default)]
    ts: Option<String>,
    #[serde(default)]
    thread_ts: Option<String>,
    #[serde(default)]
    item: Option<RawItem>,
}

#[derive(serde::Deserialize)]
struct RawItem {
    #[serde(default)]
    channel: Option<String>,
}

/// Decode a raw envelope frame. Malformed JSON and unknown/no-ack types map to
/// [`Envelope::Ignore`] so the socket loop can treat parsing as infallible.
pub fn parse_envelope(text: &str) -> Envelope {
    let Ok(raw) = serde_json::from_str::<RawEnvelope>(text) else {
        return Envelope::Ignore;
    };
    match raw.kind.as_str() {
        "hello" => Envelope::Hello,
        "disconnect" => Envelope::Disconnect { reason: raw.reason.unwrap_or_default() },
        // Every other typed envelope (`events_api`, `slash_commands`,
        // `interactive`) needs an ack keyed by its `envelope_id`.
        _ => match raw.envelope_id {
            Some(envelope_id) => {
                let event = raw.payload.and_then(|p| p.event).and_then(slack_event);
                Envelope::Event { envelope_id, event }
            }
            None => Envelope::Ignore,
        },
    }
}

fn slack_event(e: RawEvent) -> Option<SlackEvent> {
    match e.kind.as_str() {
        "message" => Some(SlackEvent::Message(MessageEvent {
            channel: e.channel.unwrap_or_default(),
            channel_type: e.channel_type.unwrap_or_default(),
            user: e.user.unwrap_or_default(),
            subtype: e.subtype,
            ts: e.ts.unwrap_or_default(),
            thread_ts: e.thread_ts.unwrap_or_default(),
        })),
        "reaction_added" | "reaction_removed" => Some(SlackEvent::Reaction(ReactionEvent {
            user: e.user.unwrap_or_default(),
            item_channel: e.item.and_then(|i| i.channel).unwrap_or_default(),
        })),
        _ => None,
    }
}

/// The ack frame for an `envelope_id` — Slack drops the connection if an
/// events envelope goes unacked, so the loop sends this before acting.
pub fn ack_json(envelope_id: &str) -> String {
    serde_json::json!({ "envelope_id": envelope_id }).to_string()
}

/// Whether an event should trigger a refresh. A resolved `watched_channel` is
/// matched exactly; otherwise the watched user is, which misses my own activity
/// — already known locally — but catches theirs.
pub fn is_watched_event(event: &SlackEvent, watched_channel: &str, watch_user_id: &str) -> bool {
    match event {
        SlackEvent::Message(msg) => is_watched_message(msg, watched_channel, watch_user_id),
        SlackEvent::Reaction(r) => {
            match_channel_or_user(&r.item_channel, &r.user, watched_channel, watch_user_id)
        }
    }
}

/// New messages count — top-level, thread reply and shared file alike.
fn is_watched_message(msg: &MessageEvent, watched_channel: &str, watch_user_id: &str) -> bool {
    if let Some(sub) = &msg.subtype
        && sub != "file_share"
        && sub != "thread_broadcast"
    {
        return false;
    }
    if msg.channel_type != "im" {
        return false;
    }
    match_channel_or_user(&msg.channel, &msg.user, watched_channel, watch_user_id)
}

fn match_channel_or_user(
    channel: &str,
    user: &str,
    watched_channel: &str,
    watch_user_id: &str,
) -> bool {
    if !watched_channel.is_empty() {
        return channel == watched_channel;
    }
    !watch_user_id.is_empty() && user == watch_user_id
}

/// The `wss://` URL from `apps.connections.open`, with `{ok:false}` as an error.
pub fn parse_connection_url(body: &serde_json::Value) -> Result<String, String> {
    if !body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        let err = body.get("error").and_then(|v| v.as_str()).unwrap_or("unknown error");
        return Err(format!("apps.connections.open failed: {err}"));
    }
    body.get("url")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| "apps.connections.open: no url in response".to_string())
}

/// Live HTTP; the URL parsing above is the tested seam.
pub fn open_socket_connection(app_token: &str) -> Result<String, String> {
    let response = crate::slack::agent()?
        .post("https://slack.com/api/apps.connections.open")
        .set("Authorization", &format!("Bearer {app_token}"))
        .timeout(HTTP_TIMEOUT)
        .send_form(&[])
        .map_err(|e| format!("apps.connections.open request failed: {e}"))?;
    let body: serde_json::Value = response
        .into_json()
        .map_err(|e| format!("apps.connections.open returned invalid JSON: {e}"))?;
    parse_connection_url(&body)
}

const BACKOFF_BASE_MS: u64 = 1_000;
const BACKOFF_CAP_MS: u64 = 30_000;
/// 2^5 · 1s = 32s already exceeds the 30s cap, so attempts past this add nothing.
const BACKOFF_MAX_SHIFT: u32 = 5;

/// Exponential from 1s, capped at 30s. Reset on a `hello`; advanced on each
/// failed connect, so a persistent outage stops hammering Slack.
#[derive(Debug, Default)]
pub struct Backoff {
    attempt: u32,
}

impl Backoff {
    pub fn new() -> Self {
        Self { attempt: 0 }
    }

    pub fn reset(&mut self) {
        self.attempt = 0;
    }

    pub fn next_delay(&mut self) -> Duration {
        let shift = self.attempt.min(BACKOFF_MAX_SHIFT);
        let ms = BACKOFF_BASE_MS.saturating_mul(1u64 << shift).min(BACKOFF_CAP_MS);
        self.attempt = self.attempt.saturating_add(1);
        Duration::from_millis(ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_hello_and_disconnect() {
        assert_eq!(parse_envelope(r#"{"type":"hello","num_connections":1}"#), Envelope::Hello);
        assert_eq!(
            parse_envelope(r#"{"type":"disconnect","reason":"warning"}"#),
            Envelope::Disconnect { reason: "warning".to_string() }
        );
        // Missing reason degrades to empty, still a disconnect.
        assert_eq!(
            parse_envelope(r#"{"type":"disconnect"}"#),
            Envelope::Disconnect { reason: String::new() }
        );
    }

    #[test]
    fn parse_events_api_message_event() {
        let frame = json!({
            "type": "events_api",
            "envelope_id": "env-123",
            "accepts_response_payload": false,
            "payload": {
                "event": {
                    "type": "message",
                    "channel": "D07ABC",
                    "channel_type": "im",
                    "user": "U_WIFE",
                    "text": "dinner at 7?",
                    "ts": "1720000100.000200"
                }
            }
        })
        .to_string();
        let Envelope::Event { envelope_id, event } = parse_envelope(&frame) else {
            panic!("expected an Event envelope");
        };
        assert_eq!(envelope_id, "env-123");
        let Some(SlackEvent::Message(msg)) = event else {
            panic!("expected a message event")
        };
        assert_eq!(msg.channel, "D07ABC");
        assert_eq!(msg.channel_type, "im");
        assert_eq!(msg.user, "U_WIFE");
        assert_eq!(msg.subtype, None);
        assert_eq!(msg.ts, "1720000100.000200");
        assert_eq!(msg.thread_ts, "", "a top-level message has no parent");
    }

    #[test]
    fn parse_thread_reply_carries_its_parent_ts() {
        let frame = json!({
            "type": "events_api",
            "envelope_id": "env-t",
            "payload": { "event": {
                "type": "message", "channel": "D07ABC", "channel_type": "im",
                "user": "U_WIFE", "ts": "1720000200.0", "thread_ts": "1720000100.000200"
            }}
        })
        .to_string();
        let Envelope::Event { event: Some(SlackEvent::Message(msg)), .. } = parse_envelope(&frame)
        else {
            panic!("expected a message event");
        };
        assert_eq!(msg.thread_ts, "1720000100.000200");
    }

    #[test]
    fn parse_reaction_events_read_the_item_channel() {
        for kind in ["reaction_added", "reaction_removed"] {
            let frame = json!({
                "type": "events_api",
                "envelope_id": "env-r",
                "payload": { "event": {
                    "type": kind, "user": "U_WIFE", "reaction": "thumbsup",
                    "item": { "type": "message", "channel": "D07ABC", "ts": "1720000100.0" }
                }}
            })
            .to_string();
            assert_eq!(
                parse_envelope(&frame),
                Envelope::Event {
                    envelope_id: "env-r".to_string(),
                    event: Some(SlackEvent::Reaction(ReactionEvent {
                        user: "U_WIFE".to_string(),
                        item_channel: "D07ABC".to_string(),
                    })),
                }
            );
        }
    }

    #[test]
    fn unhandled_event_types_still_ack() {
        let frame = json!({
            "type": "events_api",
            "envelope_id": "env-9",
            "payload": { "event": { "type": "channel_created", "user": "U_WIFE" } }
        })
        .to_string();
        assert_eq!(
            parse_envelope(&frame),
            Envelope::Event { envelope_id: "env-9".to_string(), event: None }
        );
    }

    #[test]
    fn slash_and_interactive_envelopes_ack_with_no_event() {
        for kind in ["slash_commands", "interactive"] {
            let frame = json!({ "type": kind, "envelope_id": "e1" }).to_string();
            assert_eq!(
                parse_envelope(&frame),
                Envelope::Event { envelope_id: "e1".to_string(), event: None }
            );
        }
    }

    #[test]
    fn malformed_or_ackless_frames_are_ignored() {
        assert_eq!(parse_envelope("not json"), Envelope::Ignore);
        // An unknown type with no envelope_id can't be acked, so ignore it.
        assert_eq!(parse_envelope(r#"{"type":"mystery"}"#), Envelope::Ignore);
    }

    #[test]
    fn ack_json_echoes_the_envelope_id() {
        assert_eq!(ack_json("abc-1"), r#"{"envelope_id":"abc-1"}"#);
    }

    fn msg(channel: &str, channel_type: &str, user: &str, subtype: Option<&str>) -> SlackEvent {
        SlackEvent::Message(MessageEvent {
            channel: channel.to_string(),
            channel_type: channel_type.to_string(),
            user: user.to_string(),
            subtype: subtype.map(str::to_string),
            ts: "1.0".to_string(),
            thread_ts: String::new(),
        })
    }

    fn reaction(item_channel: &str, user: &str) -> SlackEvent {
        SlackEvent::Reaction(ReactionEvent {
            user: user.to_string(),
            item_channel: item_channel.to_string(),
        })
    }

    #[test]
    fn watched_message_matches_the_resolved_channel() {
        assert!(is_watched_event(&msg("D1", "im", "U_WIFE", None), "D1", "U_WIFE"));
        // A different DM (someone else) must not trigger a refresh.
        assert!(!is_watched_event(&msg("D2", "im", "U_OTHER", None), "D1", "U_WIFE"));
    }

    #[test]
    fn watched_message_falls_back_to_sender_without_a_channel() {
        // No resolved channel: match on the watched sender instead.
        assert!(is_watched_event(&msg("D9", "im", "U_WIFE", None), "", "U_WIFE"));
        assert!(!is_watched_event(&msg("D9", "im", "U_ME", None), "", "U_WIFE"));
    }

    #[test]
    fn watched_message_ignores_non_im_and_edits_but_keeps_shares_and_broadcasts() {
        assert!(!is_watched_event(&msg("C1", "channel", "U_WIFE", None), "", "U_WIFE"));
        assert!(!is_watched_event(&msg("D1", "im", "U_WIFE", Some("message_changed")), "D1", ""));
        // A shared photo and a thread reply echoed to the DM are real messages.
        assert!(is_watched_event(&msg("D1", "im", "U_WIFE", Some("file_share")), "D1", ""));
        assert!(is_watched_event(&msg("D1", "im", "U_WIFE", Some("thread_broadcast")), "D1", ""));
    }

    #[test]
    fn watched_reaction_routes_on_the_item_channel_then_the_reactor() {
        assert!(is_watched_event(&reaction("D1", "U_WIFE"), "D1", "U_WIFE"));
        // Their reaction in someone else's DM is not ours, channel-matched.
        assert!(!is_watched_event(&reaction("D2", "U_WIFE"), "D1", "U_WIFE"));
        // Unresolved channel: the reactor decides.
        assert!(is_watched_event(&reaction("D9", "U_WIFE"), "", "U_WIFE"));
        assert!(!is_watched_event(&reaction("D9", "U_ME"), "", "U_WIFE"));
    }

    #[test]
    fn parse_connection_url_reads_the_wss_url() {
        let body = json!({ "ok": true, "url": "wss://wss-primary.slack.com/link/?ticket=x" });
        assert_eq!(
            parse_connection_url(&body).unwrap(),
            "wss://wss-primary.slack.com/link/?ticket=x"
        );
    }

    #[test]
    fn parse_connection_url_surfaces_slack_errors() {
        let err = parse_connection_url(&json!({ "ok": false, "error": "invalid_auth" }));
        assert_eq!(err.unwrap_err(), "apps.connections.open failed: invalid_auth");
        assert!(parse_connection_url(&json!({ "ok": true })).is_err());
    }

    #[test]
    fn backoff_is_exponential_and_capped() {
        let mut b = Backoff::new();
        assert_eq!(b.next_delay(), Duration::from_secs(1));
        assert_eq!(b.next_delay(), Duration::from_secs(2));
        assert_eq!(b.next_delay(), Duration::from_secs(4));
        assert_eq!(b.next_delay(), Duration::from_secs(8));
        assert_eq!(b.next_delay(), Duration::from_secs(16));
        assert_eq!(b.next_delay(), Duration::from_secs(30), "capped at 30s");
        assert_eq!(b.next_delay(), Duration::from_secs(30), "stays capped");
        // A healthy hello resets to the base delay.
        b.reset();
        assert_eq!(b.next_delay(), Duration::from_secs(1));
    }
}
