//! Data-hub collectors for the towles-tool personal dashboard. Each gathers one
//! slice of state — calendar events, cross-repo issues, pull-request status, CI runs — and
//! writes it into the shared [`tt_store::Store`]. The calendar collector shells out
//! to `claude -p` once per configured [`tt_config::CalendarSource`], each writing
//! its own store lane; issues and PRs shell out to `gh`. Tauri-free, so both the CLI
//! and the app's scheduler drive it against the same [`CollectSummary`] contract.
//!
//! The public `collect_*` functions **never panic and never return `Err`**: every
//! failure becomes a [`CollectSummary`] with `ok = false`, recorded via `record_run`
//! under a stable key.

mod calendar;
mod ci;
mod gh;
pub mod issues;
pub mod nudge;
mod prs;
mod quiet_hours;
mod slack;
mod slack_socket;
mod sweep;
mod sweep_cache;
mod task_links;

pub use calendar::*;
pub use sweep::*;
pub use task_links::*;

pub use issues::{fetch_importable_issues, search_repo_issues};
pub use nudge::NudgeTarget;
pub use quiet_hours::{should_run_at, should_run_calendar};
pub use slack::{
    DmFile, DmMessage, DmReaction, DmUpload, SlackDmConfig, SlackFile, SlackUser, auth_user_id,
    dm_channel_id, fetch_dm_history, fetch_file, fetch_thread, list_users, open_im, post_message,
    react, send_dm, set_reaction,
};
pub use slack_socket::{
    Backoff, Envelope, MessageEvent, ReactionEvent, SlackEvent, ack_json, is_watched_event,
    open_socket_connection, parse_connection_url, parse_envelope,
};

use std::path::{Path, PathBuf};
use std::time::Duration;

use tt_config::CalendarSource;
use tt_store::{EventInput, Store};

/// Hard cap: a wedged `claude` would stall every collector behind it, since the
/// scheduler awaits batches serially.
const CLAUDE_TIMEOUT: Duration = Duration::from_secs(180);

/// The outcome of a single collector run.
#[derive(Debug, Clone, PartialEq)]
pub struct CollectSummary {
    pub collector: String,
    pub ok: bool,
    pub count: usize,
    /// The error on failure, or context on success (e.g. `"no repos configured"`).
    pub message: Option<String>,
}

/// Collect open issues assigned to me across `repo_dirs` via `gh`. Only a clean
/// sweep does a full-table replace, so an erroring repo keeps its last-known-good
/// rows. `reuse_ms` is how old another window's answer may be before this one asks.
pub fn collect_issues(
    store: &Store,
    repo_dirs: &[PathBuf],
    reuse_ms: i64,
    now_ms: i64,
) -> CollectSummary {
    let repos = dedupe_repo_dirs(repo_dirs);
    let outcome =
        sweep_repos_shared(&repos, "issues", reuse_ms, now_ms, issues::collect_repo_issues);
    let write = |all: &[tt_store::IssueInput], repos: Option<&[String]>| match repos {
        None => store.replace_issues(all),
        Some(repos) => store.replace_issues_for_repos(repos, all),
    };
    let summary =
        finish_sweep(store, "issues", outcome, write, |i| (i.repo.clone(), i.number), now_ms);
    sync_task_links(store, &dirs_of(&repos), now_ms);
    summary
}

/// Open issues carrying any of `labels` across `repo_dirs`, for the Board's "start
/// a task" suggestions. No labels clears the cache without asking GitHub anything.
pub fn collect_watched_issues(
    store: &Store,
    repo_dirs: &[PathBuf],
    labels: &[String],
    reuse_ms: i64,
    now_ms: i64,
) -> CollectSummary {
    let labels = normalize_labels(labels);
    if labels.is_empty() {
        let cleared = store.replace_watched_issues(&[]).map(|_| 0).map_err(|e| e.to_string());
        return finish(store, WATCHED_ISSUES, cleared.is_ok(), 0, cleared.err(), now_ms);
    }
    let repos = dedupe_repo_dirs(repo_dirs);
    // The labels are part of the question: a changed list must not reuse an old answer.
    let kind = format!("{WATCHED_ISSUES}:{}", labels.join(","));
    let outcome = sweep_repos_shared(&repos, &kind, reuse_ms, now_ms, |dir| {
        issues::collect_repo_watched_issues(dir, &labels)
    });
    let write = |all: &[tt_store::IssueInput], repos: Option<&[String]>| match repos {
        None => store.replace_watched_issues(all),
        Some(repos) => store.replace_watched_issues_for_repos(repos, all),
    };
    finish_sweep(store, WATCHED_ISSUES, outcome, write, |i| (i.repo.clone(), i.number), now_ms)
}

