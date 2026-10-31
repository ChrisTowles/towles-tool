//! The rail's chosen order: repos, and the checkouts inside each repo, by
//! [`RailSort`]. Applied to the payload in the engine, so every surface reading
//! it — the tree, the icon strip, the jump digits — agrees without re-sorting.
//!
//! Every sort is stable over the incoming order, which is [`RailSort::Manual`]
//! itself, so ties (and repos with no activity at all) keep the order you gave.

use tt_config::RailSort;

use crate::types::{FolderData, RepoData, RowRecord};

/// Recency is compared in buckets this wide. Agents stamp activity every few
/// seconds, and two busy repos ranked by the raw time would swap on every tick;
/// within a bucket the manual order breaks the tie and holds still.
pub const RECENT_BUCKET_MS: i64 = 5 * 60_000;

/// Newest sign of work in a checkout: [`FolderData::worked_at_ms`] plus the agent
/// events the engine has attributed to its sessions.
pub fn folder_activity_ms(folder: &FolderData) -> i64 {
    let agents = folder.sessions.iter().flat_map(|s| s.agent_state.iter().chain(&s.agents));
    agents
        .map(|ev| ev.ts.max(ev.details.as_ref().and_then(|d| d.last_activity_at).unwrap_or(0)))
        .fold(folder.worked_at_ms, i64::max)
}

pub fn repo_activity_ms(repo: &RepoData) -> i64 {
    repo.folders.iter().map(folder_activity_ms).max().unwrap_or(0)
}

fn bucket(ms: i64) -> i64 {
    ms.div_euclid(RECENT_BUCKET_MS)
}

pub fn sort_repos(repos: &mut [RepoData], sort: RailSort) {
    match sort {
        RailSort::Manual => {}
        RailSort::Name => repos.sort_by_cached_key(|r| r.name.to_lowercase()),
        RailSort::Recent => {
            repos.sort_by_cached_key(|r| std::cmp::Reverse(bucket(repo_activity_ms(r))))
        }
    }
}

/// The repo's own checkout (and `~`'s one row) always leads: it is the repo, the
/// rest are tasks hanging off it, and only those are reordered.
pub fn sort_folders(folders: &mut [FolderData], sort: RailSort) {
    let pinned = |f: &FolderData| !matches!(f.record, RowRecord::Checkout | RowRecord::Home);
    match sort {
        RailSort::Manual => {}
        RailSort::Name => folders.sort_by_cached_key(|f| (pinned(f), f.name.to_lowercase())),
        RailSort::Recent => folders
            .sort_by_cached_key(|f| (pinned(f), std::cmp::Reverse(bucket(folder_activity_ms(f))))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AgentEvent, AgentEventDetails, AgentStatus, RowTask, SessionData};

    const MIN: i64 = 60_000;

    fn task(name: &str, worked_at_ms: i64) -> FolderData {
        FolderData {
            name: name.to_string(),
            dir: format!("/r/.claude/worktrees/{name}"),
            record: RowRecord::Task {
                task: RowTask { id: 1, status: "doing".into(), branch: None },
            },
            worked_at_ms,
            ..Default::default()
        }
    }

    fn root(name: &str, worked_at_ms: i64) -> FolderData {
        FolderData {
            name: name.to_string(),
            dir: format!("/{name}"),
            record: RowRecord::Checkout,
            worked_at_ms,
            ..Default::default()
        }
    }

    fn repo(name: &str, folders: Vec<FolderData>) -> RepoData {
        RepoData {
            key: format!("path:/{name}"),
            dir: format!("/{name}"),
            name: name.to_string(),
            origin_url: None,
            folders,
            needs: 0,
            meta: None,
            color: Default::default(),
            archived: false,
        }
    }

    fn names(folders: &[FolderData]) -> Vec<&str> {
        folders.iter().map(|f| f.name.as_str()).collect()
    }

    fn repo_names(repos: &[RepoData]) -> Vec<&str> {
        repos.iter().map(|r| r.name.as_str()).collect()
    }

    #[test]
    fn manual_keeps_the_incoming_order() {
        let mut repos = vec![repo("b", vec![]), repo("a", vec![])];
        sort_repos(&mut repos, RailSort::Manual);
        assert_eq!(repo_names(&repos), ["b", "a"]);
    }

    #[test]
    fn name_sorts_repos_ignoring_case() {
        let mut repos = vec![
            repo("zeta", vec![]),
            repo("Alpha", vec![]),
            repo("beta", vec![]),
        ];
        sort_repos(&mut repos, RailSort::Name);
        assert_eq!(repo_names(&repos), ["Alpha", "beta", "zeta"]);
    }

    #[test]
    fn recent_puts_the_repo_with_the_newest_checkout_first() {
        let mut repos = vec![
            repo("old", vec![root("old", 10 * MIN)]),
            repo("new", vec![root("new", MIN), task("t", 60 * MIN)]),
        ];
        sort_repos(&mut repos, RailSort::Recent);
        assert_eq!(repo_names(&repos), ["new", "old"]);
    }

    #[test]
    fn recent_ties_inside_a_bucket_keep_the_manual_order() {
        // One minute apart is the same bucket: neither repo jumps the other.
        let mut repos = vec![
            repo("a", vec![root("a", 20 * MIN)]),
            repo("b", vec![root("b", 21 * MIN)]),
        ];
        sort_repos(&mut repos, RailSort::Recent);
        assert_eq!(repo_names(&repos), ["a", "b"]);
    }

    #[test]
    fn agent_activity_counts_as_recent_work() {
        let busy = AgentEvent {
            agent: "claude".into(),
            session: "s".into(),
            status: AgentStatus::Busy,
            ts: MIN,
            thread_id: None,
            thread_name: None,
            unseen: None,
            details: Some(AgentEventDetails {
                last_activity_at: Some(90 * MIN),
                ..Default::default()
            }),
        };
        let mut agent_task = task("agent", 0);
        agent_task.sessions = vec![SessionData { agent_state: Some(busy), ..Default::default() }];
        assert_eq!(folder_activity_ms(&agent_task), 90 * MIN);

        let mut folders = vec![root("r", 0), task("edited", 30 * MIN), agent_task];
        sort_folders(&mut folders, RailSort::Recent);
        assert_eq!(names(&folders), ["r", "agent", "edited"]);
    }

    #[test]
    fn the_repos_own_checkout_stays_first_whatever_the_sort() {
        let mut folders = vec![root("zz-root", 0), task("b", 50 * MIN), task("a", 99 * MIN)];
        sort_folders(&mut folders, RailSort::Name);
        assert_eq!(names(&folders), ["zz-root", "a", "b"]);
        sort_folders(&mut folders, RailSort::Recent);
        assert_eq!(names(&folders), ["zz-root", "a", "b"]);
    }
}
