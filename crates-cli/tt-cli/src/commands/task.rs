//! `tt task` — worktree-task lifecycle over any git checkout.
//!
//! Thin CLI shell: creation/rendering/removal all live in `tt_tasks::ops`
//! (shared with the app's `task_create`/`task_delete` commands). See the
//! tt-tasks crate docs for the convention and the `${tt:...}` template
//! grammar.

use std::fs;
use std::path::Path;

use tt_agentboard::task_removal;
// The clock read at the command boundary — the store, the removal sequence and
// the staleness math all take injected instants.
use tt_config::now_ms;
use tt_tasks::envfile;
use tt_tasks::ops::{self, CleanOpts, CreateOpts, RemoveOpts, TaskRoot};

use crate::cli::TaskCommands;
use crate::ui;

pub fn run(command: TaskCommands) -> i32 {
    let result = match command {
        TaskCommands::New { title, repo, status, notes, goal, branch, base, json } => cmd_new(
            &title,
            &repo,
            &status,
            notes.as_deref(),
            goal.as_deref(),
            branch.as_deref(),
            base.as_deref(),
            json,
        ),
        TaskCommands::Ls { json, stale, root } => cmd_ls(json, stale, root.as_deref()),
        TaskCommands::Rm { name, force, outcome, root } => {
            cmd_rm(&name, force, outcome.as_deref(), root.as_deref())
        }
        TaskCommands::Init { root } => cmd_init(root.as_deref()),
        TaskCommands::Env { name, root } => cmd_env(&name, root.as_deref()),
        TaskCommands::Ports { probe, json, root } => cmd_ports(probe, json, root.as_deref()),
        TaskCommands::Clean { dry_run, json, root } => cmd_clean(dry_run, json, root.as_deref()),
        // Nudge reports through its own `hook.nudge` event on every path — the
        // hook that calls it discards output — so it owns its exit code rather
        // than sharing this group's `Result<(), String>`.
        TaskCommands::Nudge(args) => return crate::commands::nudge::run(args),
    };
    match result {
        Ok(()) => 0,
        Err(message) => {
            ui::error(&message);
            1
        }
    }
}

/// Remove a worktree task and everything bound to it, through the one shared sequence
/// in [`tt_agentboard::task_removal`]; the CLI passes no hooks, the app passes its own
/// and gets identical ordering. `None` outcome infers from the row's own evidence.
fn remove_task_fully(
    opts: &RemoveOpts,
    dir: &Path,
    checkout: &Path,
    outcome: Option<tt_store::TaskOutcome>,
    on_missing: task_removal::MissingDir,
) -> Result<task_removal::Outcome, String> {
    let store = board_store_for_removal(checkout, dir);
    let now_ms = now_ms();
    let outcome = outcome.unwrap_or_else(|| {
        store
            .as_ref()
            .and_then(|s| s.task_for_worktree_dir(&dir.to_string_lossy()).ok().flatten())
            .map(|row| row.inferred_outcome())
            .unwrap_or(tt_store::TaskOutcome::Done)
    });
    let removal = task_removal::TaskRemoval {
        opts,
        dir,
        repos_path: &tt_agentboard::repos::default_repos_path(),
        rows: store.as_ref().map(|s| s as &dyn task_removal::BoardRows),
        outcome,
        now_ms,
        on_missing,
    };
    task_removal::remove_task_and_bindings(removal, &mut task_removal::NoHooks)
        .map_err(|e| e.to_string())
}

/// Open the board store scoped to `dir` (instance state, tt.db included, nests
/// per-checkout). `None` on a store that won't open: the worktree removal has already
/// happened by then, and failing now would report a real removal as a failure.
fn board_store_for(dir: &Path) -> Option<tt_store::Store> {
    let scope = tt_config::task_scope_from_dir(dir);
    let path = tt_config::store_db_path_for_scope(scope.as_deref()).ok()?;
    tt_store::Store::open(&path).ok()
}