const WATCHED_ISSUES: &str = "issues:watched";

/// Trimmed, blank-free and deduped, in the order given.
fn normalize_labels(labels: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for label in labels.iter().map(|l| l.trim()).filter(|l| !l.is_empty()) {
        if !out.iter().any(|seen| seen == label) {
            out.push(label.to_string());
        }
    }
    out
}

/// Every PR class in one sweep, for on-demand refreshes worth all three `gh` calls;
/// the periodic tick splits into [`collect_prs_open`] and [`collect_prs_merged`].
/// Shares nothing cross-window: every caller is a "refresh now".
pub fn collect_prs(store: &Store, repo_dirs: &[PathBuf], now_ms: i64) -> CollectSummary {
    let repos = dedupe_repo_dirs(repo_dirs);
    let outcome = sweep_repos(&dirs_of(&repos), prs::collect_repo_prs);
    let write = |all: &[tt_store::PrInput], repos: Option<&[String]>| match repos {
        None => store.replace_prs(all),
        Some(repos) => store.replace_prs_for_repos(repos, all),
    };
    let summary =
        finish_sweep(store, "prs", outcome, write, |p| (p.repo.clone(), p.number), now_ms);
    sync_task_links(store, &dirs_of(&repos), now_ms);
    summary
}

/// The fast half of [`collect_prs`]: authored + review-requested open PRs on the
/// scheduler's frequent tick, recorded under `prs` like the others. Runs
/// [`sync_task_links`], keeping merge detection on this cadence.
pub fn collect_prs_open(
    store: &Store,
    repo_dirs: &[PathBuf],
    origin: Option<&Path>,
    reuse_ms: i64,
    now_ms: i64,
) -> CollectSummary {
    let (repo_dirs, scoped) = scope_to_origin(repo_dirs, origin);
    let repos = dedupe_repo_dirs(&repo_dirs);
    let outcome =
        sweep_repos_shared(&repos, "prs-open", reuse_ms, now_ms, prs::collect_repo_prs_open);
    let swept = swept_repos(&outcome, scoped);
    let write =
        |all: &[tt_store::PrInput], repos: Option<&[String]>| match repos.or(swept.as_deref()) {
            None => store.replace_open_prs(all),
            Some(repos) => store.replace_open_prs_for_repos(repos, all),
        };
    let summary =
        finish_sweep(store, "prs", outcome, write, |p| (p.repo.clone(), p.number), now_ms);
    sync_task_links(store, &dirs_of(&repos), now_ms);
    summary
}

/// The slow half of [`collect_prs`]. Links its own rows rather than leaving them to
/// the open half: a merge nudge fires both concurrently, and the open pass linking
/// rows the merged pass hasn't written yet is a race it loses half the time — for a
/// 20-minute wait, on the one event the nudge exists to make immediate.
/// [`link_task_prs`] alone, since the per-ref fetches are the open half's job.
pub fn collect_prs_merged(
    store: &Store,
    repo_dirs: &[PathBuf],
    origin: Option<&Path>,
    reuse_ms: i64,
    now_ms: i64,
) -> CollectSummary {
    let (repo_dirs, scoped) = scope_to_origin(repo_dirs, origin);
    let repos = dedupe_repo_dirs(&repo_dirs);
    let outcome =
        sweep_repos_shared(&repos, "prs-merged", reuse_ms, now_ms, prs::collect_repo_merged_prs);
    let swept = swept_repos(&outcome, scoped);
    let write =
        |all: &[tt_store::PrInput], repos: Option<&[String]>| match repos.or(swept.as_deref()) {
            None => store.replace_merged_prs(all),
            Some(repos) => store.replace_merged_prs_for_repos(repos, all),
        };
    let summary =
        finish_sweep(store, "prs", outcome, write, |p| (p.repo.clone(), p.number), now_ms);
    link_task_prs(store, &repo_dir_index(&dirs_of(&repos)), now_ms);
    summary
}

