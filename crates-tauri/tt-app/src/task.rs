//! `task_*` commands: worktree-task creation/removal from the app
//! (Agentboard's new-task modal and the rail's delete-worktree action). Thin
//! over `tt_tasks::ops`, which is shared with the `tt task` CLI — the app
//! never reimplements task logic.

use base64::Engine as _;
use serde::Serialize;
use std::path::PathBuf;
use tauri::Manager;

use tt_agentboard::types::RowPhase;
use tt_tasks::guards::RmBlocked;
use tt_tasks::ops::{self, CreateOpts, RemoveOpts, RemovePhase};
use tt_tasks::pasted::{self, PastedImage};
use tt_tasks::suggest::Suggested;

/// Worktree operations running right now, keyed by directory — only this process
/// can tell a task mid-`worktree add` from a crashed create. Not persisted: a
/// crash ends the entry, the row honestly reads detached.
#[derive(Default)]
pub struct TaskPhases(std::sync::Mutex<std::collections::HashMap<String, RowPhase>>);

impl TaskPhases {
    pub fn creating(&self, dir: &str, label: &str) {
        self.set(dir, RowPhase::Creating { label: label.to_string() });
    }

    pub fn removing(&self, dir: &str, label: &str) {
        self.set(dir, RowPhase::Removing { label: label.to_string() });
    }

    fn set(&self, dir: &str, phase: RowPhase) {
        self.0.lock().unwrap().insert(dir.to_string(), phase);
    }

    /// Must run on every exit path — a row stuck on `creating` is worse.
    pub fn clear(&self, dir: &str) {
        self.0.lock().unwrap().remove(dir);
    }

    pub fn get(&self, dir: &str) -> Option<RowPhase> {
        self.0.lock().unwrap().get(dir).cloned()
    }
}

/// Push a fresh snapshot with the phase, so every step is on screen when it
/// starts rather than a poll later.
fn set_phase(app: &tauri::AppHandle, write: impl FnOnce(&TaskPhases)) {
    write(&app.state::<TaskPhases>());
    app.state::<crate::agentboard::Ab>().emit.notify_one();
}

/// Task lifecycle is a natural moment to check whether main moved fleet-wide;
/// off the response path so a slow fetch never delays it.
fn refresh_all_git_info_in_background(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let ab = app.state::<crate::agentboard::Ab>();
        let targets: Vec<String> =
            ab.engine.lock().unwrap().git_targets().into_iter().map(|(dir, _, _)| dir).collect();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            tt_agentboard::git_info::fetch_all(&targets);
        })
        .await;
        ab.emit.notify_one();
    });
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TaskCreated {
    pub name: String,
    pub dir: String,
    pub branch: String,
    pub base: String,
    pub warnings: Vec<String>,
}

