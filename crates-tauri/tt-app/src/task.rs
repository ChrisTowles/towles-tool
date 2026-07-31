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

/// Worktree operations running right now, keyed by directory — only this
/// process can tell a task mid-`worktree add` from a crashed create. Not
/// persisted: a crash ends the entry, the row honestly reads detached.
#[derive(Default)]
pub struct TaskPhases(std::sync::Mutex<std::collections::HashMap<String, RowPhase>>);

impl TaskPhases {
    /// Mark `dir` as being created, with the step now running.
    pub fn creating(&self, dir: &str, label: &str) {
        self.set(dir, RowPhase::Creating { label: label.to_string() });
    }

    /// Mark `dir` as being removed, with the step now running.
    pub fn removing(&self, dir: &str, label: &str) {
        self.set(dir, RowPhase::Removing { label: label.to_string() });
    }

    fn set(&self, dir: &str, phase: RowPhase) {
        self.0.lock().unwrap().insert(dir.to_string(), phase);
    }

    /// Must run on every exit path, failures included — a row stuck on
    /// `creating` forever is worse than one that admits it's detached.
    pub fn clear(&self, dir: &str) {
        self.0.lock().unwrap().remove(dir);
    }

    /// The phase for `dir`, if an operation is running on it.
    pub fn get(&self, dir: &str) -> Option<RowPhase> {
        self.0.lock().unwrap().get(dir).cloned()
    }
}

/// Record a phase change and push a fresh snapshot — so every step is on
/// screen when it starts, not a poll later.
fn set_phase(app: &tauri::AppHandle, write: impl FnOnce(&TaskPhases)) {
    write(&app.state::<TaskPhases>());
    app.state::<crate::agentboard::Ab>().emit.notify_one();
}

/// Fire-and-forget `git fetch` across every tracked repo, then nudge the
/// rail. Task lifecycle is a natural moment to check whether main moved
/// fleet-wide; off the response path so a slow fetch never delays it.
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

