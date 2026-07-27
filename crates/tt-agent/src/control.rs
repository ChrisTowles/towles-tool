//! The *other* protocol on the same pipe: control requests.
//!
//! `stream-json` carries two interleaved conversations. [`crate::protocol`]
//! models the first — the message stream the transcript renders. This module
//! models the second: a JSON-RPC-shaped request/response channel the CLI uses
//! to **ask the client a question and block until it answers**.
//!
//! ```text
//! CLI → {"type":"control_request","request_id":"…","request":{"subtype":"can_use_tool",…}}
//! us  → {"type":"control_response","response":{"subtype":"success","request_id":"…","response":{…}}}
//! ```
//!
//! **An unanswered control request is a hang, not a dropped message.** That is
//! the whole reason this module exists as a first-class thing rather than more
//! `AgentEvent::Other`: the CLI is genuinely waiting, and a client that files
//! the request under "protocol noise it doesn't render" presents as an agent
//! that went quiet forever. Hence [`encode_error`], and hence
//! [`crate::AgentEvent::UnsupportedControlRequest`] — a subtype we can't serve
//! still gets an answer.
//!
//! The channel is opened by spawning with `--permission-prompt-tool stdio`
//! (see [`crate::session::build_args`]). Without that flag the CLI resolves
//! permissions against settings internally and never asks.
//!
//! ## `can_use_tool` is three features, not one
//!
//! Every gated tool call arrives here, but so do the tools whose entire purpose
//! is to ask the human something. Claude Code marks the difference itself with
//! `requires_user_interaction`, and the distinction is the one a UI cares
//! about:
//!
//! - **A gate** (`Write`, `Bash`, …) — "may I?", answered allow/deny.
//! - **A question** (`AskUserQuestion`) — the answer is *data*, returned by
//!   allowing the call with an edited `input`. Refusing it is not "deny", it is
//!   allowing the tool having answered nothing.
//! - **A plan** (`ExitPlanMode`) — allow to approve, deny-with-message to send
//!   the model revision notes.
//!
//! All three are one request shape and one response shape, which is why they
//! share a code path here and a renderer seam in the frontend.
//!
//! ## What is deliberately left opaque
//!
//! `permission_suggestions` (and the `updated_permissions` that echoes them
//! back) stay [`Value`]. They are the CLI's own vocabulary for "always allow
//! this" — `{"type":"setMode","mode":"acceptEdits","destination":"session"}`,
//! `addRules`, and whatever it grows next. We render their labels and hand the
//! chosen one straight back, so modeling the shape would buy nothing and cost a
//! parse failure every time the CLI adds a suggestion kind.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::json::{opt_str_field, str_field};

/// A parsed `control_request` line, before we decide whether we can serve it.
///
/// Only the envelope is modeled here; the per-subtype payload stays as `raw`
/// so [`crate::protocol`] can lift the one subtype we serve into a real event
/// and answer the rest with an error.
#[derive(Debug, Clone, PartialEq)]
pub struct ControlRequest {
    pub request_id: String,
    pub subtype: String,
    pub raw: Value,
}

impl ControlRequest {
    /// Read the envelope out of an already-parsed line, or `None` if this is
    /// not a control request at all.
    ///
    /// Takes `&mut` so the payload can be *moved* out rather than cloned: a
    /// `Write` gate's `input.content` is an entire file, and this runs on the
    /// reader thread the CLI is blocked against. The line is left with a null
    /// `request` on success and untouched on `None`, so a caller that falls
    /// through to the message-stream match still sees what it had.
    pub fn from_value(v: &mut Value) -> Option<Self> {
        if v.get("type").and_then(Value::as_str)? != "control_request" {
            return None;
        }
        let request_id = v.get("request_id").and_then(Value::as_str)?.to_string();
        let request = v.get_mut("request")?;
        let subtype = request.get("subtype").and_then(Value::as_str).unwrap_or("").to_string();
        Some(Self { request_id, subtype, raw: request.take() })
    }
}

