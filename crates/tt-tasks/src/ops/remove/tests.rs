use std::net::TcpListener;

use super::*;
use crate::ops::claims::{record_task_ports, registry_claims};
use crate::ops::test_support::{add_task, git, repo_with_origin};
use crate::ops::{TEARDOWN_ENV_KEY, TaskRoot};

fn ports_dir(sr: &TaskRoot) -> PathBuf {
    sr.checkout.parent().unwrap().join("ports")
}

fn opts(sr: &TaskRoot, name: &str, force: bool) -> RemoveOpts {
    RemoveOpts {
        root: Some(sr.checkout.clone()),
        name: name.to_string(),
        force,
        ports_dir: Some(ports_dir(sr)),
    }
}

fn remove(sr: &TaskRoot, name: &str, force: bool) -> (Result<RemoveOutcome>, Vec<RemovePhase>) {
    let mut phases = Vec::new();
    let outcome = remove_task(&opts(sr, name, force), &mut |p| phases.push(p));
    (outcome, phases)
}

fn removed(outcome: Result<RemoveOutcome>) -> RemovedTask {
    match outcome {
        Ok(RemoveOutcome::Removed(task)) => task,
        Ok(RemoveOutcome::Blocked { blocked, .. }) => panic!("blocked: {blocked:?}"),
        Err(e) => panic!("errored: {e}"),
    }
}

fn blocked(outcome: Result<RemoveOutcome>) -> (Vec<RmBlocked>, Vec<String>) {
    match outcome {
        Ok(RemoveOutcome::Blocked { blocked, messages, .. }) => (blocked, messages),
        Ok(RemoveOutcome::Removed(_)) => panic!("expected a refusal"),
        Err(e) => panic!("errored: {e}"),
    }
}

fn commit(dir: &Path, message: &str) {
    git(dir, &["commit", "-q", "--allow-empty", "-m", message]);
}

fn mentions(messages: &[String], needle: &str) -> bool {
    messages.iter().any(|m| m.contains(needle))
}

const ALL_PHASES: [RemovePhase; 5] = [
    RemovePhase::CheckingGuards,
    RemovePhase::StoppingSessions,
    RemovePhase::RunningTeardown,
    RemovePhase::CleaningDocker,
    RemovePhase::RemovingWorktree,
];

#[test]
fn unsafe_and_unknown_names_are_refused_before_anything_is_touched() {
    let (_tmp, sr) = repo_with_origin();
    add_task(&sr, "feat-a", "feat/a");

    let (traversal, phases) = remove(&sr, "../repo", false);
    assert!(matches!(traversal, Err(OpsError::NoSuchTask { .. })));
    let (primary, _) = remove(&sr, "primary", false);
    assert!(matches!(primary, Err(OpsError::PrimaryRemoval)));
    let (by_dir_name, _) = remove(&sr, "repo", false);
    assert!(matches!(by_dir_name, Err(OpsError::PrimaryRemoval)));
    let (missing, _) = remove(&sr, "feat-nope", true);
    assert!(matches!(missing, Err(OpsError::NoSuchTask { .. })));

    assert!(phases.is_empty(), "no phase may fire for a refused name");
    assert!(sr.task_dir("feat-a").is_dir());
}

#[test]
fn a_clean_task_goes_through_every_phase_in_order_and_keeps_its_branch() {
    let (_tmp, sr) = repo_with_origin();
    let dir = add_task(&sr, "feat-a", "feat/a");
    commit(&dir, "unshipped work");

    let (outcome, phases) = remove(&sr, "feat-a", false);
    let task = removed(outcome);

    assert_eq!(phases, ALL_PHASES);
    assert!(!dir.exists());
    assert_eq!((task.name.as_str(), task.checkout.as_path()), ("feat-a", sr.checkout.as_path()));
    assert!(!task.landed);
    assert!(mentions(&task.messages, "1 commit(s) on feat/a have not reached main"));
    git(&sr.checkout, &["rev-parse", "--verify", "refs/heads/feat/a"]);
}