/// Resolve whichever board store actually holds the row bound to `dir`: normally
/// `checkout`, but an instance run from inside another task's worktree scopes there,
/// hence the ambient cwd fallback. Deliberately *not* `task_scope_from_dir(dir)` —
/// `state_cleanup` wipes that scope wholesale, so it would find a row a heartbeat
/// before its database is deleted.
fn board_store_for_removal(checkout: &Path, dir: &Path) -> Option<tt_store::Store> {
    let dir_s = dir.to_string_lossy();
    let has_row = |s: &tt_store::Store| matches!(s.task_for_worktree_dir(&dir_s), Ok(Some(_)));
    let primary = board_store_for(checkout);
    if primary.as_ref().is_some_and(has_row) {
        return primary;
    }
    let ambient = std::env::current_dir().ok().and_then(|cwd| board_store_for(&cwd));
    if ambient.as_ref().is_some_and(has_row) {
        return ambient;
    }
    // Neither has the row (common — many worktrees have no bound task): keep the
    // primary-anchored store.
    primary.or(ambient)
}

/// Steps 4 and 5 of the removal sequence, for `tt task clean` (bulk removal has already
/// taken each worktree off disk by then). **Returns** notes rather than printing —
/// `ui::warning` shares stdout with `--json`'s document, so the caller folds them in.
fn after_removal(checkout: &Path, dir: &Path) -> Vec<String> {
    let store = board_store_for(checkout);
    task_removal::remove_bindings(
        &tt_agentboard::repos::default_repos_path(),
        store.as_ref().map(|s| s as &dyn task_removal::BoardRows),
        dir,
        // `clean` only sweeps *finished* tasks — landed by evidence — so the
        // close is always a done, never an abandonment.
        tt_store::TaskOutcome::Done,
        now_ms(),
    )
}

/// Create a task (the unit of work): a board-task row PLUS its worktree, in one shot.
/// Same store path as the app's `+` flow and MCP `task_create`, same
/// `ops::create_task` — those two flows unified behind one verb.
#[allow(clippy::too_many_arguments)] // mirrors `TaskCommands::New`'s own flags 1:1
fn cmd_new(
    title: &str,
    repo: &str,
    status: &str,
    notes: Option<&str>,
    goal: Option<&str>,
    branch: Option<&str>,
    base: Option<&str>,
    json: bool,
) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("a task needs a title".to_string());
    }

    // Resolved by name or dir, exactly as MCP `task_create` does.
    let repos = tt_agentboard::repos::load_repos(&tt_agentboard::repos::default_repos_path());
    let entries = tt_agentboard::repos::repo_entries(&repos);
    let repo_dir = match entries.iter().find(|e| e.dir == repo || e.name == repo) {
        Some(e) => e.dir.clone(),
        // A repo not on the rail is still usable when it names a real checkout on disk.
        None if Path::new(repo).is_dir() => repo.to_string(),
        None => {
            return Err(format!("unknown repo {repo:?} — track it on the Agentboard rail first"));
        }
    };

    // The branch defaults to a slug of the title; the task folder slugs it again.
    let branch = match branch.map(str::trim).filter(|b| !b.is_empty()) {
        Some(b) => b.to_string(),
        None => {
            let slug = tt_git::branch_name::slug(title);
            if slug.is_empty() {
                return Err("cannot derive a branch from the title — pass --branch".to_string());
            }
            slug
        }
    };

    // `--repo` may name any dir inside the checkout, including one of its own worktrees.
    // Bind the row to the main checkout as `ops::create_task` does: a nested path in
    // `worktree_repo_root` keys the card to a Board swimlane matching no repo.
    let sr = ops::discover_root(Some(Path::new(&repo_dir))).map_err(|e| e.to_string())?;
    let repo_root = sr.checkout.to_string_lossy().to_string();

    let opts = CreateOpts {
        root: Some(sr.checkout.clone()),
        branch,
        base: base.map(str::to_string),
        run_setup: true,
    };
    // Text mode only — `ui::info` writes to stdout, which `--json`'s document owns.
    // Worth printing because the setup step can run for minutes in silence.
    let created = ops::create_task(&opts, now_ms(), &mut |phase| {
        if !json {
            ui::info(phase.label());
        }
    })
    .map_err(|e| e.to_string())?;
    // Collected, not printed: `ui::warning` also writes to stdout, and a store
    // contended by another `tt` is exactly when this path fires. Warnings still reach
    // the caller — as `ui::warning` lines in text mode, as `"warnings"` in `--json`.
    let mut warnings = created.warnings.clone();
    let dir_s = created.dir.to_string_lossy().to_string();

    // A store that can't open (or a rejected status) is a soft failure: the worktree
    // exists and is usable, so warn rather than abort.
    let task_id =
        match record_board_task(title, status, notes, goal, &repo_root, &created.branch, &dir_s) {
            Ok(id) => Some(id),
            Err(e) => {
                warnings
                    .push(format!("worktree created, but the board task was not recorded: {e}"));
                None
            }
        };

    if json {
        let ports: serde_json::Map<String, serde_json::Value> =
            created.ports.iter().map(|(k, p)| (k.clone(), (*p).into())).collect();
        let value = serde_json::json!({
            "taskId": task_id,
            "title": title,
            "status": status,
            "repo": repo_root,
            "name": created.name,
            "dir": dir_s,
            "branch": created.branch,
            "base": created.base,
            "baseLabel": created.base_label,
            "ports": ports,
            "inheritedKeys": created.inherited,
            "warnings": warnings,
        });
        println!("{}", serde_json::to_string_pretty(&value).unwrap_or_default());
    } else {
        for warning in &warnings {
            ui::warning(warning);
        }
        match task_id {
            Some(id) => ui::success(&format!(
                "created task #{id} \"{title}\" ({status}) on branch {}",
                created.branch
            )),
            None => ui::success(&format!("created worktree on branch {}", created.branch)),
        }
        for (key, port) in &created.ports {
            println!("  {key}={port}");
        }
        if created.inherited > 0 {
            println!("  inherited {} key(s) from a sibling checkout", created.inherited);
        }
        println!("task: {dir_s}");
    }
    Ok(())
}

