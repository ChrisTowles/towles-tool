use super::*;

fn store() -> Store {
    Store::open_in_memory().unwrap()
}

fn task(s: &Store, text: &str, created_ms: i64) -> i64 {
    s.add_task(text, "backlog", None, None, created_ms).unwrap().id
}

fn bound(s: &Store, text: &str, created_ms: i64, branch: &str, dir: &str) -> i64 {
    let id = task(s, text, created_ms);
    s.set_task_worktree(id, "/repos/x", Some("o/x"), Some(branch), Some(dir)).unwrap();
    id
}

fn pr_input(number: i64, branch: &str, state: &str) -> PrInput {
    PrInput {
        repo: "o/x".to_string(),
        number,
        title: "t".to_string(),
        branch: branch.to_string(),
        state: state.to_string(),
        checks: "passing".to_string(),
        review_state: String::new(),
        url: format!("https://github.com/o/x/pull/{number}"),
        updated_ts: 1,
        base_branch: String::new(),
    }
}

fn row_count(s: &Store) -> i64 {
    s.conn.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0)).unwrap()
}

#[test]
fn an_unknown_status_is_refused_on_add_and_on_move_and_writes_nothing() {
    let s = store();
    assert!(s.add_task("x", "someday", None, None, 1).is_err());
    assert_eq!(row_count(&s), 0);

    let id = task(&s, "real", 1);
    assert!(s.set_task_status(id, "blocked", 2).is_err());
    assert_eq!(s.task_by_id(id).unwrap().status, "backlog");
}

#[test]
fn adding_straight_into_done_stamps_completion() {
    let s = store();
    let t = s.add_task("already shipped", "done", None, Some("why"), 500).unwrap();
    assert_eq!((t.completed_at, t.goal.as_deref()), (Some(500), Some("why")));
    assert!(t.closed, "done is the terminal column");
    assert!(s.open_tasks().unwrap().is_empty());
}

#[test]
fn closing_twice_keeps_the_first_completion_time() {
    let s = store();
    let id = task(&s, "t", 1);
    s.close_task(id, TaskOutcome::Done, 100).unwrap();
    let again = s.close_task(id, TaskOutcome::Done, 900).unwrap();
    assert_eq!(again.completed_at, Some(100));
}

#[test]
fn closing_an_unknown_task_errors_and_changes_nothing() {
    let s = store();
    let id = task(&s, "t", 1);
    assert!(matches!(s.close_task(id + 1, TaskOutcome::Done, 5), Err(Error::TaskNotFound(_))));
    assert_eq!(s.task_by_id(id).unwrap().outcome, None);
}

#[test]
fn closing_detaches_the_dir_but_keeps_the_repo_binding() {
    let s = store();
    let id = bound(&s, "t", 1, "feat/a", "/w/a");
    let closed = s.close_task(id, TaskOutcome::Abandoned, 10).unwrap();
    let worktree = closed.worktree.unwrap();
    assert_eq!(worktree.dir, None);
    assert_eq!(worktree.repo_root, "/repos/x");
    assert_eq!(worktree.branch.as_deref(), Some("feat/a"));
    assert!(!closed.has_worktree);
}

#[test]
fn rebinding_a_worktree_only_overwrites_the_columns_it_is_given() {
    let s = store();
    let id = bound(&s, "t", 1, "feat/a", "/w/a");
    s.set_task_worktree(id, "/repos/y", None, None, None).unwrap();

    let worktree = s.task_by_id(id).unwrap().worktree.unwrap();
    assert_eq!(worktree.repo_root, "/repos/y");
    assert_eq!(worktree.repo.as_deref(), Some("o/x"));
    assert_eq!(worktree.branch.as_deref(), Some("feat/a"));
    assert_eq!(worktree.dir.as_deref(), Some("/w/a"));
}