/// Default branch first; [`ops::BaseBranch`] has the name-vs-label split.
#[tauri::command]
pub fn task_base_branches(root: String) -> Result<Vec<ops::BaseBranch>, String> {
    let sr = ops::discover_root(Some(&PathBuf::from(root))).map_err(|e| e.to_string())?;
    ops::checkout_branches(&sr.checkout).map_err(|e| e.to_string())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BranchCheck {
    pub name: Option<String>,
    /// Bound onto the task row at submit, so the rail row exists before git runs.
    pub dir: Option<String>,
    pub taken: bool,
    pub branch_exists: bool,
    pub error: Option<String>,
}

/// Read-only — safe on every (debounced) keystroke.
#[tauri::command]
pub fn task_check_branch(root: String, branch: String) -> Result<BranchCheck, String> {
    let sr = ops::discover_root(Some(&PathBuf::from(root))).map_err(|e| e.to_string())?;
    let check = ops::check_branch(&sr, branch.trim());
    Ok(BranchCheck {
        name: check.name,
        dir: check.dir,
        taken: check.taken,
        branch_exists: check.branch_exists,
        error: check.error,
    })
}

/// A **prompt improver** button: ask `claude -p` (cwd = `dir` for real repo
/// context) to rewrite the typed goal and propose a branch; `instruction` is the
/// improver's user-editable prompt from settings. Nothing runs automatically.
#[tauri::command]
pub async fn task_suggest(
    dir: String,
    goal: String,
    image_paths: Vec<String>,
    instruction: Option<String>,
) -> Result<Suggested, String> {
    let images = image_paths.len();
    let instruction = instruction.unwrap_or_default();
    let result = tauri::async_runtime::spawn_blocking(move || {
        tt_tasks::suggest(&PathBuf::from(dir), &goal, &image_paths, &instruction)
    })
    .await
    .map_err(|e| format!("worktree task failed: {e}"))?
    .map_err(|e| e.to_string());
    // A hard failure stays at `warn` — one log site must not cost the severity.
    match &result {
        Ok(s) => {
            let outcome = if s.fallback.is_some() { "fallback" } else { "ok" };
            tracing::info!(
                images,
                outcome,
                reason = s.fallback.as_deref().unwrap_or(""),
                "task_suggest"
            );
        }
        Err(e) => tracing::warn!(images, outcome = "error", reason = e.as_str(), "task_suggest"),
    }
    result
}

/// Fetch, worktree add, render `.env`, inherit secrets. Deliberately **not** the
/// install step — that can run for minutes and this gates the terminal pane; the
/// caller fires `task_run_setup` once the pane opens.
#[tauri::command]
pub async fn task_create(
    app: tauri::AppHandle,
    root: String,
    branch: String,
    base: String,
    dir: String,
) -> Result<TaskCreated, String> {
    let branch = branch.trim().to_string();
    if branch.is_empty() {
        return Err("a task needs a branch — tasks are named after their branch".to_string());
    }
    let opts = CreateOpts {
        root: Some(PathBuf::from(root)),
        branch,
        base: {
            let b = base.trim();
            (!b.is_empty()).then(|| b.to_string())
        },
        run_setup: false,
    };
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    // Claimed before the first step, so the row is never on the rail mute.
    set_phase(&app, |p| p.creating(&dir, "starting"));
    let progress_app = app.clone();
    let event_dir = dir.clone();
    let created = tauri::async_runtime::spawn_blocking(move || {
        let mut phase_start = std::time::Instant::now();
        ops::create_task(&opts, now_ms, &mut |phase| {
            set_phase(&progress_app, |p| p.creating(&event_dir, phase.label()));
            // `prev_ms` times the *previous* step; the last one differences
            // against the `task.created` event below.
            tracing::info!(
                phase = ?phase,
                label = phase.label(),
                prev_ms = phase_start.elapsed().as_millis() as u64,
                "task.create_phase"
            );
            phase_start = std::time::Instant::now();
        })
    })
    .await;
    // Released on every path — else the row never falls back to detached.
    set_phase(&app, |p| p.clear(&dir));
    let created =
        created.map_err(|e| format!("worktree task failed: {e}"))?.map_err(|e| e.to_string())?;
    tracing::info!(
        name = %created.name,
        branch = %created.branch,
        base = %created.base_label,
        warnings = created.warnings.len(),
        "task.created"
    );
    refresh_all_git_info_in_background(&app);
    Ok(TaskCreated {
        name: created.name,
        dir: created.dir.to_string_lossy().to_string(),
        branch: created.branch,
        base: created.base,
        warnings: created.warnings,
    })
}

/// The DOM can't see an image paste on Linux, so the form reads the clipboard
/// natively off `keydown`. Off the main thread (GTK deadlock risk).
#[tauri::command]
pub async fn read_clipboard_image(app: tauri::AppHandle) -> Result<Option<PastedImage>, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    tauri::async_runtime::spawn_blocking(move || {
        // An empty/non-image clipboard errors in the plugin — the common case.
        let Ok(image) = app.clipboard().read_image() else {
            return Ok(None);
        };
        let rgba = image.rgba();
        let png =
            pasted::rgba_to_png(image.width(), image.height(), rgba).map_err(|e| e.to_string())?;
        if png.len() > pasted::MAX_IMAGE_BYTES {
            return Err(format!(
                "clipboard image is {} bytes, over the {}-byte limit",
                png.len(),
                pasted::MAX_IMAGE_BYTES
            ));
        }
        Ok(Some(PastedImage {
            mime: "image/png".to_string(),
            data_base64: base64::engine::general_purpose::STANDARD.encode(&png),
        }))
    })
    .await
    .map_err(|e| format!("clipboard task failed: {e}"))?
}

