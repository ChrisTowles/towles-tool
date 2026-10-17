use super::*;
use tt_store::TaskOutcome;

/// `(dir, resolved name)` per tracked repo, for comparing against a literal.
fn tracked(repos: &[TrackedRepo]) -> Vec<(&Path, Option<&str>)> {
    repos.iter().map(|r| (r.dir.as_path(), r.name.as_deref())).collect()
}

/// One worktree task, unlinked, bound to `o/x`.
fn store_with_unlinked_task() -> (Store, i64) {
    let store = Store::open_in_memory().unwrap();
    let task = store.add_task("t", "doing", None, None, 1).unwrap();
    store.set_task_worktree(task.id, "/r", Some("o/x"), Some("feat/y"), Some("/w")).unwrap();
    (store, task.id)
}

/// Well past one probe interval, so a candidate is actually due.
const PROBE_NOW: i64 = PR_PROBE_INTERVAL_MS * 10;

/// A repo the sweep couldn't name is a question still owed, not one asked:
/// stamping here would sit on the task for the whole interval for nothing.
#[test]
fn a_branch_probe_with_no_repo_dir_leaves_the_clock_alone() {
    let (store, id) = store_with_unlinked_task();
    probe_unlinked_worktree_prs(&store, &std::collections::HashMap::new(), PROBE_NOW);
    assert_eq!(store.unlinked_worktrees(0, 8).unwrap().len(), 1, "task {id} still owed");
}

/// A branch the local repo answers for — here by not being a repo at all,
/// with `Repo::branch_was_pushed` covering the real shapes — costs no `gh`
/// call, and the stamp is what stops it being reconsidered every pass.
#[test]
fn a_locally_answered_branch_is_stamped_without_asking_github() {
    let (store, _) = store_with_unlinked_task();
    let dir = tempfile::tempdir().unwrap();
    let index = std::collections::HashMap::from([("o/x".to_string(), dir.path().to_path_buf())]);
    probe_unlinked_worktree_prs(&store, &index, PROBE_NOW);
    assert!(store.unlinked_worktrees(PROBE_NOW - 1, 8).unwrap().is_empty());
    assert_eq!(store.unlinked_worktrees(PROBE_NOW, 8).unwrap().len(), 1);
}

#[test]
fn the_calendar_schema_asks_for_events_as_dated_strings() {
    let schema: serde_json::Value = serde_json::from_str(CALENDAR_SCHEMA).unwrap();
    assert_eq!(schema["required"], serde_json::json!(["events"]));
    let item = &schema["properties"]["events"]["items"];
    assert_eq!(item["required"], serde_json::json!(["externalId", "title", "start"]));
    assert_eq!(item["additionalProperties"], serde_json::json!(false));
    // Epoch numbers are arithmetic a model can't check; the offset-bearing
    // string is what the calendar reports verbatim.
    for field in ["start", "end"] {
        assert_eq!(item["properties"][field]["type"], "string");
        assert_eq!(item["properties"][field]["format"], "date-time");
    }
}

#[test]
fn a_schema_validated_envelope_becomes_event_inputs() {
    let raw = r#"{"type":"result","is_error":false,"structured_output":{"events":[
        {"externalId":"e1","title":"standup","start":"2026-07-20T15:00:00-05:00",
         "end":"2026-07-20T15:15:00-05:00","attendees":["Chris"],"location":"zoom"}]}}"#;
    let answer: CalendarAnswer = tt_exec::claude::parse_response(raw).unwrap().answer;
    assert_eq!(answer.events.len(), 1);
    assert_eq!(answer.events[0].external_id, "e1");
    // The reported offset survives — normalizing to UTC on the way in would
    // discard the one thing the column exists to carry.
    assert_eq!(answer.events[0].start.to_rfc3339(), "2026-07-20T15:00:00-05:00");
    assert_eq!(answer.events[0].join_url, None);
}

#[test]
fn an_empty_day_is_a_valid_answer_not_a_failure() {
    let answer: CalendarAnswer =
        tt_exec::claude::parse_response(r#"{"is_error":false,"structured_output":{"events":[]}}"#)
            .unwrap()
            .answer;
    assert!(answer.events.is_empty());
}

#[test]
fn a_claude_side_failure_reads_as_itself() {
    // A credit-balance error must not read as "no parseable JSON in claude output".
    let raw = r#"{"type":"result","is_error":true,
        "result":"Credit balance is too low to run this request."}"#;
    let e = tt_exec::claude::parse_response::<CalendarAnswer>(raw).unwrap_err();
    assert_eq!(e.brief(), "claude -p failed: Credit balance is too low to run this request.");
}

