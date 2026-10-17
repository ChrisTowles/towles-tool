//! Black-box tests for `tt task clean` against a real checkout in a tempdir
//! (nested `.claude/worktrees/<name>` tasks). Every invocation fakes
//! HOME/XDG_DATA_HOME: clean sweeps the machine's instance-state tree and
//! prunes the real agentboard store, so an unfaked run would mutate the
//! developer's actual state.

mod common;

use common::{Tt, canonical_temp, data_home, tt_in};
use std::path::{Path, PathBuf};

fn git(dir: &Path, args: &[&str]) {
    tt_git::testing::git(dir, args);
}

/// A `tt` command with the state tree sandboxed under `home`.
fn tt(home: &Path) -> Tt {
    let mut cmd = tt_in(home);
    cmd.env_remove(tt_config::STATE_SCOPE_ENV);
    cmd
}

/// The task dir for `name` under the checkout: `.claude/worktrees/<name>`.
fn task_dir(checkout: &Path, name: &str) -> PathBuf {
    checkout.join(".claude").join("worktrees").join(name)
}

/// A port pool no other test in this binary will touch, kept below the ephemeral
/// range (32768-60999). `port_occupied` answers by binding, so a shared pool makes
/// tests read each other's probes as phantom listeners — see `task_commands.rs`'s
/// `next_pool` for the full mechanism.
fn next_pool() -> String {
    static NEXT: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(26410);
    let lo = NEXT.fetch_add(30, std::sync::atomic::Ordering::Relaxed);
    assert!(lo + 30 < 32768, "test port pools have grown into the ephemeral range");
    format!("{lo}-{}", lo + 29)
}

/// Build `<tmp>/demo` like the task lifecycle tests, but with a committed
/// `crates/tt-config/` marker so the checkouts derive state scopes (`demo`,
/// `demo-<task>`) and the sweep has something to key on.
fn make_checkout(tmp: &Path) -> PathBuf {
    let seed = tmp.join("seed");
    std::fs::create_dir_all(seed.join("crates").join("tt-config")).unwrap();
    git(tmp, &["init", "seed"]);
    std::fs::write(seed.join(".env.example"), format!("UI_PORT=${{tt:port {}}}\n", next_pool()))
        .unwrap();
    std::fs::write(seed.join(".gitignore"), ".env\n").unwrap();
    std::fs::write(seed.join("crates").join("tt-config").join(".gitkeep"), "").unwrap();
    git(&seed, &["add", "."]);
    git(&seed, &["commit", "-m", "seed"]);

    git(tmp, &["clone", "seed", "demo"]);
    tmp.join("demo")
}

fn new_task(home: &Path, root: &str, branch: &str) {
    tt(home).args(["task", "new", branch, "--repo", root, "-b", branch]).assert().success();
}

fn commit_file(task: &Path, name: &str) {
    std::fs::write(task.join(name), "work").unwrap();
    git(task, &["add", name]);
    git(task, &["commit", "-m", name]);
}

fn branch_exists(checkout: &Path, branch: &str) -> bool {
    !tt_git::testing::git(checkout, &["branch", "--list", branch]).is_empty()
}

