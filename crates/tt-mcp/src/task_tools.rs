use super::*;

impl Dispatcher {
    /// Open board tasks in board order, with their issue/PR links and repo/worktree binding.
    pub(crate) fn task_list(&self) -> Result<Value, String> {
        let tasks = self.store.open_tasks().map_err(|e| e.to_string())?;
        Ok(json!({ "tasks": tasks }))
    }

    /// One task by id, done tasks included.
    pub(crate) fn task_status(&self, args: &Value) -> Result<Value, String> {
        let id = args
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| "missing required argument: id".to_string())?;
        // Only a genuinely absent row is "no such task": a busy-timeout read as a vanished task
        // makes a session go create a duplicate.
        let task = self.store.task_by_id(id).map_err(|error| match error {
            tt_store::Error::TaskNotFound(id) => format!("no task with id {id}"),
            other => format!("could not read task {id}: {other}"),
        })?;
        Ok(json!({ "task": task }))
    }

    /// Record what an agent reported when it finished, on the task's own row — the worktree and its
    /// scrollback die when the user confirms the task. Not folded into `notes`: [`task_prompt`] feeds
    /// notes into a `task_start` prompt, so a summary there would return as instructions.
    pub(crate) fn task_summary(&self, args: &Value, now_ms: i64) -> Result<Value, String> {
        let id = args
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| "missing required argument: id".to_string())?;
        let summary = args
            .get("summary")
            .and_then(Value::as_str)
            .ok_or_else(|| "missing required argument: summary".to_string())?;
        // As in `task_status`: a busy db must not read as a vanished row.
        let task =
            self.store.set_task_summary(id, summary, now_ms).map_err(|error| match error {
                tt_store::Error::TaskNotFound(id) => format!("no task with id {id}"),
                other => format!("could not record the summary for task {id}: {other}"),
            })?;
        Ok(json!({ "task": task }))
    }

    /// Re-read the branch the task's worktree is on and record it — the fix after a
    /// `git switch -c` inside the task. Refusals are errors: none has a force to retry with.
    pub(crate) fn task_sync(&self, args: &Value) -> Result<Value, String> {
        let id = args
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| "missing required argument: id".to_string())?;
        let resync =
            tt_tasks::ops::sync_task_branch(&self.store, id, "mcp").map_err(|e| {
                match (&e, e.remedy()) {
                    (tt_tasks::ops::SyncError::Store(tt_store::Error::TaskNotFound(id)), _) => {
                        format!("no task with id {id}")
                    }
                    (_, Some(remedy)) => format!("{e} — {remedy}"),
                    (_, None) => e.to_string(),
                }
            })?;
        let task = self.store.task_by_id(id).map_err(|e| e.to_string())?;
        let mut result = json!(resync);
        result["task"] = json!(task);
        Ok(result)
    }

    /// The same store path as the Agentboard `+` flow, so the task lands in that repo's swimlane
    /// at once (no worktree yet). `repo` is a GitHub `owner/repo` slug.
    pub(crate) fn task_create(&self, args: &Value, now_ms: i64) -> Result<Value, String> {
        let title = args
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .ok_or_else(|| "missing required argument: title".to_string())?;
        let text_arg = |key: &str| {
            args.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty())
        };
        let status = args.get("status").and_then(Value::as_str).unwrap_or("backlog");
        let notes = args.get("notes").and_then(Value::as_str);
        let goal = args.get("goal").and_then(Value::as_str);
        let origin = match text_arg("origin") {
            None => "agent",
            Some("park") => "park",
            Some(other) => return Err(format!("unknown origin: {other} (only \"park\")")),
        };

        // Case-insensitive, stamped with the tracked repo's own spelling: `christowles/x` must not
        // mint a second identity beside `ChrisTowles/x` and split one repo across two lanes.
        let (repo_root, repo) = match (text_arg("repo"), text_arg("dir")) {
            (Some(repo_arg), _) => self
                .store
                .tracked_repo_for_owner_repo(repo_arg)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| {
                    let slugs = self.store.repo_slugs().unwrap_or_default();
                    unknown_repo_message(repo_arg, &slugs)
                })?,
            (None, Some(dir)) => self
                .store
                .tracked_repo_for_dir(dir)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("{dir} is in no tracked repo"))?,
            (None, None) => return Err("missing required argument: repo (or dir)".to_string()),
        };

        let task =
            self.store.add_task(title, status, notes, goal, now_ms).map_err(|e| e.to_string())?;
        self.store
            .set_task_worktree(task.id, &repo_root, Some(&repo), None, None)
            .map_err(|e| e.to_string())?;
        let task = self.store.task_by_id(task.id).map_err(|e| e.to_string())?;
        tracing::info!(task_id = task.id, %repo, %status, origin, "task.created");
        Ok(json!({ "task": task }))
    }

    /// Mint the worktree, launch an agent on the goal. Each guard exists because its failure is
    /// silent or destructive: a second worktree abandons the running one; a closed task resurrects.
    pub(crate) fn task_start(&mut self, args: &Value) -> Result<Value, String> {
        let id = args
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| "missing required argument: id".to_string())?;
        let branch_arg =
            args.get("branch").and_then(Value::as_str).map(str::trim).filter(|b| !b.is_empty());
        let base = args
            .get("base")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|b| !b.is_empty())
            .map(str::to_string);

        // Availability before diagnosis: don't make a caller fix its arguments for a tool that can't run.
        if self.task_host.is_none() {
            return Err("task_start is unavailable: no task host is attached".to_string());
        }

        // `task_by_id` already distinguishes "no such row" from "couldn't answer".
        let task = self.store.task_by_id(id).map_err(|e| e.to_string())?;

        let req = task_start_request(&task, branch_arg, base)?;
        let branch = req.branch.clone();
        let host =
            self.task_host.as_ref().expect("checked above, before any of the row guards ran");
        host.start_task(req)?;

        Ok(json!({
            "status": "starting",
            "id": id,
            "text": task.text,
            "branch": branch,
        }))
    }
}

