//! Guarded removal (`tt task rm`), the fleet-wide clean (`tt task clean`),
//! docker cleanup, and clearing a task's own stale dev server off one of its
//! claimed ports.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::claims::{port_occupied, port_registry_path, release_task_ports};
use super::{
    OpsError, Result, base_refs, dir_names, discover_root, git_checkout, orphaned_count,
    run_teardown, uncommitted_count, work_state,
};
use crate::envfile;
use crate::guards::{ForeignPort, RmBlocked};

#[derive(Debug, Default)]
pub struct RemoveOpts {
    /// Task root; `None` walks up from the current working directory.
    pub root: Option<PathBuf>,
    /// Task directory name under `tasks/`.
    pub name: String,
    /// Skip guards (each skip lands in [`RemovedTask::messages`]) and force
    /// worktree removal.
    pub force: bool,
}

/// A step of [`remove_task`] worth showing the user live, in the order they
/// run. Deliberately coarse — one variant per subprocess-bearing step — so a
/// host with a UI can narrate a teardown or `git worktree remove` that takes
/// its time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemovePhase {
    CheckingGuards,
    /// Guards passed (or were forced); live sessions stop before anything on
    /// disk changes.
    StoppingSessions,
    RunningTeardown,
    CleaningDocker,
    RemovingWorktree,
    /// Off disk: untracking from `repos.json` and closing the bound board row.
    /// Reported by `tt_agentboard::task_removal`, the one step outside
    /// `remove_task` itself.
    Untracking,
}

impl RemovePhase {
    pub fn label(self) -> &'static str {
        match self {
            Self::CheckingGuards => "checking for uncommitted work",
            Self::StoppingSessions => "stopping sessions",
            Self::RunningTeardown => "running teardown command",
            Self::CleaningDocker => "cleaning up docker resources",
            Self::RemovingWorktree => "deleting git worktree",
            Self::Untracking => "untracking worktree",
        }
    }
}

pub struct RemovedTask {
    pub name: String,
    /// The removed checkout's directory (now gone from disk) — callers use it
    /// to untrack the task from stores keyed by dir (the agentboard rail).
    pub dir: PathBuf,
    /// The main checkout the task belonged to. Carried because it survives the
    /// removal and `dir` does not: it identifies the *instance state* holding
    /// this task's board row.
    pub checkout: PathBuf,
    /// Progress notes for the user. Callers surface these — nothing here prints.
    pub messages: Vec<String>,
}

/// How a removal ended.
///
/// A guard refusal is an `Ok` variant, not an [`OpsError`]: it is an expected
/// answer with a next step attached (stash it, stop the dev server, re-run
/// with force), not a failure. Errors stay for what the user genuinely cannot
/// proceed past: a bad path, a broken worktree, git falling over.
pub enum RemoveOutcome {
    Removed(RemovedTask),
    Blocked {
        name: String,
        blocked: Vec<RmBlocked>,
        /// Caveats gathered before the verdict. A refusal computed against
        /// stale refs (the `fetch --prune` failed) is exactly the case a user
        /// must be told about: "unreachable from any branch/remote" can be an
        /// artifact of the staleness rather than a property of the branch.
        messages: Vec<String>,
    },
}

