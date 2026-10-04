//! Task creation: worktree add, `.env` render with port claims, sibling
//! secret inheritance, and the setup step. A task branches new work off a base or
//! checks out an open PR's existing head for review ([`TaskSource`]).

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use super::render::render_task_env;
use super::{
    FETCH_TIMEOUT, OpsError, Result, TaskRoot, base_branch, discover_root, effective_origin_base,
    fast_forward_base_if_behind, git_checkout, git_checkout_timeout, note_if_slow, run_setup,
    validate_branch_name,
};
use crate::issue::{self, Issue};
use crate::pr::{self, PullRequest};
use crate::{envfile, layout};

/// Tasks are branch-named either way — there is no detached/parked mode.
#[derive(Debug, Clone)]
pub enum TaskSource {
    /// `base: None` = the checkout's branch.
    NewBranch {
        branch: String,
        base: Option<String>,
    },
    /// Check out open PR `#n`'s head as-is ([`PullRequest::local_branch`]).
    PullRequest(u64),
}

#[derive(Debug)]
pub struct CreateOpts {
    /// Task root; `None` walks up from the current working directory.
    pub root: Option<PathBuf>,
    pub source: TaskSource,
    /// Run the setup step in the new task (declared `TT_TASK_SETUP` from the
    /// rendered `.env`, else lockfile-detected package-manager install).
    pub run_setup: bool,
}

/// A step of [`create_task`] worth showing the user live, in the order they
/// run — the mirror of [`super::RemovePhase`]. Coarse by design: one variant
/// per subprocess-bearing step, not every internal git call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreatePhase {
    /// `worktree prune`, `fetch origin`, and the base's fast-forward — or, for a
    /// PR, the `gh` lookup.
    Fetching,
    /// `git worktree add`, after fetching a PR's head into its branch.
    AddingWorktree,
    /// Rendering `.env` and inheriting a sibling checkout's secrets.
    PreparingEnv,
    /// The declared `TT_TASK_SETUP` command. Only reached when
    /// [`CreateOpts::run_setup`] is set — the app runs setup separately.
    RunningSetup,
}

impl CreatePhase {
    /// Present-participle label for a status line.
    pub fn label(self) -> &'static str {
        match self {
            Self::Fetching => "fetching origin",
            Self::AddingWorktree => "adding the git worktree",
            Self::PreparingEnv => "rendering .env and claiming ports",
            Self::RunningSetup => "running setup",
        }
    }
}

pub struct CreatedTask {
    pub name: String,
    pub dir: PathBuf,
    pub branch: String,
    pub base: String,
    /// The ref the task effectively branched from — `origin/<base>` when the
    /// creation-time fast-forward applied ([`effective_origin_base`]), else
    /// `base`. Display/prompt honesty; `base` stays the branch-name value.
    pub base_label: String,
    pub ports: Vec<(String, u16)>,
    pub inherited: usize,
    pub warnings: Vec<String>,
    pub pr: Option<PullRequest>,
}

struct Target {
    branch: String,
    base: String,
    base_label: String,
    pr: Option<PullRequest>,
}

/// Review-form preflight: the PR, the branch and dir its task would get, and why it
/// can't be created (`error`).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCheck {
    pub pr: PullRequest,
    pub branch: String,
    pub dir: Option<String>,
    pub error: Option<String>,
}

pub fn check_pr(sr: &TaskRoot, number: u64) -> Result<PrCheck> {
    let pr = pr::view(&sr.checkout, number).map_err(OpsError::Pr)?;
    let branch = pr.local_branch();
    let name = layout::task_name_from_branch(&branch);
    let dir = name.as_ref().map(|n| sr.task_dir(n));
    let error = if !pr.is_open() {
        Some(format!(
            "PR #{number} is {} — only an open PR can be reviewed",
            pr.state.to_lowercase()
        ))
    } else if let Err(e) = validate_branch_name(&branch) {
        Some(e.to_string())
    } else if dir.as_ref().is_some_and(|d| d.exists()) {
        Some(format!("a task for {branch} already exists"))
    } else {
        name.is_none().then(|| OpsError::BadBranchName(branch.clone()).to_string())
    };
    let dir = dir.map(|d| d.to_string_lossy().to_string());
    Ok(PrCheck { pr, branch, dir, error })
}