impl Dispatcher {
    pub(crate) fn task_delete(&mut self, args: &Value) -> Result<Value, String> {
        let id = args
            .get("id")
            .and_then(Value::as_i64)
            .ok_or_else(|| "missing required argument: id".to_string())?;
        let force = args.get("force").and_then(Value::as_bool).unwrap_or(false);
        let outcome = match args.get("outcome").and_then(Value::as_str) {
            None => None,
            Some(raw) => Some(
                tt_store::TaskOutcome::parse(raw)
                    .ok_or_else(|| format!("unknown outcome {raw:?} (done|abandoned)"))?,
            ),
        };
        let host = self
            .task_host
            .as_ref()
            .ok_or_else(|| "task_delete is unavailable: no task host is attached".to_string())?;

        // The host resolves the row to delete it anyway, so it names the task and diagnoses unknown ids.
        match host.delete_task(id, force, outcome)? {
            TaskDeletion::Deleted { name, messages } => {
                Ok(json!({ "status": "deleted", "id": id, "text": name, "messages": messages }))
            }
            TaskDeletion::Refused { name, blockers, messages } => Ok(json!({
                "status": "refused",
                "id": id,
                "text": name,
                "blockers": blockers,
                "messages": messages,
            })),
        }
    }

    /// `/done` as one call, so finishing a task is code rather than an agent's reading of a
    /// procedure: the task comes from the caller's checkout (closed rows included — a merge
    /// closes the card while the worktree lives on), the gate reads git and `gh` live, and
    /// the summary lands before the delete removes the caller's own pane.
    pub(crate) fn task_done(&mut self, args: &Value, now_ms: i64) -> Result<Value, String> {
        let dir = args
            .get("dir")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .ok_or_else(|| "missing required argument: dir".to_string())?;
        let summary = args
            .get("summary")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "missing required argument: summary".to_string())?;
        if self.task_host.is_none() {
            return Err("task_done is unavailable: no task host is attached".to_string());
        }
        let task = self.task_for_checkout(dir)?;
        let id = task.id;