/// Write the #339 board-task row and bind it to `repo_root` + the new worktree. Same
/// store path as the app's `store_add_task` + `store_task_set_worktree`.
fn record_board_task(
    title: &str,
    status: &str,
    notes: Option<&str>,
    goal: Option<&str>,
    repo_root: &str,
    branch: &str,
    dir: &str,
) -> Result<i64, String> {
    let now_ms = now_ms();
    let store = tt_store::Store::open_default().map_err(|e| e.to_string())?;
    let task = store.add_task(title, status, notes, goal, now_ms).map_err(|e| e.to_string())?;
    store
        .set_task_worktree(task.id, repo_root, None, Some(branch), Some(dir))
        .map_err(|e| e.to_string())?;
    Ok(task.id)
}

/// Resolve `name` to a checkout dir: `primary` or a dir under `.claude/worktrees/`.
fn checkout_dir(sr: &TaskRoot, name: &str) -> Result<std::path::PathBuf, String> {
    if name == "primary" || name == sr.checkout.file_name().and_then(|n| n.to_str()).unwrap_or("") {
        return Ok(sr.checkout.clone());
    }
    let dir = sr.task_dir(name);
    if dir.is_dir() {
        Ok(dir)
    } else {
        Err(format!("no task {name} in {}", sr.tasks_dir().display()))
    }
}

fn cmd_init(root: Option<&Path>) -> Result<(), String> {
    let sr = ops::discover_root(root).map_err(|e| e.to_string())?;
    let report = ops::init_repo(&sr, now_ms()).map_err(|e| e.to_string())?;

    println!("template: {}", report.template.display());
    if report.sidecar_created {
        println!(
            "  created (empty) — add ${{tt:port A-B}} tokens there, or commit a tokenized \
             .env.example instead"
        );
    }
    if report.gitignore_added {
        println!("gitignore: added .env");
    }
    for warning in &report.render.warnings {
        ui::warning(warning);
    }
    for (key, port) in &report.render.ports {
        println!("  {key}={port}");
    }
    ui::success(&format!(
        "rendered primary/.env ({} reused, {} fresh claim(s))",
        report.render.reused, report.render.claimed
    ));
    Ok(())
}