/// The one repo a nudge from `origin` is about, or every tracked repo when there is no
/// origin or none holds it. `true` when narrowed: such a sweep must never be written as
/// a full snapshot, which would clear every other repo's rows.
fn scope_to_origin(repo_dirs: &[PathBuf], origin: Option<&Path>) -> (Vec<PathBuf>, bool) {
    match nudge::origin_repo(repo_dirs, origin) {
        Some(dir) => (vec![dir], true),
        None => (repo_dirs.to_vec(), false),
    }
}

/// For a narrowed sweep, the repos it answered for — the write's forced per-repo scope.
fn swept_repos<T>(sweep: &Sweep<T>, scoped: bool) -> Option<Vec<String>> {
    scoped.then(|| sweep.successes.iter().map(|(repo, _)| repo.clone()).collect())
}

/// The latest default-branch Actions run per workflow for every tracked repo, under `ci`.
pub fn collect_ci(
    store: &Store,
    repo_dirs: &[PathBuf],
    origin: Option<&Path>,
    reuse_ms: i64,
    now_ms: i64,
) -> CollectSummary {
    let (repo_dirs, scoped) = scope_to_origin(repo_dirs, origin);
    let repos = dedupe_repo_dirs(&repo_dirs);
    let sweep = sweep_repos_shared(&repos, "ci", reuse_ms, now_ms, ci::collect_repo_ci);
    finish_ci_sweep(store, sweep, scoped, now_ms)
}

/// How long a workflow missing from a successful fetch keeps its last run.
const CI_ABSENT_KEEP_MS: i64 = 14 * 24 * 60 * 60 * 1000;

/// CI rows are upserted, never swapped: a workflow missing from this page keeps its
/// last known run until [`CI_ABSENT_KEEP_MS`] old. Only a sweep that reached every
/// tracked repo prunes whole repos, and only repos no longer tracked.
fn finish_ci_sweep(
    store: &Store,
    sweep: Sweep<tt_store::CiRun>,
    scoped: bool,
    now_ms: i64,
) -> CollectSummary {
    // A narrowed sweep says nothing about the repos it skipped.
    let clean = sweep.errors.is_empty() && sweep.skipped.is_empty() && !scoped;
    let tracked: Vec<String> = sweep.successes.iter().map(|(repo, _)| repo.clone()).collect();
    let stale_before_ms = now_ms.saturating_sub(CI_ABSENT_KEEP_MS);
    let write = |all: &[tt_store::CiRun], _scope: Option<&[String]>| {
        let written = store.upsert_ci_runs(all)?;
        for repo in &tracked {
            let present: Vec<&str> =
                all.iter().filter(|r| &r.repo == repo).map(|r| r.workflow.as_str()).collect();
            store.prune_absent_ci_workflows(repo, &present, stale_before_ms)?;
        }
        if clean {
            store.prune_ci_runs_except(&tracked)?;
        }
        Ok(written)
    };
    finish_sweep(store, "ci", sweep, write, |r| (r.repo.clone(), r.workflow.clone()), now_ms)
}

/// Upsert the watched Slack DM's latest state. Missing credentials is a recorded
/// failure, not a silent no-op: the caller already gated on `enabled`.
pub fn collect_slack_dm(store: &Store, config: &SlackDmConfig, now_ms: i64) -> CollectSummary {
    const KEY: &str = "slack:dm";
    if config.token.trim().is_empty() || config.watch_user_id.trim().is_empty() {
        let msg = "slack collector needs both a token and a watch user id".to_string();
        return finish(store, KEY, false, 0, Some(msg), now_ms);
    }
    match slack::fetch_dm(config) {
        Ok(Some(dm)) => match store.upsert_dm(&dm, now_ms) {
            Ok(()) => finish(store, KEY, true, 1, None, now_ms),
            Err(e) => finish(store, KEY, false, 0, Some(e.to_string()), now_ms),
        },
        Ok(None) => finish(store, KEY, true, 0, Some("no messages in DM yet".to_string()), now_ms),
        Err(msg) => finish(store, KEY, false, 0, Some(msg), now_ms),
    }
}