fn clean_json(home: &Path, root: &str, extra: &[&str]) -> serde_json::Value {
    let mut args = vec!["task", "clean", "--json", "--root", root];
    args.extend_from_slice(extra);
    let out = tt(home).args(&args).output().unwrap();
    assert!(out.status.success(), "clean failed: {}", String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(&out.stdout).expect("clean --json emits JSON")
}

#[test]
fn clean_removes_merged_task_and_sweeps_state_keeps_the_rest() {
    let (_guard, tmp) = canonical_temp();
    let home = tmp.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let checkout = make_checkout(&tmp);
    let root_s = checkout.to_string_lossy().to_string();

    // done: committed and classically merged into main → finished.
    new_task(&home, &root_s, "feat/done");
    commit_file(&task_dir(&checkout, "feat-done"), "done.txt");
    git(&checkout, &["merge", "--no-ff", "feat/done", "-m", "merge done"]);

    // dirty-done: merged too, but the tree is dirty → guard keeps it.
    new_task(&home, &root_s, "feat/dirty-done");
    commit_file(&task_dir(&checkout, "feat-dirty-done"), "dd.txt");
    git(&checkout, &["merge", "--no-ff", "feat/dirty-done", "-m", "merge dd"]);
    std::fs::write(task_dir(&checkout, "feat-dirty-done").join("junk.txt"), "wip").unwrap();

    // fresh: created from the current tip, no commits → not finished.
    new_task(&home, &root_s, "feat/fresh");

    // wip: has its own unmerged commit → active.
    new_task(&home, &root_s, "feat/wip");
    commit_file(&task_dir(&checkout, "feat-wip"), "wip.txt");

    // Instance-state dirs: the removed task's scope, an old orphan, a live
    // task's scope, and a foreign repo's scope.
    let data_tasks = data_home(&home).join("towles-tool").join("tasks");
    let cfg_tasks = home.join(".config/towles-tool/tasks");
    for dir in [
        data_tasks.join("demo-feat-done"),
        data_tasks.join("demo-stale-old"),
        data_tasks.join("demo-feat-wip"),
        data_tasks.join("blog-x"),
        cfg_tasks.join("demo-stale-cfg"),
    ] {
        std::fs::create_dir_all(&dir).unwrap();
    }

    // Unscoped agentboard store: one window on a live folder, one on a folder
    // that no longer exists.
    let ab = home.join(".config/towles-tool/agentboard");
    std::fs::create_dir_all(&ab).unwrap();
    let live = checkout.to_string_lossy().to_string();
    let dead = "/nonexistent-folder-xyz";
    std::fs::write(
        ab.join("sessions.json"),
        format!(
            r#"{{"folders":{{"{live}":[{{"id":"sa","name":"shell 1","createdAt":1}}],"{dead}":[{{"id":"sb","name":"shell 1","createdAt":2}}]}}}}"#
        ),
    )
    .unwrap();
    std::fs::write(
        ab.join("windows.json"),
        format!(
            r#"{{"windows":[{{"id":"w1","name":"primary","folderDir":"{live}","panes":["sa"]}},{{"id":"w2","name":"primary","folderDir":"{dead}","panes":["sb"]}}],"activeWindows":{{"{live}":"w1","{dead}":"w2"}}}}"#
        ),
    )
    .unwrap();

    let report = clean_json(&home, &root_s, &[]);

    // Only the merged-and-clean task goes; its branch goes with it.
    let removed: Vec<&str> =
        report["removed"].as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert_eq!(removed, vec!["feat-done"]);
    assert!(report["removed"][0]["reason"].as_str().unwrap().contains("merged into main"));
    assert!(!task_dir(&checkout, "feat-done").exists());
    assert!(!branch_exists(&checkout, "feat/done"));

    let kept: Vec<&str> =
        report["kept"].as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert_eq!(kept, vec!["feat-dirty-done", "feat-fresh", "feat-wip"]);
    let dd = &report["kept"][0];
    assert!(dd["why"][0].as_str().unwrap().contains("not clean"), "got {dd}");
    assert!(task_dir(&checkout, "feat-dirty-done").exists());
    assert!(task_dir(&checkout, "feat-fresh").exists());
    assert!(task_dir(&checkout, "feat-wip").exists());
    assert!(branch_exists(&checkout, "feat/wip"));

    // Sweep: our stale scopes go (including the just-removed task's), live and
    // foreign scopes stay.
    let swept: Vec<&str> =
        report["sweptStateDirs"].as_array().unwrap().iter().map(|p| p.as_str().unwrap()).collect();
    assert!(!data_tasks.join("demo-feat-done").exists(), "swept: {swept:?}");
    assert!(!data_tasks.join("demo-stale-old").exists());
    assert!(!cfg_tasks.join("demo-stale-cfg").exists());
    assert!(data_tasks.join("demo-feat-wip").exists(), "live task scope must survive");
    assert!(data_tasks.join("blog-x").exists(), "foreign repo scope must survive");

    // Agentboard store: the dead folder's window + session records are gone.
    let windows: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(ab.join("windows.json")).unwrap()).unwrap();
    let dirs: Vec<&str> = windows["windows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w["folderDir"].as_str().unwrap())
        .collect();
    assert_eq!(dirs, vec![live.as_str()]);
    assert!(windows["activeWindows"].get(dead).is_none());
    let sessions: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(ab.join("sessions.json")).unwrap()).unwrap();
    assert!(sessions["folders"].get(dead).is_none());
    assert!(sessions["folders"].get(&live).is_some());

    // A second run has nothing left to do.
    let report = clean_json(&home, &root_s, &[]);
    assert!(report["removed"].as_array().unwrap().is_empty());
    assert!(report["sweptStateDirs"].as_array().unwrap().is_empty());
    assert!(report["agentboard"].as_array().unwrap().is_empty());
}