/// Staged in `tt_config::pasted_images_dir()`, not the repo (`tt_tasks::pasted`
/// explains). Runs before `task_create`.
#[tauri::command]
pub async fn task_write_pasted_images(
    repo: String,
    branch: String,
    images: Vec<PastedImage>,
) -> Result<Vec<String>, String> {
    let base = tt_config::pasted_images_dir();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    tauri::async_runtime::spawn_blocking(move || {
        let scope = pasted::scope_name(&repo, &branch);
        pasted::write_images(&base, &scope, &images, now_ms)
    })
    .await
    .map_err(|e| format!("worktree task failed: {e}"))?
    .map(|paths| paths.iter().map(|p| p.to_string_lossy().to_string()).collect())
    .map_err(|e| e.to_string())
}

/// `TT_TASK_SETUP` or lockfile detection; `Ok(Some)` carries the retry-able
/// warning. `task_create` deliberately doesn't run it.
#[tauri::command]
pub async fn task_run_setup(dir: String) -> Result<Option<String>, String> {
    use tracing::Instrument as _;

    let span = tracing::info_span!(
        "task.setup",
        dir = %dir,
        outcome = tracing::field::Empty,
    );
    async move {
        let result =
            tauri::async_runtime::spawn_blocking(move || ops::run_setup(&PathBuf::from(dir)))
                .await
                .map_err(|e| format!("worktree task failed: {e}"))?
                .map_err(|e| e.to_string());
        // Three endings: a failed setup still leaves a usable task (hence `Ok`).
        let outcome = match &result {
            Ok(None) => "ok",
            Ok(Some(_)) => "warned",
            Err(_) => "err",
        };
        tracing::Span::current().record("outcome", outcome);
        result
    }
    .instrument(span)
    .await
}

/// The wire form of [`ops::RemoveOutcome`] — see its doc for why a guard refusal
/// is an `Ok` variant. Tagged so the frontend narrows on `status`.
#[derive(Serialize, Clone)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum TaskDeleteOutcome {
    Deleted {
        name: String,
        messages: Vec<String>,
    },
    Blocked {
        name: String,
        blockers: Vec<Blocker>,
        /// A refusal computed against stale refs must not look like one online.
        messages: Vec<String>,
    },
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Blocker {
    /// Stable discriminant — the UI branches on this, never on message text.
    pub kind: String,
    /// Already names the port's holder, so there is no separate holder field.
    pub message: String,
    pub remedy: String,
    /// Whether forcing past this destroys work that exists nowhere else.
    pub loses_work: bool,
    /// Set for `foreignPort` — the argument to `task_stop_port`.
    pub port: Option<u16>,
}

impl From<&RmBlocked> for Blocker {
    fn from(blocked: &RmBlocked) -> Self {
        Blocker {
            kind: blocked.kind().to_string(),
            message: blocked.to_string(),
            remedy: blocked.remedy(),
            loses_work: blocked.loses_work(),
            port: blocked.port(),
        }
    }
}

/// Both forms resolve to the same board-row + worktree pair before anything is
/// touched — one operation through two handles, not two that can drift.
#[derive(Debug, Clone)]
pub enum DeleteTarget {
    Board(i64),
    /// The rail, which lists worktrees on disk whether or not the board knows.
    Worktree(String),
}

/// Resolved once before anything destructive runs, so a target that doesn't
/// exist fails while it's still free to fail.
struct Resolved {
    /// `None` for a rail-initiated delete, where the row is found by bound dir.
    board_id: Option<i64>,
    /// Present even when the directory vanished — bindings still need tearing down.
    dir: Option<String>,
    label: String,
}

fn resolve_delete_target(app: &tauri::AppHandle, target: DeleteTarget) -> Result<Resolved, String> {
    match target {
        DeleteTarget::Board(id) => {
            let task =
                crate::store::task_by_id(app, id)?.ok_or_else(|| format!("no board task #{id}"))?;
            let dir = task.worktree.as_ref().and_then(|w| w.dir.clone());
            Ok(Resolved { board_id: Some(id), dir, label: task.text })
        }
        DeleteTarget::Worktree(dir) => {
            let label = PathBuf::from(&dir)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&dir)
                .to_string();
            Ok(Resolved { board_id: None, dir: Some(dir), label })
        }
    }
}