fn cmd_env(name: &str, root: Option<&Path>) -> Result<(), String> {
    let sr = ops::discover_root(root).map_err(|e| e.to_string())?;
    let dir = checkout_dir(&sr, name)?;
    let summary = ops::render_task_env(&sr, &dir, None, now_ms()).map_err(|e| e.to_string())?;
    for warning in &summary.warnings {
        ui::warning(warning);
    }
    ui::success(&format!(
        "rendered {name}/.env ({} reused, {} fresh claim(s), {} extra key(s) preserved)",
        summary.reused, summary.claimed, summary.preserved
    ));
    Ok(())
}

fn cmd_ls(json: bool, stale: Option<u64>, root: Option<&Path>) -> Result<(), String> {
    let sr = ops::discover_root(root).map_err(|e| e.to_string())?;
    let _ = ops::git_checkout(&sr.checkout, &["worktree", "prune"]);
    let mut checkouts: Vec<(String, std::path::PathBuf, bool)> =
        vec![("primary".to_string(), sr.checkout.clone(), true)];
    checkouts.extend(sr.tasks().into_iter().map(|(name, dir)| (name, dir, false)));

    let refs = ops::base_refs(&sr.checkout);
    // One clock read at the command boundary; `staleness::assess` reads none of its own.
    let now_unix = now_ms() / 1000;

    struct Row {
        name: String,
        branch: String,
        detached: bool,
        broken: bool,
        work: tt_tasks::landed::WorkState,
        /// Rendered STATE cell — each arm below knows which vocabulary applies to it.
        state: String,
        /// Only computed under `--stale`: one extra git call per row.
        staleness: Option<tt_tasks::Staleness>,
        ports: Vec<(String, String)>,
        primary: bool,
    }

    let mut rows = Vec::new();
    for (name, dir, is_primary) in checkouts {
        // One cached `tt_git::repo` handle per row instead of three `git` spawns; a
        // repo that won't open *is* the broken case.
        let repo = ops::repo_at(&dir).ok();
        let broken = repo.is_none();
        let (branch, detached, work, state) = if broken {
            ("BROKEN".to_string(), false, Default::default(), "broken".to_string())
        } else {
            let repo = repo.expect("checked above");
            let current = repo.head_branch().unwrap_or_default();
            let uncommitted = ops::uncommitted_count(&dir);
            if current.is_empty() {
                // A detached HEAD leaves the landed axes unanswerable, but the orphan
                // count is base-independent and is exactly the work removal destroys —
                // defaulting it to 0 would report `holdsWork: false` for unreachable work.
                let sha = repo
                    .head_id()
                    .map(|id| id.to_hex_with_len(7).to_string())
                    .unwrap_or_else(|| "?".to_string());
                let work = tt_tasks::landed::WorkState {
                    uncommitted,
                    orphaned: ops::orphaned_count(&dir),
                    ..Default::default()
                };
                let state = work.headline();
                (format!("detached:{sha}"), true, work, state)
            } else if current == refs.base {
                // A checkout on the base branch has no line of work to judge; the landed
                // vocabulary would label the main checkout "no commits".
                let work = tt_tasks::landed::WorkState { uncommitted, ..Default::default() };
                let state = match uncommitted {
                    0 => "clean".to_string(),
                    n => format!("{n} uncommitted"),
                };
                (current, false, work, state)
            } else {
                let work = ops::work_state(
                    &refs,
                    &dir,
                    &format!("refs/heads/{current}"),
                    uncommitted,
                    ops::orphaned_count(&dir),
                );
                let state = work.headline();
                (current, false, work, state)
            }
        };
        // Recency is a separate axis from landed-vs-not; `staleness::assess` combines
        // them. A broken checkout has no git to ask.
        let staleness = stale.map(|threshold| {
            let last = if broken { None } else { ops::last_own_commit_unix(&dir, &refs.base) };
            tt_tasks::assess_staleness(last, now_unix, threshold, work.landed.is_some())
        });
        let env_text = fs::read_to_string(dir.join(".env")).unwrap_or_default();
        // The same claim filter the removal guard, the sibling scan and the app's MCP
        // bind use — a hand-rolled one here counted `FOO_PORT=0` as a claim.
        // `_in_order`, not `_by_key`: the column stays in `.env` order.
        let ports: Vec<(String, String)> = envfile::port_claims_in_order(&env_text)
            .into_iter()
            .map(|(k, p)| (k, p.to_string()))
            .collect();
        rows.push(Row {
            name,
            branch,
            detached,
            broken,
            work,
            state,
            staleness,
            ports,
            primary: is_primary,
        });
    }

    // `--stale` is a query: keep only the rows that tripped the threshold.
    if stale.is_some() {
        rows.retain(|r| r.staleness.is_some_and(|s| s.stale));
    }

    if json {
        let items: Vec<serde_json::Value> = rows
            .iter()
            .map(|r| {
                let port_map: serde_json::Map<String, serde_json::Value> =
                    r.ports.iter().map(|(k, v)| (k.clone(), v.clone().into())).collect();
                let mut item = serde_json::json!({
                    "name": r.name,
                    "branch": r.branch,
                    "detached": r.detached,
                    "broken": r.broken,
                    // Two axes: work that dies with the task, vs commits base never saw.
                    "uncommitted": r.work.uncommitted,
                    "unlanded": r.work.unlanded,
                    "orphaned": r.work.orphaned,
                    "landed": r.work.landed.map(|v| v.label()),
                    "holdsWork": r.work.holds_work(),
                    "state": r.state,
                    "ports": port_map,
                    "primary": r.primary,
                });
                // Absent unless `--stale` computed it, so the default document stays
                // byte-identical.
                if let Some(s) = r.staleness {
                    let map = item.as_object_mut().expect("json! built an object");
                    map.insert("ageDays".into(), s.age_days.into());
                    map.insert("stale".into(), s.stale.into());
                }
                item
            })
            .collect();
        println!("{}", serde_json::to_string_pretty(&items).unwrap_or_default());
    } else if let Some(threshold) = stale.filter(|_| rows.is_empty()) {
        // An empty table reads as "the tool didn't run".
        println!("no stale tasks (no commits in {threshold}+ days, still unlanded)");
    } else {
        // `--stale` slots an AGE column ahead of PORTS. Columns are sized to the actual
        // rows: task names are branch slugs, and one overflowing a fixed width shifted
        // every later column out of alignment.
        let mut headers: Vec<&str> = vec!["CHECKOUT", "BRANCH", "STATE"];
        if stale.is_some() {
            headers.push("AGE");
        }
        headers.push("PORTS");
        let cells: Vec<Vec<String>> = rows
            .iter()
            .map(|r| {
                let ports: Vec<String> = r.ports.iter().map(|(k, v)| format!("{k}={v}")).collect();
                let mut row = vec![r.name.clone(), r.branch.clone(), r.state.clone()];
                if stale.is_some() {
                    let age = r
                        .staleness
                        .and_then(|s| s.age_days)
                        .map(|d| format!("{d}d"))
                        .unwrap_or_else(|| "-".to_string());
                    row.push(age);
                }
                row.push(ports.join(" "));
                row
            })
            .collect();
        // Chars, not bytes: a multi-byte branch name must not over-pad its column.
        let width = |i: usize| {
            cells
                .iter()
                .map(|c| c[i].chars().count())
                .chain([headers[i].chars().count()])
                .max()
                .unwrap_or(0)
        };
        let last = headers.len() - 1;
        let print_row = |cells: &[String]| {
            let mut line = String::new();
            for (i, cell) in cells.iter().enumerate() {
                if i == last {
                    line.push_str(cell);
                } else {
                    line.push_str(&format!("{cell:<width$}  ", width = width(i)));
                }
            }
            println!("{}", line.trim_end());
        };
        print_row(&headers.iter().map(|h| h.to_string()).collect::<Vec<_>>());
        for c in &cells {
            print_row(c);
        }
    }
    Ok(())
}

