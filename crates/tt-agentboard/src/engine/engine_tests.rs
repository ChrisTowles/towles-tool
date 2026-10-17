use super::*;

fn engine() -> (tempfile::TempDir, Engine) {
    let tmp = tempfile::tempdir().unwrap();
    let repos_path = tmp.path().join("repos.json");
    (tmp, Engine::new_for_test(repos_path))
}

fn git_info(branch: &str) -> crate::git_info::GitInfo {
    crate::git_info::GitInfo { branch: branch.to_string(), ..Default::default() }
}

#[test]
fn add_session_then_close_session_round_trips_by_folder() {
    let (_tmp, mut e) = engine();
    let a = e.add_session("/repo/x", Some("one"), 1000);
    let b = e.add_session("/repo/x", Some("two"), 1001);
    let ids = e.session_ids_for("/repo/x");
    assert!(ids.contains(&a.id) && ids.contains(&b.id));
    assert!(e.session_ids_for("/repo/other").is_empty());

    assert!(e.close_session(&a.id, 1002));
    assert!(!e.close_session("nope", 1003));
    assert_eq!(e.session_ids_for("/repo/x"), vec![b.id]);

    assert_eq!(e.folder_meta.last_worked_at_for("/repo/x"), Some(1002));
}

#[test]
fn retire_prior_run_closes_all_but_the_kept_records_once() {
    let (_tmp, mut e) = engine();
    let stale = e.add_session("/repo/x", None, 1000);
    let candidate = e.add_session("/repo/x", None, 1001);
    let this_run = e.add_session("/repo/x", None, 1002);
    e.prior_run = [&stale, &candidate].iter().map(|r| r.id.clone()).collect();

    let keep = HashSet::from([candidate.id.clone()]);
    assert_eq!(e.retire_prior_run(&keep, 2000), vec![stale.id.clone()]);
    let left: Vec<String> = e.session_ids_for("/repo/x");
    assert_eq!(left, vec![candidate.id.clone(), this_run.id.clone()]);
    assert!(e.retire_prior_run(&HashSet::new(), 3000).is_empty());
}

#[test]
fn close_folder_returns_the_ids_it_removed_and_empties_the_folder() {
    let (_tmp, mut e) = engine();
    let a = e.add_session("/repo/x", None, 1000);
    let b = e.add_session("/repo/x", None, 1001);

    let mut closed = e.close_folder("/repo/x");
    closed.sort();
    let mut expected = vec![a.id, b.id];
    expected.sort();
    assert_eq!(closed, expected);
    assert!(e.session_ids_for("/repo/x").is_empty());

    assert!(e.close_folder("/repo/never").is_empty());
}

#[test]
fn rename_and_purpose_report_whether_they_changed() {
    let (_tmp, mut e) = engine();
    let rec = e.add_session("/repo/x", Some("orig"), 1000);
    assert!(e.rename_session(&rec.id, "renamed"));
    assert!(!e.rename_session(&rec.id, "renamed"));
    assert!(!e.rename_session("unknown-id", "x"));

    assert!(e.set_session_purpose(&rec.id, Some("ship it")));
    assert!(!e.set_session_purpose(&rec.id, Some("ship it")));
    assert!(e.set_session_purpose(&rec.id, None));
}

#[test]
fn add_repo_is_idempotent_and_remove_reports_removal() {
    let (_tmp, mut e) = engine();
    assert!(e.add_repo("/repo/a"));
    assert!(!e.add_repo("/repo/a"));
    assert!(e.add_repo("/repo/b"));
    assert!(e.repo_dirs().contains(&"/repo/a".to_string()));
    assert!(e.repo_dirs().contains(&"/repo/b".to_string()));

    assert!(e.remove_repo("/repo/a"));
    assert!(!e.remove_repo("/repo/a"));
    assert!(!e.repo_dirs().contains(&"/repo/a".to_string()));
    assert!(e.repo_dirs().contains(&"/repo/b".to_string()));
}

#[test]
fn a_tracked_folder_is_listed_with_no_sessions_until_one_is_created() {
    let (_tmp, mut e) = engine();
    assert!(e.add_repo("/repo/quiet"));

    let payload = e.compute_payload(1000);
    assert_eq!(payload.repos[0].folders[0].dir, "/repo/quiet");
    assert!(payload.repos[0].folders[0].sessions.is_empty());

    e.add_session("/repo/quiet", None, 1001);
    let payload = e.compute_payload(1002);
    assert_eq!(payload.repos[0].folders[0].sessions.len(), 1);
}