/// Remove a task: guarded (clean tree, no commits unreachable from a branch
/// or remote, nothing foreign on its claimed ports), then teardown, docker,
/// `git worktree remove`.
///
/// [`RemovePhase::StoppingSessions`] fires after the last return that leaves the
/// task untouched and before the first destructive step — the app hangs its
/// kill-the-PTYs step there, so a *refused* removal never costs a live session.
pub fn remove_task(
    opts: &RemoveOpts,
    on_phase: &mut dyn FnMut(RemovePhase),
) -> Result<RemoveOutcome> {
    let sr = discover_root(opts.root.as_deref())?;
    // Parse-don't-validate: a name that isn't one safe path segment (a
    // hand-typed `../x`) must die here, before it is ever joined under the
    // worktrees dir and `remove_dir_all`'d.
    let Some(name) = crate::layout::TaskName::parse(&opts.name) else {
        return Err(OpsError::NoSuchTask {
            name: opts.name.clone(),
            tasks_dir: sr.tasks_dir().display().to_string(),
        });
    };
    let name = name.as_str().to_string();
    if name == "primary" || sr.checkout.file_name().and_then(|n| n.to_str()) == Some(&name) {
        return Err(OpsError::PrimaryRemoval);
    }
    let dir = sr.task_dir(&name);
    if !dir.is_dir() {
        return Err(OpsError::NoSuchTask { name, tasks_dir: sr.tasks_dir().display().to_string() });
    }
    let dir_s = dir.to_string_lossy().to_string();
    let mut messages = Vec::new();
    // The task's state scope must be read while the checkout still exists —
    // scope detection probes the directory (see `tt_config::task_scope_from_dir`).
    let state_scope = tt_config::task_scope_from_dir(&dir);

    on_phase(RemovePhase::CheckingGuards);

    // Refresh remote-tracking refs before the unreachable-commit guard below:
    // against a stale `origin/*` a branch merged upstream still looks
    // unreachable, and one merged just now can look falsely safe.
    match git_checkout(&sr.checkout, &["fetch", "--prune", "--quiet", "origin"]) {
        Ok(out) if out.ok() => {}
        _ => messages
            .push("fetch --prune failed (offline?) — using local refs for guard checks".into()),
    }

    // One status read answers both questions below — whether git works in
    // there at all, and how dirty the tree is.
    let status = crate::ops::repo_at(&dir).ok().and_then(|repo| repo.status().ok());

    // broken worktree: git can't even report status
    let Some(status) = status else {
        if !opts.force {
            return Err(OpsError::BrokenWorktree { name });
        }
        messages.push(
            "skipping guards (--force): worktree is broken — removing directory + registration"
                .to_string(),
        );
        on_phase(RemovePhase::StoppingSessions);
        on_phase(RemovePhase::RunningTeardown);
        if let Some(warning) = run_teardown(&dir)? {
            messages.push(warning);
        }
        on_phase(RemovePhase::CleaningDocker);
        docker_cleanup(&name, &dir, &mut messages);
        on_phase(RemovePhase::RemovingWorktree);
        fs::remove_dir_all(&dir)
            .map_err(|e| OpsError::Io(format!("cannot remove {dir_s}: {e}")))?;
        let _ = git_checkout(&sr.checkout, &["worktree", "prune"]);
        if let Ok(path) = port_registry_path(&sr.checkout) {
            release_task_ports(&sr.checkout, &path, &name);
        }
        state_cleanup(state_scope.as_deref(), &mut messages);
        return Ok(RemoveOutcome::Removed(RemovedTask {
            name,
            dir,
            checkout: sr.checkout.clone(),
            messages,
        }));
    };

    let dirty = status.len();
    let unreachable = orphaned_count(&dir);
    // Name the holder of each foreign port — a blocker is only actionable if
    // the user can tell which process to stop. Skipped under --force, where it
    // would only decorate a log line at the cost of two subprocesses.
    let foreign: Vec<ForeignPort> = claimed_ports(&dir)
        .into_iter()
        .filter(|&p| port_occupied(p) && !docker_owns_port(&name, p))
        .map(|port| ForeignPort {
            port,
            holder: if opts.force { None } else { crate::ports::holder(port) },
        })
        .collect();

    let blocked = crate::guards::check_removal(dirty, unreachable, &foreign);
    if !blocked.is_empty() {
        if !opts.force {
            return Ok(RemoveOutcome::Blocked { name, blocked, messages });
        }
        for reason in &blocked {
            messages.push(format!("skipping guard (--force): {reason}"));
        }
    }

    // Commits that never reached the base are NOT a removal guard — the branch
    // survives in the shared `.git`. Say so anyway, or "removed" reads as "that
    // work is dealt with".
    let branch = crate::ops::repo_at(&dir)
        .ok()
        .and_then(|repo| repo.head_branch())
        .filter(|b| !b.is_empty());
    if let Some(branch) = &branch {
        let refs = base_refs(&sr.checkout);
        if *branch != refs.base {
            let work = work_state(&refs, &dir, &format!("refs/heads/{branch}"), dirty, unreachable);
            match (work.unlanded, work.landed) {
                (0, Some(via)) => {
                    messages.push(format!(
                        "{branch} is {} into {} — nothing outstanding",
                        via.label(),
                        refs.base
                    ));
                }
                (n, _) if n > 0 => {
                    messages.push(format!(
                        "{n} commit(s) on {branch} have not reached {} — they stay on the branch, not in this worktree",
                        refs.base
                    ));
                }
                _ => {}
            }
        }
    }

    // Past every guard, and the state above is already gathered — only now is
    // it safe to kill the folder's PTYs (#366).
    on_phase(RemovePhase::StoppingSessions);
    on_phase(RemovePhase::RunningTeardown);
    if let Some(warning) = run_teardown(&dir)? {
        messages.push(warning);
    }
    on_phase(RemovePhase::CleaningDocker);
    docker_cleanup(&name, &dir, &mut messages);

    on_phase(RemovePhase::RemovingWorktree);
    let remove = if opts.force {
        git_checkout(&sr.checkout, &["worktree", "remove", "--force", &dir_s])
    } else {
        git_checkout(&sr.checkout, &["worktree", "remove", &dir_s])
    };
    match remove {
        Ok(out) if out.ok() => {}
        result => {
            let detail = match result {
                Ok(out) => out.stderr.trim().to_string(),
                Err(e) => e.to_string(),
            };
            if !opts.force {
                return Err(OpsError::Git(format!("git worktree remove failed:\n{detail}")));
            }
            messages.push(format!("git worktree remove failed ({detail}) — removing directory"));
            fs::remove_dir_all(&dir)
                .map_err(|e| OpsError::Io(format!("cannot remove {dir_s}: {e}")))?;
        }
    }
    let _ = git_checkout(&sr.checkout, &["worktree", "prune"]);
    if let Ok(path) = port_registry_path(&sr.checkout) {
        release_task_ports(&sr.checkout, &path, &name);
    }
    state_cleanup(state_scope.as_deref(), &mut messages);
    Ok(RemoveOutcome::Removed(RemovedTask { name, dir, checkout: sr.checkout.clone(), messages }))
}