fn cmd_rm(
    name: &str,
    force: bool,
    outcome: Option<&str>,
    root: Option<&Path>,
) -> Result<(), String> {
    let sr = ops::discover_root(root).map_err(|e| e.to_string())?;
    let dir = sr.task_dir(name);
    let opts = RemoveOpts { root: root.map(Path::to_path_buf), name: name.to_string(), force };
    // clap's value_parser guarantees the spelling; parse never fails here.
    let outcome = outcome.and_then(tt_store::TaskOutcome::parse);
    // The name came from the command line, so a missing worktree is a typo to report.
    match remove_task_fully(&opts, &dir, &sr.checkout, outcome, task_removal::MissingDir::Fail)? {
        task_removal::Outcome::Removed { name, messages } => {
            for message in messages {
                ui::warning(&message);
            }
            ui::success(&format!("removed {name} (ports released with its .env)"));
            Ok(())
        }
        task_removal::Outcome::Blocked { name, blocked, messages } => {
            Err(refusal(&name, &blocked, &messages))
        }
    }
}

/// Render a guard refusal for the terminal: each reason with its remedy, since a reason
/// alone is a dead end rather than a decision. Sole owner of this text — `Blocked`
/// carries typed reasons so each shell formats its own. `messages` are caveats from
/// before the verdict — chiefly a failed `fetch --prune`, since a refusal judged against
/// stale `origin/*` refs otherwise reads exactly like a real one.
fn refusal(name: &str, blocked: &[tt_tasks::RmBlocked], messages: &[String]) -> String {
    let mut out = format!("refused to remove {name}:");
    for note in messages {
        out.push_str(&format!("\n  note: {note}"));
    }
    for reason in blocked {
        out.push_str(&format!("\n  {reason}\n    → {}", reason.remedy()));
    }
    let loses_work = blocked.iter().any(tt_tasks::RmBlocked::loses_work);
    out.push_str(&format!(
        "\n  Re-run with --force to remove anyway{}.",
        if loses_work { " — this discards the work above for good" } else { "" }
    ));
    out
}