#[test]
fn clean_removes_a_squash_merged_task_even_when_local_base_is_stale() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let checkout = make_checkout(tmp.path());
    let root_s = checkout.to_string_lossy().to_string();
    let seed = tmp.path().join("seed");

    // The real GitHub signature: the branch's content is squashed onto the
    // remote's main under a brand-new SHA and the remote branch is deleted.
    // The local `main` is never pulled, so this only resolves against
    // `origin/main` — and only the tree probe sees it, since neither
    // reachability nor `git cherry` matches a squashed commit.
    new_task(&home, &root_s, "feat/push");
    let task = task_dir(&checkout, "feat-push");
    commit_file(&task, "pushed.txt");
    commit_file(&task, "pushed2.txt");
    git(&task, &["push", "-u", "origin", "feat/push"]);
    git(&seed, &["merge", "--squash", "feat/push"]);
    git(&seed, &["commit", "-m", "squashed feat/push (#1)"]);
    git(&seed, &["branch", "-D", "feat/push"]);

    let report = clean_json(&home, &root_s, &[]);
    // Failure here means the squash went undetected. The reason the task was
    // kept, plus the state of the ref the detection actually depends on, is
    // the whole diagnosis — without it this reads as a bare
    // `Null != "feat-push"` with nothing to act on.
    let git_out = |dir: &Path, args: &[&str]| -> String {
        let out = tt_git::testing::git_output(dir, args);
        format!("{}{}", out.stdout.trim(), out.stderr.trim())
    };
    assert_eq!(
        report["removed"][0]["name"],
        "feat-push",
        "a squash-merged task must be cleaned\n  kept={}\n  warnings={}\n  origin/main={}\n  main={}",
        report["kept"],
        report["warnings"],
        git_out(
            &checkout,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                "refs/remotes/origin/main"
            ]
        ),
        git_out(&checkout, &["rev-parse", "--verify", "--quiet", "refs/heads/main"]),
    );
    let reason = report["removed"][0]["reason"].as_str().unwrap();
    assert!(reason.contains("squash-merged"), "reason should name how it landed, got {reason:?}");
    assert!(!task.exists());
    assert!(!branch_exists(&checkout, "feat/push"));
}

#[test]
fn clean_keeps_a_task_whose_remote_branch_vanished_without_merging() {
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let checkout = make_checkout(tmp.path());
    let root_s = checkout.to_string_lossy().to_string();

    // Identical to a merged PR from the outside — pushed, then the remote
    // branch disappeared — except the commit never reached main. `clean`
    // deletes branches, so treating a gone upstream as proof of merge would
    // destroy the only copy of this work.
    new_task(&home, &root_s, "feat/vanished");
    let task = task_dir(&checkout, "feat-vanished");
    commit_file(&task, "unmerged.txt");
    git(&task, &["push", "-u", "origin", "feat/vanished"]);
    git(&tmp.path().join("seed"), &["branch", "-D", "feat/vanished"]);

    let report = clean_json(&home, &root_s, &[]);
    assert!(
        report["removed"].as_array().unwrap().is_empty(),
        "work that never landed must not be cleaned"
    );
    let why = report["kept"][0]["why"][0].as_str().unwrap();
    assert!(why.contains("never reached"), "kept reason should explain, got {why:?}");
    assert!(task.exists());
    assert!(branch_exists(&checkout, "feat/vanished"), "the branch still holds the only copy");
}

#[test]
fn clean_dry_run_touches_nothing() {
    let (_guard, tmp) = canonical_temp();
    let home = tmp.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let checkout = make_checkout(&tmp);
    let root_s = checkout.to_string_lossy().to_string();

    new_task(&home, &root_s, "feat/done");
    commit_file(&task_dir(&checkout, "feat-done"), "done.txt");
    git(&checkout, &["merge", "--no-ff", "feat/done", "-m", "merge done"]);
    let stale = data_home(&home).join("towles-tool").join("tasks").join("demo-gone");
    std::fs::create_dir_all(&stale).unwrap();

    let report = clean_json(&home, &root_s, &["--dry-run"]);
    assert_eq!(report["dryRun"], true);
    assert_eq!(report["removed"][0]["name"], "feat-done");
    assert!(task_dir(&checkout, "feat-done").exists(), "dry run must not remove");
    assert!(branch_exists(&checkout, "feat/done"));
    assert!(stale.exists(), "dry run must not sweep");
    let swept: Vec<&str> =
        report["sweptStateDirs"].as_array().unwrap().iter().map(|p| p.as_str().unwrap()).collect();
    assert_eq!(swept.len(), 1, "reports the orphan scope: {swept:?}");
    assert!(swept[0].ends_with("demo-gone"));
}

