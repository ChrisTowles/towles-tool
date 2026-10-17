use super::*;

/// The app-side half of `task_delete`; with no host the tool refuses rather than half-delete.
pub trait TaskHost: Send {
    /// Close task `id` and delete everything bound to it; `force` skips the guards.
    fn delete_task(
        &self,
        id: i64,
        force: bool,
        outcome: Option<tt_store::TaskOutcome>,
    ) -> Result<TaskDeletion, String>;

    /// Mint `req`'s worktree and launch an agent on its goal; returns once handed off.
    fn start_task(&self, req: TaskStartRequest) -> Result<(), String>;
}

/// The app-side half of `preview_file`, routed by caller — see [`PreviewFile::session`].
pub trait PreviewHost: Send {
    fn show(&self, file: PreviewFile) -> Result<(), String>;
}

pub struct PreviewFile {
    pub path: String,
    pub title: String,
    /// The routing key: the caller's PTY session. `None` falls back to matching the path.
    pub session: Option<String>,
}

/// The app-side half of `file_open`: reveal a path in the caller's Files pane.
pub trait EditorHost: Send {
    fn open_file(&self, request: FileToOpen) -> Result<(), String>;
}

/// The app-side half of `needs_you`, read from the agentboard's PTY-stamped state.
pub trait AttentionHost: Send {
    fn needs_you(&self) -> Vec<WaitingRow>;

    /// Chime until the user answers — a hand-off: returns once the chime starts.
    fn summon(&self, request: SummonRequest) -> Result<(), String>;
}

pub struct SummonRequest {
    pub reason: String,
    /// The caller's PTY; `None` is answered by input to any terminal.
    pub session: Option<String>,
    pub max_minutes: u32,
}

/// `summon`'s chime cap when the caller names none, and its clamp.
pub(crate) const SUMMON_DEFAULT_MINUTES: u32 = 15;
pub(crate) const SUMMON_MAX_MINUTES: u32 = 60;
pub(crate) const SUMMON_REASON_MAX_CHARS: usize = 200;

/// One checkout the queue has on the user, and why.
pub struct WaitingRow {
    /// The waiting agent's `TT_SESSION_ID`; a red CI or a PR to land has none.
    pub session: Option<String>,
    pub title: String,
    pub repo: String,
    pub dir: String,
    /// The queue's wait reason, e.g. `answer`, `fix_ci` or `land`.
    pub reason: String,
    /// The reason in the queue chip's words, e.g. `asking`, `CI red`, `PR approved`.
    pub why: String,
    pub also: Vec<String>,
    pub since_ms: Option<i64>,
}

pub struct FileToOpen {
    pub path: String,
    /// The frontend cannot `stat`: a file is also selected in the opened pane.
    pub is_dir: bool,
    pub line: Option<u32>,
    pub session: Option<String>,
}

/// Absolute and canonical for [`validate_preview_path`]'s reasons.
pub(crate) fn validate_open_path(raw: &str) -> Result<(String, bool), String> {
    let path = std::path::Path::new(raw.trim());
    if path.as_os_str().is_empty() {
        return Err("missing required argument: path".to_string());
    }
    if !path.is_absolute() {
        return Err(format!(
            "path must be absolute — {raw:?} is relative, and this server serves every session on \
             the machine, so it has no working directory to resolve it against"
        ));
    }
    let resolved = std::fs::canonicalize(path).map_err(|e| format!("can't open {raw:?}: {e}"))?;
    let is_dir = resolved.is_dir();
    Ok((resolved.to_string_lossy().into_owned(), is_dir))
}

/// The frontend inlines the whole file, so a huge path must fail as an answer, not a frozen window.
pub(crate) const PREVIEW_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// Rejects what would otherwise show as a blank pane; canonical on the way out.
pub(crate) fn validate_preview_path(raw: &str) -> Result<String, String> {
    let path = std::path::Path::new(raw.trim());
    if path.as_os_str().is_empty() {
        return Err("missing required argument: path".to_string());
    }
    if !path.is_absolute() {
        return Err(format!(
            "path must be absolute — {raw:?} is relative, and this server serves every session on \
             the machine, so it has no working directory to resolve it against"
        ));
    }
    let meta = std::fs::metadata(path).map_err(|e| format!("can't read {raw:?}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{raw:?} is not a file"));
    }
    if meta.len() > PREVIEW_MAX_BYTES {
        return Err(format!(
            "{raw:?} is {} bytes — the preview inlines the whole file, so keep it under {} bytes",
            meta.len(),
            PREVIEW_MAX_BYTES
        ));
    }
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    Ok(resolved.to_string_lossy().into_owned())
}

/// The caller's title, else the file name — never an empty header, which reads as broken.
pub(crate) fn preview_title(path: &str, title: Option<&str>) -> String {
    match title.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => t.to_string(),
        None => std::path::Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Preview".to_string()),
    }
}

/// Everything the host needs to start a task. A hand-off: the tool reports `"starting"`.
pub struct TaskStartRequest {
    pub id: i64,
    pub text: String,
    pub repo_root: String,
    /// Derived from `text` when the caller doesn't name one — a task is named after its branch.
    pub branch: String,
    pub base: Option<String>,
    /// The row's `goal` plus its `notes`, where a task's real handoff context lives.
    pub prompt: String,
}

/// What a [`TaskHost::delete_task`] attempt produced; a refusal is an answer, not an error.
pub enum TaskDeletion {
    Deleted {
        name: String,
        messages: Vec<String>,
    },
    /// Each blocker carries `losesWork`: "stop your dev server" vs "forcing destroys commits".
    Refused {
        name: String,
        blockers: Vec<Value>,
        messages: Vec<String>,
    },
}
