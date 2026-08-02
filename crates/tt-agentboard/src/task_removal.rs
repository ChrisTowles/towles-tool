//! Removing a worktree task and everything bound to it — the sequence, in one
//! place. A task is three things (#339): a board row, a git worktree, and what
//! the host attached to that directory, so the *order* is policy, not detail:
//!
//! 1. guards run with everything still alive, so a refusal costs nothing;
//! 2. the host tears down what it owns (PTYs, rail state);
//! 3. the worktree leaves disk;
//! 4. the dir is untracked from `repos.json` — skip it and the `prs`/`issues`
//!    collectors retry `gh`/`git` against a dead path forever;
//! 5. the board row is **closed last**, recording a [`tt_store::TaskOutcome`].
//!
//! It needs all three at once, so neither `tt-tasks` (cycle) nor `tt-app` can host it.

use std::path::Path;

use tt_store::{Store, TaskOutcome};
use tt_tasks::RmBlocked;
use tt_tasks::ops::{self, RemoveOpts, RemoveOutcome, RemovePhase};

/// What the host does at the points in the sequence only it can act on. All
/// default to nothing, so the CLI implements none of them.
pub trait RemovalHooks {
    /// A step is starting, so a UI can show it rather than one static label.
    ///
    /// [`RemovePhase::StoppingSessions`] fires once the guards have passed (or
    /// been forced), which is where the app kills the folder's PTYs — so a
    /// *refused* removal never costs a live Claude session.
    fn on_phase(&mut self, _phase: RemovePhase) {}

    /// The worktree is gone from disk; the app drops the folder's session,
    /// window and pane records here.
    ///
    /// **Two directories' cached git state go stale, not one**: `dir`'s own and
    /// the *owner* checkout's, whose cached worktree listing still names `dir`.
    /// Invalidating only one once put a deleted task's row back on the rail.
    /// Returns progress notes, ordered as this step ran.
    fn after_removal(&mut self, _dir: &Path) -> Vec<String> {
        Vec::new()
    }
}

/// What an already-gone worktree directory means. The two callers mean
/// genuinely different things by it, and collapsing them makes one of them lie:
pub enum MissingDir {
    /// **Fail.** The caller named a task — `tt task rm feat-tpyo` — and a name
    /// resolving to nothing is a mistake to report, not a no-op to celebrate.
    Fail,
    /// **Tear the bindings down anyway.** The caller holds a *record* pointing
    /// at the directory, which is exactly what needs cleaning up after someone
    /// removed the worktree outside the app.
    TearDownBindings,
}

/// A hook set that does nothing — the CLI's.
pub struct NoHooks;
impl RemovalHooks for NoHooks {}

/// How the sequence reaches the board row bound to a worktree. A trait, not a
/// `&Store`: the app's store sits behind the mutex serving UI snapshots, and
/// holding that across a minute-long `git worktree remove` would freeze the
/// board it exists to publish.
pub trait BoardRows {
    /// Close the task bound to `dir`, recording `outcome`. `None` when the
    /// worktree had no task — the rail discovers ones the board never knew.
    fn close_task_for_worktree(
        &self,
        dir: &str,
        outcome: TaskOutcome,
        now_ms: i64,
    ) -> Option<String>;
}

impl BoardRows for Store {
    fn close_task_for_worktree(
        &self,
        dir: &str,
        outcome: TaskOutcome,
        now_ms: i64,
    ) -> Option<String> {
        let row = self.task_for_worktree_dir(dir).ok()??;
        match self.close_task(row.id, outcome, now_ms) {
            Ok(_) => Some(format!(
                "closed board task #{} as {} ({})",
                row.id,
                outcome.as_str(),
                row.text
            )),
            Err(error) => Some(format!("could not close board task #{}: {error}", row.id)),
        }
    }
}

/// One task to remove: the worktree at `dir`, plus the bindings keyed by it.
pub struct TaskRemoval<'a> {
    /// Which worktree, and whether to skip the guards.
    pub opts: &'a RemoveOpts,
    /// Passed rather than re-derived: it is the key every binding is stored
    /// under, and must outlive the directory.
    pub dir: &'a Path,
    /// The tracked-repo list to untrack `dir` from.
    pub repos_path: &'a Path,
    /// `None` skips step 5 — a real state for a caller that can't resolve which
    /// per-checkout store owns the row.
    pub rows: Option<&'a dyn BoardRows>,
    /// Recorded on the board row at step 5. Headless callers infer it (merged
    /// PR / landed work ⇒ done, else abandoned).
    pub outcome: TaskOutcome,
    pub now_ms: i64,
    /// What an already-gone directory means to this caller — see [`MissingDir`].
    pub on_missing: MissingDir,
}

/// [`ops::RemoveOutcome`] with the bindings teardown folded into `Removed`.
pub enum Outcome {
    Removed {
        name: String,
        messages: Vec<String>,
    },
    /// The guards refused. **Nothing was removed** — not the worktree, not the
    /// bindings, not the row — so the caller can surface the reasons and retry.
    Blocked {
        name: String,
        blocked: Vec<RmBlocked>,
        messages: Vec<String>,
    },
}