#[test]
fn a_branch_already_merged_reports_it_landed() {
    let (_tmp, sr) = repo_with_origin();
    let dir = add_task(&sr, "feat-a", "feat/a");
    commit(&dir, "shipped work");
    git(&sr.checkout, &["merge", "-q", "--no-ff", "-m", "merge", "feat/a"]);

    let task = removed(remove(&sr, "feat-a", false).0);
    assert!(task.landed);
    assert!(mentions(&task.messages, "feat/a is merged into main — nothing outstanding"));
    assert!(mentions(&task.messages, "deleted branch feat/a"));
    assert!(!git(&sr.checkout, &["branch", "--list", "feat/a"]).contains("feat/a"));
}

#[test]
fn a_task_that_never_committed_takes_its_empty_branch_with_it() {
    let (_tmp, sr) = repo_with_origin();
    add_task(&sr, "feat-a", "feat/a");

    let task = removed(remove(&sr, "feat-a", false).0);
    assert!(mentions(&task.messages, "deleted branch feat/a"));
    assert!(!git(&sr.checkout, &["branch", "--list", "feat/a"]).contains("feat/a"));
}

#[test]
fn a_dirty_tree_blocks_removal_and_costs_nothing() {
    let (_tmp, sr) = repo_with_origin();
    let dir = add_task(&sr, "feat-a", "feat/a");
    fs::write(dir.join("scratch.txt"), "wip").unwrap();

    let (outcome, phases) = remove(&sr, "feat-a", false);
    let (reasons, _) = blocked(outcome);

    assert_eq!(reasons, [RmBlocked::DirtyTree { entries: 1 }]);
    assert_eq!(phases, [RemovePhase::CheckingGuards], "a refusal must not stop sessions");
    assert!(dir.join("scratch.txt").is_file());
}

#[test]
fn force_removes_a_dirty_tree_and_logs_the_skipped_guard() {
    let (_tmp, sr) = repo_with_origin();
    let dir = add_task(&sr, "feat-a", "feat/a");
    fs::write(dir.join("scratch.txt"), "wip").unwrap();

    let task = removed(remove(&sr, "feat-a", true).0);

    assert!(!dir.exists());
    assert!(mentions(&task.messages, "skipping guard (--force)"));
}

#[test]
fn a_foreign_listener_on_a_claimed_port_blocks_removal() {
    let (_tmp, sr) = repo_with_origin();
    let dir = add_task(&sr, "feat-a", "feat/a");
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    fs::write(dir.join(".env"), format!("UI_PORT={port}\n")).unwrap();

    let (reasons, _) = blocked(remove(&sr, "feat-a", false).0);

    assert_eq!(reasons.len(), 1);
    assert_eq!(reasons[0].port(), Some(port));
    assert!(dir.is_dir());

    let forced = removed(remove(&sr, "feat-a", true).0);
    assert!(mentions(&forced.messages, "skipping guard (--force)"));
    assert!(!dir.exists());
}

#[test]
fn an_unclaimed_listener_is_not_this_tasks_problem() {
    let (_tmp, sr) = repo_with_origin();
    let dir = add_task(&sr, "feat-a", "feat/a");
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    fs::write(dir.join(".env"), "TASK=3\nNOT_A_CLAIM=1\n").unwrap();

    removed(remove(&sr, "feat-a", false).0);
    drop(listener);
    assert!(!dir.exists(), "{port} was never claimed");
}

#[test]
fn teardown_runs_before_the_worktree_is_deleted() {
    let (tmp, sr) = repo_with_origin();
    let dir = add_task(&sr, "feat-a", "feat/a");
    let seen_tree = tmp.path().join("tree-was-there");
    fs::write(
        dir.join(".env"),
        format!("{TEARDOWN_ENV_KEY}=cp {} {}\n", dir.join(".env").display(), seen_tree.display()),
    )
    .unwrap();

    removed(remove(&sr, "feat-a", false).0);

    assert!(seen_tree.is_file(), "teardown must see the task's .env and tree");
    assert!(!dir.exists());
}