#[test]
fn an_answer_of_the_wrong_shape_reads_as_a_shape_complaint() {
    // Distinct from the case above, and that distinction is the point.
    let raw = r#"{"is_error":false,"structured_output":{"events":[{"title":"no id"}]}}"#;
    let e = tt_exec::claude::parse_response::<CalendarAnswer>(raw).unwrap_err();
    assert!(e.brief().contains("not in the expected shape"), "{e}");
    assert!(matches!(e, tt_exec::claude::Error::Unparseable(_)), "{e:?}");
}

#[test]
fn collect_prs_no_repos_is_clean_noop() {
    let store = Store::open_in_memory().unwrap();
    let summary = collect_prs(&store, &[], 1);
    assert!(summary.ok);
    assert_eq!(summary.count, 0);
    assert_eq!(summary.message.as_deref(), Some("no repos configured"));
    let runs = store.runs().unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].collector, "prs");
    assert!(runs[0].ok);
}

#[test]
fn collect_prs_open_and_collect_prs_merged_are_clean_noops_and_share_the_prs_key() {
    let store = Store::open_in_memory().unwrap();
    let open = collect_prs_open(&store, &[], None, FETCH_NOW, 1);
    assert!(open.ok);
    assert_eq!(open.count, 0);
    let merged = collect_prs_merged(&store, &[], None, FETCH_NOW, 2);
    assert!(merged.ok);
    assert_eq!(merged.count, 0);
    // Both cadences are splits of one logical collector, so one `prs` key.
    let runs = store.runs().unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].collector, "prs");
}

#[test]
fn collect_manual_runs_issues_and_prs_but_never_calendar() {
    let store = Store::open_in_memory().unwrap();
    let summaries = collect_manual(&store, &[], &[], None, 1);
    let keys: Vec<&str> = summaries.iter().map(|s| s.collector.as_str()).collect();
    assert_eq!(
        keys,
        ["issues", "issues:watched", "prs", "ci"],
        "manual refresh runs issues + PRs + CI, skips calendar"
    );
    assert!(!keys.contains(&"claude:calendar"), "calendar is never manually triggered");
}

#[test]
fn collect_manual_includes_slack_only_when_configured() {
    let store = Store::open_in_memory().unwrap();
    // `watch_user_id` left empty, so this fails before any network call.
    let config = SlackDmConfig {
        token: "xoxp-test".to_string(),
        watch_user_id: String::new(),
        watch_name: String::new(),
    };
    let keys: Vec<String> = collect_manual(&store, &[], &[], Some(&config), 1)
        .into_iter()
        .map(|s| s.collector)
        .collect();
    assert_eq!(keys, ["issues", "issues:watched", "prs", "ci", "slack:dm"]);
}

#[test]
fn collect_watched_issues_without_labels_clears_the_cache_offline() {
    let store = Store::open_in_memory().unwrap();
    store.replace_watched_issues(&[issue("o/a", 4)]).unwrap();
    let blank = ["  ".to_string()];
    let summary = collect_watched_issues(&store, &[PathBuf::from("/nope")], &blank, 0, 1);
    assert!(summary.ok);
    assert_eq!(summary.collector, "issues:watched");
    assert!(store.watched_issues().unwrap().is_empty());
}

#[test]
fn normalize_labels_trims_drops_blanks_and_dedupes_in_order() {
    let raw = [" ready ", "", "bug", "ready"].map(String::from);
    assert_eq!(normalize_labels(&raw), ["ready", "bug"]);
}

#[test]
fn collect_issues_no_repos_is_clean_noop() {
    let store = Store::open_in_memory().unwrap();
    let summary = collect_issues(&store, &[], FETCH_NOW, 1);
    assert!(summary.ok);
    assert_eq!(summary.count, 0);
    assert_eq!(summary.message.as_deref(), Some("no repos configured"));
    let runs = store.runs().unwrap();
    assert_eq!(runs[0].collector, "issues");
}

#[test]
fn rollup_moves_task_to_done_when_all_links_resolve() {
    let store = Store::open_in_memory().unwrap();
    store.replace_issues(&[issue("o/r", 1)]).unwrap();
    let task = store.add_task("linked", "backlog", None, None, 1).unwrap();
    store.attach_task_issue(task.id, "o/r", 1, "https://github.com/o/r/issues/1").unwrap();
    store.attach_task_pr(task.id, "o/r", 10, "https://github.com/o/r/pull/10").unwrap();

    // Everything open: no-op.
    store.refresh_link_states_from_cache(2).unwrap();
    assert_eq!(rollup_task_statuses(&store, 2).unwrap(), 0);
    assert_eq!(store.get_task(task.id).unwrap().unwrap().status, "backlog");

    // Issue closes but the PR is still open → card stays put.
    let mut closed = issue("o/r", 1);
    closed.state = "closed".to_string();
    store.replace_issues(&[closed.clone()]).unwrap();
    store.refresh_link_states_from_cache(3).unwrap();
    assert_eq!(rollup_task_statuses(&store, 3).unwrap(), 0);
    assert_eq!(store.get_task(task.id).unwrap().unwrap().status, "backlog");

    // PR merges too (its targeted fetch writes the row) → all resolved → done.
    store.upsert_prs(&[pr("o/r", 10, "merged")]).unwrap();
    store.refresh_link_states_from_cache(4).unwrap();
    assert_eq!(rollup_task_statuses(&store, 4).unwrap(), 1);
    assert_eq!(store.get_task(task.id).unwrap().unwrap().status, "done");

    // Issue reopens on GitHub → done task falls back to backlog.
    store.replace_issues(&[issue("o/r", 1)]).unwrap();
    store.refresh_link_states_from_cache(5).unwrap();
    assert_eq!(rollup_task_statuses(&store, 5).unwrap(), 1);
    assert_eq!(store.get_task(task.id).unwrap().unwrap().status, "backlog");
}

