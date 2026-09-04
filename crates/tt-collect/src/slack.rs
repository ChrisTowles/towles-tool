//! Slack DM watcher + chat bridge: one DM conversation via the Slack Web API.
//!
//! The *watcher* ([`fetch_dm`]) polls with a user OAuth token (`xoxp-…`): the
//! newest real message decides everything — sent by the watched user ⇒
//! *unanswered*, sent by anyone else ⇒ answered. The *chat bridge* serves the
//! app's DM panel on demand. HTTP plumbing is isolated in [`SlackHttp`];
//! response interpretation is pure functions over `serde_json::Value`, so it
//! unit-tests with inline fixtures.
//!
//! Slack keeps thread replies *out* of `conversations.history` — a parent only
//! carries `reply_count`/`latest_reply`. So the newest thing in the DM may be a
//! reply the watcher would otherwise never see; [`fetch_dm`] follows the
//! freshest parent into `conversations.replies` when that is the case.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tt_store::DmInput;

/// Per-call HTTP cap. Slack answers these in well under a second; without a
/// cap a dead network wedges the scheduler's blocking worker.
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

/// The shared HTTP agent, built once with native-tls rather than ureq's default
/// rustls+webpki-roots. TLS-inspecting proxies (Zscaler and similar) inject
/// their root CA into the OS trust store, which only native-tls consults.
pub(crate) fn agent() -> Result<&'static ureq::Agent, String> {
    static AGENT: OnceLock<Result<ureq::Agent, String>> = OnceLock::new();
    AGENT
        .get_or_init(|| {
            let connector = native_tls::TlsConnector::new()
                .map_err(|e| format!("failed to initialize native TLS: {e}"))?;
            Ok(ureq::AgentBuilder::new().tls_connector(Arc::new(connector)).build())
        })
        .as_ref()
        .map_err(String::clone)
}

/// Slack settings the collector needs, decoupled from `tt-config` — callers map
/// their settings into this, as `CalendarProvider` is passed in.
#[derive(Debug, Clone, PartialEq)]
pub struct SlackDmConfig {
    /// User OAuth token (`xoxp-…`).
    pub token: String,
    pub watch_user_id: String,
    /// Falls back to the member id when empty.
    pub watch_name: String,
}

struct SlackHttp<'a> {
    token: &'a str,
}

impl SlackHttp<'_> {
    fn call(&self, method: &str, params: &[(&str, &str)]) -> Result<serde_json::Value, String> {
        let mut request = agent()?
            .post(&format!("https://slack.com/api/{method}"))
            .set("Authorization", &format!("Bearer {}", self.token))
            .timeout(HTTP_TIMEOUT);
        for (k, v) in params {
            request = request.query(k, v);
        }
        let response = request.call().map_err(|e| format!("slack {method} request failed: {e}"))?;
        Self::parse_response(response, method)
    }

    /// For calls carrying user-written text: a query string would cap length and
    /// mangle newlines.
    fn call_form(&self, method: &str, form: &[(&str, &str)]) -> Result<serde_json::Value, String> {
        let response = agent()?
            .post(&format!("https://slack.com/api/{method}"))
            .set("Authorization", &format!("Bearer {}", self.token))
            .timeout(HTTP_TIMEOUT)
            .send_form(form)
            .map_err(|e| format!("slack {method} request failed: {e}"))?;
        Self::parse_response(response, method)
    }

    fn parse_response(response: ureq::Response, method: &str) -> Result<serde_json::Value, String> {
        let body: serde_json::Value = response
            .into_json()
            .map_err(|e| format!("slack {method} returned invalid JSON: {e}"))?;
        check_ok(&body, method)?;
        Ok(body)
    }
}

/// One message, as the app's chat panel renders it. Serialized camelCase because
/// it crosses the Tauri IPC boundary verbatim.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DmMessage {
    /// Slack's `"seconds.micros"` — the id `conversations.replies` and
    /// `reactions.add` are keyed by. `ts` is the same instant in epoch ms.
    pub ts_raw: String,
    pub text: String,
    pub ts: i64,
    /// Sent by me — anyone but the watched user.
    pub from_me: bool,
    pub files: Vec<DmFile>,
    pub reactions: Vec<DmReaction>,
    /// Empty when standalone. On a parent it equals `ts_raw`; on a reply it
    /// points back at the parent.
    pub thread_ts: String,
    pub reply_count: u32,
    pub latest_reply_ts: i64,
}