/// The ports a checkout claims, from its rendered `.env`.
fn claimed_ports(dir: &Path) -> BTreeSet<u16> {
    envfile::port_claims(&fs::read_to_string(dir.join(".env")).unwrap_or_default())
}

/// Stop whatever is listening on `port` in the task named `name` under `root`
/// — the remedy for [`RmBlocked::ForeignPortListener`].
///
/// The claim check is the whole safety story: `port` must appear in *this
/// task's* rendered `.env`. An unclaimed one is somebody else's — quite
/// possibly a sibling's working dev server, whose whole process group this
/// would kill.
pub fn stop_task_port(root: Option<&Path>, name: &str, port: u16) -> Result<crate::ports::Stopped> {
    let sr = discover_root(root)?;
    let dir = sr.task_dir(name);
    if !dir.is_dir() {
        return Err(OpsError::NoSuchTask {
            name: name.to_string(),
            tasks_dir: sr.tasks_dir().display().to_string(),
        });
    }
    if !claimed_ports(&dir).contains(&port) {
        return Err(OpsError::PortNotClaimed { name: name.to_string(), port });
    }
    Ok(crate::ports::stop_listeners(port)?)
}

/// Delete the removed task's instance-state directories. Only checkouts of
/// this repo have a scope; other repos' tasks skip cleanly.
fn state_cleanup(scope: Option<&str>, messages: &mut Vec<String>) {
    let Some(scope) = scope else {
        return;
    };
    for dir in tt_config::instance_state_dirs_for_scope(scope) {
        if !dir.is_dir() {
            continue;
        }
        match fs::remove_dir_all(&dir) {
            Ok(()) => messages.push(format!("removed task state {}", dir.display())),
            Err(e) => messages.push(format!("could not remove task state {}: {e}", dir.display())),
        }
    }
}

// clean — remove every finished task and the state removed checkouts left behind

#[derive(Debug, Default)]
pub struct CleanOpts {
    /// Task root; `None` walks up from the current working directory.
    pub root: Option<PathBuf>,
    /// Report what would happen without removing or sweeping anything.
    pub dry_run: bool,
    /// Parents of per-scope instance-state dirs to sweep. Empty = skip it.
    pub scope_parents: Vec<PathBuf>,
}

/// A task `clean` removed (or, on dry-run, would remove).
pub struct FinishedTask {
    pub name: String,
    pub branch: String,
    /// How the branch landed, e.g. `"squash-merged into main"`.
    pub reason: String,
    /// Empty on dry-run.
    pub messages: Vec<String>,
    /// See [`RemovedTask::dir`].
    pub dir: PathBuf,
    /// The main checkout this task belonged to — see [`RemovedTask::checkout`].
    pub checkout: PathBuf,
}

/// A task `clean` left alone, and why.
pub struct KeptTask {
    pub name: String,
    pub branch: String,
    pub why: Vec<String>,
}