#[test]
fn rollup_never_overturns_an_explicit_outcome() {
    // A task closed as abandoned whose linked PR later reads merged must not
    // be resurrected — `set_task_status` would clear the outcome as it went.
    let store = Store::open_in_memory().unwrap();
    let task = store.add_task("closed", "doing", None, None, 1).unwrap();
    store.attach_task_pr(task.id, "o/r", 10, "u").unwrap();
    store.upsert_prs(&[pr("o/r", 10, "merged")]).unwrap();
    store.refresh_link_states_from_cache(2).unwrap();
    store.close_task(task.id, TaskOutcome::Abandoned, 3).unwrap();

    assert_eq!(rollup_task_statuses(&store, 4).unwrap(), 0);
    let after = store.get_task(task.id).unwrap().unwrap();
    assert_eq!(after.status, "doing", "frozen where it was closed");
    assert_eq!(after.outcome.as_deref(), Some("abandoned"));
}

/// Both halves must link, or the pass writing the merged rows and the pass
/// linking them race — and a nudge fires them together. Asserted through
/// archiving, `link_task_prs`' one effect that needs no `gh`.
#[test]
fn the_merged_half_links_its_own_rows() {
    let store = Store::open_in_memory().unwrap();
    let done = store.add_task("done", "doing", None, None, 1).unwrap();
    store.close_task(done.id, TaskOutcome::Done, 10).unwrap();

    let now = tt_store::ARCHIVE_AFTER_MS + 100;
    assert!(collect_prs_merged(&store, &[], None, FETCH_NOW, now).ok);
    assert!(store.get_task(done.id).unwrap().unwrap().archived_at.is_some());
}

#[test]
fn sync_sweep_archives_old_finished_tasks() {
    // Anything finished more than ARCHIVE_AFTER_MS ago leaves the board.
    let store = Store::open_in_memory().unwrap();
    let old = store.add_task("old", "doing", None, None, 1).unwrap();
    store.close_task(old.id, TaskOutcome::Done, 10).unwrap();
    let fresh = store.add_task("fresh", "doing", None, None, 2).unwrap();
    store.close_task(fresh.id, TaskOutcome::Done, 500).unwrap();

    let now = tt_store::ARCHIVE_AFTER_MS + 100;
    store.archive_closed_tasks(now - tt_store::ARCHIVE_AFTER_MS, now).unwrap();
    assert!(store.get_task(old.id).unwrap().unwrap().archived_at.is_some());
    assert!(store.get_task(fresh.id).unwrap().unwrap().archived_at.is_none());
}

#[test]
fn rollup_ignores_linkless_tasks_and_manual_non_done_moves() {
    let store = Store::open_in_memory().unwrap();
    let plain = store.add_task("plain", "backlog", None, None, 1).unwrap();
    store.set_task_status(plain.id, "doing", 1).unwrap();

    assert_eq!(rollup_task_statuses(&store, 2).unwrap(), 0);
    assert_eq!(store.get_task(plain.id).unwrap().unwrap().status, "doing");
}

#[test]
fn absent_refs_are_never_inferred_closed() {
    // An issue that merely left the snapshot (reassigned away, collector
    // failure) must not roll its task to done.
    let store = Store::open_in_memory().unwrap();
    store.replace_issues(&[issue("o/r", 1)]).unwrap();
    let task = store.add_task("linked", "doing", None, None, 1).unwrap();
    store.attach_task_issue(task.id, "o/r", 1, "u").unwrap();
    store.refresh_link_states_from_cache(2).unwrap();

    store.replace_issues(&[]).unwrap();
    store.refresh_link_states_from_cache(3).unwrap();
    assert_eq!(rollup_task_statuses(&store, 3).unwrap(), 0);
    assert_eq!(store.get_task(task.id).unwrap().unwrap().status, "doing");
    assert_eq!(store.open_issue_refs_missing_from_cache().unwrap(), vec![("o/r".to_string(), 1)]);
}

