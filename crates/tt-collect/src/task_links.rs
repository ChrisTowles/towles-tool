use super::*;

/// The Board↔GitHub read half for tasks: a targeted `gh <issue|pr> view` for every
/// link *missing* from the snapshot, since absence is ambiguous and state is never
/// inferred, then [`link_task_prs`]. Each stage logs and moves on. The PR half
/// writes the whole row back, not just the state — the rail draws its badge from
/// `pr_status`, so a PR no sweep carries would be a link with no badge.
pub(crate) fn sync_task_links(store: &Store, repo_dirs: &[PathBuf], now_ms: i64) {
    let dir_by_repo = repo_dir_index(repo_dirs);
    match store.open_issue_refs_missing_from_cache() {
        Ok(refs) => {
            for (repo, number) in refs {
                let Some(dir) = dir_by_repo.get(&repo) else {
                    continue;
                };
                match issues::fetch_issue_state(dir, number) {
                    Ok(state) => {
                        if let Err(e) = store.set_issue_link_state(&repo, number, &state, now_ms) {
                            log::warn!("set_issue_link_state {repo}#{number} failed: {e}");
                        }
                    }
                    Err(e) => log::warn!("issue state fetch {repo}#{number} failed: {e}"),
                }
            }
        }
        Err(e) => log::warn!("open_issue_refs_missing_from_cache failed: {e}"),
    }
    match store.pr_refs_missing_from_cache() {
        Ok(refs) => {
            for (repo, number) in refs {
                let Some(dir) = dir_by_repo.get(&repo) else {
                    continue;
                };
                match prs::fetch_pr(dir, &repo, number) {
                    Ok(Some(pr)) => {
                        if let Err(e) = store.upsert_prs(std::slice::from_ref(&pr)) {
                            log::warn!("upsert_prs {repo}#{number} failed: {e}");
                        }
                    }
                    Ok(None) => log::warn!("gh pr view {repo}#{number}: no PR in JSON"),
                    Err(e) => log::warn!("pr fetch {repo}#{number} failed: {e}"),
                }
            }
        }
        Err(e) => log::warn!("pr_refs_missing_from_cache failed: {e}"),
    }
    link_task_prs(store, &dir_by_repo, now_ms);
}

/// What a pass owes its *own* rows: state onto link rows, attach branch matches,
/// roll up, archive. Both PR halves run it — the merged half writes rows the open
/// half would otherwise race to link — while the per-ref fetches stay on the open.
pub(crate) fn link_task_prs(
    store: &Store,
    dir_by_repo: &std::collections::HashMap<String, PathBuf>,
    now_ms: i64,
) {
    if let Err(e) = store.refresh_link_states_from_cache(now_ms) {
        log::warn!("refresh_link_states_from_cache failed: {e}");
    }
    probe_unlinked_worktree_prs(store, dir_by_repo, now_ms);
    if let Err(e) = store.auto_attach_worktree_prs(now_ms) {
        log::warn!("auto_attach_worktree_prs failed: {e}");
    }
    if let Err(e) = rollup_task_statuses(store, now_ms) {
        log::warn!("rollup_task_statuses failed: {e}");
    }
    // The same cadence that creates done tasks in the first place.
    if let Err(e) = store.archive_closed_tasks(now_ms - tt_store::ARCHIVE_AFTER_MS, now_ms) {
        log::warn!("archive_closed_tasks failed: {e}");
    }
}

/// How long a worktree task waits before asking GitHub about its branch again.
pub(crate) const PR_PROBE_INTERVAL_MS: i64 = 15 * 60 * 1000;

/// `gh` calls one pass may spend on branch probes; the rest lead the next queue.
pub(crate) const PR_PROBE_MAX_CALLS: usize = 8;

/// Wider than the call cap: the free pushed-branch gate must not spend a slot.
pub(crate) const PR_PROBE_CANDIDATES: usize = PR_PROBE_MAX_CALLS * 4;