/// One emoji reaction, aggregated across its reactors. A DM has exactly two
/// members, so anyone who isn't the watched user is me.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DmReaction {
    /// Shortcode without colons (`thumbsup`, `heart`, `+1`).
    pub name: String,
    pub count: u32,
    /// I am one of the reactors, so the chip toggles off rather than on.
    pub mine: bool,
}

/// One attached file. The private URLs need the token's bearer header, so the
/// webview can't load them — the app fetches bytes through [`fetch_file`] and
/// renders images as a `data:` URI.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DmFile {
    pub id: String,
    /// `name`, falling back to `title`.
    pub name: String,
    pub mimetype: String,
    pub url_private: String,
    /// Empty when Slack made no thumbnail (non-images).
    pub thumb_url: String,
    /// Web permalink, for "open in browser" on a non-image chip.
    pub permalink: String,
    /// The panel renders these inline.
    pub is_image: bool,
}

/// The newest `limit` top-level messages, oldest first — no store involved.
/// Thread replies are excluded; the panel pulls those via [`fetch_thread`].
pub fn fetch_dm_history(config: &SlackDmConfig, limit: u32) -> Result<Vec<DmMessage>, String> {
    let http = SlackHttp { token: &config.token };
    let channel = open_channel(&http, config)?;
    let history = http.call(
        "conversations.history",
        &[("channel", channel.as_str()), ("limit", &limit.to_string())],
    )?;
    Ok(parse_history(&history, config))
}

/// One thread's parent followed by every reply, oldest first.
pub fn fetch_thread(config: &SlackDmConfig, thread_ts: &str) -> Result<Vec<DmMessage>, String> {
    let http = SlackHttp { token: &config.token };
    let channel = open_channel(&http, config)?;
    let replies = http.call(
        "conversations.replies",
        &[
            ("channel", channel.as_str()),
            ("ts", thread_ts),
            ("limit", &THREAD_LIMIT.to_string()),
        ],
    )?;
    // `conversations.replies` is oldest-first already, so `parse_history`'s
    // reverse (right for `conversations.history`) has to be undone.
    let mut out = parse_history(&replies, config);
    out.reverse();
    Ok(out)
}

/// The panel is a glance surface, not an archive.
const THREAD_LIMIT: u32 = 200;

/// The watched user's DM channel id. `conversations.open` is idempotent — it
/// returns the existing channel rather than creating a second one.
fn open_channel(http: &SlackHttp<'_>, config: &SlackDmConfig) -> Result<String, String> {
    let open = http.call("conversations.open", &[("users", config.watch_user_id.as_str())])?;
    parse_open_channel(&open)
}

/// The socket loop's copy of [`open_channel`], for matching incoming events to
/// the watched conversation exactly.
pub fn dm_channel_id(config: &SlackDmConfig) -> Result<String, String> {
    open_channel(&SlackHttp { token: &config.token }, config)
}

/// A workspace member, for Settings' "pick the person to watch" dropdown.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackUser {
    pub id: String,
    pub name: String,
}

/// Enough for a personal workspace many times over, without a runaway on a
/// huge corporate one.
const MAX_USER_PAGES: usize = 20;

/// The workspace's human members (`users:read`), sorted by name. Bots, deleted
/// accounts and Slackbot are dropped.
pub fn list_users(token: &str) -> Result<Vec<SlackUser>, String> {
    let http = SlackHttp { token };
    let mut users: Vec<SlackUser> = Vec::new();
    let mut cursor = String::new();
    for _ in 0..MAX_USER_PAGES {
        let mut params = vec![("limit", "200")];
        if !cursor.is_empty() {
            params.push(("cursor", cursor.as_str()));
        }
        let body = http.call("users.list", &params)?;
        users.extend(parse_users(&body));
        cursor = body
            .pointer("/response_metadata/next_cursor")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if cursor.is_empty() {
            break;
        }
    }
    users.sort_by_key(|u| u.name.to_lowercase());
    Ok(users)
}

pub(crate) fn parse_users(body: &serde_json::Value) -> Vec<SlackUser> {
    let Some(members) = body.get("members").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    members
        .iter()
        .filter(|m| !m.get("deleted").and_then(|v| v.as_bool()).unwrap_or(false))
        .filter(|m| !m.get("is_bot").and_then(|v| v.as_bool()).unwrap_or(false))
        .filter_map(|m| {
            let id = m.get("id").and_then(|v| v.as_str())?;
            if id == "USLACKBOT" {
                return None;
            }
            Some(SlackUser { id: id.to_string(), name: user_display_name(m, id) })
        })
        .collect()
}