/// Plant the app's WebKit dir, launcher and icon for `identifier` under the sandbox's
/// user data dir, returning the three paths.
#[cfg(target_os = "linux")]
fn plant_app_residue(home: &Path, identifier: &str) -> tt_config::HostPaths {
    let paths = tt_config::host_paths_in(&data_home(home), identifier);
    std::fs::create_dir_all(paths.webkit_data.join("localstorage")).unwrap();
    std::fs::write(paths.webkit_data.join("localstorage/db"), "12345").unwrap();
    for file in [&paths.launcher, &paths.icon] {
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, "x").unwrap();
    }
    paths
}

#[cfg(target_os = "linux")]
fn residue_exists(paths: &tt_config::HostPaths) -> bool {
    paths.all().iter().any(|p| p.exists())
}

#[cfg(target_os = "linux")]
#[test]
fn clean_sweeps_app_residue_of_gone_tasks_never_the_base_or_live_ones() {
    let (_guard, tmp) = canonical_temp();
    let home = tmp.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let checkout = make_checkout(&tmp);
    let root_s = checkout.to_string_lossy().to_string();

    new_task(&home, &root_s, "feat/done");
    commit_file(&task_dir(&checkout, "feat-done"), "done.txt");
    git(&checkout, &["merge", "--no-ff", "feat/done", "-m", "merge done"]);
    new_task(&home, &root_s, "feat/fresh");

    let base = plant_app_residue(&home, tt_config::APP_IDENTIFIER);
    let fresh = plant_app_residue(&home, "dev.towles.tool.task-feat-fresh");
    let done = plant_app_residue(&home, "dev.towles.tool.task-feat-done");
    let gone = plant_app_residue(&home, "dev.towles.tool.task-feat-gone");
    let old = plant_app_residue(&home, "dev.towles.tool.slot-feat-old");
    std::fs::remove_file(&gone.icon).unwrap();

    let dry = clean_json(&home, &root_s, &["--dry-run"]);
    let identifiers = |report: &serde_json::Value| -> Vec<String> {
        report["sweptHostResidue"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["identifier"].as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(
        identifiers(&dry),
        [
            "dev.towles.tool.slot-feat-old",
            "dev.towles.tool.task-feat-done",
            "dev.towles.tool.task-feat-gone",
        ]
    );
    let gone_entry = &dry["sweptHostResidue"][2];
    assert_eq!(gone_entry["bytes"], 6, "webkit file + launcher: {gone_entry}");
    assert_eq!(gone_entry["paths"].as_array().unwrap().len(), 2, "the icon was already gone");
    for planted in [&base, &fresh, &done, &gone, &old] {
        assert!(planted.all().iter().any(|p| p.exists()), "a dry run deletes nothing");
    }

    let report = clean_json(&home, &root_s, &[]);
    let removed = &report["removed"][0];
    assert_eq!(removed["name"], "feat-done");
    let notes = removed["messages"].to_string();
    assert!(notes.contains("removed app residue"), "removal reclaims its own: {notes}");
    assert!(!residue_exists(&done) && !residue_exists(&gone) && !residue_exists(&old));
    assert!(base.all().iter().all(|p| p.exists()), "the daily driver's data is untouchable");
    assert!(fresh.all().iter().all(|p| p.exists()), "a live task's data is untouchable");

    assert!(identifiers(&clean_json(&home, &root_s, &[])).is_empty(), "nothing left to sweep");
}

#[cfg(target_os = "linux")]
#[test]
fn rm_reclaims_the_removed_tasks_app_residue_only() {
    let (_guard, tmp) = canonical_temp();
    let home = tmp.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let checkout = make_checkout(&tmp);
    let root_s = checkout.to_string_lossy().to_string();
    new_task(&home, &root_s, "feat/rm-me");
    new_task(&home, &root_s, "feat/stay");

    let base = plant_app_residue(&home, tt_config::APP_IDENTIFIER);
    let stay = plant_app_residue(&home, "dev.towles.tool.task-feat-stay");
    let mine = plant_app_residue(&home, "dev.towles.tool.task-feat-rm-me");

    let out = tt(&home).args(["task", "rm", "feat-rm-me", "--root", &root_s]).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));

    assert!(!residue_exists(&mine));
    assert!(base.all().iter().all(|p| p.exists()));
    assert!(stay.all().iter().all(|p| p.exists()));
}