fn cal_event(ext: &str, start_ts: i64) -> EventInput {
    EventInput {
        external_id: ext.to_string(),
        title: format!("event {ext}"),
        start: chrono::DateTime::from_timestamp_millis(start_ts).unwrap().fixed_offset(),
        end: chrono::DateTime::from_timestamp_millis(start_ts + 30 * 60 * 1000)
            .map(|e| e.fixed_offset()),
        attendees: vec![],
        location: None,
        join_url: None,
    }
}

/// Local noon, so a `now + 1h` event can't cross into the next local day.
fn local_noon_ms() -> i64 {
    use chrono::{Local, TimeZone};
    Local.with_ymd_and_hms(2026, 7, 12, 12, 0, 0).unwrap().timestamp_millis()
}

/// Write `events` into `source`'s lane the way [`collect_calendar`] does.
fn seed(store: &Store, source: &str, events: &[EventInput], now: i64) {
    let (start, end) = Store::local_day_bounds(now);
    store.replace_events_for_source(source, start, end, events, now).unwrap();
}

/// The store half of one source's pull, after `claude -p` returns.
fn apply(store: &Store, source: &str, events: &[EventInput], now: i64) -> Result<usize, String> {
    let (start, end) = Store::local_day_bounds(now);
    store_calendar_events(store, source, start, end, events, now)
}

#[test]
fn local_day_bounds_bracket_now() {
    let now = local_noon_ms();
    let (start, end) = Store::local_day_bounds(now);
    assert!(start <= now && now < end, "now falls inside its own local day");
    assert!(end - start >= 23 * 60 * 60 * 1000);
    assert!(end - start <= 25 * 60 * 60 * 1000);
}

#[test]
fn calendar_non_empty_result_replaces_that_sources_day() {
    let store = Store::open_in_memory().unwrap();
    let now = local_noon_ms();
    seed(&store, "google", &[cal_event("old", now + 60 * 60 * 1000)], now);

    let fresh = cal_event("new", now + 2 * 60 * 60 * 1000);
    assert_eq!(apply(&store, "google", std::slice::from_ref(&fresh), now).unwrap(), 1);

    let stored = store.events_between(now, now + 24 * 60 * 60 * 1000).unwrap();
    assert_eq!(stored.len(), 1, "the day's replace swapped the old row for the new one");
    assert_eq!(stored[0].external_id, "new");
}

#[test]
fn calendar_empty_result_with_future_events_preserves_and_fails() {
    let store = Store::open_in_memory().unwrap();
    let now = local_noon_ms();
    seed(&store, "google", &[cal_event("keep", now + 60 * 60 * 1000)], now);

    let err = apply(&store, "google", &[], now).unwrap_err();

    assert!(err.contains("kept existing events"));
    let stored = store.events_between(now, now + 24 * 60 * 60 * 1000).unwrap();
    assert_eq!(stored.len(), 1, "existing future events survive the empty sweep");
    assert_eq!(stored[0].external_id, "keep");
}

#[test]
fn calendar_empty_result_with_no_future_events_clears_ok() {
    let store = Store::open_in_memory().unwrap();
    let now = local_noon_ms();
    seed(&store, "google", &[cal_event("past", now - 60 * 60 * 1000)], now);

    assert_eq!(apply(&store, "google", &[], now).unwrap(), 0, "a genuinely empty day is fine");
    assert!(
        store
            .events_between(now - 24 * 60 * 60 * 1000, now + 24 * 60 * 60 * 1000)
            .unwrap()
            .is_empty(),
        "the empty result clears the stale past row"
    );
}

#[test]
fn calendar_empty_result_on_empty_store_is_clean_noop() {
    let store = Store::open_in_memory().unwrap();
    let now = local_noon_ms();
    assert_eq!(apply(&store, "google", &[], now).unwrap(), 0);
}

#[test]
fn one_sources_empty_sweep_neither_consults_nor_clears_another() {
    // Outlook coming back empty must be neither excused by google's rows nor
    // allowed to delete them.
    let store = Store::open_in_memory().unwrap();
    let now = local_noon_ms();
    seed(&store, "google", &[cal_event("personal", now + 60 * 60 * 1000)], now);

    assert_eq!(apply(&store, "outlook", &[], now).unwrap(), 0);

    let stored = store.events_between(now, now + 24 * 60 * 60 * 1000).unwrap();
    assert_eq!(stored.len(), 1, "google's row is untouched by outlook's pull");
    assert_eq!(stored[0].external_id, "personal");
}

#[test]
fn calendar_with_no_enabled_sources_is_a_clean_noop() {
    let store = Store::open_in_memory().unwrap();
    let sources: Vec<CalendarSource> = CalendarSource::defaults()
        .into_iter()
        .map(|s| CalendarSource { enabled: false, ..s })
        .collect();

    let summary = collect_calendar(&store, &sources, local_noon_ms());

    assert!(summary.ok);
    assert_eq!(summary.count, 0);
    assert_eq!(summary.message.as_deref(), Some("no calendar sources enabled"));
    let runs = store.runs().unwrap();
    assert_eq!(runs[0].collector, "claude:calendar");
}