#[test]
fn a_failing_teardown_warns_and_removal_continues() {
    let (_tmp, sr) = repo_with_origin();
    let dir = add_task(&sr, "feat-a", "feat/a");
    fs::write(dir.join(".env"), format!("{TEARDOWN_ENV_KEY}=false\n")).unwrap();

    let task = removed(remove(&sr, "feat-a", false).0);

    assert!(mentions(&task.messages, "teardown `false` failed"));
    assert!(!dir.exists());
}

#[test]
fn removal_releases_the_tasks_port_claims() {
    let (_tmp, sr) = repo_with_origin();
    add_task(&sr, "feat-a", "feat/a");
    add_task(&sr, "feat-b", "feat/b");
    let reg = port_registry_path(&sr.checkout, Some(&ports_dir(&sr))).unwrap();
    record_task_ports(&sr, &reg, "feat-a", &[("UI_PORT".into(), 4601)], 1).unwrap();
    record_task_ports(&sr, &reg, "feat-b", &[("UI_PORT".into(), 4602)], 1).unwrap();

    removed(remove(&sr, "feat-a", false).0);

    assert_eq!(registry_claims(&sr, &reg, "x"), BTreeSet::from([4602]));
}

#[test]
fn a_broken_worktree_needs_force_and_is_then_dropped() {
    let (_tmp, sr) = repo_with_origin();
    let dir = sr.task_dir("feat-broken");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(".git"), "gitdir: /nonexistent/gitdir\n").unwrap();

    let (outcome, phases) = remove(&sr, "feat-broken", false);
    assert!(matches!(outcome, Err(OpsError::BrokenWorktree { .. })));
    assert_eq!(phases, [RemovePhase::CheckingGuards]);
    assert!(dir.is_dir());

    let (outcome, phases) = remove(&sr, "feat-broken", true);
    let task = removed(outcome);
    assert_eq!(phases, ALL_PHASES);
    assert!(mentions(&task.messages, "worktree is broken"));
    assert!(!dir.exists());
}

#[test]
fn a_leftover_directory_git_forgot_is_removed_without_force() {
    let (_tmp, sr) = repo_with_origin();
    let dir = sr.task_dir("feat-ghost");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("root-owned.log"), "x").unwrap();

    let task = removed(remove(&sr, "feat-ghost", false).0);

    assert!(mentions(&task.messages, "git already forgot this worktree"));
    assert!(!task.landed);
    assert!(!dir.exists());
}

#[test]
fn stop_task_port_refuses_unclaimed_ports_and_unknown_tasks() {
    let (_tmp, sr) = repo_with_origin();
    let dir = add_task(&sr, "feat-a", "feat/a");
    fs::write(dir.join(".env"), "UI_PORT=4701\n").unwrap();

    let unclaimed = stop_task_port(Some(&sr.checkout), "feat-a", 4702);
    assert!(matches!(unclaimed, Err(OpsError::PortNotClaimed { port: 4702, .. })));
    let unknown = stop_task_port(Some(&sr.checkout), "feat-nope", 4701);
    assert!(matches!(unknown, Err(OpsError::NoSuchTask { .. })));
}

#[test]
fn claimed_ports_reads_only_port_vars_and_tolerates_a_missing_env() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(claimed_ports(tmp.path()).is_empty());
    fs::write(tmp.path().join(".env"), "UI_PORT=4801\nAPI_PORT=4802\nTASK=3\nNAME=x\n").unwrap();
    assert_eq!(claimed_ports(tmp.path()), BTreeSet::from([4801, 4802]));
}

#[test]
fn phase_labels_are_distinct_and_non_empty() {
    let labels: BTreeSet<&str> =
        ALL_PHASES.iter().chain([&RemovePhase::Untracking]).map(|p| p.label()).collect();
    assert_eq!(labels.len(), 6);
    assert!(!labels.contains(""));
}