/// A `can_use_tool` request: the model wants to run `tool_name` with `input`.
///
/// Serialized camelCase and carried inside [`crate::AgentEvent`], so the
/// frontend receives it verbatim over the Tauri event channel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    /// What [`encode_decision`] must echo back. The CLI correlates on it.
    pub request_id: String,
    pub tool_name: String,
    /// The CLI's own label for the tool, when it differs from `tool_name`.
    pub display_name: Option<String>,
    /// A one-line summary of the call (a path, a command) the CLI prepared for
    /// exactly this prompt — better than anything we'd derive from `input`.
    pub description: Option<String>,
    /// Pairs the prompt with the `toolUse` turn already in the transcript, so
    /// the card can render against the call instead of beside it.
    pub tool_use_id: Option<String>,
    /// The tool's arguments — and, for a question tool, the thing the answer is
    /// written *into*. See [`PermissionDecision::Allow::updated_input`].
    pub input: Value,
    /// Ways to stop being asked ("always allow", "accept edits this session"),
    /// in the CLI's vocabulary. Opaque by design — see the module docs.
    #[serde(default)]
    pub suggestions: Vec<Value>,
    /// The CLI's own flag for "this request has no sensible default and must
    /// reach a human". Passed through for the record; which *card* to render is
    /// decided by the payload's shape (see the frontend's `promptKind`), since
    /// every request on this channel needs a human by the time it gets here.
    #[serde(default)]
    pub requires_user_interaction: bool,
}

impl PermissionRequest {
    /// Lift a `can_use_tool` request out of its envelope.
    ///
    /// Total rather than fallible: a request missing `tool_name` is still a
    /// request the CLI is blocked on, so it becomes a prompt with an empty name
    /// rather than a parse failure that strands the session.
    ///
    /// Consumes the request so `input` and the suggestions move instead of
    /// being deep-copied — see [`ControlRequest::from_value`].
    pub fn from_control(mut req: ControlRequest) -> Self {
        let input = req.raw.get_mut("input").map(Value::take).unwrap_or_else(|| json!({}));
        let suggestions = req
            .raw
            .get_mut("permission_suggestions")
            .and_then(Value::as_array_mut)
            .map(std::mem::take)
            .unwrap_or_default();
        let r = &req.raw;
        let (tool_name, display_name, description, tool_use_id) = (
            str_field(r, "tool_name"),
            opt_str_field(r, "display_name"),
            opt_str_field(r, "description"),
            opt_str_field(r, "tool_use_id"),
        );
        let requires_user_interaction =
            r.get("requires_user_interaction").and_then(Value::as_bool).unwrap_or(false);
        Self {
            request_id: req.request_id,
            tool_name,
            display_name,
            description,
            tool_use_id,
            input,
            suggestions,
            requires_user_interaction,
        }
    }
}

/// What the human decided.
///
/// The three variants are the CLI's `behavior` values. Note that `Deny`'s
/// `message` is not cosmetic: it is delivered to the model as the tool result,
/// so "no — read the config first" is a steering channel, not just a refusal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PermissionDecision {
    #[serde(rename_all = "camelCase")]
    Allow {
        /// Replaces the tool's arguments when present. For a gate this is
        /// `None` (run it as asked); for `AskUserQuestion` it is the whole
        /// mechanism — the answers are written into `input.answers` and handed
        /// back, because the tool's *result* is its own edited input.
        updated_input: Option<Value>,
        /// Suggestions the user accepted, echoed verbatim from
        /// [`PermissionRequest::suggestions`].
        #[serde(default)]
        updated_permissions: Vec<Value>,
    },
    #[serde(rename_all = "camelCase")]
    Deny { message: Option<String> },
    /// Neither allowed nor refused — the prompt went away (pane closed, session
    /// stopped). Distinct from `Deny` so the model isn't told the user objected
    /// when they merely left.
    Cancelled,
}

/// How a prompt ended, in the frontend's own vocabulary.
///
/// Carried alongside [`PermissionDecision`] rather than derived from it, because
/// the wire shape does not recover it: a question the user skipped is an `Allow`
/// with no `updated_input`, byte-identical to a plain gate allow. Typed rather
/// than a bare string so a typo is a deserialize error at the IPC boundary
/// instead of an unqueryable word in the event log.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Verdict {
    Allow,
    Answered,
    Deny,
    Cancelled,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Answered => "answered",
            Self::Deny => "deny",
            Self::Cancelled => "cancelled",
        }
    }
}