fn cmd_clean(dry_run: bool, json: bool, root: Option<&Path>) -> Result<(), String> {
    let bases = tt_config::instance_state_bases().map_err(|e| e.to_string())?;
    let opts = CleanOpts {
        root: root.map(Path::to_path_buf),
        dry_run,
        scope_parents: bases.scope_parents().to_vec(),
    };
    let report =
        ops::clean_tasks(&opts, tt_config::task_scope_from_dir).map_err(|e| e.to_string())?;

    // Drop each removed task's now-dangling repos.json entry so collectors don't keep
    // retrying a gone dir. Collected, not printed: `ui::warning` shares stdout with
    // `--json`'s document (the hazard fixed in `cmd_new`).
    let mut warnings = report.warnings.clone();
    if !dry_run {
        for task in &report.removed {
            for note in after_removal(&task.checkout, &task.dir) {
                warnings.push(format!("{}: {note}", task.name));
            }
        }
    }

    // Stores that survive the sweep: the unscoped daily driver's plus every remaining
    // checkout's. Removed scopes went wholesale with their state dir.
    let mut store_dirs = vec![bases.agentboard_dir(None)];
    store_dirs.extend(report.live_scopes.iter().map(|s| bases.agentboard_dir(Some(s))));
    let mut prunes = Vec::new();
    for dir in store_dirs {
        match tt_agentboard::cleanup::prune_store(&dir, dry_run) {
            Ok(Some(prune)) => prunes.push(prune),
            Ok(None) => {}
            Err(e) => {
                warnings.push(format!("agentboard prune failed for {}: {e}", dir.display()));
            }
        }
    }

    if json {
        let value = serde_json::json!({
            "dryRun": report.dry_run,
            "removed": report.removed.iter().map(|s| serde_json::json!({
                "name": s.name,
                "branch": s.branch,
                "reason": s.reason,
                "messages": s.messages,
            })).collect::<Vec<_>>(),
            "kept": report.kept.iter().map(|s| serde_json::json!({
                "name": s.name,
                "branch": s.branch,
                "why": s.why,
            })).collect::<Vec<_>>(),
            "sweptStateDirs": report.swept_state_dirs.iter()
                .map(|p| p.display().to_string()).collect::<Vec<_>>(),
            "sweptPortRegistries": report.swept_port_registries.iter()
                .map(|p| p.display().to_string()).collect::<Vec<_>>(),
            "agentboard": prunes.iter().map(|p| serde_json::json!({
                "dir": p.dir.display().to_string(),
                "sessionFoldersDropped": p.session_folders_dropped,
                "windowsDropped": p.windows_dropped,
                "panesDropped": p.panes_dropped,
            })).collect::<Vec<_>>(),
            "warnings": warnings,
        });
        println!("{}", serde_json::to_string_pretty(&value).unwrap_or_default());
        return Ok(());
    }

    for warning in &warnings {
        ui::warning(warning);
    }
    let verb = if dry_run { "would remove" } else { "removed" };
    for task in &report.removed {
        ui::success(&format!("{verb} {} ({} — {})", task.name, task.branch, task.reason));
        for message in &task.messages {
            println!("  {message}");
        }
    }
    for task in &report.kept {
        println!("kept {} ({}): {}", task.name, task.branch, task.why.join("; "));
    }
    if !report.swept_state_dirs.is_empty() {
        let verb = if dry_run { "would sweep" } else { "swept" };
        println!("{verb} stale instance state:");
        for dir in &report.swept_state_dirs {
            println!("  {}", dir.display());
        }
    }
    if !report.swept_port_registries.is_empty() {
        let verb = if dry_run { "would sweep" } else { "swept" };
        println!("{verb} port registries of removed checkouts:");
        for path in &report.swept_port_registries {
            println!("  {}", path.display());
        }
    }
    for prune in &prunes {
        let verb = if dry_run { "would prune" } else { "pruned" };
        println!(
            "{verb} agentboard store {}: {} window(s), {} pane(s), {} session folder(s)",
            prune.dir.display(),
            prune.windows_dropped,
            prune.panes_dropped,
            prune.session_folders_dropped.len()
        );
    }
    if report.removed.is_empty()
        && report.swept_state_dirs.is_empty()
        && report.swept_port_registries.is_empty()
        && prunes.is_empty()
    {
        println!("nothing to clean");
    }
    Ok(())
}