/// What a task started from an issue is called, decided before anything is created:
/// an explicit title replaces the issue's, and the branch — unless given — slugs
/// whichever title won, the same rule a plain `tt task new` applies to TITLE.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueTask {
    pub issue: Issue,
    pub title: String,
    pub branch: String,
    /// Carries the issue's title and URL so the agent started in the task sees
    /// what it is for.
    pub goal: String,
}

impl IssueTask {
    pub fn plan(
        issue: Issue,
        title: Option<&str>,
        branch: Option<&str>,
        goal: Option<&str>,
    ) -> Result<Self> {
        if !issue.is_open() {
            return Err(OpsError::Issue(format!(
                "#{} is {}, not open",
                issue.number,
                issue.state.to_lowercase()
            )));
        }
        let title = given(title).unwrap_or(&issue.title).to_string();
        let branch = match given(branch) {
            Some(b) => b.to_string(),
            None => {
                let slug = tt_git::branch_name::slug(&title);
                if slug.is_empty() {
                    return Err(OpsError::Issue(format!(
                        "cannot derive a branch from #{}'s title — pass --branch",
                        issue.number
                    )));
                }
                slug
            }
        };
        let goal = given(goal)
            .map(str::to_string)
            .unwrap_or_else(|| format!("{} (#{}) {}", issue.title, issue.number, issue.url));
        Ok(Self { issue, title, branch, goal })
    }
}

fn given(s: Option<&str>) -> Option<&str> {
    s.map(str::trim).filter(|s| !s.is_empty())
}

/// Look up issue `number` in `sr`'s repo and name its task ([`IssueTask::plan`]).
pub fn issue_task(
    sr: &TaskRoot,
    number: u64,
    title: Option<&str>,
    branch: Option<&str>,
    goal: Option<&str>,
) -> Result<IssueTask> {
    let issue = issue::view(&sr.checkout, number).map_err(OpsError::Issue)?;
    IssueTask::plan(issue, title, branch, goal)
}

fn new_branch_target(
    sr: &TaskRoot,
    branch: &str,
    base: Option<&str>,
    warnings: &mut Vec<String>,
) -> Target {
    let base = base.map(str::to_string).unwrap_or_else(|| base_branch(&sr.checkout));
    // The ref this task effectively branches from — probed after the fetch so
    // a just-created remote counterpart counts, and carried on the result as
    // `base_label`, which the create's telemetry span records as the ref
    // creation actually used (agreeing with `checkout_branches`' labels).
    let effective = effective_origin_base(&sr.checkout, &base);
    if let Some(upstream) = &effective {
        fast_forward_base_if_behind(sr, &base, upstream, warnings);
    }
    let base_label = effective.unwrap_or_else(|| base.clone());
    Target { branch: branch.to_string(), base, base_label, pr: None }
}

fn pr_target(sr: &TaskRoot, number: u64) -> Result<Target> {
    let pr = pr::view(&sr.checkout, number).map_err(OpsError::Pr)?;
    if !pr.is_open() {
        return Err(OpsError::Pr(format!("PR #{number} is {}, not open", pr.state.to_lowercase())));
    }
    let branch = pr.local_branch();
    validate_branch_name(&branch)?;
    let base = pr.base_branch.clone();
    let origin_base = format!("origin/{base}");
    let has_origin = super::repo_at(&sr.checkout).is_ok_and(|repo| repo.has_rev(&origin_base));
    let base_label = if has_origin { origin_base } else { base.clone() };
    Ok(Target { branch, base, base_label, pr: Some(pr) })
}

