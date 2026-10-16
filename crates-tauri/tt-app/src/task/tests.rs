use super::*;
use tt_tasks::guards::{ForeignPort, PortHolder};
use tt_tasks::ports::Stopped;

fn branch(branch: &str, base: &str) -> CreateSource {
    CreateSource::Branch { branch: branch.to_string(), base: base.to_string() }
}

#[test]
fn a_branch_source_is_trimmed_and_a_blank_base_means_the_checkouts_branch() {
    let Ok(TaskSource::NewBranch { branch: name, base }) = task_source(branch("  feat/x \n", " "))
    else {
        panic!("expected a new-branch source");
    };
    assert_eq!((name.as_str(), base), ("feat/x", None));

    let Ok(TaskSource::NewBranch { base, .. }) = task_source(branch("feat/x", " develop ")) else {
        panic!("expected a new-branch source");
    };
    assert_eq!(base.as_deref(), Some("develop"));
}

#[test]
fn a_task_without_a_branch_is_refused() {
    let err = task_source(branch("   ", "main")).unwrap_err();
    assert!(err.contains("needs a branch"), "{err}");
}

#[test]
fn a_pr_source_passes_its_number_through() {
    assert!(matches!(task_source(CreateSource::Pr { number: 7 }), Ok(TaskSource::PullRequest(7))));
}

#[test]
fn the_frontend_sends_sources_tagged_by_kind() {
    let pr: CreateSource = serde_json::from_str(r#"{"kind":"pr","number":9}"#).unwrap();
    assert!(matches!(pr, CreateSource::Pr { number: 9 }));
    let new: CreateSource =
        serde_json::from_str(r#"{"kind":"branch","branch":"a","base":"b"}"#).unwrap();
    assert!(matches!(new, CreateSource::Branch { .. }));
    assert!(serde_json::from_str::<CreateSource>(r#"{"kind":"nope"}"#).is_err());
}

#[test]
fn delete_needs_exactly_one_of_id_or_dir() {
    assert!(matches!(delete_target(Some(3), None), Ok(DeleteTarget::Board(3))));
    assert!(
        matches!(delete_target(None, Some("/w/a".into())), Ok(DeleteTarget::Worktree(d)) if d == "/w/a")
    );
    assert!(delete_target(None, None).is_err());
    assert!(delete_target(Some(3), Some("/w/a".into())).is_err());
}

#[test]
fn outcomes_parse_or_name_the_bad_value() {
    assert_eq!(parse_outcome(None), Ok(None));
    assert_eq!(parse_outcome(Some("done")), Ok(Some(tt_store::TaskOutcome::Done)));
    assert_eq!(parse_outcome(Some("abandoned")), Ok(Some(tt_store::TaskOutcome::Abandoned)));
    assert_eq!(parse_outcome(Some("merged")), Err("unknown task outcome: merged".to_string()));
}

#[test]
fn purge_needs_a_board_id_and_no_worktree() {
    assert_eq!(purge_target(Some(4), false), Ok(4));
    assert!(purge_target(None, false).unwrap_err().contains("by id"));
    assert!(purge_target(Some(4), true).unwrap_err().contains("still bound to a worktree"));
}

#[test]
fn a_worktree_is_labelled_by_its_directory_name() {
    assert_eq!(worktree_label("/repo/.claude/worktrees/feat-a"), "feat-a");
    assert_eq!(worktree_label("/"), "/");
}

#[test]
fn stopping_a_port_reports_one_outcome_for_the_log_and_the_toast() {
    let stopped = |pgids: &[i32], graceful| Stopped { pgids: pgids.to_vec(), graceful };
    assert_eq!(
        stop_port_report(&stopped(&[], true), 3000),
        ("already_free", "Port 3000 was already free".to_string())
    );
    assert_eq!(
        stop_port_report(&stopped(&[10], true), 3000),
        ("terminated", "Port 3000: stopped 1 process group".to_string())
    );
    assert_eq!(
        stop_port_report(&stopped(&[10, 11], false), 3000),
        ("killed", "Port 3000: force-killed 2 process groups".to_string())
    );
}

#[test]
fn phases_are_tracked_per_directory_and_cleared_on_exit() {
    let phases = TaskPhases::default();
    phases.creating("/w/a", "fetching");
    phases.removing("/w/b", "deleting");
    assert_eq!(phases.get("/w/a"), Some(RowPhase::Creating { label: "fetching".into() }));
    assert_eq!(phases.get("/w/b"), Some(RowPhase::Removing { label: "deleting".into() }));

    phases.removing("/w/a", "stopping sessions");
    assert_eq!(phases.get("/w/a"), Some(RowPhase::Removing { label: "stopping sessions".into() }));

    phases.clear("/w/a");
    assert_eq!(phases.get("/w/a"), None);
    assert!(phases.get("/w/b").is_some(), "clearing one directory leaves the others");
}

#[test]
fn a_blocker_carries_the_guards_kind_remedy_and_port() {
    let dirty = Blocker::from(&RmBlocked::DirtyTree { entries: 2 });
    assert_eq!((dirty.kind.as_str(), dirty.loses_work, dirty.port), ("dirtyTree", true, None));
    assert!(dirty.message.contains("2 changed/untracked"));
    assert!(!dirty.remedy.is_empty());

    let holder = PortHolder { pid: 42, command: "node".into() };
    let port = ForeignPort { port: 5173, holder: Some(holder.clone()) };
    let foreign =
        Blocker::from(&RmBlocked::ForeignPortListener { port: port.port, holder: port.holder });
    assert_eq!(
        (foreign.kind.as_str(), foreign.loses_work, foreign.port),
        ("foreignPort", false, Some(5173))
    );
    assert!(foreign.remedy.contains(&holder.describe()));
}

#[test]
fn delete_outcomes_serialize_tagged_by_status_with_camel_case_fields() {
    let deleted = TaskDeleteOutcome::Deleted { name: "a".into(), messages: vec!["m".into()] };
    assert_eq!(
        serde_json::to_value(&deleted).unwrap(),
        serde_json::json!({ "status": "deleted", "name": "a", "messages": ["m"] })
    );

    let blocked = TaskDeleteOutcome::Blocked {
        name: "a".into(),
        blockers: vec![Blocker::from(&RmBlocked::UnreachableCommits { count: 3 })],
        messages: Vec::new(),
    };
    let json = serde_json::to_value(&blocked).unwrap();
    assert_eq!(json["status"], "blocked");
    assert_eq!(json["blockers"][0]["kind"], "unreachableCommits");
    assert_eq!(json["blockers"][0]["losesWork"], true);
}