#[test]
fn a_failed_cli_scan_keeps_the_last_snapshot() {
    let failed = AgentScan { agents: Vec::new(), ok: false };
    assert!(collect_agent_snapshot(&InstanceScope::Any, &[], &failed).is_none());
}

#[test]
fn every_rebuild_reads_the_last_stored_agent_snapshot() {
    let (_tmp, mut e) = engine();
    assert!(e.add_repo("/repo/a"));
    let session = e.add_session("/repo/a", None, 1000);
    let other = e.add_session("/repo/a", None, 1001);
    e.tracker.apply_event(AgentEvent {
        agent: "claude-code".to_string(),
        session: "a".to_string(),
        status: crate::types::AgentStatus::Busy,
        ts: 1000,
        thread_id: Some("t1".to_string()),
        thread_name: None,
        unseen: None,
        details: None,
    });
    e.set_agent_snapshot(AgentSnapshot {
        live_threads: HashSet::from(["t1".to_string()]),
        tt_session_by_thread: HashMap::from([("t1".to_string(), other.id.clone())]),
        unlisted: Vec::new(),
    });

    for now in [1002, 1003] {
        let payload = e.compute_payload(now);
        let rows = &payload.repos[0].folders[0].sessions;
        let row = |id: &str| rows.iter().find(|r| r.id == id).unwrap();
        assert!(row(&session.id).agent_state.is_none());
        let state = row(&other.id).agent_state.as_ref();
        assert_eq!(state.map(|s| s.status), Some(crate::types::AgentStatus::Busy));
    }
}

#[test]
fn add_repo_persists_across_a_reconstructed_engine() {
    let tmp = tempfile::tempdir().unwrap();
    let repos_path = tmp.path().join("repos.json");
    {
        let mut e = Engine::new_for_test(repos_path.clone());
        assert!(e.add_repo("/repo/persisted"));
    }
    let e2 = Engine::new_for_test(repos_path);
    assert!(e2.repo_paths.contains(&"/repo/persisted".to_string()));
}

#[test]
fn find_worktree_owner_resolves_a_missing_dir_to_its_tracked_owner() {
    let (_tmp, mut e) = engine();
    assert!(e.add_repo("/repo/main"));
    e.store_git_info(
        "/repo/main",
        crate::git_info::GitInfo {
            linked_worktree_dirs: vec!["/repo/main/.claude/worktrees/thing".to_string()],
            ..Default::default()
        },
        1000,
    );

    // A discovered worktree is no `repos.json` entry, so `remove_repo` can't.
    assert_eq!(
        e.find_worktree_owner("/repo/main/.claude/worktrees/thing"),
        Some("/repo/main".to_string())
    );
    assert!(!e.remove_repo("/repo/main/.claude/worktrees/thing"));

    assert_eq!(e.find_worktree_owner("/repo/elsewhere"), None);
}

/// Removal invalidates the *owner* too: its cached `linked_worktree_dirs`
/// still names the deleted path until a recompute gets through.
#[test]
fn invalidating_the_owner_requeues_its_stale_worktree_list() {
    let (_tmp, mut e) = engine();
    // Real epoch-ms: `invalidate` stamps `0`, stale only far from the epoch.
    let now = 1_700_000_000_000;
    let wt = "/repo/main/.claude/worktrees/feat-deleted";
    assert!(e.add_repo("/repo/main"));
    e.store_git_info(
        "/repo/main",
        crate::git_info::GitInfo {
            linked_worktree_dirs: vec![wt.to_string()],
            ..Default::default()
        },
        now,
    );

    assert!(e.stale_git_targets(now + 1).is_empty());

    assert_eq!(e.find_worktree_owner(wt), Some("/repo/main".to_string()));

    e.invalidate_git("/repo/main", GitInvalidation::ControlFile);
    assert!(
        e.stale_git_targets(now + 2).iter().any(|(dir, _, _)| dir == "/repo/main"),
        "the owner must be due for a recompute immediately, not in 60s"
    );
}