fn clean(sr: &TaskRoot, dry_run: bool) -> CleanReport {
    let opts = CleanOpts {
        root: Some(sr.checkout.clone()),
        dry_run,
        scope_parents: Vec::new(),
        ports_dir: Some(ports_dir(sr)),
    };
    clean_tasks(&opts, |_| None).unwrap()
}

fn names<T>(items: &[T], name: impl Fn(&T) -> &str) -> Vec<String> {
    items.iter().map(|i| name(i).to_string()).collect()
}

/// Four tasks: one merged into main, one with unshipped work, one on the base
/// branch itself, one with a dirty tree.
fn mixed_fleet() -> (tempfile::TempDir, TaskRoot) {
    let (tmp, sr) = repo_with_origin();
    let merged = add_task(&sr, "feat-merged", "feat/merged");
    commit(&merged, "shipped");
    git(&sr.checkout, &["merge", "-q", "--no-ff", "-m", "merge", "feat/merged"]);
    let active = add_task(&sr, "feat-active", "feat/active");
    commit(&active, "in flight");
    let dirty = add_task(&sr, "feat-dirty", "feat/dirty");
    fs::write(dirty.join("scratch.txt"), "wip").unwrap();
    (tmp, sr)
}

#[test]
fn a_dry_run_names_what_would_go_and_why_the_rest_stays_without_touching_disk() {
    let (_tmp, sr) = mixed_fleet();

    let report = clean(&sr, true);

    assert!(report.dry_run);
    assert_eq!(names(&report.removed, |t| &t.name), ["feat-merged"]);
    assert_eq!(report.removed[0].reason, "merged into main");
    assert!(report.removed[0].messages.is_empty());
    let kept = names(&report.kept, |t| &t.name);
    assert_eq!(kept, ["feat-active", "feat-dirty"]);
    assert!(report.kept[0].why[0].starts_with("active:"), "{:?}", report.kept[0].why);
    assert!(sr.task_dir("feat-merged").is_dir());
}

#[test]
fn clean_removes_only_finished_tasks_and_deletes_their_branch() {
    let (_tmp, sr) = mixed_fleet();

    let report = clean(&sr, false);

    assert_eq!(names(&report.removed, |t| &t.name), ["feat-merged"]);
    assert!(mentions(&report.removed[0].messages, "deleted branch feat/merged"));
    assert!(!sr.task_dir("feat-merged").exists());
    assert!(sr.task_dir("feat-active").is_dir());
    assert!(sr.task_dir("feat-dirty").is_dir());
    let branches = git(&sr.checkout, &["branch", "--list", "feat/*"]);
    assert!(!branches.contains("merged") && branches.contains("active"), "{branches}");
}

#[test]
fn clean_never_judges_detached_broken_or_base_branch_tasks_as_finished() {
    let (_tmp, sr) = repo_with_origin();
    let detached = add_task(&sr, "feat-detached", "feat/detached");
    git(&detached, &["checkout", "-q", "--detach"]);
    let broken = sr.task_dir("feat-broken");
    fs::create_dir_all(&broken).unwrap();
    fs::write(broken.join(".git"), "gitdir: /nonexistent/gitdir\n").unwrap();
    let on_base = sr.task_dir("feat-on-base");
    git(
        &sr.checkout,
        &[
            "worktree",
            "add",
            "-q",
            "--detach",
            on_base.to_str().unwrap(),
            "main",
        ],
    );

    let report = clean(&sr, false);

    assert!(report.removed.is_empty());
    let why = |name: &str| {
        report.kept.iter().find(|k| k.name == name).unwrap_or_else(|| panic!("{name} kept")).why[0]
            .clone()
    };
    assert!(why("feat-broken").contains("worktree is broken"));
    assert!(why("feat-detached").contains("detached HEAD"));
    assert!(why("feat-on-base").contains("detached HEAD"));
    assert!(report.kept.iter().all(|k| sr.task_dir(&k.name).exists()));
}

