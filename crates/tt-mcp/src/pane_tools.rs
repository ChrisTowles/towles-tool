use super::*;

impl Dispatcher {
    /// Put a file on screen in the Preview pane — see [`PreviewHost`]. Everything checkable is
    /// checked here, because every failure of this tool is a silent empty pane.
    pub(crate) fn preview_file(
        &mut self,
        args: &Value,
        ctx: &RequestContext,
    ) -> Result<Value, String> {
        let raw = args
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| "missing required argument: path".to_string())?;

        // Availability before diagnosis, as in `task_start`.
        if self.preview_host.is_none() {
            return Err("preview_file is unavailable: no preview host is attached".to_string());
        }
        let path = validate_preview_path(raw)?;
        let title = preview_title(&path, args.get("title").and_then(Value::as_str));

        // `"routed": "path"` tells an agent its request carried no session and the pane may open
        // elsewhere. The session comes off the transport, never the arguments.
        let routed = if ctx.session.is_some() { "session" } else { "path" };
        let host =
            self.preview_host.as_ref().expect("checked above, before the path was validated");
        host.show(PreviewFile {
            path: path.clone(),
            title: title.clone(),
            session: ctx.session.clone(),
        })?;

        Ok(json!({ "status": "showing", "path": path, "title": title, "routed": routed }))
    }

    /// What waits on the user, in the queue's order. The caller's own terminal is left
    /// out: it is the one the user is already looking at.
    pub(crate) fn needs_you(&self, ctx: &RequestContext) -> Result<Value, String> {
        let host = self
            .attention_host
            .as_ref()
            .ok_or_else(|| "needs_you is unavailable: no attention host is attached".to_string())?;
        let waiting: Vec<Value> = host
            .needs_you()
            .into_iter()
            .filter(|w| ctx.session.is_none() || w.session != ctx.session)
            .map(|w| {
                json!({
                    "session": w.session,
                    "title": w.title,
                    "repo": w.repo,
                    "dir": w.dir,
                    "reason": w.reason,
                    "why": w.why,
                    "also": w.also,
                    "sinceMs": w.since_ms,
                })
            })
            .collect();
        Ok(json!({ "waiting": waiting }))
    }

    /// Chime until the user answers the caller's terminal — see [`AttentionHost::summon`].
    pub(crate) fn summon(&self, args: &Value, ctx: &RequestContext) -> Result<Value, String> {
        let reason = args
            .get("reason")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .ok_or_else(|| "missing required argument: reason".to_string())?;
        let host = self
            .attention_host
            .as_ref()
            .ok_or_else(|| "summon is unavailable: no attention host is attached".to_string())?;
        let max_minutes = match args.get("max_minutes") {
            None | Some(Value::Null) => SUMMON_DEFAULT_MINUTES,
            Some(v) => v
                .as_u64()
                .ok_or_else(|| "max_minutes must be a positive integer".to_string())?
                .clamp(1, u64::from(SUMMON_MAX_MINUTES)) as u32,
        };
        host.summon(SummonRequest {
            reason: reason.chars().take(SUMMON_REASON_MAX_CHARS).collect(),
            session: ctx.session.clone(),
            max_minutes,
        })?;
        Ok(json!({ "status": "summoning", "session": ctx.session, "maxMinutes": max_minutes }))
    }

    /// Reveal a file or folder in the caller's own Files pane — see [`EditorHost`]. Validated
    /// here for `preview_file`'s reason: a missing path would be a pane that never appears.
    pub(crate) fn file_open(
        &mut self,
        args: &Value,
        ctx: &RequestContext,
    ) -> Result<Value, String> {
        let raw = args
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| "missing required argument: path".to_string())?;

        // Availability before diagnosis, same as `task_start`.
        if self.editor_host.is_none() {
            return Err("file_open is unavailable: no editor host is attached".to_string());
        }
        let (path, is_dir) = validate_open_path(raw)?;
        let line = args
            .get("line")
            .and_then(Value::as_u64)
            .filter(|&n| n > 0)
            .map(|n| n.min(u64::from(u32::MAX)) as u32);

        let routed = if ctx.session.is_some() { "session" } else { "path" };
        let host = self.editor_host.as_ref().expect("checked above, before the path was validated");
        host.open_file(FileToOpen {
            path: path.clone(),
            is_dir,
            line,
            session: ctx.session.clone(),
        })?;

        Ok(json!({ "status": "opening", "path": path, "routed": routed }))
    }
}