/// Delete a task's *presence* — panes and worktree — while its board row
/// survives closed (`purge` is the only true row delete). The row closes last,
/// only if the worktree really went, and PTYs die only past the guards —
/// dropping records up front made a blocked removal look clean.
pub fn delete_task_blocking(
    app: &tauri::AppHandle,
    target: DeleteTarget,
    force: bool,
    outcome: Option<tt_store::TaskOutcome>,
    purge: bool,
) -> Result<TaskDeleteOutcome, String> {
    let Resolved { board_id, dir, label } = resolve_delete_target(app, target)?;

    // The only hard delete, row-only: a bound row would orphan its checkout.
    if purge {
        let Some(id) = board_id else {
            return Err("purge names a board task by id".to_string());
        };
        if dir.is_some() {
            return Err(
                "this task is still bound to a worktree — close it first, then purge".to_string()
            );
        }
        crate::store::delete_task_row(app, id)?;
        return Ok(TaskDeleteOutcome::Deleted {
            name: label,
            messages: vec!["deleted the board task permanently".to_string()],
        });
    }

    // No worktree: the row is the whole task, so close it in place.
    let Some(dir) = dir.as_deref() else {
        let mut messages = Vec::new();
        if let Some(id) = board_id {
            let outcome = outcome.unwrap_or_else(|| inferred_outcome_for(app, Some(id), None));
            crate::store::close_task_row(app, id, outcome)?;
            messages.push(format!("closed the board task as {}", outcome.as_str()));
        }
        return Ok(TaskDeleteOutcome::Deleted { name: label, messages });
    };

    // Decided before anything is destroyed; recorded after the worktree is gone.
    let outcome = outcome.unwrap_or_else(|| inferred_outcome_for(app, board_id, Some(dir)));

    // A gone directory can't resolve, so `root` stays `None` — safe **only**
    // because `TearDownBindings` skips the removal step for a missing dir;
    // otherwise `remove_task` would re-discover a root from this process's cwd.
    let (root, name) = match ops::resolve_task_dir(std::path::Path::new(dir)) {
        Ok((checkout, name)) => (Some(checkout), name),
        Err(_) if !std::path::Path::new(dir).is_dir() => {
            (None, tt_tasks::task_name_from_dir(std::path::Path::new(dir)))
        }
        Err(error) => return Err(error.to_string()),
    };
    let opts = RemoveOpts { root, name, force };
    let mut hooks = AppRemovalHooks { app, dir };
    let rows = AppBoardRows { app, board_id };
    let removal = tt_agentboard::task_removal::TaskRemoval {
        opts: &opts,
        dir: std::path::Path::new(dir),
        repos_path: &tt_agentboard::repos::default_repos_path(),
        rows: Some(&rows),
        outcome,
        now_ms: crate::store::now_ms(),
        // The dir came from the store or the rail, never a typed name, so a
        // missing one means the record outlived the checkout.
        on_missing: tt_agentboard::task_removal::MissingDir::TearDownBindings,
    };

    let outcome = tt_agentboard::task_removal::remove_task_and_bindings(removal, &mut hooks);
    // Released however the removal ended — a refused row must go back to reading
    // as ordinary rather than staying stuck on `removing`.
    set_phase(app, |p| p.clear(dir));
    let outcome = outcome.map_err(|e| e.to_string())?;

    match outcome {
        tt_agentboard::task_removal::Outcome::Removed { messages, .. } => {
            // A never-tracked task also drops off the rail — don't wait a poll.
            app.state::<crate::agentboard::Ab>().emit.notify_one();
            refresh_all_git_info_in_background(app);
            Ok(TaskDeleteOutcome::Deleted { name: label, messages })
        }
        // Nothing was removed, so the user can act on the blocker and retry.
        tt_agentboard::task_removal::Outcome::Blocked { name, blocked, messages } => {
            Ok(TaskDeleteOutcome::Blocked {
                name,
                blockers: blocked.iter().map(Blocker::from).collect(),
                messages,
            })
        }
    }
}