/// What a manual "refresh now" fires: issues, PRs, CI runs, and the watched DM when
/// `slack` is configured. Calendar is excluded — every run spends `claude` tokens.
/// Asks GitHub itself, since stale data reads as the button doing nothing.
pub fn collect_manual(
    store: &Store,
    repo_dirs: &[PathBuf],
    watched_labels: &[String],
    slack: Option<&SlackDmConfig>,
    now_ms: i64,
) -> Vec<CollectSummary> {
    let mut summaries = vec![
        collect_issues(store, repo_dirs, FETCH_NOW, now_ms),
        collect_watched_issues(store, repo_dirs, watched_labels, FETCH_NOW, now_ms),
        collect_prs(store, repo_dirs, now_ms),
        collect_ci(store, repo_dirs, None, FETCH_NOW, now_ms),
    ];
    if let Some(config) = slack {
        summaries.push(collect_slack_dm(store, config, now_ms));
    }
    summaries
}

/// The rail's "Sync now" for one repo. Never takes the full-table-replace path:
/// even a clean run touches only `dir`'s rows, so one repo can't wipe another's. A
/// missing `dir` is a recorded failure, not a sweep's silent skip.
pub fn collect_repo_now(store: &Store, dir: &Path, now_ms: i64) -> Vec<CollectSummary> {
    if !dir.is_dir() {
        let msg = format!("repo directory not found: {}", dir.display());
        return vec![
            finish(store, "issues", false, 0, Some(msg.clone()), now_ms),
            finish(store, "prs", false, 0, Some(msg), now_ms),
        ];
    }
    let issues_summary = collect_repo_issues_now(store, dir, now_ms);
    let prs_summary = collect_repo_prs_now(store, dir, now_ms);
    sync_task_links(store, std::slice::from_ref(&dir.to_path_buf()), now_ms);
    vec![issues_summary, prs_summary]
}

fn collect_repo_issues_now(store: &Store, dir: &Path, now_ms: i64) -> CollectSummary {
    write_repo_issues_now(store, issues::collect_repo_issues(dir), now_ms)
}

/// Apply one repo's issues via the scoped write — split out so the scoping is
/// unit-testable without shelling out to `gh`.
fn write_repo_issues_now(
    store: &Store,
    result: Result<(String, Vec<tt_store::IssueInput>), String>,
    now_ms: i64,
) -> CollectSummary {
    match result {
        Ok((repo, items)) => match store.replace_issues_for_repos(&[repo], &items) {
            Ok(count) => finish(store, "issues", true, count, None, now_ms),
            Err(e) => finish(store, "issues", false, 0, Some(e.to_string()), now_ms),
        },
        Err(e) => finish(store, "issues", false, 0, Some(e), now_ms),
    }
}

fn collect_repo_prs_now(store: &Store, dir: &Path, now_ms: i64) -> CollectSummary {
    write_repo_prs_now(store, prs::collect_repo_prs(dir), now_ms)
}

/// Apply one repo's PRs via the scoped write — split out so the scoping is
/// unit-testable without shelling out to `gh`.
fn write_repo_prs_now(
    store: &Store,
    result: Result<(String, Vec<tt_store::PrInput>), String>,
    now_ms: i64,
) -> CollectSummary {
    match result {
        Ok((repo, items)) => match store.replace_prs_for_repos(&[repo], &items) {
            Ok(count) => finish(store, "prs", true, count, None, now_ms),
            Err(e) => finish(store, "prs", false, 0, Some(e.to_string()), now_ms),
        },
        Err(e) => finish(store, "prs", false, 0, Some(e), now_ms),
    }
}

/// Tracked repo dirs from the agentboard repos config. Only real checkouts live
/// here — task worktrees are store records, never `repos.json` entries.
pub fn tracked_repo_dirs() -> Vec<PathBuf> {
    let path = tt_agentboard::repos::default_repos_path();
    tt_agentboard::repos::load_repos(&path).into_iter().map(PathBuf::from).collect()
}

/// Record the run and build the summary. A failed `record_run` is ignored — the
/// contract forbids surfacing it.
fn finish(
    store: &Store,
    collector: &str,
    ok: bool,
    count: usize,
    message: Option<String>,
    now_ms: i64,
) -> CollectSummary {
    let _ = store.record_run(collector, ok, message.as_deref(), now_ms);
    CollectSummary { collector: collector.to_string(), ok, count, message }
}

#[cfg(test)]
mod tests;