fn record(repo_root: &str, dir: &str, kind: tt_store::TaskKind) -> tt_store::RailWorktree {
    tt_store::RailWorktree {
        task_id: 1,
        kind,
        status: "doing".to_string(),
        repo_root: repo_root.to_string(),
        dir: dir.to_string(),
        branch: Some("feat/thing".to_string()),
        created_at: 1000,
    }
}

/// A row is on the rail because a record says so; detection can't move one.
#[test]
fn a_task_row_exists_on_its_record_alone() {
    let (_tmp, mut e) = engine();
    let wt = "/repo/main/.claude/worktrees/feat-thing";
    assert!(e.add_repo("/repo/main"));

    assert!(e.set_task_worktrees(vec![record("/repo/main", wt, tt_store::TaskKind::Task)]));
    assert!(e.watch_targets().contains(&wt.to_string()));
    assert!(!e.set_task_worktrees(vec![record("/repo/main", wt, tt_store::TaskKind::Task)]));

    // The row goes with the record, though the parent still lists it.
    e.store_git_info(
        "/repo/main",
        crate::git_info::GitInfo {
            linked_worktree_dirs: vec![wt.to_string()],
            ..Default::default()
        },
        2000,
    );
    assert!(e.set_task_worktrees(vec![]));
    assert!(!e.watch_targets().contains(&wt.to_string()));
}

/// Removal needn't out-race discovery: a deleted worktree keeps its row.
#[test]
fn a_task_row_survives_its_directory_vanishing() {
    let (_tmp, mut e) = engine();
    let wt = "/repo/main/.claude/worktrees/feat-gone";
    assert!(e.add_repo("/repo/main"));
    e.set_task_worktrees(vec![record("/repo/main", wt, tt_store::TaskKind::Task)]);
    e.store_git_info(
        wt,
        crate::git_info::GitInfo { dir_missing: true, ..Default::default() },
        1000,
    );

    assert!(e.watch_targets().contains(&wt.to_string()));
    assert!(
        e.vanished_detected_records().is_empty(),
        "a task's record is never retired by its directory going away"
    );
}

/// Detected rows are records too: the setting filters, never discovers.
#[test]
fn detected_rows_are_hidden_by_the_setting_not_by_discovery() {
    let (_tmp, mut e) = engine();
    let task = "/repo/main/.claude/worktrees/feat-thing";
    let agent = "/repo/main/.claude/worktrees/agent-a12d791a14a404064";
    assert!(e.add_repo("/repo/main"));
    e.set_task_worktrees(vec![
        record("/repo/main", task, tt_store::TaskKind::Task),
        record("/repo/main", agent, tt_store::TaskKind::Detected),
    ]);

    assert_eq!(e.watch_targets(), vec!["/repo/main".to_string(), task.to_string()]);

    e.show_unmanaged_worktrees = true;
    assert_eq!(
        e.watch_targets(),
        vec![
            "/repo/main".to_string(),
            task.to_string(),
            agent.to_string()
        ]
    );
}

/// What the host reconciles into `detected` records; empty once recorded.
#[test]
fn unrecorded_worktrees_are_offered_once_and_then_stay_quiet() {
    let (tmp, mut e) = engine();
    let wt_path = tmp.path().join("agent-8f21");
    std::fs::create_dir(&wt_path).unwrap();
    let wt = wt_path.to_string_lossy().to_string();
    assert!(e.add_repo("/repo/main"));
    e.store_git_info(
        "/repo/main",
        crate::git_info::GitInfo { linked_worktree_dirs: vec![wt.clone()], ..Default::default() },
        1000,
    );
    e.store_git_info(&wt, git_info("agent/8f21"), 1000);

    let found = e.unrecorded_worktrees();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].dir, wt);
    assert_eq!(found[0].repo_root, "/repo/main");
    assert_eq!(found[0].branch.as_deref(), Some("agent/8f21"));

    e.set_task_worktrees(vec![record("/repo/main", &wt, tt_store::TaskKind::Detected)]);
    assert!(e.unrecorded_worktrees().is_empty(), "already recorded — nothing to write");
}

/// The gap the second candidate source closes: git prunes a registration, the
/// directory stays, and a git-only list can never offer that checkout again.
#[test]
fn a_checkout_git_has_forgotten_is_still_offered() {
    let (tmp, mut e) = engine();
    let root = tmp.path().join("repo");
    let wt = tt_tasks::worktrees_dir(&root).join("feat-orphan");
    std::fs::create_dir_all(&wt).unwrap();
    let root_s = root.to_string_lossy().to_string();
    assert!(e.add_repo(&root_s));

    let found = e.unrecorded_worktrees();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].dir, wt.to_string_lossy());
    assert_eq!(found[0].repo_root, root_s);
    assert_eq!(found[0].branch, None, "nothing can name a branch git forgot");
}