#[test]
fn calendar_source_without_a_prompt_fails_without_spawning_claude() {
    let store = Store::open_in_memory().unwrap();
    let now = local_noon_ms();
    let sources = vec![CalendarSource {
        id: "google".to_string(),
        label: "Google".to_string(),
        enabled: true,
        prompt: "   ".to_string(),
    }];

    let summary = collect_calendar(&store, &sources, now);

    assert!(!summary.ok);
    assert_eq!(summary.message.as_deref(), Some("google: source has no prompt"));
}

fn issue(repo: &str, number: i64) -> tt_store::IssueInput {
    tt_store::IssueInput {
        repo: repo.to_string(),
        number,
        title: format!("issue {number}"),
        labels: vec![],
        assignees: vec![],
        state: "open".to_string(),
        url: format!("https://github.com/{repo}/issues/{number}"),
        updated_ts: 1,
    }
}

fn issue_write(
    store: &Store,
) -> impl Fn(&[tt_store::IssueInput], Option<&[String]>) -> tt_store::Result<usize> + '_ {
    |all, repos| match repos {
        None => store.replace_issues(all),
        Some(repos) => store.replace_issues_for_repos(repos, all),
    }
}

fn pr(repo: &str, number: i64, state: &str) -> tt_store::PrInput {
    tt_store::PrInput {
        repo: repo.to_string(),
        number,
        title: format!("pr {number}"),
        branch: format!("branch-{number}"),
        state: state.to_string(),
        checks: "none".to_string(),
        review_state: String::new(),
        url: format!("https://github.com/{repo}/pull/{number}"),
        updated_ts: 1,
        base_branch: "main".to_string(),
    }
}

#[test]
fn write_repo_issues_now_only_replaces_the_synced_repo() {
    // The bug this prevents: a 1-element sweep reads as "clean" and full-table
    // replaces, wiping every other tracked repo's rows.
    let store = Store::open_in_memory().unwrap();
    store.replace_issues(&[issue("o/a", 1), issue("o/b", 2)]).unwrap();

    let summary = write_repo_issues_now(&store, Ok(("o/a".to_string(), vec![issue("o/a", 9)])), 5);

    assert!(summary.ok);
    assert_eq!(summary.count, 1);
    let issues = store.issues().unwrap();
    assert!(issues.iter().any(|i| i.repo == "o/a" && i.number == 9), "synced repo's fresh row");
    assert!(issues.iter().any(|i| i.repo == "o/b" && i.number == 2), "other repo untouched");
    assert!(!issues.iter().any(|i| i.number == 1), "synced repo's stale row is gone");
}

#[test]
fn write_repo_issues_now_records_the_error_and_keeps_existing_rows_on_failure() {
    let store = Store::open_in_memory().unwrap();
    store.replace_issues(&[issue("o/a", 1)]).unwrap();

    let summary = write_repo_issues_now(&store, Err("gh: rate limited".to_string()), 5);

    assert!(!summary.ok);
    assert_eq!(summary.message.as_deref(), Some("gh: rate limited"));
    assert_eq!(store.issues().unwrap().len(), 1, "existing rows survive a failed sync");
}

#[test]
fn write_repo_prs_now_only_replaces_the_synced_repo() {
    let store = Store::open_in_memory().unwrap();
    store.replace_prs(&[pr("o/a", 1, "open"), pr("o/b", 2, "open")]).unwrap();

    let summary =
        write_repo_prs_now(&store, Ok(("o/a".to_string(), vec![pr("o/a", 9, "open")])), 5);

    assert!(summary.ok);
    assert_eq!(summary.count, 1);
    let prs = store.prs().unwrap();
    assert!(prs.iter().any(|p| p.repo == "o/a" && p.number == 9), "synced repo's fresh row");
    assert!(prs.iter().any(|p| p.repo == "o/b" && p.number == 2), "other repo untouched");
    assert!(!prs.iter().any(|p| p.number == 1), "synced repo's stale row is gone");
}

fn ci_run(repo: &str, workflow: &str, conclusion: &str, created_ms: i64) -> tt_store::CiRun {
    tt_store::CiRun {
        repo: repo.to_string(),
        workflow: workflow.to_string(),
        status: "completed".to_string(),
        conclusion: conclusion.to_string(),
        created_ms,
        updated_ms: created_ms,
        url: String::new(),
        head_sha: String::new(),
        event: "push".to_string(),
        branch: "main".to_string(),
    }
}