/// The repo's port picture, or a single-port listener probe. `scripts/task-port.mjs`
/// delegates its freeness checks to the probe, so the bind semantics
/// (`ops::port_occupied` — both loopback stacks, EACCES) have one implementation.
fn cmd_ports(probe: Option<u16>, json: bool, root: Option<&Path>) -> Result<(), String> {
    if let Some(port) = probe {
        let occupied = ops::port_occupied(port);
        if json {
            println!("{}", serde_json::json!({ "port": port, "occupied": occupied }));
        } else {
            println!("port {port}: {}", if occupied { "occupied" } else { "free" });
        }
        return Ok(());
    }

    let sr = ops::discover_root(root).map_err(|e| e.to_string())?;
    let report = ops::port_report(&sr);
    if json {
        println!("{}", serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?);
        return Ok(());
    }
    if report.is_empty() {
        println!("no port claims in {}", sr.checkout.display());
        return Ok(());
    }
    println!("{:<7} {:<24} {:<20} {:<13} LISTENER", "PORT", "OWNER", "VAR", "SOURCE");
    for row in &report {
        println!(
            "{:<7} {:<24} {:<20} {:<13} {}",
            row.port,
            row.owner,
            row.var,
            row.source,
            if row.occupied { "yes" } else { "-" }
        );
    }
    Ok(())
}