/// Steps 4 and 5 alone, for a caller whose worktree is already off disk — a
/// real operation, not a shortcut: bindings outlive the directory they are
/// keyed by, and `tt task clean` needs the identical teardown in bulk.
pub fn remove_bindings(
    repos_path: &Path,
    rows: Option<&dyn BoardRows>,
    dir: &Path,
    outcome: TaskOutcome,
    now_ms: i64,
) -> Vec<String> {
    let dir_s = dir.to_string_lossy().to_string();
    let mut messages = Vec::new();

    // A task worktree is never a `repos.json` entry (see `RowRecord`'s doc), so
    // this only fires on a legacy file written before that rule.
    if let Ok((_, true)) = crate::repos::remove_repo_persisted(repos_path, &dir_s) {
        messages.push("untracked from the agentboard rail".to_string());
    }

    // Last: the worktree is gone, so this can no longer strand anything on disk.
    if let Some(note) = rows.and_then(|rows| rows.close_task_for_worktree(&dir_s, outcome, now_ms))
    {
        messages.push(note);
    }
    messages
}

/// Run the whole sequence at the top of this module. A missing directory is
/// handled per [`MissingDir`], and *only* [`MissingDir::TearDownBindings`]
/// skips step 3 — an unconditional `is_dir()` pre-flight would turn `tt task rm
/// <typo>` into a cheerful "removed". Skipping the call outright, rather than
/// catching `NoSuchTask`, also stops a stale recorded dir from having its root
/// re-discovered from the *process's* cwd — a different checkout entirely.
pub fn remove_task_and_bindings(
    task: TaskRemoval<'_>,
    hooks: &mut dyn RemovalHooks,
) -> Result<Outcome, ops::OpsError> {
    let mut messages = Vec::new();
    let name;

    let bindings_only =
        !task.dir.is_dir() && matches!(task.on_missing, MissingDir::TearDownBindings);
    if bindings_only {
        name = task.opts.name.clone();
        messages.push(format!(
            "worktree {} was already gone — its configured TT_TASK_TEARDOWN (if any) did not run",
            task.dir.display()
        ));
    } else {
        match ops::remove_task(task.opts, &mut |phase| hooks.on_phase(phase))? {
            RemoveOutcome::Removed(removed) => {
                name = removed.name;
                messages.extend(removed.messages);
            }
            RemoveOutcome::Blocked { name, blocked, messages: notes } => {
                messages.extend(notes);
                return Ok(Outcome::Blocked { name, blocked, messages });
            }
        }
    }

    messages.extend(hooks.after_removal(task.dir));
    hooks.on_phase(RemovePhase::Untracking);
    messages.extend(remove_bindings(
        task.repos_path,
        task.rows,
        task.dir,
        task.outcome,
        task.now_ms,
    ));
    Ok(Outcome::Removed { name, messages })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_700_000_000_000;

    fn store_with_task_at(dir: &str) -> Store {
        let store = Store::open_in_memory().unwrap();
        let task = store.add_task("wire up the thing", "doing", None, None, NOW).unwrap();
        store
            .set_task_worktree(task.id, "/repos/demo", None, Some("feat/thing"), Some(dir))
            .unwrap();
        store
    }

    fn repos_json(tmp: &tempfile::TempDir, dirs: &[&str]) -> std::path::PathBuf {
        let path = tmp.path().join("repos.json");
        let config = serde_json::json!({ "repoPaths": dirs });
        std::fs::write(&path, serde_json::to_string_pretty(&config).unwrap()).unwrap();
        path
    }

    /// Why steps 4 + 5 are one function: doing one stranded the other.
    #[test]
    fn remove_bindings_untracks_the_dir_and_closes_the_bound_row() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = "/repos/demo/.claude/worktrees/feat-thing";
        let path = repos_json(&tmp, &[dir, "/repos/other"]);
        let store = store_with_task_at(dir);
        let id = store.task_for_worktree_dir(dir).unwrap().unwrap().id;

        let notes = remove_bindings(
            &path,
            Some(&store),
            std::path::Path::new(dir),
            TaskOutcome::Abandoned,
            NOW + 5,
        );

        assert!(notes.iter().any(|n| n.contains("untracked")), "{notes:?}");
        assert!(notes.iter().any(|n| n.contains("closed board task")), "{notes:?}");
        assert!(store.task_for_worktree_dir(dir).unwrap().is_none(), "the binding went");
        // …but the row survives as the record, closed with the outcome.
        let row = store.task_by_id(id).unwrap();
        assert_eq!(row.outcome.as_deref(), Some("abandoned"));
        assert_eq!(row.status, "doing", "abandoned freezes the status");
        assert_eq!(row.worktree.as_ref().unwrap().dir, None);
        let left = crate::repos::load_repos(&path);
        assert_eq!(left, vec!["/repos/other".to_string()], "only this task's path was untracked");
    }

    /// The rail's normal case, not an error — it still has to be untracked.
    #[test]
    fn remove_bindings_untracks_a_worktree_with_no_board_row() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = "/repos/demo/.claude/worktrees/feat-orphan";
        let path = repos_json(&tmp, &[dir]);
        let store = Store::open_in_memory().unwrap();

        let notes =
            remove_bindings(&path, Some(&store), std::path::Path::new(dir), TaskOutcome::Done, NOW);

        assert_eq!(notes, vec!["untracked from the agentboard rail".to_string()]);
        assert!(crate::repos::load_repos(&path).is_empty());
    }

    /// A caller with no store still gets the untrack — the half it *can* do.
    #[test]
    fn remove_bindings_without_a_store_still_untracks() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = "/repos/demo/.claude/worktrees/feat-thing";
        let path = repos_json(&tmp, &[dir]);

        let notes = remove_bindings(&path, None, std::path::Path::new(dir), TaskOutcome::Done, NOW);

        assert_eq!(notes, vec!["untracked from the agentboard rail".to_string()]);
    }

    /// Silent, not an error: `tt task clean` runs this for every task it sweeps.
    #[test]
    fn remove_bindings_is_quiet_when_there_is_nothing_to_clean() {
        let tmp = tempfile::tempdir().unwrap();
        let path = repos_json(&tmp, &["/repos/other"]);
        let store = Store::open_in_memory().unwrap();

        let notes = remove_bindings(
            &path,
            Some(&store),
            std::path::Path::new("/repos/gone"),
            TaskOutcome::Done,
            NOW,
        );

        assert!(notes.is_empty(), "{notes:?}");
        assert_eq!(crate::repos::load_repos(&path), vec!["/repos/other".to_string()]);
    }

    /// The stale-record path must never reach `ops::remove_task`. `opts.root`
    /// is `None` with a name resolving to nothing — the shape the app produces
    /// when a board row outlived its checkout. Were the removal step to run, it
    /// would walk up from the *test process's* cwd and act on a different
    /// checkout's `.claude/worktrees/<name>`.
    #[test]
    fn tear_down_bindings_never_runs_the_removal_step() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("gone-worktree");
        let path = repos_json(&tmp, &[dir.to_str().unwrap()]);
        let store = store_with_task_at(dir.to_str().unwrap());
        let opts = RemoveOpts { root: None, name: "gone-worktree".to_string(), force: false };

        let outcome = remove_task_and_bindings(
            TaskRemoval {
                opts: &opts,
                dir: &dir,
                repos_path: &path,
                rows: Some(&store),
                outcome: TaskOutcome::Done,
                now_ms: NOW,
                on_missing: MissingDir::TearDownBindings,
            },
            &mut NoHooks,
        )
        .expect("a missing dir is not an error for this caller");

        let Outcome::Removed { messages, .. } = outcome else {
            panic!("nothing on disk to block on");
        };
        assert!(messages.iter().any(|m| m.contains("was already gone")), "{messages:?}");
        assert!(messages.iter().any(|m| m.contains("untracked")), "{messages:?}");
        assert!(messages.iter().any(|m| m.contains("closed board task")), "{messages:?}");
        assert!(crate::repos::load_repos(&path).is_empty());
    }

    /// The same missing dir named on a command line: a typo must be reported.
    #[test]
    fn fail_on_missing_reports_the_unknown_task() {
        let tmp = tempfile::tempdir().unwrap();
        let checkout = tmp.path().join("demo");
        std::fs::create_dir_all(checkout.join(".git")).unwrap();
        let dir = checkout.join(".claude/worktrees/feat-tpyo");
        let path = repos_json(&tmp, &[]);
        let opts = RemoveOpts { root: Some(checkout), name: "feat-tpyo".to_string(), force: false };

        let error = remove_task_and_bindings(
            TaskRemoval {
                opts: &opts,
                dir: &dir,
                repos_path: &path,
                rows: None,
                outcome: TaskOutcome::Abandoned,
                now_ms: NOW,
                on_missing: MissingDir::Fail,
            },
            &mut NoHooks,
        );
        let Err(error) = error else {
            panic!("an unknown task name is an error, not a no-op")
        };
        assert!(matches!(error, ops::OpsError::NoSuchTask { .. }), "{error}");
    }

    /// Rows are found by the dir they are bound to, so a different worktree's
    /// removal can never take one.
    #[test]
    fn remove_bindings_leaves_another_worktrees_row_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let mine = "/repos/demo/.claude/worktrees/feat-mine";
        let theirs = "/repos/demo/.claude/worktrees/feat-theirs";
        let path = repos_json(&tmp, &[mine, theirs]);
        let store = store_with_task_at(theirs);

        let notes = remove_bindings(
            &path,
            Some(&store),
            std::path::Path::new(mine),
            TaskOutcome::Done,
            NOW,
        );

        assert!(!notes.iter().any(|n| n.contains("closed board task")), "{notes:?}");
        let theirs_row = store.task_for_worktree_dir(theirs).unwrap();
        assert!(theirs_row.is_some(), "their row stayed bound");
        assert_eq!(theirs_row.unwrap().outcome, None, "…and open");
    }
}