#[test]
fn binding_an_unknown_task_errors_and_spares_the_detected_row() {
    let s = store();
    s.record_detected_worktree("/repos/x", "/w/a", Some("feat/a"), 1).unwrap();
    let err = s.set_task_worktree(9999, "/repos/x", None, None, Some("/w/a"));
    assert!(matches!(err, Err(Error::TaskNotFound(9999))));
    assert!(s.task_for_worktree_dir("/w/a").unwrap().is_some(), "the detected row must survive");
}

#[test]
fn attaching_a_link_twice_refreshes_the_url_and_keeps_the_observed_state() {
    let s = store();
    let id = task(&s, "t", 1);
    s.attach_task_issue(id, "o/x", 7, "https://old").unwrap();
    s.set_issue_link_state("o/x", 7, "closed", 50).unwrap();
    s.attach_task_issue(id, "o/x", 7, "https://new").unwrap();
    s.attach_task_pr(id, "o/x", 8, "https://old").unwrap();
    s.attach_task_pr(id, "o/x", 8, "https://new").unwrap();

    let got = s.task_by_id(id).unwrap();
    assert_eq!(got.issues.len(), 1);
    assert_eq!(
        (got.issues[0].url.as_str(), got.issues[0].state.as_str()),
        ("https://new", "closed")
    );
    assert_eq!((got.prs.len(), got.prs[0].url.as_str()), (1, "https://new"));
}

#[test]
fn links_need_a_task_and_detaching_a_missing_link_is_a_no_op() {
    let s = store();
    assert!(matches!(s.attach_task_issue(1, "o/x", 1, "u"), Err(Error::TaskNotFound(1))));
    assert!(matches!(s.attach_task_pr(1, "o/x", 1, "u"), Err(Error::TaskNotFound(1))));

    let id = task(&s, "t", 1);
    s.attach_task_issue(id, "o/x", 1, "u").unwrap();
    s.detach_task_issue(id, "o/x", 99).unwrap();
    s.detach_task_pr(id, "o/x", 99).unwrap();
    assert_eq!(s.task_by_id(id).unwrap().issues.len(), 1);
    s.detach_task_issue(id, "o/x", 1).unwrap();
    assert!(s.task_by_id(id).unwrap().issues.is_empty());
}

#[test]
fn link_states_copy_from_the_collector_snapshot_and_skip_absent_refs() {
    let s = store();
    let id = task(&s, "t", 1);
    s.attach_task_issue(id, "o/x", 1, "u1").unwrap();
    s.attach_task_issue(id, "o/x", 2, "u2").unwrap();
    s.attach_task_pr(id, "o/x", 3, "u3").unwrap();
    s.attach_task_pr(id, "o/x", 4, "u4").unwrap();
    s.replace_issues(&[IssueInput {
        repo: "o/x".to_string(),
        number: 1,
        title: "i".to_string(),
        labels: Vec::new(),
        state: "closed".to_string(),
        url: "u1".to_string(),
        updated_ts: 1,
    }])
    .unwrap();
    s.upsert_prs(&[pr_input(3, "feat/z", "merged")]).unwrap();

    assert_eq!(s.refresh_link_states_from_cache(77).unwrap(), 2);

    let got = s.task_by_id(id).unwrap();
    assert_eq!(got.issues[0].state, "closed");
    assert_ne!(got.issues[1].state, "closed", "ref 2 is not in the snapshot");
    assert_eq!((got.prs[0].state.as_str(), got.prs[0].checks.as_str()), ("merged", "passing"));
    assert_ne!(got.prs[1].state, "merged");
}

#[test]
fn refs_missing_from_the_snapshot_are_listed_in_order() {
    let s = store();
    let id = task(&s, "t", 1);
    s.attach_task_issue(id, "o/x", 2, "u").unwrap();
    s.attach_task_issue(id, "o/x", 1, "u").unwrap();
    s.attach_task_pr(id, "o/x", 9, "u").unwrap();
    s.set_issue_link_state("o/x", 1, "open", 5).unwrap();
    s.set_issue_link_state("o/x", 2, "closed", 5).unwrap();

    assert_eq!(s.open_issue_refs_missing_from_cache().unwrap(), [("o/x".to_string(), 1)]);
    assert_eq!(s.pr_refs_missing_from_cache().unwrap(), [("o/x".to_string(), 9)]);

    s.upsert_prs(&[pr_input(9, "feat/z", "open")]).unwrap();
    assert!(s.pr_refs_missing_from_cache().unwrap().is_empty());
}