/// Branches available as a base ref for `root`'s task root, default branch
/// first ([`ops::BaseBranch`] for the name-vs-label split).
#[tauri::command]
pub fn task_base_branches(root: String) -> Result<Vec<ops::BaseBranch>, String> {
    let sr = ops::discover_root(Some(&PathBuf::from(root))).map_err(|e| e.to_string())?;
    ops::checkout_branches(&sr.checkout).map_err(|e| e.to_string())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BranchCheck {
    pub name: Option<String>,
    /// The worktree's future path — see [`ops::BranchCheck::dir`]. The form
    /// binds it onto the task row at submit so the rail row exists before any
    /// git work starts.
    pub dir: Option<String>,
    pub taken: bool,
    pub branch_exists: bool,
    pub error: Option<String>,
}

/// Preflight the branch field: legal ref, already-exists, name collision.
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
/// context) to rewrite the typed goal and propose a branch; `instruction` is
/// the improver's user-editable prompt from settings. Nothing runs
/// automatically. Off the main thread. Returns flat Suggested fields.
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
    // A hard failure stays at `warn` — merging the two log sites must not cost
    // the severity an operator filters on.
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

/// Create the task for `branch` off `base`: fetch, worktree add, render
/// `.env`, inherit secrets. Deliberately **not** the install step — that can
/// run for minutes and this gates the terminal pane; the caller fires
/// `task_run_setup` after the pane opens. `dir` is already bound onto the
/// task row, so this only adds the live phase label. Off the main thread.
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
    // Claimed before the first step runs, so there is no window where the row
    // is on the rail with nothing to say for itself.
    set_phase(&app, |p| p.creating(&dir, "starting"));
    let progress_app = app.clone();
    let event_dir = dir.clone();
    let created = tauri::async_runtime::spawn_blocking(move || {
        let mut phase_start = std::time::Instant::now();
        ops::create_task(&opts, now_ms, &mut |phase| {
            set_phase(&progress_app, |p| p.creating(&event_dir, phase.label()));
            // `prev_ms` times the *previous* step; the last step differences
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
    // Released on every path, failures included — else the row never falls
    // back to detached, where retry/delete live.
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

/// The clipboard's image as a base64 PNG; `Ok(None)` = no image. The DOM
/// can't see an image paste on Linux, so the form reads the clipboard
/// natively off `keydown`. Off the main thread (GTK deadlock risk).
#[tauri::command]
pub async fn read_clipboard_image(app: tauri::AppHandle) -> Result<Option<PastedImage>, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    tauri::async_runtime::spawn_blocking(move || {
        // An empty/non-image clipboard errors in the plugin — the common
        // case, so it maps to `None`, not a user-visible failure.
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

/// Stage the form's pasted images as files for Claude's opening prompt —
/// in `tt_config::pasted_images_dir()`, not the repo (`tt_tasks::pasted`
/// explains). Runs before `task_create`; off the main thread.
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

/// Run a checkout's setup step (`TT_TASK_SETUP` or lockfile detection);
/// `Ok(Some)` carries the retry-able warning. `task_create` doesn't run it.
/// Off the main thread; a span logs the install duration.
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
        // Three endings, not two: a failed setup still leaves a usable task
        // (hence `Ok`), and logging that as success hides the retry case.
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

/// The wire form of [`ops::RemoveOutcome`] — see its doc for why a guard
/// refusal is an `Ok` variant rather than an error. Serialized as a tagged
/// union so the frontend gets real narrowing on `status`.
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
        /// Caveats gathered before the verdict — a refusal computed against
        /// stale refs (failed pre-flight fetch) must not look identical to
        /// one computed online: "unreachable commits" can be an artifact of
        /// the staleness.
        messages: Vec<String>,
    },
}

/// One reason a removal was refused, with everything the UI needs to render
/// it as an actionable row.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Blocker {
    /// Stable discriminant (`dirtyTree` / `unreachableCommits` /
    /// `foreignPort`) — the UI branches on this, never on message text.
    pub kind: String,
    /// What's wrong. Already names the port's holder where there is one, so
    /// there's no separate holder field — the UI renders these two strings
    /// and nothing else.
    pub message: String,
    /// What to do about it.
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

/// What to delete. Both forms resolve to the same board-row + worktree pair
/// before anything is touched — one operation through two handles, not two
/// behaviors that can drift. Either half may be absent.
#[derive(Debug, Clone)]
pub enum DeleteTarget {
    /// A board task id — the Board screen and the `task_delete` MCP tool.
    Board(i64),
    /// A worktree directory — the Agentboard rail, which lists worktrees found
    /// on disk whether or not the board knows about them.
    Worktree(String),
}

/// What a [`DeleteTarget`] actually names, resolved once before anything
/// destructive runs so a target that doesn't exist fails while it's still free
/// to fail.
struct Resolved {
    /// The board row, when the target named one. `None` for a rail-initiated
    /// delete, where the row is found by its bound dir (`BoardRows`).
    board_id: Option<i64>,
    /// The worktree bound to it, if any. Present even when the directory has
    /// since vanished — the bindings still need tearing down.
    dir: Option<String>,
    /// What to call this in messages and toasts.
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
/// survives closed; refuses if the worktree holds work that exists nowhere
/// else (`purge` is the only true row delete). The single delete path. The
/// row closes last, only if the worktree really went; a guarded refusal
/// returns `Blocked` with everything untouched, and PTYs die only past the
/// guards — dropping records up front made a blocked removal look clean.
pub fn delete_task_blocking(
    app: &tauri::AppHandle,
    target: DeleteTarget,
    force: bool,
    outcome: Option<tt_store::TaskOutcome>,
    purge: bool,
) -> Result<TaskDeleteOutcome, String> {
    let Resolved { board_id, dir, label } = resolve_delete_target(app, target)?;

    // Purge: the only hard delete, row-only — a bound row refuses, since
    // deleting it would orphan the checkout on disk.
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

    // No worktree: nothing to guard and nothing to tear down, so the row is
    // the whole task — close it in place. Everything else runs the shared
    // sequence.
    let Some(dir) = dir.as_deref() else {
        let mut messages = Vec::new();
        if let Some(id) = board_id {
            let outcome = outcome.unwrap_or_else(|| inferred_outcome_for(app, Some(id), None));
            crate::store::close_task_row(app, id, outcome)?;
            messages.push(format!("closed the board task as {}", outcome.as_str()));
        }
        return Ok(TaskDeleteOutcome::Deleted { name: label, messages });
    };

    // Decide the outcome before anything is destroyed: the row's evidence is
    // read now, recorded at step 5 (after the worktree is gone).
    let outcome = outcome.unwrap_or_else(|| inferred_outcome_for(app, board_id, Some(dir)));

    // A gone directory can't resolve, so `root` stays `None` — safe **only**
    // because `TearDownBindings` skips the removal step for a missing dir;
    // `remove_task` with `root: None` would re-discover a root from this
    // process's cwd and could hit a same-named worktree elsewhere.
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
        // The dir came out of the app's own store or the rail, never a typed
        // name, so a missing one means the record outlived the checkout — the
        // record is exactly what still needs clearing.
        on_missing: tt_agentboard::task_removal::MissingDir::TearDownBindings,
    };

    let outcome = tt_agentboard::task_removal::remove_task_and_bindings(removal, &mut hooks);
    // Released however the removal ended. A *refusal* is the case that matters:
    // the row is still there with its worktree intact, so it must go back to
    // reading as an ordinary row rather than staying stuck on `removing`.
    set_phase(app, |p| p.clear(dir));
    let outcome = outcome.map_err(|e| e.to_string())?;

    match outcome {
        tt_agentboard::task_removal::Outcome::Removed { messages, .. } => {
            // Re-emit either way: a fleet-discovered (never-tracked) task also
            // drops off the rail on the next recompute, so don't make the user
            // wait a poll.
            app.state::<crate::agentboard::Ab>().emit.notify_one();
            refresh_all_git_info_in_background(app);
            Ok(TaskDeleteOutcome::Deleted { name: label, messages })
        }
        // A refusal ends here: nothing was removed — not the worktree, not the
        // panes, not the row — so the user can act on the blocker and retry
        // from exactly where they were.
        tt_agentboard::task_removal::Outcome::Blocked { name, blocked, messages } => {
            Ok(TaskDeleteOutcome::Blocked {
                name,
                blockers: blocked.iter().map(Blocker::from).collect(),
                messages,
            })
        }
    }
}

/// The outcome when the caller didn't pass one: the row's own evidence
/// (`inferred_outcome`, merged PR ⇒ done), else done. Covers MCP callers;
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

/// The app's half of the removal sequence: the two steps that need the live
/// process, which is exactly why they are hooks rather than shared code.
struct AppRemovalHooks<'a> {
    app: &'a tauri::AppHandle,
    dir: &'a str,
}

impl tt_agentboard::task_removal::RemovalHooks for AppRemovalHooks<'_> {
    fn on_phase(&mut self, phase: RemovePhase) {
        // The record (and so the row) survives until the close at the very
        // end, reporting each step as it runs.
        set_phase(self.app, |p| p.removing(self.dir, phase.label()));

        // `StoppingSessions` doubles as the removal's go/no-go moment (see
        // `RemovalHooks::on_phase`), so the PTY kill anchors to it. Locks
        // scoped tight: never hold the engine lock across a subprocess.
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
        // Resolved while the owner's cached worktree list still names this
        // dir — the staleness that makes the lookup work is what the
        // invalidate below fixes.
        let owner = engine.find_worktree_owner(self.dir);
        let closed_ids = engine.close_folder(self.dir);
        if !closed_ids.is_empty() {
            notes.push(format!(
                "closed {} session{} and their panes/windows",
                closed_ids.len(),
                if closed_ids.len() == 1 { "" } else { "s" }
            ));
        }
        // The row itself is the task record's business and outlives the
        // directory by design — all that has to go here is the cached git info
        // for a path that no longer answers. See `Engine::drop_git_cache`.
        engine.drop_git_cache(self.dir);
        // …and the *owner's* entry, whose cached `linked_worktree_dirs`
        // still names the gone directory until the TTL lets a recompute
        // through. Invalidating closes that window on the next tick instead
        // of a minute later.
        if let Some(owner) = owner {
            engine.invalidate_git(&owner);
        }
        notes
    }
}

/// Reaches the board row through the app's shared store — locking only for the
/// delete itself, never across the worktree removal (see
/// [`tt_agentboard::task_removal::BoardRows`]).
struct AppBoardRows<'a> {
    app: &'a tauri::AppHandle,
    /// The row the caller already resolved. Preferred over a dir lookup,
    /// which can quietly miss (trailing slash, symlink) and leave the very
    /// row the user asked to delete in place.
    board_id: Option<i64>,
}

impl tt_agentboard::task_removal::BoardRows for AppBoardRows<'_> {
    fn close_task_for_worktree(
        &self,
        dir: &str,
        outcome: tt_store::TaskOutcome,
        _now_ms: i64,
    ) -> Option<String> {
        // Store errors become a note, never silence — "nothing was bound"
        // must not stand in for "the store wouldn't answer".
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

/// The Tauri command over [`delete_task_blocking`] — see its doc. Exactly
/// one of `id`/`dir` identifies the task; `outcome` omitted lets the row's
/// own evidence decide; `purge` is the explicit permanent delete. Off the
/// main thread.
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

    // A span for the command boundary's own duration. `outcome` covers all
    // three endings (a refusal looks like success in an `is_ok` log); `force`
    // rides along — the one entry that can have destroyed uncommitted work.
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

/// Stop whatever is listening on `port` — the `foreignPort` blocker's remedy.
/// `ops::stop_task_port` refuses any port the task doesn't claim in its own
/// `.env`, which keeps this from being a UI-reachable "kill any port"
/// primitive. SIGTERM, then SIGKILL if still held.
#[tauri::command]
pub async fn task_stop_port(dir: String, port: u16) -> Result<String, String> {
    use tracing::Instrument as _;

    // Signals processes, so it gets its own record. `.instrument`, not a
    // held `enter()` guard — an entered span across an `.await` attributes
    // whatever else runs on this thread to it.
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
                // One decision for both log field and toast. Nothing
                // signaled = the port was already free.
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