        let worktree = task.worktree.as_ref().and_then(|w| w.dir.as_deref()).map(Path::new);
        let mut messages = Vec::new();
        if let Some(worktree) = worktree.filter(|w| w.is_dir()) {
            let branch = tt_tasks::ops::head_branch(worktree)
                .ok_or_else(|| format!("{} is on no branch", worktree.display()))?;
            let (blockers, notes) = tt_tasks::ops::finish_blockers(worktree, &branch);
            messages.extend(notes);
            if !blockers.is_empty() {
                return Ok(json!({
                    "status": "refused",
                    "id": id,
                    "text": task.text,
                    "blockers": blockers,
                    "messages": messages,
                }));
            }
            messages.extend(tt_tasks::ops::stop_own_listeners(worktree)?);
        }

        self.store.set_task_summary(id, summary, now_ms).map_err(|e| e.to_string())?;
        let host = self.task_host.as_ref().expect("checked above, before the task was resolved");
        let deletion = host.delete_task(id, false, Some(tt_store::TaskOutcome::Done))?;
        Ok(match deletion {
            TaskDeletion::Deleted { name, messages: more } => {
                messages.extend(more);
                json!({ "status": "deleted", "id": id, "text": name, "messages": messages })
            }
            TaskDeletion::Refused { name, blockers, messages: more } => {
                messages.extend(more);
                json!({
                    "status": "refused",
                    "id": id,
                    "text": name,
                    "blockers": blockers,
                    "messages": messages,
                })
            }
        })
    }

    /// The board task bound to the checkout containing `dir`. Walks up, since a session's cwd
    /// can sit below its worktree root; a main checkout matches nothing, which is the answer.
    pub(crate) fn task_for_checkout(&self, dir: &str) -> Result<tt_store::TaskItem, String> {
        self.find_task_for_checkout(dir)?.ok_or_else(|| {
            format!(
                "no board task is bound to {dir} — this is a main checkout or a worktree the \
                 board never tracked, so there is no task to finish here"
            )
        })
    }

    /// The task whose bound worktree contains `dir`, closed rows included.
    pub(crate) fn find_task_for_checkout(
        &self,
        dir: &str,
    ) -> Result<Option<tt_store::TaskItem>, String> {
        let given = Path::new(dir);
        if !given.is_absolute() {
            return Err(format!("dir must be an absolute path, got {dir:?}"));
        }
        let canonical = std::fs::canonicalize(given).ok();
        for start in std::iter::once(given).chain(canonical.as_deref()) {
            for candidate in start.ancestors() {
                let key = candidate.to_string_lossy();
                if let Some(task) =
                    self.store.task_for_worktree_dir(&key).map_err(|e| e.to_string())?
                {
                    return Ok(Some(task));
                }
            }
        }
        Ok(None)
    }

    /// Every other open task's changes against its base, and which of them `dir` also touches.
    /// With `dir`, only tasks of the same repo are listed and the caller's own task is left out.
    pub(crate) fn task_diff(&self, args: &Value) -> Result<Value, String> {
        use tt_tasks::overlap::{changes_since_base, overlap, task_base};

        let dir = args.get("dir").and_then(Value::as_str).map(str::trim).filter(|d| !d.is_empty());
        let caller = dir.map(|d| self.find_task_for_checkout(d)).transpose()?.flatten();
        let caller_root: Option<PathBuf> = match (&caller, dir) {
            (Some(task), _) => task.worktree.as_ref().map(|w| PathBuf::from(&w.repo_root)),
            (None, Some(d)) => tt_tasks::main_checkout_for(Path::new(d))
                .map(Path::to_path_buf)
                .or_else(|| tt_git::repo::discover_root(Path::new(d))),
            (None, None) => None,
        };
        let same_dir = |a: &Path, b: &Path| {
            a == b || std::fs::canonicalize(a).ok() == std::fs::canonicalize(b).ok()
        };
        let mine = dir.and_then(|d| {
            let root = caller_root.as_deref().unwrap_or(Path::new(d));
            changes_since_base(Path::new(d), &task_base(Path::new(d), root))
        });

        let mut tasks = Vec::new();
        for task in self.store.open_tasks().map_err(|e| e.to_string())? {
            if caller.as_ref().is_some_and(|c| c.id == task.id) {
                continue;
            }
            let Some(worktree) = task.worktree.as_ref() else {
                continue;
            };
            let Some(task_dir) = worktree.dir.as_deref().map(Path::new).filter(|d| d.is_dir())
            else {
                continue;
            };
            let root = Path::new(&worktree.repo_root);
            if caller_root.as_deref().is_some_and(|r| !same_dir(r, root)) {
                continue;
            }
            let Some(changes) = changes_since_base(task_dir, &task_base(task_dir, root)) else {
                continue;
            };
            let shared =
                mine.as_ref().map(|m| overlap(&m.files, &changes.files)).unwrap_or_default();
            tasks.push(json!({
                "id": task.id,
                "text": task.text,
                "branch": worktree.branch,
                "dir": task_dir.to_string_lossy(),
                "base": changes.base,
                "files": changes.files,
                "capped": changes.capped,
                "overlap": shared,
            }));
        }
        // Most collisions first: those are the ones worth reading before a rebase.
        tasks.sort_by_key(|t| std::cmp::Reverse(t["overlap"].as_array().map_or(0, Vec::len)));
        Ok(json!({ "mine": mine, "tasks": tasks }))
    }
}