/// Fetch the PR head into its branch and add the worktree. No `+` on the refspec: git
/// only fast-forwards an existing branch, so local commits the PR lacks survive.
/// Returns whether the branch is new (a failed create then deletes it).
fn add_pr_worktree(
    sr: &TaskRoot,
    pr: &PullRequest,
    branch: &str,
    dir: &str,
    warnings: &mut Vec<String>,
) -> Result<bool> {
    let existed = super::branch_exists(&sr.checkout, branch);
    let head = format!("refs/pull/{}/head:refs/heads/{branch}", pr.number);
    let tracking = format!("+refs/heads/{0}:refs/remotes/origin/{0}", pr.head_branch);
    let mut args = vec!["fetch", "--quiet", "origin", head.as_str()];
    if !pr.cross_repository {
        args.push(tracking.as_str());
    }
    let fetched = git_checkout(&sr.checkout, &args)?;
    if !fetched.ok() {
        return Err(OpsError::Git(format!(
            "could not fetch PR #{} into {branch}:
{}",
            pr.number,
            fetched.stderr.trim()
        )));
    }
    let added = git_checkout(&sr.checkout, &["worktree", "add", dir, branch])?;
    if !added.ok() {
        if !existed {
            let _ = super::repo_at(&sr.checkout).map(|repo| repo.delete_branch(branch));
        }
        return Err(OpsError::Git(format!(
            "git worktree add failed:
{}",
            added.stderr.trim()
        )));
    }
    if pr.cross_repository {
        warnings.push(format!(
            "PR #{} comes from {}'s fork — {branch} has no upstream, so pushing needs that fork              as a remote",
            pr.number, pr.head_owner
        ));
    } else {
        let upstream = format!("origin/{}", pr.head_branch);
        let set = git_checkout(&sr.checkout, &["branch", "--set-upstream-to", &upstream, branch]);
        if !set.as_ref().is_ok_and(|out| out.ok()) {
            warnings.push(format!("{branch} was checked out without tracking {upstream}"));
        }
    }
    Ok(!existed)
}

