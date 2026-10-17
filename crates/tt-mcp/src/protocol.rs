use super::*;

/// The one thing the tool list can't say: where a pane lands. Guidance, not a procedure.
pub(crate) const INSTRUCTIONS: &str = "Sessions started in the app's terminals are routed to their own \
    task: preview_file and file_open open their panes beside the calling terminal, so pass any \
    absolute path — where the file lives does not decide where it shows. The board and calendar \
    tools read and write this app instance's own store.";

/// What `server/discover` answers. The cache hints say "ask again": an instance restarted on
/// the same port may be a different build with different tools.
pub(crate) fn discover_result() -> Value {
    json!({
        "supportedVersions": [PROTOCOL_VERSION],
        "capabilities": { "tools": {} },
        "instructions": INSTRUCTIONS,
        "ttlMs": 0,
        "cacheScope": "public",
    })
}

pub(crate) fn tools_list_result() -> Value {
    json!({ "tools": tool_definitions(), "ttlMs": 0, "cacheScope": "public" })
}

pub(crate) fn request_meta(request: &Value) -> Option<&Value> {
    request.get("params")?.get("_meta")
}

/// A request turned away before its method was looked at, as the error it becomes.
pub(crate) struct Rejection {
    code: i64,
    message: String,
    data: Option<Value>,
}

impl Rejection {
    pub(crate) fn header(message: String) -> Rejection {
        Rejection { code: HEADER_MISMATCH, message, data: None }
    }

    /// A request missing a required `_meta` field is malformed: `-32602`, and 400 over HTTP.
    pub(crate) fn missing_meta(key: &str) -> Rejection {
        let message = required(&format!("params._meta.{key}"));
        Rejection { code: INVALID_PARAMS, message, data: None }
    }

    pub(crate) fn into_outcome(self, id: Value) -> Outcome {
        let mut error = json!({ "code": self.code, "message": self.message });
        if let Some(data) = self.data {
            error["data"] = data;
        }
        let response = json!({ "jsonrpc": "2.0", "id": id, "error": error }).to_string();
        Outcome::refused(response, self.code, self.message)
    }
}

/// Every request's checks before dispatch: the HTTP binding's mirrored headers agree with the
/// body, and the body names the one version served. The "required" refusals spell the version
/// out because a legacy client opening with `initialize` can show nothing else.
pub(crate) fn admit(request: &Value, method: &str, ctx: &RequestContext) -> Result<(), Rejection> {
    let version =
        request_meta(request).and_then(|m| m.get(META_PROTOCOL_VERSION)).and_then(Value::as_str);
    if let Some(headers) = &ctx.headers {
        if headers.protocol_version.is_none() {
            return Err(Rejection::header(required(&format!("{PROTOCOL_VERSION_HEADER} header"))));
        }
        mirrored(PROTOCOL_VERSION_HEADER, headers.protocol_version.as_deref(), version)?;
        mirrored(METHOD_HEADER, headers.method.as_deref(), Some(method))?;
        if method == "tools/call" {
            let name = request.pointer("/params/name").and_then(Value::as_str);
            let sent = headers.name.as_deref().map(decode_sentinel);
            mirrored(NAME_HEADER, sent.as_deref(), name)?;
        }
    }
    match version {
        None => return Err(Rejection::missing_meta(META_PROTOCOL_VERSION)),
        Some(requested) if requested != PROTOCOL_VERSION => {
            return Err(Rejection {
                code: UNSUPPORTED_PROTOCOL_VERSION,
                message: "Unsupported protocol version".to_string(),
                data: Some(json!({ "supported": [PROTOCOL_VERSION], "requested": requested })),
            });
        }
        Some(_) => {}
    }
    // Required on every request. Only presence is checked: a `MissingRequiredClientCapability`
    // answers a request that needs one the client withheld, and nothing here needs any.
    let capabilities = request_meta(request).and_then(|m| m.get(META_CLIENT_CAPABILITIES));
    if !capabilities.is_some_and(Value::is_object) {
        return Err(Rejection::missing_meta(META_CLIENT_CAPABILITIES));
    }
    Ok(())
}

pub(crate) fn required(what: &str) -> String {
    format!(
        "{what} is required: this server speaks MCP {PROTOCOL_VERSION} only, which has no \
         initialize handshake"
    )
}

/// Equal to the body field it copies, and absent when there is nothing to copy.
pub(crate) fn mirrored(
    header: &str,
    sent: Option<&str>,
    body: Option<&str>,
) -> Result<(), Rejection> {
    match (sent, body) {
        (None, None) => Ok(()),
        (Some(sent), Some(body)) if sent == body => Ok(()),
        (None, Some(_)) => Err(Rejection::header(format!("missing {header} header"))),
        (Some(sent), None) => {
            Err(Rejection::header(format!("{header} header {sent:?} names nothing in the body")))
        }
        (Some(sent), Some(body)) => Err(Rejection::header(format!(
            "{header} header {sent:?} does not match the body's {body:?}"
        ))),
    }
}

/// `=?base64?…?=` carries a header-unsafe name; decoded before comparing, as the spec asks.
pub(crate) fn decode_sentinel(value: &str) -> Cow<'_, str> {
    use base64::Engine;
    value
        .strip_prefix("=?base64?")
        .and_then(|rest| rest.strip_suffix("?="))
        .and_then(|encoded| base64::engine::general_purpose::STANDARD.decode(encoded).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .map_or(Cow::Borrowed(value), Cow::Owned)
}

/// `name version` from the request's own `clientInfo`; per request, since nothing persists.
pub(crate) fn client_label(request: &Value) -> Option<String> {
    let info = request_meta(request)?.get(META_CLIENT_INFO)?;
    let name = info.get("name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty())?;
    match info.get("version").and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()) {
        Some(version) => Some(format!("{name} {version}")),
        None => Some(name.to_string()),
    }
}

/// The args for the call log, cut at [`CALL_LOG_ARGS_MAX`] chars on a char boundary.
pub(crate) fn compact_args(args: &Value) -> String {
    let rendered = args.to_string();
    if rendered.chars().count() <= CALL_LOG_ARGS_MAX {
        return rendered;
    }
    let mut truncated: String = rendered.chars().take(CALL_LOG_ARGS_MAX).collect();
    truncated.push('…');
    truncated
}

pub(crate) fn error_response(id: Value, code: i64, message: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string()
}

impl Dispatcher {
    /// Every result carries `resultType`, required since 2026-07-28, and names this server.
    pub(crate) fn result_response(&self, id: Value, mut result: Value) -> String {
        if let Some(result) = result.as_object_mut() {
            result.insert("resultType".to_string(), json!("complete"));
            result.insert("_meta".to_string(), json!({ META_SERVER_INFO: self.server_info }));
        }
        json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
    }

    /// The value twice: as `structuredContent`, which a client validates against the tool's
    /// `outputSchema` and prefers for display, and as the text block the spec keeps for clients
    /// that read only that.
    pub(crate) fn tool_result_response(&self, id: Value, value: &Value) -> String {
        let text = serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string());
        self.result_response(
            id,
            json!({ "content": [{ "type": "text", "text": text }], "structuredContent": value }),
        )
    }

    pub(crate) fn tool_error_response(&self, id: Value, message: &str) -> String {
        self.result_response(
            id,
            json!({ "content": [{ "type": "text", "text": message }], "isError": true }),
        )
    }
}