impl std::fmt::Display for Verdict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Encode a decision as the `control_response` line to write to stdin.
///
/// One JSON object; the caller adds the newline that frames it, exactly as
/// with [`crate::protocol::encode_user_message`].
pub fn encode_decision(request_id: &str, decision: &PermissionDecision) -> String {
    let response = match decision {
        PermissionDecision::Allow { updated_input, updated_permissions } => {
            let mut body = json!({ "behavior": "allow" });
            // Both keys are omitted rather than sent null: the CLI treats an
            // absent `updatedInput` as "run it as asked", and an explicit null
            // is not the same thing.
            if let Some(input) = updated_input {
                body["updatedInput"] = input.clone();
            }
            if !updated_permissions.is_empty() {
                body["updatedPermissions"] = Value::Array(updated_permissions.clone());
            }
            body
        }
        PermissionDecision::Deny { message } => match message {
            Some(m) => json!({ "behavior": "deny", "message": m }),
            None => json!({ "behavior": "deny" }),
        },
        PermissionDecision::Cancelled => json!({ "behavior": "cancelled" }),
    };
    envelope(json!({
        "subtype": "success",
        "request_id": request_id,
        "response": response,
    }))
}

/// Encode a refusal to serve a control request at all.
///
/// This is what keeps an unknown subtype from becoming a hang, so it is the
/// load-bearing half of forward compatibility here — the analogue of
/// [`crate::AgentEvent::Other`] on a channel where staying silent is not an
/// option.
pub fn encode_error(request_id: &str, error: &str) -> String {
    envelope(json!({
        "subtype": "error",
        "request_id": request_id,
        "error": error,
    }))
}