/// Ask GitHub about the branch of each worktree task with no PR linked yet. The
/// snapshot can't answer: a PR merging between two open sweeps links only if the
/// merged sweep covers it, and every squash merge from a worktree lands that way
/// (`gh pr merge` dies on "'main' is already used by worktree"). Per *task*, so
/// both GraphQL brakes matter: the free pushed-branch gate and the capped calls.
pub(crate) fn probe_unlinked_worktree_prs(
    store: &Store,
    dir_by_repo: &std::collections::HashMap<String, PathBuf>,
    now_ms: i64,
) {
    let candidates =
        match store.unlinked_worktrees(now_ms - PR_PROBE_INTERVAL_MS, PR_PROBE_CANDIDATES) {
            Ok(candidates) => candidates,
            Err(e) => {
                log::warn!("unlinked_worktrees failed: {e}");
                return;
            }
        };

    let mut ask = Vec::new();
    let mut probed = Vec::new();
    for task in candidates {
        // No dir means no way to ask, so the clock stays unstamped.
        let Some(dir) = dir_by_repo.get(&task.repo) else {
            continue;
        };
        // Free half: a branch that never left this machine has no PR to find.
        let pushed = tt_git::repo::open(dir).is_ok_and(|repo| repo.branch_was_pushed(&task.branch));
        probed.push(task.task_id);
        if pushed {
            ask.push((task, dir.clone()));
        }
        if ask.len() >= PR_PROBE_MAX_CALLS {
            break;
        }
    }

    // Claimed before any call, so the open and merged passes a nudge fires together
    // can't both spend one here. Stamped on a miss and an error alike.
    if !probed.is_empty()
        && let Err(e) = store.mark_pr_probe(&probed, now_ms)
    {
        log::warn!("mark_pr_probe failed: {e}");
        return;
    }

    let found: Vec<_> = ask
        .into_iter()
        .filter_map(|(task, dir)| match prs::fetch_branch_pr(&dir, &task.repo, &task.branch) {
            Ok(pr) => pr,
            Err(e) => {
                log::warn!("branch PR probe for {}#{} failed: {e}", task.repo, task.branch);
                None
            }
        })
        .collect();
    if !found.is_empty()
        && let Err(e) = store.upsert_prs(&found)
    {
        log::warn!("upsert_prs failed: {e}");
    }
}

/// Map `owner/name` → repo dir so targeted fetches know where to run `gh`. A dir
/// whose lookup fails is skipped; its refs keep their cached state.
pub(crate) fn repo_dir_index(repo_dirs: &[PathBuf]) -> std::collections::HashMap<String, PathBuf> {
    let mut index = std::collections::HashMap::new();
    for dir in repo_dirs {
        match gh::repo_name_with_owner(dir) {
            Ok(name) => {
                index.entry(name).or_insert_with(|| dir.clone());
            }
            Err(e) => log::debug!("repo name lookup failed for {}: {e}", dir.display()),
        }
    }
    index
}

/// Roll linked tasks across the done boundary from their cached link states, and back
/// to `backlog` on a reopened ref. Unlinked tasks never auto-move; closed and archived
/// ones are skipped, since an explicit outcome is a decision this must never overturn.
pub fn rollup_task_statuses(store: &Store, now_ms: i64) -> tt_store::Result<usize> {
    let mut changed = 0;
    for task in store.all_tasks()? {
        if task.issues.is_empty() && task.prs.is_empty() {
            continue;
        }
        if task.outcome.is_some() || task.archived_at.is_some() {
            continue;
        }
        let resolved = task.issues.iter().all(|l| l.state == "closed")
            && task.prs.iter().all(|l| l.state == "merged" || l.state == "closed");
        let target = match (resolved, task.status.as_str()) {
            (true, status) if status != "done" => Some("done"),
            (false, "done") => Some("backlog"),
            _ => None,
        };
        if let Some(status) = target {
            store.set_task_status(task.id, status, now_ms)?;
            changed += 1;
        }
    }
    Ok(changed)
}
