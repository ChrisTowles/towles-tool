//! Removal guards for `tt task rm` — a task must never take work with it. Pure
//! functions: the CLI gathers git output, bind-test results and docker listings in the
//! task's directory and hands the raw data here for the decision.
//!
//! - Stashes are repo-global in a worktree hub (they live in the shared `.git`), so a
//!   per-task stash guard is meaningless here.
//! - The commit guard means *reachable from no branch and no remote*: removing a
//!   worktree never deletes branches, so only detached/orphan commits are real data
//!   loss. Upstream-based checks silently pass on never-pushed branches and detached
//!   HEADs (both occurred in the real migration), and remote-only checks block
//!   everything in a `git clone --bare` hub, which has no `refs/remotes` at all.

use thiserror::Error;

/// The process holding a port: enough to recognize it ("that's my dev server") without
/// opening a terminal.
///
/// Lives with the decision rather than in [`crate::ports`] that discovers it: this module
/// is the pure half of the crate, and a decision depending on a module that spawns
/// subprocesses is the arrow that erodes that.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortHolder {
    pub pid: i32,
    /// Executable name — see `ports::command_name` for why it is `argv[0]`, not `comm`.
    pub command: String,
}

impl PortHolder {
    /// `node (pid 12345)` — how both the guard message and the app's row say who.
    pub fn describe(&self) -> String {
        format!("{} (pid {})", self.command, self.pid)
    }
}

/// A claimed port something outside the task's own containers is listening on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForeignPort {
    pub port: u16,
    /// `None` when `lsof`/`ps` couldn't name the process — the bind probe still proved
    /// *something* is there.
    pub holder: Option<PortHolder>,
}

/// Why a task may NOT be removed. Typed all the way to both shells rather than flattened
/// at the guard: the app renders each reason as its own row with its own remedy and, for
/// a port, its own "stop it" button. A joined string can do neither.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum RmBlocked {
    #[error("task working tree is not clean ({entries} changed/untracked path(s))")]
    DirtyTree { entries: usize },

    #[error(
        "{count} commit(s) reachable from no branch or remote — removal would orphan them; park them on a branch or push first"
    )]
    UnreachableCommits { count: u64 },

    #[error(
        "port {port} (claimed by this task) is in use by {} — a dev server may be running",
        .holder.as_ref().map_or_else(
            || "a process outside the task's containers".to_string(),
            PortHolder::describe,
        )
    )]
    ForeignPortListener {
        port: u16,
        holder: Option<PortHolder>,
    },
}

impl RmBlocked {
    /// Stable identifier, so a UI branches on the kind and not the message text.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::DirtyTree { .. } => "dirtyTree",
            Self::UnreachableCommits { .. } => "unreachableCommits",
            Self::ForeignPortListener { .. } => "foreignPort",
        }
    }

    /// What turns the refusal into a next step — an instruction, not a diagnosis. Plain
    /// prose, no markup: the app's dialog is not a terminal, and backticks around a
    /// command showed up as literal backticks on screen.
    pub fn remedy(&self) -> String {
        match self {
            Self::DirtyTree { .. } => "Commit or stash the changes to keep them.".to_string(),
            Self::UnreachableCommits { .. } => {
                "Put them on a branch or push them to keep them.".to_string()
            }
            Self::ForeignPortListener { holder, .. } => match holder {
                Some(h) => {
                    format!("Stop {} — it's probably a dev server in this task.", h.describe())
                }
                None => "Stop whatever is using the port — probably a dev server in this task."
                    .to_string(),
            },
        }
    }

    /// Whether forcing past this guard destroys work that exists nowhere else. A stray
    /// listener costs nothing; the git guards are unrecoverable, and the app says so
    /// before offering the force.
    pub fn loses_work(&self) -> bool {
        match self {
            Self::DirtyTree { .. } | Self::UnreachableCommits { .. } => true,
            Self::ForeignPortListener { .. } => false,
        }
    }

    /// The claimed port this guard is about, for a shell that can offer to clear it —
    /// an accessor, so shells never reach into the enum's variant shapes.
    pub fn port(&self) -> Option<u16> {
        match self {
            Self::ForeignPortListener { port, .. } => Some(*port),
            _ => None,
        }
    }
}