fn envelope(response: Value) -> String {
    json!({ "type": "control_response", "response": response }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Captured from a live `claude` session, not hand-written — the field
    /// names here are the contract and guessing them is how this breaks.
    const CAN_USE_TOOL: &str = r#"{
      "type": "control_request",
      "request_id": "316f8755",
      "request": {
        "subtype": "can_use_tool",
        "tool_name": "Write",
        "display_name": "Write",
        "input": { "file_path": "/tmp/probe.txt", "content": "hello" },
        "description": "probe.txt",
        "permission_suggestions": [
          { "type": "setMode", "mode": "acceptEdits", "destination": "session" }
        ],
        "tool_use_id": "toolu_014rFH"
      }
    }"#;

    fn parse(s: &str) -> ControlRequest {
        ControlRequest::from_value(&mut serde_json::from_str(s).unwrap()).unwrap()
    }

    #[test]
    fn lifts_a_real_permission_request() {
        let req = parse(CAN_USE_TOOL);
        assert_eq!(req.subtype, "can_use_tool");
        let perm = PermissionRequest::from_control(req);
        assert_eq!(perm.request_id, "316f8755");
        assert_eq!(perm.tool_name, "Write");
        assert_eq!(perm.description.as_deref(), Some("probe.txt"));
        assert_eq!(perm.tool_use_id.as_deref(), Some("toolu_014rFH"));
        assert_eq!(perm.input["file_path"], "/tmp/probe.txt");
        assert_eq!(perm.suggestions.len(), 1, "suggestions pass through unmodeled");
        assert_eq!(perm.suggestions[0]["mode"], "acceptEdits");
        assert!(!perm.requires_user_interaction, "a gate is not a question");
    }

    #[test]
    fn a_question_is_flagged_by_the_cli_not_by_its_tool_name() {
        let req = parse(
            r#"{"type":"control_request","request_id":"r1","request":{
                 "subtype":"can_use_tool","tool_name":"AskUserQuestion",
                 "input":{"questions":[]},"requires_user_interaction":true}}"#,
        );
        assert!(PermissionRequest::from_control(req).requires_user_interaction);
    }

    #[test]
    fn a_request_missing_its_fields_is_still_answerable() {
        // The CLI is blocked on this regardless of how sparse it is, so it must
        // reach the UI as a prompt rather than vanish into a parse error.
        let req = parse(r#"{"type":"control_request","request_id":"r2","request":{}}"#);
        let perm = PermissionRequest::from_control(req);
        assert_eq!(perm.request_id, "r2");
        assert_eq!(perm.tool_name, "");
        assert_eq!(perm.input, json!({}));
        assert!(perm.suggestions.is_empty());
    }

    #[test]
    fn non_control_lines_are_not_control_requests() {
        let mut v: Value = serde_json::from_str(r#"{"type":"assistant","message":{}}"#).unwrap();
        assert!(ControlRequest::from_value(&mut v).is_none());
        // A control_request with no `request` object is malformed enough to
        // ignore — there is no request_id/subtype pair to answer.
        let mut v: Value = serde_json::from_str(r#"{"type":"control_request"}"#).unwrap();
        assert!(ControlRequest::from_value(&mut v).is_none());
    }

    fn decode(line: &str) -> Value {
        let v: Value = serde_json::from_str(line).unwrap();
        assert_eq!(v["type"], "control_response");
        v["response"].clone()
    }

    #[test]
    fn allow_omits_the_keys_it_has_nothing_to_say_about() {
        let r = decode(&encode_decision(
            "r1",
            &PermissionDecision::Allow { updated_input: None, updated_permissions: Vec::new() },
        ));
        assert_eq!(r["subtype"], "success");
        assert_eq!(r["request_id"], "r1");
        assert_eq!(r["response"]["behavior"], "allow");
        // Absent, not null: the CLI reads a missing `updatedInput` as "run it
        // as asked", which an explicit null would not mean.
        assert!(r["response"].get("updatedInput").is_none());
        assert!(r["response"].get("updatedPermissions").is_none());
    }

    #[test]
    fn allow_carries_edited_input_and_accepted_suggestions() {
        let r = decode(&encode_decision(
            "r1",
            &PermissionDecision::Allow {
                updated_input: Some(json!({ "answers": { "Colour?": "Blue" } })),
                updated_permissions: vec![json!({ "type": "setMode", "mode": "acceptEdits" })],
            },
        ));
        assert_eq!(r["response"]["updatedInput"]["answers"]["Colour?"], "Blue");
        assert_eq!(r["response"]["updatedPermissions"][0]["mode"], "acceptEdits");
    }

    #[test]
    fn deny_carries_its_message_because_the_model_reads_it() {
        let r = decode(&encode_decision(
            "r1",
            &PermissionDecision::Deny { message: Some("read the config first".into()) },
        ));
        assert_eq!(r["response"]["behavior"], "deny");
        assert_eq!(r["response"]["message"], "read the config first");

        let bare = decode(&encode_decision("r1", &PermissionDecision::Deny { message: None }));
        assert!(bare["response"].get("message").is_none());
    }

    #[test]
    fn cancelled_is_distinct_from_deny() {
        let r = decode(&encode_decision("r1", &PermissionDecision::Cancelled));
        assert_eq!(r["response"]["behavior"], "cancelled");
    }

    #[test]
    fn an_unservable_subtype_still_gets_an_answer() {
        let r = decode(&encode_error("r9", "unsupported control request: hook_callback"));
        assert_eq!(r["subtype"], "error");
        assert_eq!(r["request_id"], "r9");
        assert!(r["error"].as_str().unwrap().contains("hook_callback"));
    }

    #[test]
    fn responses_are_one_line_each() {
        for line in [
            encode_decision("r", &PermissionDecision::Cancelled),
            encode_error("r", "nope"),
        ] {
            assert!(!line.contains('\n'), "the newline is the framing");
        }
    }

    /// The decision crosses IPC from the webview, so these are the exact
    /// payloads the frontend sends — including the ones where it omits a field
    /// entirely, which is the case a hand-written `Option` gets wrong.
    #[test]
    fn decisions_deserialize_from_what_the_frontend_actually_sends() {
        let allow: PermissionDecision = serde_json::from_str(r#"{"kind":"allow"}"#).unwrap();
        assert_eq!(
            allow,
            PermissionDecision::Allow { updated_input: None, updated_permissions: Vec::new() }
        );

        let answered: PermissionDecision =
            serde_json::from_str(r#"{"kind":"allow","updatedInput":{"answers":{"q":"a"}}}"#)
                .unwrap();
        let PermissionDecision::Allow { updated_input, .. } = answered else {
            panic!("expected Allow")
        };
        assert_eq!(updated_input.unwrap()["answers"]["q"], "a");

        assert_eq!(
            serde_json::from_str::<PermissionDecision>(r#"{"kind":"deny"}"#).unwrap(),
            PermissionDecision::Deny { message: None }
        );
        assert_eq!(
            serde_json::from_str::<PermissionDecision>(r#"{"kind":"cancelled"}"#).unwrap(),
            PermissionDecision::Cancelled
        );
    }
}