/// Profile display name, then real name, then the handle, then the id.
fn user_display_name(member: &serde_json::Value, id: &str) -> String {
    fn trimmed(value: Option<&str>) -> Option<&str> {
        value.map(str::trim).filter(|s| !s.is_empty())
    }
    trimmed(member.pointer("/profile/display_name").and_then(|v| v.as_str()))
        .or_else(|| trimmed(member.pointer("/profile/real_name").and_then(|v| v.as_str())))
        .or_else(|| trimmed(member.get("name").and_then(|v| v.as_str())))
        .unwrap_or(id)
        .to_string()
}

/// Post as the token's user (`chat:write`). A non-empty `thread_ts` replies
/// inside that thread instead of starting a new top-level message.
pub fn send_dm(config: &SlackDmConfig, text: &str, thread_ts: &str) -> Result<(), String> {
    let http = SlackHttp { token: &config.token };
    let channel = open_channel(&http, config)?;
    let mut form = vec![("channel", channel.as_str()), ("text", text)];
    if !thread_ts.is_empty() {
        form.push(("thread_ts", thread_ts));
    }
    http.call_form("chat.postMessage", &form)?;
    Ok(())
}

/// Toggle one of my reactions (`reactions:write`), `name` a bare shortcode.
///
/// A redundant toggle is `already_reacted`/`no_reaction`, which both mean the
/// reaction already reads as asked — success, not an error on a right state.
pub fn set_reaction(config: &SlackDmConfig, ts: &str, name: &str, add: bool) -> Result<(), String> {
    let http = SlackHttp { token: &config.token };
    let channel = open_channel(&http, config)?;
    let method = if add { "reactions.add" } else { "reactions.remove" };
    let name = name.trim().trim_matches(':');
    match http.call_form(
        method,
        &[
            ("channel", channel.as_str()),
            ("timestamp", ts),
            ("name", name),
        ],
    ) {
        Ok(_) => Ok(()),
        Err(e) if is_redundant_reaction(&e) => Ok(()),
        Err(e) => Err(e),
    }
}

fn is_redundant_reaction(error: &str) -> bool {
    error.contains("already_reacted") || error.contains("no_reaction")
}

/// Keeps a surprise large upload from ballooning the base64 IPC payload.
const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;

pub struct SlackFile {
    pub mimetype: String,
    pub bytes: Vec<u8>,
}

/// A private file's bytes, bearer-authenticated — the webview can't, since those
/// URLs 302 to a sign-in page. Only `*.slack.com` is honored: the token must
/// never ride along to another host. A missing `files:read` scope gets its own
/// error so the caller can render a placeholder, not a failed panel.
pub fn fetch_file(token: &str, url: &str) -> Result<SlackFile, String> {
    use std::io::Read;

    if !is_slack_file_url(url) {
        return Err(format!("refusing to fetch non-Slack file URL: {url}"));
    }
    let response = agent()?
        .get(url)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(HTTP_TIMEOUT)
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(401 | 403, _) => file_unauthorized(),
            other => format!("slack file request failed: {other}"),
        })?;
    let mimetype = response.content_type().to_string();
    if mimetype.starts_with("text/html") {
        // A token without `files:read` gets Slack's sign-in HTML at HTTP 200
        // instead of the bytes; treat that as the scope error, not an image.
        return Err(file_unauthorized());
    }
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_FILE_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("slack file read failed: {e}"))?;
    Ok(SlackFile { mimetype, bytes })
}

/// Carries the stable `files:read` marker the frontend matches on.
fn file_unauthorized() -> String {
    "slack file unauthorized (files:read scope missing)".to_string()
}

/// The guard keeping the bearer token off any other origin.
pub(crate) fn is_slack_file_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    // Strip any userinfo/port so only the hostname is matched.
    let host = host.rsplit('@').next().unwrap_or(host);
    let host = host.split(':').next().unwrap_or(host);
    host == "slack.com" || host.ends_with(".slack.com")
}

/// A `conversations.history` (or `.replies`) response as oldest-first messages.
pub(crate) fn parse_history(history: &serde_json::Value, config: &SlackDmConfig) -> Vec<DmMessage> {
    let Some(messages) = history.get("messages").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut out: Vec<DmMessage> = messages
        .iter()
        .filter(|m| is_renderable(m))
        .filter_map(|m| parse_message(m, config))
        .collect();
    // Slack returns history newest-first; the chat view reads top-down in time.
    out.reverse();
    out
}