fn ci_conclusion(store: &Store, repo: &str, workflow: &str) -> Option<String> {
    store
        .ci_runs()
        .unwrap()
        .into_iter()
        .find(|r| r.repo == repo && r.workflow == workflow)
        .map(|r| r.conclusion)
}

#[test]
fn ci_sweep_with_a_failed_repo_keeps_its_rows_and_an_absent_workflow() {
    let store = Store::open_in_memory().unwrap();
    store
        .upsert_ci_runs(&[
            ci_run("o/a", "CI", "failure", 1),
            ci_run("o/a", "Nightly", "failure", 1),
            ci_run("o/b", "CI", "success", 1),
        ])
        .unwrap();

    let sweep = Sweep {
        successes: vec![("o/a".to_string(), vec![ci_run("o/a", "CI", "success", 2)])],
        errors: vec!["o/b: gh exploded".to_string()],
        skipped: vec![],
    };
    let summary = finish_ci_sweep(&store, sweep, false, 5);

    assert!(!summary.ok, "a failed repo still fails the run");
    assert_eq!(summary.count, 1);
    assert_eq!(ci_conclusion(&store, "o/a", "CI").as_deref(), Some("success"));
    assert_eq!(
        ci_conclusion(&store, "o/a", "Nightly").as_deref(),
        Some("failure"),
        "a workflow outside this page keeps its last known run"
    );
    assert_eq!(
        ci_conclusion(&store, "o/b", "CI").as_deref(),
        Some("success"),
        "the failed repo's rows are intact"
    );
}

#[test]
fn clean_ci_sweep_prunes_only_repos_no_longer_tracked() {
    let store = Store::open_in_memory().unwrap();
    store
        .upsert_ci_runs(&[
            ci_run("o/a", "Nightly", "failure", 1),
            ci_run("o/gone", "CI", "success", 1),
        ])
        .unwrap();

    let sweep = Sweep {
        successes: vec![
            ("o/a".to_string(), vec![]),
            ("o/b".to_string(), vec![ci_run("o/b", "CI", "success", 2)]),
        ],
        errors: vec![],
        skipped: vec![],
    };
    let summary = finish_ci_sweep(&store, sweep, false, 5);

    assert!(summary.ok);
    let keys: Vec<(String, String)> =
        store.ci_runs().unwrap().into_iter().map(|r| (r.repo, r.workflow)).collect();
    assert_eq!(
        keys,
        [
            ("o/a".to_string(), "Nightly".to_string()),
            ("o/b".to_string(), "CI".to_string())
        ],
        "an empty page keeps o/a's row; only the untracked repo is gone"
    );
}

#[test]
fn ci_sweep_ages_out_a_workflow_gone_from_a_fetched_repo() {
    let store = Store::open_in_memory().unwrap();
    let now = CI_ABSENT_KEEP_MS * 2;
    let old = now - CI_ABSENT_KEEP_MS - 1;
    store
        .upsert_ci_runs(&[
            ci_run("o/a", "Deleted", "failure", old),
            ci_run("o/a", "Weekly", "failure", now - 1),
            ci_run("o/b", "Gone", "failure", old),
        ])
        .unwrap();

    let sweep = Sweep {
        successes: vec![("o/a".to_string(), vec![ci_run("o/a", "CI", "success", now)])],
        errors: vec!["o/b: gh exploded".to_string()],
        skipped: vec![],
    };
    finish_ci_sweep(&store, sweep, false, now);

    let keys: Vec<(String, String)> =
        store.ci_runs().unwrap().into_iter().map(|r| (r.repo, r.workflow)).collect();
    assert_eq!(
        keys,
        [
            ("o/a".to_string(), "CI".to_string()),
            ("o/a".to_string(), "Weekly".to_string()),
            ("o/b".to_string(), "Gone".to_string())
        ],
        "the old absent workflow ages out; a recent one and a failed repo's rows stay"
    );
}

#[test]
fn a_nudge_scoped_ci_sweep_leaves_other_repos_runs() {
    let store = Store::open_in_memory().unwrap();
    store.upsert_ci_runs(&[ci_run("o/b", "CI", "failure", 1)]).unwrap();
    let sweep = Sweep {
        successes: vec![("o/a".to_string(), vec![ci_run("o/a", "CI", "success", 5)])],
        errors: vec![],
        skipped: vec![],
    };
    finish_ci_sweep(&store, sweep, true, 5);
    let repos: Vec<String> = store.ci_runs().unwrap().into_iter().map(|r| r.repo).collect();
    assert_eq!(repos, ["o/a", "o/b"], "a clean one-repo sweep is no snapshot of the rest");
}