/// Both sources report every *healthy* worktree, so dedup is the common path.
#[test]
fn a_worktree_both_sources_report_is_offered_once() {
    let (tmp, mut e) = engine();
    let root = tmp.path().join("repo");
    let wt = tt_tasks::worktrees_dir(&root).join("feat-thing");
    std::fs::create_dir_all(&wt).unwrap();
    let (root_s, wt_s) = (root.to_string_lossy().to_string(), wt.to_string_lossy().to_string());
    assert!(e.add_repo(&root_s));
    e.store_git_info(
        &root_s,
        crate::git_info::GitInfo { linked_worktree_dirs: vec![wt_s.clone()], ..Default::default() },
        1000,
    );
    e.store_git_info(&wt_s, git_info("feat/thing"), 1000);

    let found = e.unrecorded_worktrees();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].branch.as_deref(), Some("feat/thing"));
}

/// The deleted-task flap: offering a gone directory mints a record,
/// `vanished_detected_records` forgets it next tick, and it mints again.
#[test]
fn a_vanished_worktree_is_never_offered_as_unrecorded() {
    let (tmp, mut e) = engine();
    let live = tmp.path().join("still-here");
    std::fs::create_dir(&live).unwrap();
    let live_s = live.to_string_lossy().to_string();
    let gone = "/repo/main/.claude/worktrees/feat-deleted";
    assert!(e.add_repo("/repo/main"));
    e.store_git_info(
        "/repo/main",
        crate::git_info::GitInfo {
            linked_worktree_dirs: vec![gone.to_string(), live_s.clone()],
            ..Default::default()
        },
        1000,
    );

    let found = e.unrecorded_worktrees();
    assert_eq!(found.iter().map(|w| w.dir.as_str()).collect::<Vec<_>>(), vec![live_s.as_str()]);

    e.set_task_worktrees(vec![record("/repo/main", gone, tt_store::TaskKind::Detected)]);
    assert_eq!(e.vanished_detected_records(), vec![gone.to_string()]);
    e.set_task_worktrees(vec![]);
    assert!(
        !e.unrecorded_worktrees().iter().any(|w| w.dir == gone),
        "forgetting a vanished record must not re-offer it — that is the flap"
    );
}

/// A tracked worktree is a `Checkout` row; recording it gives two records.
#[test]
fn a_tracked_worktree_is_never_offered_as_unrecorded() {
    let (_tmp, mut e) = engine();
    let wt = "/repo/main/.claude/worktrees/tracked";
    assert!(e.add_repo("/repo/main"));
    assert!(e.add_repo(wt));
    e.store_git_info(
        "/repo/main",
        crate::git_info::GitInfo {
            linked_worktree_dirs: vec![wt.to_string()],
            ..Default::default()
        },
        1000,
    );
    assert!(e.unrecorded_worktrees().is_empty());
    assert_eq!(e.watch_targets(), vec!["/repo/main".to_string(), wt.to_string()]);
}

/// The one case where the filesystem retires a record.
#[test]
fn vanished_detected_records_are_reported_for_cleanup() {
    let (tmp, mut e) = engine();
    let live = tmp.path().join("live-worktree");
    let live_s = live.to_string_lossy().to_string();
    std::fs::create_dir(&live).unwrap();
    let gone = "/repo/main/.claude/worktrees/agent-gone";
    assert!(e.add_repo("/repo/main"));
    e.set_task_worktrees(vec![
        record("/repo/main", &live_s, tt_store::TaskKind::Detected),
        record("/repo/main", gone, tt_store::TaskKind::Detected),
    ]);

    assert_eq!(e.vanished_detected_records(), vec![gone.to_string()]);
}

#[test]
fn store_git_info_reports_change_only_on_a_real_difference() {
    let (_tmp, mut e) = engine();
    assert!(e.store_git_info("/repo/x", git_info("main"), 1000));
    assert!(!e.store_git_info("/repo/x", git_info("main"), 1100));
    assert!(e.store_git_info("/repo/x", git_info("feat"), 1200));
}