pub struct CleanReport {
    pub dry_run: bool,
    /// Removed (dry-run: would-remove) tasks.
    pub removed: Vec<FinishedTask>,
    pub kept: Vec<KeptTask>,
    /// Orphaned per-scope state dirs swept (dry-run: would sweep).
    pub swept_state_dirs: Vec<PathBuf>,
    /// Port-registry files swept because their checkout no longer exists — the
    /// one leak the load-time prune can't reach, since nothing ever renders a
    /// gone repo again.
    pub swept_port_registries: Vec<PathBuf>,
    /// State scopes of the checkouts that remain (checkout + kept tasks) —
    /// callers prune *these* agentboard stores plus the unscoped one.
    pub live_scopes: Vec<String>,
    pub warnings: Vec<String>,
}

/// Remove every *finished* task — its branch is a strict ancestor of the
/// checkout's branch (classic merge) or its upstream is gone after
/// `fetch --prune` (squash/rebase merge) — via the same guarded
/// [`remove_task`], never forced, deleting the branch from the hub. Then sweep
/// `scope_parents` for state dirs whose checkout no longer exists; `scope_of`
/// is injected so the scope rule has exactly one owner.
pub fn clean_tasks(
    opts: &CleanOpts,
    scope_of: impl Fn(&Path) -> Option<String>,
) -> Result<CleanReport> {
    let sr = discover_root(opts.root.as_deref())?;
    let mut warnings = Vec::new();
    let _ = git_checkout(&sr.checkout, &["worktree", "prune"]);
    // --prune is what flips a merged-and-deleted remote branch to "gone".
    match git_checkout(&sr.checkout, &["fetch", "--prune", "--quiet", "origin"]) {
        Ok(out) if out.ok() => {}
        _ => warnings.push(
            "fetch --prune failed (offline?) — merges that deleted the remote branch may not \
             be detected this run"
                .to_string(),
        ),
    }

    let refs = base_refs(&sr.checkout);
    let base = refs.base.clone();

    let mut removed = Vec::new();
    let mut kept = Vec::new();
    let mut live_scopes: Vec<String> = scope_of(&sr.checkout).into_iter().collect();
    let checkout_scoped = !live_scopes.is_empty();

    for (name, dir) in sr.tasks() {
        // Computed before removal — a removed task's dir is gone afterwards.
        let scope = scope_of(&dir);
        let mut keep = |name: String, branch: String, why: Vec<String>| {
            kept.push(KeptTask { name, branch, why });
            live_scopes.extend(scope.clone());
        };

        let branch = match super::repo_at(&dir) {
            Ok(repo) => repo.head_branch().unwrap_or_default(),
            Err(_) => {
                keep(
                    name,
                    "BROKEN".to_string(),
                    vec!["worktree is broken — `tt task rm --force` to drop it".to_string()],
                );
                continue;
            }
        };
        if branch.is_empty() {
            keep(
                name,
                "detached".to_string(),
                vec!["detached HEAD — no branch to judge".to_string()],
            );
            continue;
        }
        if branch == base {
            keep(name, branch, vec!["on the base branch".to_string()]);
            continue;
        }

        let branch_ref = format!("refs/heads/{branch}");
        let work =
            work_state(&refs, &dir, &branch_ref, uncommitted_count(&dir), orphaned_count(&dir));

        let Some(via) = work.landed else {
            keep(name, branch, vec![format!("active: {}", work.headline())]);
            continue;
        };
        // `clean` deletes the branch, so unlanded commits are unrecoverable
        // here in a way they never are for `tt task rm`. Only content-based
        // evidence clears that bar.
        if work.unlanded > 0 || !via.is_content_proof() {
            keep(
                name,
                branch,
                vec![format!(
                    "{} but {} commit(s) never reached {base} — push or merge before cleaning",
                    via.label(),
                    work.unlanded
                )],
            );
            continue;
        }
        let reason = format!("{} into {base}", via.label());

        if opts.dry_run {
            removed.push(FinishedTask {
                name,
                branch,
                reason: reason.clone(),
                messages: Vec::new(),
                dir,
                checkout: sr.checkout.clone(),
            });
            continue;
        }
        let rm = RemoveOpts { root: Some(sr.checkout.clone()), name: name.clone(), force: false };
        match remove_task(&rm, &mut |_| {}) {
            Ok(RemoveOutcome::Removed(r)) => {
                let mut messages = r.messages;
                match crate::ops::repo_at(&sr.checkout).and_then(|repo| {
                    repo.delete_branch(&branch).map_err(|e| OpsError::Git(e.to_string()))
                }) {
                    Ok(()) => messages.push(format!("deleted branch {branch}")),
                    Err(_) => messages.push(format!(
                        "could not delete branch {branch} — remove it with `git branch -D`"
                    )),
                }
                removed.push(FinishedTask {
                    name,
                    branch,
                    reason: reason.clone(),
                    messages,
                    dir: r.dir,
                    checkout: r.checkout,
                });
            }
            Ok(RemoveOutcome::Blocked { blocked, .. }) => {
                keep(name, branch, blocked.iter().map(ToString::to_string).collect())
            }
            Err(e) => keep(name, branch, vec![e.to_string()]),
        }
    }

    // Sweep per-scope instance state whose checkout no longer exists — the
    // dirs `tt task rm` never touches. If the checkout itself has no scope,
    // nothing under these parents can be ours.
    let mut swept_state_dirs = Vec::new();
    if checkout_scoped {
        let live: BTreeSet<String> = live_scopes.iter().cloned().collect();
        for parent in &opts.scope_parents {
            let names = dir_names(parent);
            for stale in crate::clean::stale_scope_dirs(&sr.repo, &live, &names) {
                let dir = parent.join(&stale);
                if opts.dry_run {
                    swept_state_dirs.push(dir);
                    continue;
                }
                match fs::remove_dir_all(&dir) {
                    Ok(()) => swept_state_dirs.push(dir),
                    Err(e) => {
                        warnings.push(format!("could not remove {}: {e}", dir.display()));
                    }
                }
            }
        }
    }

    // Sweep registry files whose checkout is gone entirely. Each file is
    // self-identifying (`PortRegistry::checkout`), so this never re-derives the
    // filename hash. Machine-wide by design — a deleted repo can't sweep
    // itself, so any repo's `clean` tidies the whole ledger dir.
    let mut swept_port_registries = Vec::new();
    if let Ok(ports_dir) = tt_config::task_ports_dir()
        && let Ok(entries) = fs::read_dir(&ports_dir)
    {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let registry = super::claims::load_port_registry(&path);
            let dead = registry.checkout.is_empty() || !Path::new(&registry.checkout).is_dir();
            if !dead {
                continue;
            }
            if opts.dry_run {
                swept_port_registries.push(path);
            } else {
                match fs::remove_file(&path) {
                    Ok(()) => swept_port_registries.push(path),
                    Err(e) => {
                        warnings.push(format!("could not remove {}: {e}", path.display()));
                    }
                }
            }
        }
    }

    Ok(CleanReport {
        dry_run: opts.dry_run,
        removed,
        kept,
        swept_state_dirs,
        swept_port_registries,
        live_scopes,
        warnings,
    })
}

