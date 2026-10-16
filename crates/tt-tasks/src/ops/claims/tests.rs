use std::net::TcpListener;

use super::*;

fn root_with_tasks(tasks: &[&str]) -> (tempfile::TempDir, TaskRoot) {
    let tmp = tempfile::tempdir().unwrap();
    let checkout = tmp.path().join("repo");
    fs::create_dir_all(checkout.join(".git")).unwrap();
    let sr = TaskRoot { checkout, repo: "repo".to_string() };
    for task in tasks {
        fs::create_dir_all(sr.task_dir(task)).unwrap();
    }
    (tmp, sr)
}

fn pairs(ports: &[(&str, u16)]) -> Vec<(String, u16)> {
    ports.iter().map(|&(var, port)| (var.to_string(), port)).collect()
}

fn registry_path(sr: &TaskRoot) -> PathBuf {
    sr.checkout.parent().unwrap().join(PORT_REGISTRY_FILE)
}

/// A port nothing listens on right now.
fn free_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port()
}

#[test]
fn keyed_filename_names_the_repo_and_separates_same_named_checkouts() {
    let a = checkout_keyed_filename(Path::new("/w/api"), "x.json");
    let b = checkout_keyed_filename(Path::new("/p/api"), "x.json");
    assert!(a.starts_with("api-") && a.ends_with("-x.json"), "{a}");
    assert_ne!(a, b);
    assert_eq!(a, checkout_keyed_filename(Path::new("/w/api"), "x.json"));
}

#[test]
fn port_occupied_sees_an_ipv4_listener() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    assert!(port_occupied(port));
}

#[test]
fn the_claim_lock_excludes_a_second_holder_until_dropped() {
    let (_tmp, sr) = root_with_tasks(&[]);
    let lock = ClaimLock::acquire(&sr.checkout).unwrap();

    let probe = fs::OpenOptions::new().write(true).open(claim_lock_path(&sr.checkout)).unwrap();
    assert!(matches!(probe.try_lock(), Err(std::fs::TryLockError::WouldBlock)));

    drop(lock);
    assert!(probe.try_lock().is_ok(), "the lock must release on drop");
    assert!(claim_lock_path(&sr.checkout).exists(), "the lock file stays on disk");
}

#[test]
fn a_missing_or_corrupt_registry_reads_as_empty() {
    let (_tmp, sr) = root_with_tasks(&[]);
    let reg = registry_path(&sr);
    assert!(load_port_registry(&reg).ports.is_empty());

    fs::write(&reg, "{ not json").unwrap();
    let loaded = load_port_registry(&reg);
    assert!(loaded.ports.is_empty() && loaded.checkout.is_empty());
}

#[test]
fn two_tasks_hold_disjoint_claims_and_each_sees_only_the_others() {
    let (_tmp, sr) = root_with_tasks(&["feat-a", "feat-b"]);
    let reg = registry_path(&sr);
    record_task_ports(&sr, &reg, "feat-a", &pairs(&[("UI_PORT", 4101)]), 1).unwrap();
    record_task_ports(&sr, &reg, "feat-b", &pairs(&[("UI_PORT", 4102), ("API_PORT", 4103)]), 2)
        .unwrap();

    assert_eq!(registry_claims(&sr, &reg, "feat-a"), BTreeSet::from([4102, 4103]));
    assert_eq!(registry_claims(&sr, &reg, "feat-b"), BTreeSet::from([4101]));
}

#[test]
fn a_later_claim_on_the_same_port_takes_it_over() {
    let (_tmp, sr) = root_with_tasks(&["feat-a", "feat-b"]);
    let reg = registry_path(&sr);
    record_task_ports(&sr, &reg, "feat-a", &pairs(&[("UI_PORT", 4201)]), 1).unwrap();
    record_task_ports(&sr, &reg, "feat-b", &pairs(&[("UI_PORT", 4201)]), 2).unwrap();

    let claim = &load_port_registry(&reg).ports[&4201];
    assert_eq!((claim.owner.as_str(), claim.claimed_at_ms), ("feat-b", 2));
}

#[test]
fn the_primary_checkout_counts_as_alive_without_a_task_dir() {
    let (_tmp, sr) = root_with_tasks(&[]);
    let reg = registry_path(&sr);
    record_task_ports(&sr, &reg, "repo", &pairs(&[("UI_PORT", 4301)]), 1).unwrap();
    assert_eq!(registry_claims(&sr, &reg, "feat-a"), BTreeSet::from([4301]));
}