fn parse_message(m: &serde_json::Value, config: &SlackDmConfig) -> Option<DmMessage> {
    let sender = m.get("user").and_then(|v| v.as_str())?;
    Some(DmMessage {
        ts_raw: str_at(m, "ts"),
        text: str_at(m, "text"),
        ts: slack_ts_ms(str_at(m, "ts").as_str()),
        from_me: sender != config.watch_user_id,
        files: parse_files(m),
        reactions: parse_reactions(m, config),
        thread_ts: str_at(m, "thread_ts"),
        reply_count: m.get("reply_count").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        latest_reply_ts: slack_ts_ms(str_at(m, "latest_reply").as_str()),
    })
}

/// A real message: a sender, and a subtype of none, `file_share` or
/// `thread_broadcast`. Edits, deletes and joins are noise.
fn is_renderable(m: &serde_json::Value) -> bool {
    if m.get("user").and_then(|v| v.as_str()).is_none() {
        return false;
    }
    match m.get("subtype").and_then(|v| v.as_str()) {
        None | Some("file_share") | Some("thread_broadcast") => true,
        Some(_) => false,
    }
}

fn parse_reactions(m: &serde_json::Value, config: &SlackDmConfig) -> Vec<DmReaction> {
    let Some(reactions) = m.get("reactions").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    reactions
        .iter()
        .filter_map(|r| {
            let name = r.get("name").and_then(|v| v.as_str())?;
            let users: Vec<&str> = r
                .get("users")
                .and_then(|v| v.as_array())
                .map_or_else(Vec::new, |u| u.iter().filter_map(|v| v.as_str()).collect());
            // `count` is authoritative; `users` may be elided on large threads,
            // and a reaction with neither is not worth a chip.
            let count =
                r.get("count").and_then(|v| v.as_u64()).unwrap_or(users.len() as u64) as u32;
            if count == 0 {
                return None;
            }
            Some(DmReaction {
                name: name.to_string(),
                count,
                mine: users.iter().any(|u| *u != config.watch_user_id),
            })
        })
        .collect()
}

fn parse_files(m: &serde_json::Value) -> Vec<DmFile> {
    let Some(files) = m.get("files").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    files.iter().filter_map(parse_file).collect()
}

/// `None` for a tombstone or an entry with no id.
fn parse_file(f: &serde_json::Value) -> Option<DmFile> {
    if f.get("mode").and_then(|v| v.as_str()) == Some("tombstone") {
        return None;
    }
    let id = f.get("id").and_then(|v| v.as_str())?.to_string();
    let name = f
        .get("name")
        .and_then(|v| v.as_str())
        .or_else(|| f.get("title").and_then(|v| v.as_str()))
        .unwrap_or("file")
        .to_string();
    let mimetype = str_at(f, "mimetype");
    let is_image = mimetype.starts_with("image/");
    Some(DmFile {
        id,
        name,
        mimetype,
        url_private: str_at(f, "url_private"),
        thumb_url: pick_thumb(f),
        permalink: str_at(f, "permalink"),
        is_image,
    })
}

/// A mid-size thumbnail, falling back through what Slack made. Empty for a
/// non-image.
fn pick_thumb(f: &serde_json::Value) -> String {
    for key in [
        "thumb_360",
        "thumb_480",
        "thumb_720",
        "thumb_160",
        "thumb_80",
    ] {
        if let Some(url) = f.get(key).and_then(|v| v.as_str()) {
            return url.to_string();
        }
    }
    String::new()
}

/// The watched DM's latest state; `Ok(None)` when it holds no visible message.
///
/// The fourth call fires only when a thread holds something newer than every
/// top-level message. History reports a parent's `latest_reply` but never the
/// reply itself, so unfollowed, a threaded ask reads as *answered*.
pub(crate) fn fetch_dm(config: &SlackDmConfig) -> Result<Option<DmInput>, String> {
    let http = SlackHttp { token: &config.token };

    let auth = http.call("auth.test", &[])?;
    let team_id = str_at(&auth, "team_id");

    let channel = open_channel(&http, config)?;

    let history =
        http.call("conversations.history", &[("channel", channel.as_str()), ("limit", "10")])?;
    let top = latest_message(&history, config, &channel, &team_id);
    let Some(thread_ts) = fresher_thread(&history, top.as_ref().map_or(0, |d| d.ts)) else {
        return Ok(top);
    };
    let replies = http.call(
        "conversations.replies",
        &[
            ("channel", channel.as_str()),
            ("ts", thread_ts.as_str()),
            ("limit", "50"),
        ],
    )?;
    Ok(latest_reply(&replies, config, &channel, &team_id).or(top))
}