/// `goal`, then `notes` under a header; `text` last. The Board's own "Start task" passed the
/// title alone, so an agent started on a task with a written goal had seen neither.
/// The guards and derivations `task_start` applies, shared with the app's queue
/// "Start" so both refuse and name branches identically.
pub fn task_start_request(
    task: &tt_store::TaskItem,
    branch_arg: Option<&str>,
    base: Option<String>,
) -> Result<TaskStartRequest, String> {
    let id = task.id;
    if task.closed {
        return Err(format!(
            "task {id} ({:?}) is closed — reopen it on the Board before starting it",
            task.text
        ));
    }
    let worktree = task.worktree.as_ref();
    if let Some(dir) = worktree.and_then(|w| w.dir.as_deref()) {
        return Err(format!(
            "task {id} ({:?}) already has a worktree at {dir} — starting it again would \
             abandon that one",
            task.text
        ));
    }
    let repo_root = worktree
        .map(|w| w.repo_root.clone())
        .filter(|root| !root.trim().is_empty())
        .ok_or_else(|| {
            format!(
                "task {id} ({:?}) isn't bound to a repo, so there's nothing to branch from",
                task.text
            )
        })?;

    // A task is named after its branch: slug the title, as `tt task new` does.
    let branch = match branch_arg {
        Some(b) => b.to_string(),
        None => {
            let slug = tt_git::branch_name::slug(&task.text);
            if slug.is_empty() {
                return Err(format!(
                    "couldn't derive a branch name from {:?} — pass `branch` explicitly",
                    task.text
                ));
            }
            slug
        }
    };

    // Goal plus notes — the handoff context — with the title as the last resort.
    let prompt = task_start_prompt(task);

    Ok(TaskStartRequest { id, text: task.text.clone(), repo_root, branch, base, prompt })
}

pub(crate) fn task_start_prompt(task: &tt_store::TaskItem) -> String {
    let goal = task.goal.as_deref().map(str::trim).filter(|g| !g.is_empty());
    let notes = task.notes.as_deref().map(str::trim).filter(|n| !n.is_empty());
    let head = goal.unwrap_or(task.text.trim());
    match notes {
        Some(notes) => format!("{head}\n\n## Notes\n\n{notes}"),
        None => head.to_string(),
    }
}

/// Names the argument and lists the tracked `owner/repo` slugs, so a caller can self-correct.
pub(crate) fn unknown_repo_message(repo: &str, slugs: &[String]) -> String {
    if slugs.is_empty() {
        return format!(
            "unknown repo: {repo} — no repos are tracked yet (add one on the app's Agentboard)"
        );
    }
    format!("unknown repo: {repo} — tracked repos: {}", slugs.join(", "))
}