/// The row's own evidence (merged PR ⇒ done), else done. Covers MCP callers;
/// the interactive path always passes one explicitly.
fn inferred_outcome_for(
    app: &tauri::AppHandle,
    board_id: Option<i64>,
    dir: Option<&str>,
) -> tt_store::TaskOutcome {
    let id = board_id.or_else(|| {
        dir.and_then(|d| crate::store::task_id_for_worktree_dir(app, d).ok().flatten())
    });
    id.and_then(|id| crate::store::task_by_id(app, id).ok().flatten())
        .map(|task| task.inferred_outcome())
        .unwrap_or(tt_store::TaskOutcome::Done)
}

/// The two removal steps that need the live process — why they are hooks.
struct AppRemovalHooks<'a> {
    app: &'a tauri::AppHandle,
    dir: &'a str,
}

impl tt_agentboard::task_removal::RemovalHooks for AppRemovalHooks<'_> {
    fn on_phase(&mut self, phase: RemovePhase) {
        // The record survives until the close at the very end.
        set_phase(self.app, |p| p.removing(self.dir, phase.label()));

        // `StoppingSessions` doubles as the removal's go/no-go moment, so the
        // PTY kill anchors to it. Never hold the engine lock across a subprocess.
        if phase == RemovePhase::StoppingSessions {
            let ids = {
                let ab = self.app.state::<crate::agentboard::Ab>();
                let engine = ab.engine.lock().unwrap();
                engine.session_ids_for(self.dir)
            };
            if !ids.is_empty() {
                let term_state = self.app.state::<crate::terminal::TermState>();
                for id in &ids {
                    term_state.kill(id);
                }
            }
        }
    }

    fn after_removal(&mut self, _dir: &std::path::Path) -> Vec<String> {
        let mut notes = Vec::new();
        let ab = self.app.state::<crate::agentboard::Ab>();
        let mut engine = ab.engine.lock().unwrap();
        // Resolved while the owner's cached worktree list still names this dir —
        // that same staleness is what the invalidate below fixes.
        let owner = engine.find_worktree_owner(self.dir);
        let closed_ids = engine.close_folder(self.dir);
        if !closed_ids.is_empty() {
            notes.push(format!(
                "closed {} session{} and their panes/windows",
                closed_ids.len(),
                if closed_ids.len() == 1 { "" } else { "s" }
            ));
        }
        // Only the cached git info for a path that no longer answers goes here;
        // the row outlives the directory by design.
        engine.drop_git_cache(self.dir);
        // …and the *owner's* entry, whose cached `linked_worktree_dirs` names the
        // gone directory until the TTL would otherwise let a recompute through.
        if let Some(owner) = owner {
            engine.invalidate_git(&owner, tt_agentboard::GitInvalidation::WorktreeRemoved);
        }
        notes
    }
}

/// Locks only for the delete itself, never across the worktree removal (see
/// [`tt_agentboard::task_removal::BoardRows`]).
struct AppBoardRows<'a> {
    app: &'a tauri::AppHandle,
    /// Preferred over a dir lookup, which can quietly miss (trailing slash,
    /// symlink) and strand the very row the user asked to delete.
    board_id: Option<i64>,
}

impl tt_agentboard::task_removal::BoardRows for AppBoardRows<'_> {
    fn close_task_for_worktree(
        &self,
        dir: &str,
        outcome: tt_store::TaskOutcome,
        _now_ms: i64,
    ) -> Option<String> {
        // "Nothing was bound" must not stand in for "the store wouldn't answer".
        let id = match self.board_id {
            Some(id) => id,
            None => match crate::store::task_id_for_worktree_dir(self.app, dir) {
                Ok(Some(id)) => id,
                Ok(None) => return None,
                Err(error) => return Some(format!("could not read the board row: {error}")),
            },
        };
        if let Err(error) = crate::store::close_task_row(self.app, id, outcome) {
            return Some(format!("could not close board task #{id}: {error}"));
        }
        Some(format!("closed the board task as {}", outcome.as_str()))
    }
}