/// Whether a docker container owned by this task publishes `port`.
fn docker_owns_port(task_name: &str, port: u16) -> bool {
    let publish = format!("publish={port}");
    tt_exec::run("docker", &["ps", "--filter", &publish, "--format", "{{.Names}}"])
        .map(|out| {
            out.ok()
                && out
                    .stdout
                    .lines()
                    .any(|line| crate::guards::docker_resource_matches(line.trim(), task_name))
        })
        .unwrap_or(false)
}

/// Compose down (containers, networks, volumes) then an anchored sweep of
/// anything else named after the task. Best-effort: a missing docker is fine.
fn docker_cleanup(task_name: &str, dir: &Path, messages: &mut Vec<String>) {
    let has_compose = [
        "docker-compose.yml",
        "docker-compose.yaml",
        "compose.yml",
        "compose.yaml",
    ]
    .iter()
    .any(|f| dir.join(f).is_file());
    if has_compose {
        let _ = tt_exec::run_in_dir_with_timeout(
            "docker",
            &["compose", "down", "--volumes", "--remove-orphans"],
            dir,
            Duration::from_secs(120),
        );
    }
    if let Ok(out) = tt_exec::run("docker", &["ps", "-a", "--format", "{{.Names}}"]) {
        for container in out.stdout.lines().map(str::trim) {
            if crate::guards::docker_resource_matches(container, task_name) {
                messages.push(format!("removing container {container}"));
                let _ = tt_exec::run("docker", &["rm", "-f", container]);
            }
        }
    }
    if let Ok(out) = tt_exec::run("docker", &["volume", "ls", "--format", "{{.Name}}"]) {
        for volume in out.stdout.lines().map(str::trim) {
            if crate::guards::docker_resource_matches(volume, task_name) {
                messages.push(format!("removing volume {volume}"));
                let _ = tt_exec::run("docker", &["volume", "rm", volume]);
            }
        }
    }
}