/// The thread whose newest reply lands after `floor_ms`. Ties go to the
/// top-level message, already in hand.
pub(crate) fn fresher_thread(history: &serde_json::Value, floor_ms: i64) -> Option<String> {
    let messages = history.get("messages").and_then(|v| v.as_array())?;
    messages
        .iter()
        .filter(|m| m.get("reply_count").and_then(|v| v.as_u64()).unwrap_or(0) > 0)
        .map(|m| (slack_ts_ms(str_at(m, "latest_reply").as_str()), str_at(m, "thread_ts")))
        .filter(|(reply_ms, thread_ts)| *reply_ms > floor_ms && !thread_ts.is_empty())
        .max_by_key(|(reply_ms, _)| *reply_ms)
        .map(|(_, thread_ts)| thread_ts)
}

/// The newest entry of a `conversations.replies` response, by max `ts` rather
/// than position: only `conversations.history` promises an order.
pub(crate) fn latest_reply(
    replies: &serde_json::Value,
    config: &SlackDmConfig,
    channel: &str,
    team_id: &str,
) -> Option<DmInput> {
    let messages = replies.get("messages").and_then(|v| v.as_array())?;
    let newest = messages
        .iter()
        .filter(|m| is_renderable(m))
        .max_by_key(|m| slack_ts_ms(str_at(m, "ts").as_str()))?;
    Some(dm_input(newest, config, channel, team_id))
}

/// Slack wraps errors in `{"ok": false, "error": "..."}` with HTTP 200.
fn check_ok(body: &serde_json::Value, method: &str) -> Result<(), String> {
    if body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Ok(());
    }
    let error = body.get("error").and_then(|v| v.as_str()).unwrap_or("unknown error");
    Err(format!("slack {method} failed: {error}"))
}

pub(crate) fn parse_open_channel(body: &serde_json::Value) -> Result<String, String> {
    body.pointer("/channel/id")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| "slack conversations.open: no channel id in response".to_string())
}

/// The DM's latest state. History is newest-first, so the first entry with a
/// sender and no subtype is the newest real message.
pub(crate) fn latest_message(
    history: &serde_json::Value,
    config: &SlackDmConfig,
    channel: &str,
    team_id: &str,
) -> Option<DmInput> {
    let messages = history.get("messages").and_then(|v| v.as_array())?;
    let msg = messages
        .iter()
        .find(|m| m.get("subtype").is_none() && m.get("user").and_then(|v| v.as_str()).is_some())?;
    Some(dm_input(msg, config, channel, team_id))
}

fn dm_input(
    msg: &serde_json::Value,
    config: &SlackDmConfig,
    channel: &str,
    team_id: &str,
) -> DmInput {
    let sender = msg.get("user").and_then(|v| v.as_str()).unwrap_or_default();
    let from_name = if config.watch_name.trim().is_empty() {
        config.watch_user_id.clone()
    } else {
        config.watch_name.clone()
    };
    let url = if team_id.is_empty() {
        None
    } else {
        Some(format!("slack://channel?team={team_id}&id={channel}"))
    };

    DmInput {
        channel: channel.to_string(),
        from_name,
        text: str_at(msg, "text"),
        ts: slack_ts_ms(str_at(msg, "ts").as_str()),
        from_me: sender != config.watch_user_id,
        url,
    }
}

/// `"seconds.micros"` → epoch ms; 0 on garbage, as the other collectors do.
pub(crate) fn slack_ts_ms(ts: &str) -> i64 {
    ts.parse::<f64>().map(|s| (s * 1000.0) as i64).unwrap_or(0)
}