#[test]
fn a_nudge_narrows_the_sweep_to_its_repo_and_forces_a_per_repo_write() {
    let dirs = [PathBuf::from("/c/a"), PathBuf::from("/c/b")];
    let (only, scoped) = scope_to_origin(&dirs, Some(Path::new("/c/b/src")));
    assert_eq!((only, scoped), (vec![PathBuf::from("/c/b")], true));
    let (all, scoped) = scope_to_origin(&dirs, Some(Path::new("/elsewhere")));
    assert_eq!((all.len(), scoped), (2, false), "an untracked origin sweeps everything");

    let sweep: Sweep<()> =
        Sweep { successes: vec![("o/b".to_string(), vec![])], errors: vec![], skipped: vec![] };
    assert_eq!(swept_repos(&sweep, true), Some(vec!["o/b".to_string()]));
    assert_eq!(swept_repos(&sweep, false), None);
}

#[test]
fn ci_sweep_with_no_tracked_repos_clears_the_rows() {
    let store = Store::open_in_memory().unwrap();
    store.upsert_ci_runs(&[ci_run("o/a", "CI", "failure", 1)]).unwrap();

    let empty = Sweep { successes: vec![], errors: vec![], skipped: vec![] };
    let summary = finish_ci_sweep(&store, empty, false, 5);

    assert!(summary.ok);
    assert_eq!(summary.message.as_deref(), Some("no repos configured"));
    assert!(store.ci_runs().unwrap().is_empty(), "untracking every repo clears CI");
}

#[test]
fn ci_sweep_where_every_fetch_failed_keeps_the_rows() {
    let store = Store::open_in_memory().unwrap();
    store.upsert_ci_runs(&[ci_run("o/a", "CI", "failure", 1)]).unwrap();

    let failed =
        Sweep { successes: vec![], errors: vec!["o/a: rate limited".to_string()], skipped: vec![] };
    let summary = finish_ci_sweep(&store, failed, false, 5);

    assert!(!summary.ok);
    assert_eq!(store.ci_runs().unwrap().len(), 1, "a dead sweep isn't an untracked one");
}

#[test]
fn collect_repo_now_records_a_failure_for_a_missing_dir_without_touching_other_rows() {
    let store = Store::open_in_memory().unwrap();
    store.replace_issues(&[issue("o/a", 1)]).unwrap();
    store.replace_prs(&[pr("o/a", 1, "open")]).unwrap();

    let root = tempfile::tempdir().unwrap();
    let missing = root.path().join("gone");
    let summaries = collect_repo_now(&store, &missing, 9);

    assert_eq!(summaries.len(), 2);
    assert!(summaries.iter().all(|s| !s.ok));
    assert!(
        summaries.iter().all(|s| s.message.as_deref().unwrap().contains("not found")),
        "missing dir is surfaced as a clear failure, not a silent skip"
    );
    assert_eq!(store.issues().unwrap().len(), 1, "no repo touched on a missing dir");
    assert_eq!(store.prs().unwrap().len(), 1, "no repo touched on a missing dir");
}

#[test]
fn all_failed_sweep_preserves_existing_rows() {
    let store = Store::open_in_memory().unwrap();
    store.replace_issues(&[issue("o/a", 1)]).unwrap();

    let sweep =
        Sweep { successes: vec![], errors: vec!["gh: rate limited".to_string()], skipped: vec![] };
    let summary = finish_sweep(
        &store,
        "issues",
        sweep,
        issue_write(&store),
        |i| (i.repo.clone(), i.number),
        9,
    );

    assert!(!summary.ok);
    assert_eq!(store.issues().unwrap().len(), 1, "last-known-good rows survive a dead sweep");
    assert!(summary.message.unwrap().contains("rate limited"));
}

#[test]
fn partial_sweep_replaces_only_succeeded_repos() {
    let store = Store::open_in_memory().unwrap();
    store.replace_issues(&[issue("o/a", 1), issue("o/b", 2)]).unwrap();

    let sweep = Sweep {
        successes: vec![("o/a".to_string(), vec![issue("o/a", 3)])],
        errors: vec!["gh failed in /repos/b: boom".to_string()],
        skipped: vec![],
    };
    let summary = finish_sweep(
        &store,
        "issues",
        sweep,
        issue_write(&store),
        |i| (i.repo.clone(), i.number),
        9,
    );

    assert!(!summary.ok, "a failed repo marks the run failed even though data was written");
    let issues = store.issues().unwrap();
    assert!(issues.iter().any(|i| i.repo == "o/a" && i.number == 3));
    assert!(issues.iter().any(|i| i.repo == "o/b" && i.number == 2), "failed repo keeps rows");
    assert!(!issues.iter().any(|i| i.number == 1), "succeeded repo's stale rows are gone");
}

