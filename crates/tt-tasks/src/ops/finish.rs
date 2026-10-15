//! `/done`'s gate: may a task close as done right now? Answered live from git and `gh` —
//! the board's PR links lag a merge by a collector poll, and a stale "open" there would
//! refuse a task whose PR merged a second ago.

use std::path::Path;

use serde::Serialize;

use super::remove::{claimed_ports, docker_owns_port};
use super::{
    base_refs, git_checkout, orphaned_count, port_occupied, repo_at, uncommitted_count, work_state,
};
use crate::landed::WorkState;
use crate::pr::PullRequest;

/// Why a task may not close as done yet — the same `kind`/`message`/`remedy`/`losesWork`
/// shape as a removal blocker, so an agent reads one refusal format from either gate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishBlocker {
    pub kind: &'static str,
    pub message: String,
    pub remedy: String,
    pub loses_work: bool,
}

/// Every reason the task in `dir`, on `branch`, is not finished, plus caveats about how the
/// answer was reached. Empty blockers = land it.
pub fn finish_blockers(dir: &Path, branch: &str) -> (Vec<FinishBlocker>, Vec<String>) {
    let mut notes = Vec::new();
    // `/done` runs right after a merge: against a stale `origin/<base>` the merged branch
    // reads as unlanded and the gate refuses work that just shipped.
    if !git_checkout(dir, &["fetch", "--prune", "--quiet", "origin"]).is_ok_and(|out| out.ok()) {
        notes.push("fetch failed (offline?) — judged against local refs".to_string());
    }
    let open_prs = match crate::pr::list_open_for_head(dir, branch) {
        Ok(prs) => prs,
        Err(e) => {
            notes.push(format!("could not ask GitHub for open PRs ({e}) — judged by git alone"));
            Vec::new()
        }
    };
    let refs = base_refs(dir);
    let work = work_state(
        &refs,
        dir,
        &format!("refs/heads/{branch}"),
        uncommitted_count(dir),
        orphaned_count(dir),
    );
    (classify_finish(&open_prs, &work, branch, &refs.base), notes)
}

/// The pure half of [`finish_blockers`]. An open PR outranks the git answer: its branch can
/// read as landed (an earlier squash) while it still carries unmerged commits.
pub fn classify_finish(
    open_prs: &[PullRequest],
    work: &WorkState,
    branch: &str,
    base: &str,
) -> Vec<FinishBlocker> {
    let mut blockers: Vec<FinishBlocker> = open_prs
        .iter()
        .map(|pr| FinishBlocker {
            kind: "openPr",
            message: format!("PR #{} is still open: {}", pr.number, pr.url),
            remedy: format!(
                "Merge PR #{} the way this repo's PRs land, then finish again.",
                pr.number
            ),
            loses_work: false,
        })
        .collect();
    if work.uncommitted > 0 {
        blockers.push(FinishBlocker {
            kind: "dirtyTree",
            message: format!("{} uncommitted path(s) in the worktree", work.uncommitted),
            remedy: "Commit them into the PR, or discard them if they are scratch.".to_string(),
            loses_work: true,
        });
    }
    if open_prs.is_empty() && work.unlanded > 0 {
        blockers.push(FinishBlocker {
            kind: "notLanded",
            message: format!(
                "{} commit(s) on {branch} have not reached {base} and no PR is open",
                work.unlanded
            ),
            remedy: format!("Push {branch}, open a PR and merge it, then finish again."),
            loses_work: false,
        });
    }
    blockers
}

/// Stop whatever listens on the task's own claimed ports — the dev server or `bun start`
/// left running for the user to check, which the removal guard would otherwise refuse on.
/// Never this process: an app serving the caller from inside the task would kill the call.
pub fn stop_own_listeners(dir: &Path) -> Result<Vec<String>, String> {
    let name = crate::task_name_from_dir(dir);
    let me = std::process::id() as i32;
    let mut messages = Vec::new();
    for port in claimed_ports(dir) {
        if !port_occupied(port) || docker_owns_port(&name, port) {
            continue;
        }
        if crate::ports::holder(port).is_some_and(|h| h.pid == me) {
            return Err(format!(
                "this app instance holds port {port}, a claim of the task itself — finish the task from the main app"
            ));
        }
        let stopped = crate::ports::stop_listeners(port).map_err(|e| e.to_string())?;
        if !stopped.pgids.is_empty() {
            messages.push(format!("stopped the task's own process on port {port}"));
        }
    }
    Ok(messages)
}

/// The task's checked-out branch, the one its PR is opened from.
pub fn head_branch(dir: &Path) -> Option<String> {
    repo_at(dir).ok()?.head_branch().filter(|b| !b.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pr(number: u64) -> PullRequest {
        PullRequest {
            number,
            title: "t".into(),
            url: format!("https://github.com/o/r/pull/{number}"),
            state: "OPEN".into(),
            is_draft: false,
            head_branch: "feat/x".into(),
            base_branch: "main".into(),
            cross_repository: false,
            head_owner: "o".into(),
            author: "o".into(),
        }
    }

    fn kinds(blockers: &[FinishBlocker]) -> Vec<&'static str> {
        blockers.iter().map(|b| b.kind).collect()
    }

    #[test]
    fn a_merged_clean_branch_finishes() {
        let work = WorkState { total_commits: 2, ..Default::default() };
        assert!(classify_finish(&[], &work, "feat/x", "main").is_empty());
    }

    #[test]
    fn an_open_pr_blocks_and_hides_the_unlanded_count_it_explains() {
        let work = WorkState { unlanded: 3, total_commits: 3, ..Default::default() };
        let blockers = classify_finish(&[pr(7)], &work, "feat/x", "main");
        assert_eq!(kinds(&blockers), ["openPr"]);
        assert!(blockers[0].message.contains("#7"));
    }

    #[test]
    fn unlanded_commits_without_a_pr_block() {
        let work = WorkState { unlanded: 1, total_commits: 1, ..Default::default() };
        assert_eq!(kinds(&classify_finish(&[], &work, "feat/x", "main")), ["notLanded"]);
    }

    #[test]
    fn uncommitted_work_blocks_even_after_the_merge() {
        let work = WorkState { uncommitted: 1, total_commits: 1, ..Default::default() };
        let blockers = classify_finish(&[], &work, "feat/x", "main");
        assert_eq!(kinds(&blockers), ["dirtyTree"]);
        assert!(blockers[0].loses_work);
    }
}