#[test]
fn unlinked_worktrees_go_oldest_probe_first_and_honour_the_limit_and_throttle() {
    let s = store();
    let a = bound(&s, "a", 1, "feat/a", "/w/a");
    let b = bound(&s, "b", 2, "feat/b", "/w/b");
    let c = bound(&s, "c", 3, "feat/c", "/w/c");
    s.mark_pr_probe(&[a], 500).unwrap();
    s.mark_pr_probe(&[b], 100).unwrap();

    let ids = |limit, before| -> Vec<i64> {
        s.unlinked_worktrees(before, limit).unwrap().into_iter().map(|u| u.task_id).collect()
    };
    assert_eq!(ids(8, i64::MAX), [c, b, a]);
    assert_eq!(ids(2, i64::MAX), [c, b]);
    assert_eq!(ids(8, 100), [c, b], "a probe newer than the cutoff is throttled");
}

#[test]
fn unlinked_worktrees_skip_archived_unbound_and_already_linked_tasks() {
    let s = store();
    let linked = bound(&s, "linked", 1, "feat/l", "/w/l");
    s.attach_task_pr(linked, "o/x", 1, "u").unwrap();
    let archived = bound(&s, "archived", 2, "feat/r", "/w/r");
    s.close_task(archived, TaskOutcome::Abandoned, 3).unwrap();
    s.archive_closed_tasks(10, 10).unwrap();
    task(&s, "unbound", 3);
    let live = bound(&s, "live", 4, "feat/v", "/w/v");

    let ids: Vec<i64> =
        s.unlinked_worktrees(i64::MAX, 8).unwrap().into_iter().map(|u| u.task_id).collect();
    assert_eq!(ids, [live]);
}

#[test]
fn auto_attach_is_idempotent_and_matches_repo_and_branch_together() {
    let s = store();
    let id = bound(&s, "t", 1, "feat/a", "/w/a");
    s.upsert_prs(&[
        pr_input(1, "feat/a", "open"),
        pr_input(2, "feat/other", "open"),
    ])
    .unwrap();

    assert_eq!(s.auto_attach_worktree_prs(5).unwrap(), 1);
    assert_eq!(s.auto_attach_worktree_prs(6).unwrap(), 0);
    let numbers: Vec<i64> = s.task_by_id(id).unwrap().prs.iter().map(|p| p.number).collect();
    assert_eq!(numbers, [1]);
}

#[test]
fn only_open_bound_non_detected_tasks_are_offered_for_status_sync() {
    let s = store();
    let open = bound(&s, "open", 1, "feat/a", "/w/a");
    let doing = bound(&s, "doing", 2, "feat/b", "/w/b");
    s.set_task_status(doing, "doing", 3).unwrap();
    let done = bound(&s, "done", 3, "feat/c", "/w/c");
    s.set_task_status(done, "done", 4).unwrap();
    let closed = bound(&s, "closed", 4, "feat/d", "/w/d");
    s.close_task(closed, TaskOutcome::Abandoned, 5).unwrap();
    task(&s, "no dir", 5);
    s.record_detected_worktree("/repos/x", "/w/e", Some("feat/e"), 6).unwrap();

    let ids: Vec<i64> = s.worktree_bound_open_tasks().unwrap().into_iter().map(|t| t.id).collect();
    assert_eq!(ids, [open, doing]);
    assert!(s.worktree_bound_open_tasks().unwrap().iter().all(|t| t.issues.is_empty()));
}