fn str_at(value: &serde_json::Value, key: &str) -> String {
    value.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config() -> SlackDmConfig {
        SlackDmConfig {
            token: "xoxp-test".to_string(),
            watch_user_id: "U_WIFE".to_string(),
            watch_name: "Sarah".to_string(),
        }
    }

    #[test]
    fn check_ok_accepts_ok_and_surfaces_slack_errors() {
        assert!(check_ok(&json!({"ok": true}), "auth.test").is_ok());
        let err = check_ok(&json!({"ok": false, "error": "invalid_auth"}), "auth.test");
        assert_eq!(err.unwrap_err(), "slack auth.test failed: invalid_auth");
        assert!(check_ok(&json!({}), "auth.test").is_err());
    }

    #[test]
    fn parse_open_channel_reads_the_dm_id() {
        let body = json!({"ok": true, "channel": {"id": "D07ABC123"}});
        assert_eq!(parse_open_channel(&body).unwrap(), "D07ABC123");
        assert!(parse_open_channel(&json!({"ok": true})).is_err());
    }

    #[test]
    fn slack_ts_ms_converts_seconds_to_millis() {
        assert_eq!(slack_ts_ms("1720000000.123456"), 1720000000123);
        assert_eq!(slack_ts_ms("not-a-ts"), 0);
    }

    #[test]
    fn latest_message_from_watched_user_is_unanswered() {
        let history = json!({"ok": true, "messages": [
            {"user": "U_WIFE", "text": "can you grab the kids at 4?", "ts": "1720000100.000200"},
            {"user": "U_ME", "text": "heading out now", "ts": "1720000000.000100"}
        ]});
        let dm = latest_message(&history, &config(), "D1", "T1").unwrap();
        assert!(!dm.from_me);
        assert_eq!(dm.from_name, "Sarah");
        assert_eq!(dm.text, "can you grab the kids at 4?");
        assert_eq!(dm.ts, 1720000100000);
        assert_eq!(dm.url.as_deref(), Some("slack://channel?team=T1&id=D1"));
    }

    #[test]
    fn latest_message_from_me_is_answered() {
        let history = json!({"ok": true, "messages": [
            {"user": "U_ME", "text": "on it", "ts": "1720000200.0"},
            {"user": "U_WIFE", "text": "pickup at 4?", "ts": "1720000100.0"}
        ]});
        let dm = latest_message(&history, &config(), "D1", "T1").unwrap();
        assert!(dm.from_me);
    }

    #[test]
    fn latest_message_skips_subtypes_and_userless_entries() {
        let history = json!({"ok": true, "messages": [
            {"subtype": "message_changed", "user": "U_WIFE", "text": "edited", "ts": "1720000300.0"},
            {"text": "no sender", "ts": "1720000250.0"},
            {"user": "U_WIFE", "text": "real one", "ts": "1720000200.0"}
        ]});
        let dm = latest_message(&history, &config(), "D1", "T1").unwrap();
        assert_eq!(dm.text, "real one");
    }

    #[test]
    fn latest_message_handles_empty_history_and_missing_team() {
        assert!(
            latest_message(&json!({"ok": true, "messages": []}), &config(), "D1", "T1").is_none()
        );
        let history = json!({"ok": true, "messages": [
            {"user": "U_WIFE", "text": "hi", "ts": "1.0"}
        ]});
        let dm = latest_message(&history, &config(), "D1", "").unwrap();
        assert_eq!(dm.url, None);
    }

    #[test]
    fn parse_history_is_chronological_and_skips_noise() {
        let history = json!({"ok": true, "messages": [
            {"user": "U_WIFE", "text": "newest", "ts": "1720000300.0"},
            {"subtype": "message_changed", "user": "U_WIFE", "text": "edited", "ts": "1720000250.0"},
            {"text": "no sender", "ts": "1720000225.0"},
            {"user": "U_ME", "text": "mine", "ts": "1720000200.0"},
            {"user": "U_WIFE", "text": "oldest", "ts": "1720000100.0"}
        ]});
        let msgs = parse_history(&history, &config());
        let texts: Vec<&str> = msgs.iter().map(|m| m.text.as_str()).collect();
        assert_eq!(texts, ["oldest", "mine", "newest"], "oldest first, noise dropped");
        assert!(!msgs[0].from_me);
        assert!(msgs[1].from_me);
        assert_eq!(msgs[2].ts, 1720000300000);
    }

    #[test]
    fn parse_history_of_empty_or_malformed_response_is_empty() {
        assert!(parse_history(&json!({"ok": true, "messages": []}), &config()).is_empty());
        assert!(parse_history(&json!({"ok": true}), &config()).is_empty());
    }

    #[test]
    fn parse_history_reads_files_and_keeps_file_shares() {
        let history = json!({"ok": true, "messages": [
            {
                "subtype": "file_share",
                "user": "U_WIFE",
                "text": "look at this",
                "ts": "1720000300.0",
                "files": [
                    {
                        "id": "F123",
                        "name": "beach.jpg",
                        "mimetype": "image/jpeg",
                        "url_private": "https://files.slack.com/files-pri/T1-F123/beach.jpg",
                        "thumb_360": "https://files.slack.com/files-tmb/T1-F123/beach_360.jpg",
                        "permalink": "https://team.slack.com/files/U_WIFE/F123/beach.jpg"
                    }
                ]
            },
            {"user": "U_ME", "text": "nice", "ts": "1720000200.0"}
        ]});
        let msgs = parse_history(&history, &config());
        assert_eq!(msgs.len(), 2, "the file_share message is kept, not filtered");
        // Oldest-first: the plain reply (ts 200) precedes the newer share (ts 300).
        assert!(msgs[0].files.is_empty(), "the plain text message carries no files");
        let shared = &msgs[1];
        assert_eq!(shared.text, "look at this");
        assert_eq!(shared.files.len(), 1);
        let file = &shared.files[0];
        assert_eq!(file.id, "F123");
        assert_eq!(file.name, "beach.jpg");
        assert_eq!(file.mimetype, "image/jpeg");
        assert!(file.is_image);
        assert_eq!(file.url_private, "https://files.slack.com/files-pri/T1-F123/beach.jpg");
        assert_eq!(file.thumb_url, "https://files.slack.com/files-tmb/T1-F123/beach_360.jpg");
        assert_eq!(file.permalink, "https://team.slack.com/files/U_WIFE/F123/beach.jpg");
    }

    #[test]
    fn parse_history_handles_non_image_files_and_tombstones() {
        let history = json!({"ok": true, "messages": [
            {
                "subtype": "file_share",
                "user": "U_WIFE",
                "text": "",
                "ts": "1720000300.0",
                "files": [
                    {"id": "F1", "title": "budget.pdf", "mimetype": "application/pdf",
                     "url_private": "https://files.slack.com/files-pri/T1-F1/budget.pdf",
                     "permalink": "https://team.slack.com/files/U_WIFE/F1/budget.pdf"},
                    {"id": "F2", "mode": "tombstone"}
                ]
            }
        ]});
        let msgs = parse_history(&history, &config());
        assert_eq!(msgs.len(), 1);
        let files = &msgs[0].files;
        assert_eq!(files.len(), 1, "the tombstoned file is dropped");
        assert_eq!(files[0].name, "budget.pdf", "falls back to title when name is absent");
        assert!(!files[0].is_image);
        assert_eq!(files[0].thumb_url, "", "no thumbnail for a non-image");
    }

    #[test]
    fn parse_users_drops_bots_deleted_and_slackbot_and_picks_best_name() {
        let body = json!({"ok": true, "members": [
            {"id": "U1", "name": "danielle", "profile": {"display_name": "Danielle", "real_name": "Danielle T"}},
            {"id": "U2", "name": "bob", "profile": {"display_name": "", "real_name": "Bob Real"}},
            {"id": "U3", "name": "carol", "profile": {}},
            {"id": "UBOT", "name": "robo", "is_bot": true},
            {"id": "UDEL", "name": "gone", "deleted": true},
            {"id": "USLACKBOT", "name": "slackbot"}
        ]});
        let users = parse_users(&body);
        assert_eq!(
            users,
            vec![
                SlackUser { id: "U1".into(), name: "Danielle".into() },
                SlackUser { id: "U2".into(), name: "Bob Real".into() }, // display empty → real name
                SlackUser { id: "U3".into(), name: "carol".into() },    // no profile → handle
            ]
        );
    }

    #[test]
    fn parse_users_of_empty_or_malformed_is_empty() {
        assert!(parse_users(&json!({"ok": true, "members": []})).is_empty());
        assert!(parse_users(&json!({"ok": true})).is_empty());
    }

    #[test]
    fn is_slack_file_url_only_accepts_slack_https_hosts() {
        assert!(is_slack_file_url("https://files.slack.com/files-pri/T1-F1/x.png"));
        assert!(is_slack_file_url("https://slack.com/api/files.info"));
        assert!(is_slack_file_url("https://files-edge.slack.com/x"));
        // Wrong scheme, wrong host, or a look-alike domain must be refused so
        // the bearer token never leaks.
        assert!(!is_slack_file_url("http://files.slack.com/x"));
        assert!(!is_slack_file_url("https://evil.com/x"));
        assert!(!is_slack_file_url("https://files.slack.com.evil.com/x"));
        assert!(!is_slack_file_url("https://notslack.com/x"));
    }

    #[test]
    fn parse_history_reads_reactions_and_marks_mine() {
        let history = json!({"ok": true, "messages": [
            {"user": "U_WIFE", "text": "dinner?", "ts": "1720000100.0", "reactions": [
                {"name": "thumbsup", "count": 2, "users": ["U_WIFE", "U_ME"]},
                {"name": "heart", "count": 1, "users": ["U_WIFE"]},
                {"name": "ghost", "count": 0, "users": []}
            ]}
        ]});
        let msgs = parse_history(&history, &config());
        assert_eq!(
            msgs[0].reactions,
            vec![
                DmReaction { name: "thumbsup".into(), count: 2, mine: true },
                DmReaction { name: "heart".into(), count: 1, mine: false },
            ],
            "a reactor who isn't the watched user is me; a zero-count chip is dropped"
        );
    }

    #[test]
    fn parse_history_reads_thread_parents_and_keeps_broadcasts() {
        let history = json!({"ok": true, "messages": [
            {"subtype": "thread_broadcast", "user": "U_WIFE", "text": "also sharing",
             "ts": "1720000400.0", "thread_ts": "1720000100.0"},
            {"user": "U_WIFE", "text": "the plan", "ts": "1720000100.0",
             "thread_ts": "1720000100.0", "reply_count": 3, "latest_reply": "1720000400.0"},
            {"user": "U_ME", "text": "unthreaded", "ts": "1720000050.0"}
        ]});
        let msgs = parse_history(&history, &config());
        assert_eq!(msgs.len(), 3, "the thread_broadcast is kept");
        assert_eq!(msgs[0].reply_count, 0, "a plain message parents nothing");
        assert_eq!(msgs[0].thread_ts, "");
        let parent = &msgs[1];
        assert_eq!(parent.ts_raw, "1720000100.0");
        assert_eq!(parent.thread_ts, "1720000100.0", "a parent points at itself");
        assert_eq!(parent.reply_count, 3);
        assert_eq!(parent.latest_reply_ts, 1720000400000);
        assert_eq!(msgs[2].thread_ts, "1720000100.0", "the broadcast points back at its parent");
    }

    #[test]
    fn fresher_thread_finds_a_reply_newer_than_the_top_level() {
        let history = json!({"ok": true, "messages": [
            {"user": "U_ME", "text": "newest top-level", "ts": "1720000300.0"},
            {"user": "U_WIFE", "text": "old parent", "ts": "1720000100.0",
             "thread_ts": "1720000100.0", "reply_count": 1, "latest_reply": "1720000500.0"},
            {"user": "U_WIFE", "text": "stale parent", "ts": "1720000090.0",
             "thread_ts": "1720000090.0", "reply_count": 1, "latest_reply": "1720000200.0"}
        ]});
        assert_eq!(fresher_thread(&history, 1720000300000).as_deref(), Some("1720000100.0"));
        // Nothing beats a top-level message newer than every reply.
        assert_eq!(fresher_thread(&history, 1720000600000), None);
        // A parent with no replies is never followed.
        let flat = json!({"ok": true, "messages": [{"user": "U_WIFE", "ts": "1720000100.0"}]});
        assert_eq!(fresher_thread(&flat, 0), None);
    }

    #[test]
    fn latest_reply_takes_the_newest_entry_regardless_of_order() {
        let replies = json!({"ok": true, "messages": [
            {"user": "U_ME", "text": "the parent", "ts": "1720000100.0",
             "thread_ts": "1720000100.0"},
            {"user": "U_WIFE", "text": "can you grab the kids?", "ts": "1720000500.0",
             "thread_ts": "1720000100.0"},
            {"subtype": "message_changed", "user": "U_WIFE", "ts": "1720000900.0"}
        ]});
        let dm = latest_reply(&replies, &config(), "D1", "T1").unwrap();
        assert_eq!(dm.text, "can you grab the kids?");
        assert_eq!(dm.ts, 1720000500000);
        assert!(!dm.from_me, "a threaded ask from her still leaves the DM unanswered");
        assert!(
            latest_reply(&json!({"ok": true, "messages": []}), &config(), "D1", "T1").is_none()
        );
    }

    #[test]
    fn redundant_reaction_toggles_are_not_errors() {
        assert!(is_redundant_reaction("slack reactions.add failed: already_reacted"));
        assert!(is_redundant_reaction("slack reactions.remove failed: no_reaction"));
        assert!(!is_redundant_reaction("slack reactions.add failed: missing_scope"));
    }

    #[test]
    fn latest_message_falls_back_to_member_id_without_a_name() {
        let mut cfg = config();
        cfg.watch_name = "  ".to_string();
        let history = json!({"ok": true, "messages": [
            {"user": "U_WIFE", "text": "hi", "ts": "1.0"}
        ]});
        assert_eq!(latest_message(&history, &cfg, "D1", "T1").unwrap().from_name, "U_WIFE");
    }
}