#[test]
fn warm_git_cache_is_true_iff_any_entry_changed() {
    let (_tmp, mut e) = engine();
    e.store_git_info("/repo/x", git_info("main"), 1000);

    let changed = e.warm_git_cache(
        vec![
            ("/repo/x".to_string(), git_info("main")), // unchanged
            ("/repo/y".to_string(), git_info("main")), // new dir → changed
        ],
        1100,
    );
    assert!(changed);
}

/// Both poll loops call `stale_git_targets` against the same repo set; without
/// the claim they hand back the same dir, doubling every `git` chain.
#[test]
fn stale_git_targets_does_not_hand_out_a_dir_twice_before_it_is_stored() {
    let (_tmp, mut e) = engine();
    e.add_repo("/repo/x");

    let first = e.stale_git_targets(1000);
    assert_eq!(first.len(), 1, "the only tracked dir is stale on first check");

    let second = e.stale_git_targets(1010);
    assert!(second.is_empty(), "a claimed dir is withheld from a concurrent caller");

    e.store_git_info("/repo/x", git_info("main"), 1010);
    assert!(e.stale_git_targets(1020).is_empty());
}

/// A caller that never stores back must not drop its dir from the rotation.
#[test]
fn a_claim_no_one_released_self_expires_past_the_guard_window() {
    let (_tmp, mut e) = engine();
    e.add_repo("/repo/x");

    let first = e.stale_git_targets(1000);
    assert_eq!(first.len(), 1);
    assert!(
        e.stale_git_targets(1000 + GIT_PENDING_GUARD_MS - 1).is_empty(),
        "still within the guard window"
    );
    let recovered = e.stale_git_targets(1000 + GIT_PENDING_GUARD_MS);
    assert_eq!(recovered.len(), 1, "the claim expired, so the dir is eligible again");
}

/// The fleet's whole fetch bill was one flat cadence over every tracked
/// repo. A fork nobody has opened must not cost what a live task costs.
#[test]
fn fetch_tiers_by_activity_so_an_idle_repo_stops_costing_a_live_one() {
    let (_tmp, mut e) = engine();
    let now = 10_000_000_000;
    let touched =
        |ms: i64| crate::git_info::GitInfo { worktree_touched_ms: ms, ..Default::default() };
    for dir in ["/repo/live", "/repo/warm", "/repo/cold"] {
        e.add_repo(dir);
    }
    e.store_git_info("/repo/live", touched(now - 60_000), now);
    e.store_git_info("/repo/warm", touched(now - 6 * 60 * 60 * 1000), now);
    e.store_git_info("/repo/cold", touched(now - 40 * 24 * 60 * 60 * 1000), now);

    assert_eq!(e.fetch_targets(now).len(), 3, "everything is due on the first pass");

    // Three minutes on: only the active repo has earned another fetch.
    assert_eq!(e.fetch_targets(now + ACTIVE_FETCH_MS), vec!["/repo/live".to_string()]);
    // A quarter hour on: the recently-worked one joins it.
    let due = e.fetch_targets(now + RECENT_FETCH_MS);
    assert!(due.contains(&"/repo/live".to_string()) && due.contains(&"/repo/warm".to_string()));
    assert!(!due.contains(&"/repo/cold".to_string()), "40 days idle is not a 15-minute repo");
    // An hour on, the idle one finally comes round.
    assert!(e.fetch_targets(now + IDLE_FETCH_MS).contains(&"/repo/cold".to_string()));
}

/// An untouched checkout with a task open in it is the case the mtime
/// signal misses — the work is happening in the worktree, not the root.
#[test]
fn a_repo_with_a_task_worktree_keeps_the_active_cadence() {
    let (_tmp, mut e) = engine();
    let now = 10_000_000_000;
    e.add_repo("/repo/hosting");
    e.store_git_info("/repo/hosting", crate::git_info::GitInfo::default(), now);
    e.set_task_worktrees(vec![tt_store::RailWorktree {
        task_id: 1,
        kind: tt_store::TaskKind::Task,
        status: "running".into(),
        repo_root: "/repo/hosting".into(),
        dir: "/repo/hosting/.claude/worktrees/feat-x".into(),
        branch: Some("feat-x".into()),
        created_at: now,
    }]);

    assert_eq!(e.fetch_targets(now).len(), 1);
    assert_eq!(e.fetch_targets(now + ACTIVE_FETCH_MS), vec!["/repo/hosting".to_string()]);
}