#[test]
fn a_detected_worktree_is_recorded_once_and_adopting_it_keeps_its_id() {
    let s = store();
    let owned = bound(&s, "owned", 1, "feat/o", "/w/o");
    s.record_detected_worktree("/repos/x", "/w/o", Some("feat/o"), 2).unwrap();
    s.record_detected_worktree("/repos/x", "/w/d", None, 3).unwrap();
    s.record_detected_worktree("/repos/x", "/w/d", None, 4).unwrap();

    assert_eq!(row_count(&s), 2, "a dir that already has a row mints no second one");
    let detected = s.task_for_worktree_dir("/w/d").unwrap().unwrap();
    assert_eq!((detected.kind, detected.text.as_str()), (TaskKind::Detected, "d"));
    assert!(
        s.all_tasks().unwrap().iter().all(|t| t.id == owned),
        "detected rows stay off the board"
    );

    let adopted = s.adopt_detected_worktree(detected.id).unwrap();
    assert_eq!((adopted.id, adopted.kind), (detected.id, TaskKind::Task));
    assert!(adopted.rank > s.task_by_id(owned).unwrap().rank, "adoption joins the queue bottom");

    let again = s.adopt_detected_worktree(detected.id).unwrap();
    assert_eq!(again.rank, adopted.rank, "adopting twice must not reshuffle the queue");
    assert!(matches!(s.adopt_detected_worktree(9999), Err(Error::TaskNotFound(9999))));
}

#[test]
fn the_oldest_task_owns_a_worktree_dir_two_rows_claim() {
    let s = store();
    let newer = bound(&s, "newer", 20, "feat/b", "/w/same");
    let older = bound(&s, "older", 10, "feat/a", "/w/same");
    assert_eq!(s.task_for_worktree_dir("/w/same").unwrap().unwrap().id, older);
    assert_ne!(newer, older);
    assert!(s.task_for_worktree_dir("/w/none").unwrap().is_none());
}

#[test]
fn deleting_a_task_drops_its_folder_snooze_but_not_others() {
    let s = store();
    let id = bound(&s, "t", 1, "feat/a", "/w/a");
    s.snooze_queue_item(
        "folder:/w/a",
        SnoozeUntil { reason: "later", until_ms: None, until_ci: false },
        1,
    )
    .unwrap();
    s.snooze_queue_item(
        "folder:/w/other",
        SnoozeUntil { reason: "later", until_ms: None, until_ci: false },
        1,
    )
    .unwrap();

    s.delete_task(id).unwrap();

    let keys: Vec<String> = s.queue_snoozes().unwrap().into_iter().map(|q| q.key).collect();
    assert_eq!(keys, ["folder:/w/other"]);
}

#[test]
fn moving_next_to_an_unknown_anchor_errors_and_leaves_the_rank() {
    let s = store();
    let a = task(&s, "a", 1);
    let before = s.task_by_id(a).unwrap().rank;
    assert!(matches!(s.move_task(a, RankMove::Before(9999)), Err(Error::TaskNotFound(9999))));
    assert!(matches!(s.move_task(9999, RankMove::Top), Err(Error::TaskNotFound(9999))));
    assert_eq!(s.task_by_id(a).unwrap().rank, before);
}

#[test]
fn a_task_cannot_be_anchored_to_itself() {
    let s = store();
    let a = task(&s, "a", 1);
    assert!(matches!(s.move_task(a, RankMove::After(a)), Err(Error::TaskNotFound(_))));
}

#[test]
fn a_branch_switch_into_a_closed_tasks_branch_is_allowed_but_an_open_ones_is_not() {
    let s = store();
    let closed = bound(&s, "closed", 1, "feat/taken", "/w/c");
    s.close_task(closed, TaskOutcome::Done, 2).unwrap();
    let mover = bound(&s, "mover", 3, "feat/mine", "/w/m");

    let resync = s.resync_task_branch(mover, "feat/taken").unwrap();
    assert!(resync.changed);

    let open = bound(&s, "open", 4, "feat/busy", "/w/o");
    assert!(matches!(
        s.resync_task_branch(mover, "feat/busy"),
        Err(Error::BranchTaken { other_task_id, .. }) if other_task_id == open
    ));
    assert_eq!(
        s.task_by_id(mover).unwrap().worktree.unwrap().branch.as_deref(),
        Some("feat/taken")
    );
}