#[test]
fn pruning_a_vanished_owner_is_persisted_and_spares_the_living() {
    let (_tmp, sr) = root_with_tasks(&["feat-keep", "feat-gone"]);
    let reg = registry_path(&sr);
    record_task_ports(&sr, &reg, "feat-keep", &pairs(&[("UI_PORT", 4401)]), 1).unwrap();
    record_task_ports(&sr, &reg, "feat-gone", &pairs(&[("UI_PORT", 4402)]), 1).unwrap();
    fs::remove_dir_all(sr.task_dir("feat-gone")).unwrap();

    assert_eq!(registry_claims(&sr, &reg, "x"), BTreeSet::from([4401]));
    let on_disk = load_port_registry(&reg);
    assert_eq!(on_disk.ports.keys().copied().collect::<Vec<_>>(), [4401]);
}

#[test]
fn releasing_when_nothing_is_recorded_creates_no_registry() {
    let (_tmp, sr) = root_with_tasks(&["feat-a"]);
    let reg = registry_path(&sr);
    release_task_ports(&sr.checkout, &reg, "feat-a");
    assert!(!reg.exists());
}

#[test]
fn releasing_a_task_leaves_its_neighbours_claims() {
    let (_tmp, sr) = root_with_tasks(&["feat-a", "feat-b"]);
    let reg = registry_path(&sr);
    record_task_ports(&sr, &reg, "feat-a", &pairs(&[("UI_PORT", 4501)]), 1).unwrap();
    record_task_ports(&sr, &reg, "feat-b", &pairs(&[("UI_PORT", 4502)]), 1).unwrap();

    release_task_ports(&sr.checkout, &reg, "feat-a");
    assert_eq!(registry_claims(&sr, &reg, "x"), BTreeSet::from([4502]));
}

#[test]
fn the_report_merges_env_and_registry_and_marks_the_source() {
    let (_tmp, sr) = root_with_tasks(&["feat-env", "feat-both", "feat-reg", "feat-dead"]);
    let (env_only, both, reg_only, dead) = (free_port(), free_port(), free_port(), free_port());
    let all = [env_only, both, reg_only, dead];
    assert_eq!(all.iter().collect::<BTreeSet<_>>().len(), 4, "ports must be distinct");

    fs::write(sr.task_dir("feat-env").join(".env"), format!("UI_PORT={env_only}\n")).unwrap();
    fs::write(sr.task_dir("feat-both").join(".env"), format!("API_PORT={both}\n")).unwrap();

    let ports_dir = sr.checkout.parent().unwrap().join("ports");
    let reg = port_registry_path(&sr.checkout, Some(&ports_dir)).unwrap();
    record_task_ports(&sr, &reg, "feat-both", &pairs(&[("API_PORT", both)]), 99).unwrap();
    record_task_ports(&sr, &reg, "feat-reg", &pairs(&[("UI_PORT", reg_only)]), 55).unwrap();
    record_task_ports(&sr, &reg, "feat-dead", &pairs(&[("UI_PORT", dead)]), 1).unwrap();
    fs::remove_dir_all(sr.task_dir("feat-dead")).unwrap();

    let report = port_report_in(&sr, Some(&ports_dir));
    let row = |port: u16| report.iter().find(|r| r.port == port);
    let env_row = row(env_only).unwrap();
    assert_eq!(
        (env_row.source, env_row.owner.as_str(), env_row.claimed_at_ms),
        ("env", "feat-env", 0)
    );
    let both_row = row(both).unwrap();
    assert_eq!((both_row.source, both_row.claimed_at_ms), ("env+registry", 99));
    let reg_row = row(reg_only).unwrap();
    assert_eq!(
        (reg_row.source, reg_row.var.as_str(), reg_row.claimed_at_ms),
        ("registry", "UI_PORT", 55)
    );
    assert!(row(dead).is_none(), "a vanished owner's claim is not reported");
    assert!(report.windows(2).all(|w| w[0].port < w[1].port), "rows are ordered by port");
}

#[test]
fn the_report_probes_each_port_for_a_listener() {
    let (_tmp, sr) = root_with_tasks(&["feat-a"]);
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let held = listener.local_addr().unwrap().port();
    fs::write(sr.task_dir("feat-a").join(".env"), format!("UI_PORT={held}\n")).unwrap();

    let report = port_report(&sr);
    assert!(report.iter().find(|r| r.port == held).unwrap().occupied);
}