/// The files pane is a live reader of exactly this number, so the repo it
/// is open on keeps the fast cadence however stale its mtimes look.
#[test]
fn the_repo_whose_files_pane_is_open_stays_on_the_active_cadence() {
    let (_tmp, mut e) = engine();
    let now = 10_000_000_000;
    e.add_repo("/repo/reading");
    e.store_git_info("/repo/reading", crate::git_info::GitInfo::default(), now);
    assert_eq!(e.fetch_targets(now).len(), 1);
    assert!(e.fetch_targets(now + ACTIVE_FETCH_MS).is_empty(), "idle without the pane");

    e.set_folder_focus("/repo/reading", true);
    assert_eq!(e.fetch_targets(now + ACTIVE_FETCH_MS), vec!["/repo/reading".to_string()]);
}

/// Nobody is reading "behind main" while the window is in the background.
#[test]
fn an_unfocused_window_stretches_every_fetch_tier() {
    let (_tmp, mut e) = engine();
    let now = 10_000_000_000;
    e.add_repo("/repo/live");
    e.store_git_info(
        "/repo/live",
        crate::git_info::GitInfo { worktree_touched_ms: now, ..Default::default() },
        now,
    );
    assert_eq!(e.fetch_targets(now).len(), 1);

    e.set_window_focused(false);
    assert!(e.fetch_targets(now + ACTIVE_FETCH_MS).is_empty(), "backgrounded, so not yet");
    assert_eq!(e.fetch_targets(now + ACTIVE_FETCH_MS * UNFOCUSED_FETCH_MULT).len(), 1);
}

/// Coming back to the window must not serve rows up to five minutes old.
#[test]
fn refocusing_invalidates_rather_than_serving_a_background_ttl() {
    let (_tmp, mut e) = engine();
    let now = 10_000_000_000;
    e.store_git_info("/repo/a", git_info("main"), now);
    assert!(e.set_window_focused(false));
    assert!(e.git_cache.is_fresh("/repo/a", now + 90_000), "background widens the ceiling");

    assert!(e.set_window_focused(true));
    assert!(!e.git_cache.is_fresh("/repo/a", now + 90_000), "refocus invalidates");
    assert!(!e.set_window_focused(true), "no move, no second invalidation");
}

/// Switching folders mounts the new pane before the old one's cleanup; that
/// late release must not take the new pane's ceiling.
#[test]
fn releasing_folder_focus_late_does_not_steal_the_new_panes_ceiling() {
    let (_tmp, mut e) = engine();
    let now = 10_000_000;
    e.store_git_info("/repo/a", git_info("main"), now);
    e.store_git_info("/repo/b", git_info("main"), now);

    assert!(e.set_folder_focus("/repo/a", true));
    assert!(e.set_folder_focus("/repo/b", true), "the replacement claims it");
    assert!(!e.set_folder_focus("/repo/a", false), "the departing pane's late cleanup");
    assert_eq!(e.git_cache.focused_dir(), Some("/repo/b"));

    assert!(e.set_folder_focus("/repo/b", false));
    assert_eq!(e.git_cache.focused_dir(), None);
}

/// Opening a pane is somebody reading the row: the counts must be fresh.
#[test]
fn claiming_folder_focus_invalidates_so_the_next_tick_recomputes() {
    let (_tmp, mut e) = engine();
    let now = 10_000_000;
    e.store_git_info("/repo/x", git_info("main"), now);
    assert!(e.git_cache.is_fresh("/repo/x", now));

    e.set_folder_focus("/repo/x", true);
    assert!(!e.git_cache.is_fresh("/repo/x", now));
}

#[test]
fn set_folder_base_branch_change_detects_and_invalidates_git_cache() {
    let (_tmp, mut e) = engine();
    // A `now` past the TTL: `invalidate` stamps ts=0, stale only from there.
    let now = 10_000_000;
    e.store_git_info("/repo/x", git_info("main"), now);
    assert!(e.git_cache.is_fresh("/repo/x", now));

    // A new base branch marks the old baseline's stats stale.
    assert!(e.set_folder_base_branch("/repo/x", Some("develop")));
    assert!(!e.git_cache.is_fresh("/repo/x", now));

    assert!(!e.set_folder_base_branch("/repo/x", Some("develop")));
    assert!(e.set_folder_base_branch("/repo/x", None));
}