#[test]
fn clean_sweep_purges_untracked_repos() {
    let store = Store::open_in_memory().unwrap();
    store.replace_issues(&[issue("o/gone", 1)]).unwrap();

    let sweep = Sweep {
        successes: vec![("o/a".to_string(), vec![issue("o/a", 2)])],
        errors: vec![],
        skipped: vec![],
    };
    let summary = finish_sweep(
        &store,
        "issues",
        sweep,
        issue_write(&store),
        |i| (i.repo.clone(), i.number),
        9,
    );

    assert!(summary.ok);
    let issues = store.issues().unwrap();
    assert_eq!(issues.len(), 1);
    assert_eq!(issues[0].repo, "o/a", "full replace drops repos no longer tracked");
}

#[test]
fn dedupe_resolved_keeps_first_dir_per_resolved_repo() {
    let deduped = dedupe_resolved(vec![
        (PathBuf::from("/worktrees/repo-a"), Ok("o/repo".to_string())),
        (PathBuf::from("/worktrees/repo-b"), Ok("o/repo".to_string())),
        (PathBuf::from("/worktrees/other"), Ok("o/other".to_string())),
    ]);
    assert_eq!(
        tracked(&deduped),
        [
            (Path::new("/worktrees/repo-a"), Some("o/repo")),
            (Path::new("/worktrees/other"), Some("o/other")),
        ],
        "the resolved name travels with the dir — it's the shared cache's key"
    );
}

#[test]
fn dedupe_resolved_keeps_every_dir_that_fails_to_resolve() {
    // A dir whose resolution errors can't be proven a duplicate, so it survives
    // the dedup pass to surface its error. Unnamed, so it skips the cache too.
    let deduped = dedupe_resolved(vec![
        (PathBuf::from("/worktrees/a"), Err("gh: not a git repo".to_string())),
        (PathBuf::from("/worktrees/b"), Err("gh: not a git repo".to_string())),
    ]);
    assert_eq!(
        tracked(&deduped),
        [
            (Path::new("/worktrees/a"), None),
            (Path::new("/worktrees/b"), None)
        ]
    );
}

#[test]
fn dedupe_resolved_is_empty_for_empty_input() {
    assert!(dedupe_resolved(vec![]).is_empty());
}

#[test]
fn parallel_map_preserves_input_order() {
    // Reversed sleeps, so completion order differs from input order.
    let inputs: Vec<usize> = (0..12).collect();
    let out = parallel_map(&inputs, 4, |&n| {
        std::thread::sleep(std::time::Duration::from_millis(((12 - n) % 5) as u64));
        n * 10
    });
    assert_eq!(out, (0..12).map(|n| n * 10).collect::<Vec<_>>());
}

#[test]
fn parallel_sweep_contains_failures_and_keeps_order() {
    // One dir missing (skipped) and one repo erroring must not sink the rest.
    let root = tempfile::tempdir().unwrap();
    let make = |name: &str| {
        let p = root.path().join(name);
        std::fs::create_dir(&p).unwrap();
        p
    };
    let repo_dirs = vec![
        make("repo0"),
        make("repo1"),
        root.path().join("gone"), // never created → skipped
        make("repo3"),            // stubbed to error below
        make("repo4"),
    ];

    // Each issue's number encodes its input position, so ordering is checkable.
    let collect = |dir: &std::path::Path| -> Result<(String, Vec<tt_store::IssueInput>), String> {
        let name = dir.file_name().unwrap().to_string_lossy().to_string();
        if name == "repo3" {
            return Err("gh failed in repo3: boom".to_string());
        }
        let n: i64 = name.trim_start_matches("repo").parse().unwrap();
        Ok((name.clone(), vec![issue(&name, n)]))
    };

    let sweep = sweep_repos(&repo_dirs, collect);

    let repos: Vec<&str> = sweep.successes.iter().map(|(r, _)| r.as_str()).collect();
    assert_eq!(repos, ["repo0", "repo1", "repo4"], "successes keep input order");
    let numbers: Vec<i64> = sweep.successes.iter().map(|(_, v)| v[0].number).collect();
    assert_eq!(numbers, [0, 1, 4], "each surviving repo's rows are intact");

    assert_eq!(sweep.errors.len(), 1);
    assert!(sweep.errors[0].contains("repo3"), "the failing repo is reported");
    assert_eq!(sweep.skipped.len(), 1);
    assert!(sweep.skipped[0].contains("gone"), "the missing dir is skipped, not errored");
}

#[test]
fn sweep_dedups_same_repo_from_two_checkouts() {
    let store = Store::open_in_memory().unwrap();
    let sweep = Sweep {
        successes: vec![
            ("o/a".to_string(), vec![issue("o/a", 1)]),
            ("o/a".to_string(), vec![issue("o/a", 1)]),
        ],
        errors: vec![],
        skipped: vec![],
    };
    let summary = finish_sweep(
        &store,
        "issues",
        sweep,
        issue_write(&store),
        |i| (i.repo.clone(), i.number),
        9,
    );
    assert!(summary.ok);
    assert_eq!(summary.count, 1);
    assert_eq!(store.issues().unwrap().len(), 1);
}