#[test]
fn clean_sweeps_registries_of_vanished_checkouts_but_not_live_ones() {
    let (_tmp, sr) = repo_with_origin();
    let ports_dir = ports_dir(&sr);
    fs::create_dir_all(&ports_dir).unwrap();
    let live = ports_dir.join("live-ledger.json");
    let dead = ports_dir.join("dead-ledger.json");
    let anonymous = ports_dir.join("anonymous-ledger.json");
    let ledger = |checkout: &str| format!(r#"{{ "checkout": "{checkout}", "ports": {{}} }}"#);
    fs::write(&live, ledger(&sr.checkout.display().to_string())).unwrap();
    fs::write(&dead, ledger("/nonexistent/checkout")).unwrap();
    fs::write(&anonymous, "{}").unwrap();

    let dry = clean(&sr, true);
    assert!(dry.swept_port_registries.contains(&dead));
    assert!(dead.exists(), "a dry run sweeps nothing");

    let report = clean(&sr, false);
    assert!(report.swept_port_registries.contains(&dead));
    assert!(report.swept_port_registries.contains(&anonymous));
    assert!(!report.swept_port_registries.contains(&live));
    assert!(!dead.exists() && !anonymous.exists());
    assert!(live.exists());
}

#[test]
fn clean_sweeps_state_dirs_of_removed_checkouts_of_this_repo_only() {
    let (tmp, sr) = repo_with_origin();
    add_task(&sr, "feat-live", "feat/live");
    let scope_parent = tmp.path().join("scopes");
    for scope in ["repo-feat-live", "repo-feat-gone", "other-feat-x", "repo"] {
        fs::create_dir_all(scope_parent.join(scope)).unwrap();
    }
    let opts = CleanOpts {
        root: Some(sr.checkout.clone()),
        dry_run: false,
        scope_parents: vec![scope_parent.clone()],
        ports_dir: Some(ports_dir(&sr)),
    };

    let report = clean_tasks(&opts, |dir| {
        let name = dir.file_name()?.to_str()?;
        Some(if name == "repo" { name.to_string() } else { format!("repo-{name}") })
    })
    .unwrap();

    assert_eq!(report.swept_state_dirs, [scope_parent.join("repo-feat-gone")]);
    assert!(scope_parent.join("repo-feat-live").is_dir());
    assert!(scope_parent.join("other-feat-x").is_dir());
    assert!(scope_parent.join("repo").is_dir());
    assert!(!scope_parent.join("repo-feat-gone").exists());
    assert!(report.live_scopes.contains(&"repo-feat-live".to_string()));
}

#[test]
fn clean_prunes_landed_branches_no_worktree_holds_and_keeps_the_rest() {
    let (_tmp, sr) = repo_with_origin();
    let shipped = add_task(&sr, "feat-shipped", "feat/shipped");
    commit(&shipped, "shipped");
    let unshipped = add_task(&sr, "feat-unshipped", "feat/unshipped");
    fs::write(unshipped.join("wip.txt"), "wip").unwrap();
    git(&unshipped, &["add", "wip.txt"]);
    commit(&unshipped, "never merged");
    for dir in [&shipped, &unshipped] {
        git(&sr.checkout, &["worktree", "remove", &dir.to_string_lossy()]);
    }
    git(&sr.checkout, &["merge", "-q", "--no-ff", "-m", "merge", "feat/shipped"]);
    git(&sr.checkout, &["branch", "feat/empty"]);

    assert_eq!(clean(&sr, true).pruned_branches, ["feat/empty", "feat/shipped"]);
    assert!(git(&sr.checkout, &["branch", "--list", "feat/shipped"]).contains("shipped"));

    assert_eq!(clean(&sr, false).pruned_branches, ["feat/empty", "feat/shipped"]);
    let branches = git(&sr.checkout, &["branch", "--list", "feat/*"]);
    assert_eq!(branches.trim(), "feat/unshipped");
}