/// Create the task for `opts.source`: worktree under `tasks/`, rendered `.env`
/// with port claims, sibling-secrets inheritance, setup step. `now_ms` is read
/// at the CLI/app boundary, never here. `on_phase` fires at each
/// [`CreatePhase`] in order; pass `&mut |_| {}` to ignore.
pub fn create_task(
    opts: &CreateOpts,
    now_ms: i64,
    on_phase: &mut dyn FnMut(CreatePhase),
) -> Result<CreatedTask> {
    let sr = discover_root(opts.root.as_deref())?;
    if let TaskSource::NewBranch { branch, .. } = &opts.source {
        validate_branch_name(branch)?;
    }
    let mut warnings = Vec::new();
    on_phase(CreatePhase::Fetching);
    let _ = git_checkout(&sr.checkout, &["worktree", "prune"]);

    let fetch_start = Instant::now();
    match git_checkout_timeout(&sr.checkout, &["fetch", "--quiet", "origin"], FETCH_TIMEOUT) {
        Ok(out) if out.ok() => {}
        Ok(out) => warnings
            .push(format!("fetch failed (offline?) — using local refs: {}", out.stderr.trim())),
        // Includes a timed-out fetch (a stalled/inspected connection) — the
        // old `if let Ok(..) = .. && !out.ok()` form silently dropped this
        // case instead of warning on it.
        Err(e) => warnings.push(format!("fetch failed — using local refs: {e}")),
    }
    note_if_slow(&mut warnings, "fetch", fetch_start.elapsed());

    let Target { branch, base, base_label, pr } = match &opts.source {
        TaskSource::NewBranch { branch, base } => {
            new_branch_target(&sr, branch, base.as_deref(), &mut warnings)
        }
        TaskSource::PullRequest(number) => pr_target(&sr, *number)?,
    };
    let name = layout::task_name_from_branch(&branch)
        .ok_or_else(|| OpsError::BadBranchName(branch.clone()))?;
    let dir = sr.task_dir(&name);
    if dir.exists() {
        return Err(OpsError::TaskExists { name, dir: dir.display().to_string() });
    }
    fs::create_dir_all(sr.tasks_dir())
        .map_err(|e| OpsError::Io(format!("cannot create {}: {e}", sr.tasks_dir().display())))?;
    let dir_s = dir.to_string_lossy().to_string();

    on_phase(CreatePhase::AddingWorktree);
    let worktree_start = Instant::now();
    let created_branch = match &pr {
        Some(pr) => add_pr_worktree(&sr, pr, &branch, &dir_s, &mut warnings)?,
        None => {
            let add_result =
                git_checkout(&sr.checkout, &["worktree", "add", "-b", &branch, &dir_s, &base])?;
            if !add_result.ok() {
                return Err(OpsError::Git(format!(
                    "git worktree add failed:\n{}",
                    add_result.stderr.trim()
                )));
            }
            true
        }
    };
    note_if_slow(&mut warnings, "git worktree add", worktree_start.elapsed());

    // From here on, any failure must remove the worktree just added above —
    // otherwise (e.g. a template render error) it leaves a half-set-up task
    // behind: a real worktree with no rendered `.env`, invisible as "failed"
    // to `tt task ls` and blocking a retry with `TaskExists`.
    let created = (|| -> Result<CreatedTask> {
        on_phase(CreatePhase::PreparingEnv);
        let summary = render_task_env(&sr, &dir, Some(&base), now_ms)?;
        warnings.extend(summary.warnings);

        // Inherit secrets from the first sibling checkout that has a .env —
        // the main checkout first (`sr.checkouts()` orders it that way; it's
        // the longest-lived and least likely to carry stale branch-specific
        // values), else the alphabetically-first task. Surfaced in a warning
        // when it wasn't the main checkout, since a task's secrets can be
        // branch-specific or stale in a way the main checkout's never are.
        let mut inherited = 0;
        for sib_dir in sr.checkouts() {
            if sib_dir == dir {
                continue;
            }
            if let Ok(sib_env) = fs::read_to_string(sib_dir.join(".env")) {
                let env_path = dir.join(".env");
                let current = fs::read_to_string(&env_path).unwrap_or_default();
                let (merged, count) = envfile::merge_missing_keys(&current, &sib_env);
                fs::write(&env_path, merged)
                    .map_err(|e| OpsError::Io(format!("cannot write .env: {e}")))?;
                inherited = count;
                if count > 0 && sib_dir != sr.checkout {
                    let source =
                        sib_dir.file_name().and_then(|n| n.to_str()).unwrap_or("a sibling task");
                    warnings.push(format!(
                        "inherited {count} .env key(s) from {source}, not the main checkout — \
                         the main checkout has no .env yet, so these may be branch-specific or stale"
                    ));
                }
                break;
            }
        }

        if opts.run_setup {
            on_phase(CreatePhase::RunningSetup);
            let setup_start = Instant::now();
            let setup_warning = run_setup(&dir)?;
            note_if_slow(&mut warnings, "setup", setup_start.elapsed());
            if let Some(warning) = setup_warning {
                warnings.push(warning);
            }
        }

        Ok(CreatedTask {
            name,
            dir,
            branch: branch.clone(),
            base,
            base_label,
            ports: summary.ports,
            inherited,
            warnings,
            pr,
        })
    })();

    created.inspect_err(|_| {
        let _ = git_checkout(&sr.checkout, &["worktree", "remove", "--force", &dir_s]);
        let _ = fs::remove_dir_all(Path::new(&dir_s));
        // A branch this create made is deleted too, or the retry dies on
        // "branch already exists" after e.g. fixing a template error. A PR
        // branch that was already local is the user's, and stays.
        if created_branch {
            let _ = crate::ops::repo_at(&sr.checkout).map(|repo| repo.delete_branch(&branch));
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) -> String {
        let dir = dir.to_str().unwrap();
        let mut full = vec!["-C", dir, "-c", "user.name=T", "-c", "user.email=t@t"];
        full.extend_from_slice(args);
        let out = tt_exec::run("git", &full).unwrap();
        assert!(out.ok(), "git {full:?} failed: {}", out.stderr);
        out.stdout.trim().to_string()
    }

    /// An origin with PR #7 on `feat/x`, and a clone of it as the task root.
    fn origin_with_pr() -> (tempfile::TempDir, TaskRoot) {
        let tmp = tempfile::tempdir().unwrap();
        let origin = tmp.path().join("origin");
        fs::create_dir_all(&origin).unwrap();
        git(&origin, &["init", "-q", "-b", "main"]);
        git(&origin, &["commit", "-q", "--allow-empty", "-m", "base"]);
        git(&origin, &["checkout", "-q", "-b", "feat/x"]);
        git(&origin, &["commit", "-q", "--allow-empty", "-m", "pr work"]);
        git(&origin, &["update-ref", "refs/pull/7/head", "feat/x"]);
        git(&origin, &["checkout", "-q", "main"]);
        git(tmp.path(), &["clone", "-q", "origin", "repo"]);
        let sr = TaskRoot { checkout: tmp.path().join("repo"), repo: "repo".to_string() };
        (tmp, sr)
    }

    fn pr(cross_repository: bool) -> PullRequest {
        PullRequest {
            number: 7,
            title: "x".into(),
            url: String::new(),
            state: "OPEN".into(),
            is_draft: false,
            head_branch: "feat/x".into(),
            base_branch: "main".into(),
            cross_repository,
            head_owner: "someone".into(),
            author: "someone".into(),
        }
    }

    #[test]
    fn checks_out_a_same_repo_pr_tracking_its_head() {
        let (_tmp, sr) = origin_with_pr();
        let dir = sr.task_dir("feat-x");
        let mut warnings = Vec::new();
        let created =
            add_pr_worktree(&sr, &pr(false), "feat/x", dir.to_str().unwrap(), &mut warnings)
                .unwrap();
        assert!(created);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(git(&dir, &["log", "-1", "--format=%s"]), "pr work");
        assert_eq!(git(&dir, &["rev-parse", "--abbrev-ref", "@{upstream}"]), "origin/feat/x");
    }

    #[test]
    fn checks_out_a_fork_pr_under_its_own_branch_with_a_warning() {
        let (_tmp, sr) = origin_with_pr();
        let dir = sr.task_dir("someone-feat-x");
        let mut warnings = Vec::new();
        add_pr_worktree(&sr, &pr(true), "someone/feat/x", dir.to_str().unwrap(), &mut warnings)
            .unwrap();
        assert_eq!(git(&dir, &["log", "-1", "--format=%s"]), "pr work");
        assert_eq!(warnings.len(), 1);
    }

    fn issue(state: &str) -> Issue {
        Issue {
            number: 42,
            title: "Fix the thing!".into(),
            url: "https://github.com/o/r/issues/42".into(),
            state: state.into(),
        }
    }

    #[test]
    fn an_issue_task_is_named_after_the_issue() {
        let planned = IssueTask::plan(issue("OPEN"), None, None, None).unwrap();
        assert_eq!(planned.title, "Fix the thing!");
        assert_eq!(planned.branch, "fix-the-thing");
        assert_eq!(planned.goal, "Fix the thing! (#42) https://github.com/o/r/issues/42");
        assert_eq!(planned.issue.repo().as_deref(), Some("o/r"));
    }

    #[test]
    fn an_explicit_title_names_the_branch_too_but_an_explicit_branch_wins() {
        let planned = IssueTask::plan(issue("OPEN"), Some(" Custom name "), None, None).unwrap();
        assert_eq!(planned.title, "Custom name");
        assert_eq!(planned.branch, "custom-name");
        assert_eq!(planned.issue.number, 42, "the issue stays attached under a custom title");

        let planned =
            IssueTask::plan(issue("OPEN"), Some("Custom"), Some("feat/mine"), Some("why")).unwrap();
        assert_eq!(planned.branch, "feat/mine");
        assert_eq!(planned.goal, "why");
    }

    #[test]
    fn a_blank_override_falls_back_to_the_issue() {
        let planned = IssueTask::plan(issue("OPEN"), Some("  "), Some(""), Some(" ")).unwrap();
        assert_eq!(planned.title, "Fix the thing!");
        assert_eq!(planned.branch, "fix-the-thing");
        assert!(planned.goal.contains("#42"));
    }

    #[test]
    fn a_closed_issue_is_refused() {
        let err = IssueTask::plan(issue("CLOSED"), None, None, None).unwrap_err();
        assert_eq!(err.to_string(), "issue: #42 is closed, not open");
    }

    #[test]
    fn an_unsluggable_title_needs_an_explicit_branch() {
        let mut unsluggable = issue("OPEN");
        unsluggable.title = "???".into();
        let err = IssueTask::plan(unsluggable.clone(), None, None, None).unwrap_err();
        assert!(err.to_string().contains("pass --branch"), "{err}");
        assert!(IssueTask::plan(unsluggable, None, Some("feat/x"), None).is_ok());
    }

    #[test]
    fn never_overwrites_local_commits_the_pr_lacks() {
        let (_tmp, sr) = origin_with_pr();
        git(&sr.checkout, &["branch", "feat/x", "origin/main"]);
        git(&sr.checkout, &["checkout", "-q", "feat/x"]);
        git(&sr.checkout, &["commit", "-q", "--allow-empty", "-m", "mine"]);
        git(&sr.checkout, &["checkout", "-q", "main"]);
        let dir = sr.task_dir("feat-x");
        let err = add_pr_worktree(&sr, &pr(false), "feat/x", dir.to_str().unwrap(), &mut vec![])
            .unwrap_err();
        assert!(err.to_string().contains("could not fetch PR #7"), "{err}");
        assert_eq!(git(&sr.checkout, &["log", "-1", "--format=%s", "feat/x"]), "mine");
        assert!(!dir.exists());
    }
}