#[test]
fn a_pr_merging_elsewhere_retargets_the_folder_until_the_user_overrides_it() {
    let (_tmp, mut e) = engine();
    let now = 10_000_000;
    assert!(e.add_repo("/repo/x"));
    let info = crate::git_info::GitInfo {
        origin_url: Some("git@github.com:o/repo.git".to_string()),
        ..git_info("feat/wow")
    };
    e.store_git_info("/repo/x", info, now);
    let merged = tt_store::PrItem {
        repo: "o/repo".to_string(),
        number: 83,
        title: String::new(),
        branch: "feat/wow".to_string(),
        state: "merged".to_string(),
        checks: String::new(),
        review_state: String::new(),
        url: String::new(),
        updated_ts: 0,
        dismissed_ts: 0,
        base_branch: "main".to_string(),
    };

    e.set_prs(vec![merged.clone()]);
    assert!(!e.git_cache.is_fresh("/repo/x", now));
    assert_eq!(e.effective_base("/repo/x").as_deref(), Some("main"));

    e.store_git_info("/repo/x", e.git_cache.get("/repo/x"), now);
    e.set_prs(vec![merged]);
    assert!(e.git_cache.is_fresh("/repo/x", now), "an unchanged PR list re-probes nothing");

    e.set_folder_base_branch("/repo/x", Some("develop"));
    assert_eq!(e.effective_base("/repo/x").as_deref(), Some("develop"));
}

#[test]
fn home_row_leads_the_rail_keeps_its_sessions_and_is_never_a_git_target() {
    let (_tmp, mut e) = engine();
    e.home_dir = Some("/home/u".into());
    assert!(e.add_repo("/home/u/code/a"));
    let s = e.add_session("/home/u", None, 1000);

    let payload = e.compute_payload(1001);
    let dirs: Vec<&str> = payload.repos.iter().map(|r| r.dir.as_str()).collect();
    assert_eq!(dirs, ["/home/u", "/home/u/code/a"]);
    let home = &payload.repos[0].folders[0];
    assert_eq!(home.record, RowRecord::Home);
    assert_eq!(home.sessions.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), [s.id]);

    let git: Vec<String> = e.stale_git_targets(1002).into_iter().map(|t| t.0).collect();
    assert_eq!(git, ["/home/u/code/a"]);
    assert!(e.control_watch_files().values().all(|d| d != "/home/u"));
}

#[test]
fn tracking_home_as_a_repo_replaces_the_home_row() {
    let (_tmp, mut e) = engine();
    e.home_dir = Some("/home/u".into());
    assert!(e.add_repo("/home/u"));
    let payload = e.compute_payload(1000);
    assert_eq!(payload.repos.len(), 1);
    assert_eq!(payload.repos[0].folders[0].record, RowRecord::Checkout);
}

#[test]
fn set_collapsed_and_set_folder_quiet_report_only_real_changes() {
    let (_tmp, mut e) = engine();
    assert!(e.set_collapsed("row-1", true));
    assert!(!e.set_collapsed("row-1", true));
    assert!(e.set_collapsed("row-1", false));

    let one = [String::from("/repo/x")];
    assert!(e.set_folder_quiet(&one, true));
    assert!(!e.set_folder_quiet(&one, true));
    assert!(e.set_folder_quiet(&one, false));
}

/// Marking a repo means the root checkout *and* its worktrees: changed if any
/// member is, so a half-marked repo still reports and persists the rest.
#[test]
fn set_folder_quiet_marks_every_dir_it_is_given() {
    let (_tmp, mut e) = engine();
    let root = String::from("/repo");
    let worktree = String::from("/repo/.claude/worktrees/task");

    assert!(e.set_folder_quiet(std::slice::from_ref(&root), true));
    assert!(e.set_folder_quiet(&[root.clone(), worktree.clone()], true));
    assert!(e.folder_meta.quiet_for(&root));
    assert!(e.folder_meta.quiet_for(&worktree));

    assert!(e.set_folder_quiet(&[root.clone(), worktree.clone()], false));
    assert!(!e.folder_meta.quiet_for(&root));
    assert!(!e.folder_meta.quiet_for(&worktree));
}