/// Exactly one of `id`/`dir` identifies the task; `outcome` omitted lets the
/// row's own evidence decide; `purge` is the explicit permanent delete.
#[tauri::command]
pub async fn task_delete(
    app: tauri::AppHandle,
    id: Option<i64>,
    dir: Option<String>,
    force: bool,
    outcome: Option<String>,
    purge: Option<bool>,
) -> Result<TaskDeleteOutcome, String> {
    use tracing::Instrument as _;

    let target = match (id, dir.clone()) {
        (Some(id), None) => DeleteTarget::Board(id),
        (None, Some(dir)) => DeleteTarget::Worktree(dir),
        _ => return Err("task_delete needs exactly one of id/dir".to_string()),
    };
    let outcome = match outcome.as_deref() {
        None => None,
        Some(raw) => Some(
            tt_store::TaskOutcome::parse(raw)
                .ok_or_else(|| format!("unknown task outcome: {raw}"))?,
        ),
    };
    let purge = purge.unwrap_or(false);

    // `outcome` covers all three endings (a refusal looks like success in an
    // `is_ok` log); `force` is the one entry that can have destroyed work.
    let span = tracing::info_span!(
        "task_delete",
        task_id = id,
        dir = dir.as_deref().unwrap_or(""),
        force,
        purge,
        close_outcome = outcome.map(|o| o.as_str()).unwrap_or("inferred"),
        outcome = tracing::field::Empty,
        blockers = tracing::field::Empty,
    );
    async move {
        let result = tauri::async_runtime::spawn_blocking(move || {
            delete_task_blocking(&app, target, force, outcome, purge)
        })
        .await
        .map_err(|e| format!("worktree task failed: {e}"))?;
        let outcome = match &result {
            Ok(TaskDeleteOutcome::Deleted { .. }) => "ok",
            Ok(TaskDeleteOutcome::Blocked { blockers, .. }) => {
                let kinds: Vec<&str> = blockers.iter().map(|b| b.kind.as_str()).collect();
                tracing::Span::current().record("blockers", kinds.join(","));
                "blocked"
            }
            Err(_) => "err",
        };
        tracing::Span::current().record("outcome", outcome);
        result
    }
    .instrument(span)
    .await
}

/// The `foreignPort` blocker's remedy. `ops::stop_task_port` refuses any port the
/// task doesn't claim in its own `.env`, which keeps this from being a
/// UI-reachable "kill any port" primitive. SIGTERM, then SIGKILL if still held.
#[tauri::command]
pub async fn task_stop_port(dir: String, port: u16) -> Result<String, String> {
    use tracing::Instrument as _;

    // `.instrument`, not a held `enter()` guard — an entered span across an
    // `.await` attributes whatever else runs on this thread to it.
    let span = tracing::info_span!(
        "task_stop_port",
        dir = %dir,
        port,
        outcome = tracing::field::Empty,
        pgids = tracing::field::Empty,
    );
    async move {
        let stopped = tauri::async_runtime::spawn_blocking(move || {
            let (checkout, name) =
                ops::resolve_task_dir(std::path::Path::new(&dir)).map_err(|e| e.to_string())?;
            ops::stop_task_port(Some(&checkout), &name, port).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| format!("worktree task failed: {e}"))?;

        let span = tracing::Span::current();
        match stopped {
            Ok(stopped) => {
                let count = stopped.pgids.len();
                let s = if count == 1 { "" } else { "s" };
                // One decision for both log field and toast.
                let (outcome, message) = if count == 0 {
                    ("already_free", format!("Port {port} was already free"))
                } else if stopped.graceful {
                    ("terminated", format!("Port {port}: stopped {count} process group{s}"))
                } else {
                    ("killed", format!("Port {port}: force-killed {count} process group{s}"))
                };
                let pgids: Vec<String> = stopped.pgids.iter().map(i32::to_string).collect();
                span.record("pgids", pgids.join(","));
                span.record("outcome", outcome);
                Ok(message)
            }
            Err(e) => {
                span.record("outcome", "err");
                Err(e)
            }
        }
    }
    .instrument(span)
    .await
}