/// Every reason removal is blocked, given the gathered state. Empty = safe.
/// `foreign_ports` excludes the task's own docker containers, which are about to be
/// removed anyway; what is left means a dev server is still running.
pub fn check_removal(
    dirty_entries: usize,
    unreachable_commits: u64,
    foreign_ports: &[ForeignPort],
) -> Vec<RmBlocked> {
    let mut blocked = Vec::new();
    if dirty_entries > 0 {
        blocked.push(RmBlocked::DirtyTree { entries: dirty_entries });
    }
    if unreachable_commits > 0 {
        blocked.push(RmBlocked::UnreachableCommits { count: unreachable_commits });
    }
    blocked.extend(
        foreign_ports
            .iter()
            .map(|fp| RmBlocked::ForeignPortListener { port: fp.port, holder: fp.holder.clone() }),
    );
    blocked
}

/// Whether a docker container/volume name belongs to `task_name`. Anchored:
/// `blog-task-1-postgres` and `blog-task-1_data` match `blog-task-1`;
/// `blog-task-10-postgres` does NOT (substring filters caught it in the probe).
pub fn docker_resource_matches(resource: &str, task_name: &str) -> bool {
    match resource.strip_prefix(task_name) {
        Some("") => true,
        Some(rest) => rest.starts_with(['-', '_', '.']),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_task_passes() {
        assert!(check_removal(0, 0, &[]).is_empty());
    }

    #[test]
    fn every_reason_is_reported() {
        let blocked = check_removal(2, 1, &[ForeignPort { port: 3000, holder: None }]);
        assert_eq!(
            blocked,
            vec![
                RmBlocked::DirtyTree { entries: 2 },
                RmBlocked::UnreachableCommits { count: 1 },
                RmBlocked::ForeignPortListener { port: 3000, holder: None },
            ]
        );
    }

    #[test]
    fn a_named_holder_reaches_the_message_and_the_remedy() {
        let holder = PortHolder { pid: 4242, command: "node".to_string() };
        let blocked = check_removal(0, 0, &[ForeignPort { port: 4424, holder: Some(holder) }]);
        let [only] = &blocked[..] else {
            panic!("expected one blocker, got {blocked:?}")
        };
        assert!(only.to_string().contains("node (pid 4242)"), "{only}");
        assert!(only.remedy().contains("node (pid 4242)"), "{}", only.remedy());
    }

    #[test]
    fn an_unidentified_holder_still_reads_as_a_sentence() {
        let blocked = check_removal(0, 0, &[ForeignPort { port: 4424, holder: None }]);
        let [only] = &blocked[..] else {
            panic!("expected one blocker, got {blocked:?}")
        };
        assert!(only.to_string().contains("a process outside the task's containers"), "{only}");
        assert!(!only.remedy().is_empty());
    }

    #[test]
    fn only_the_git_guards_lose_work() {
        assert!(RmBlocked::DirtyTree { entries: 1 }.loses_work());
        assert!(RmBlocked::UnreachableCommits { count: 1 }.loses_work());
        assert!(!RmBlocked::ForeignPortListener { port: 3000, holder: None }.loses_work());
    }

    #[test]
    fn only_the_port_guard_offers_a_port() {
        assert_eq!(RmBlocked::ForeignPortListener { port: 3000, holder: None }.port(), Some(3000));
        assert_eq!(RmBlocked::DirtyTree { entries: 1 }.port(), None);
        assert_eq!(RmBlocked::UnreachableCommits { count: 1 }.port(), None);
    }

    #[test]
    fn kinds_are_distinct() {
        let kinds = [
            RmBlocked::DirtyTree { entries: 1 }.kind(),
            RmBlocked::UnreachableCommits { count: 1 }.kind(),
            RmBlocked::ForeignPortListener { port: 1, holder: None }.kind(),
        ];
        let unique: std::collections::BTreeSet<_> = kinds.iter().collect();
        assert_eq!(unique.len(), kinds.len(), "{kinds:?}");
    }

    #[test]
    fn docker_matching_is_anchored() {
        assert!(docker_resource_matches("blog-task-1-postgres_5433", "blog-task-1"));
        assert!(docker_resource_matches("blog-task-1_postgres_data", "blog-task-1"));
        assert!(docker_resource_matches("blog-task-1", "blog-task-1"));
        assert!(!docker_resource_matches("blog-task-10-postgres", "blog-task-1"));
        assert!(!docker_resource_matches("other-blog-task-1", "blog-task-1"));
    }
}
