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

fn ephemeral_range_start() -> u16 {
    std::fs::read_to_string("/proc/sys/net/ipv4/ip_local_port_range")
        .ok()
        .and_then(|s| s.split_whitespace().next()?.parse().ok())
        .unwrap_or(32768)
}

/// Bind a listener *below* the ephemeral range, so the kernel can't hand
/// this port to an unrelated `bind(0)` while the test is mid-flight.
fn bind_below_ephemeral_range() -> Option<(std::net::TcpListener, u16)> {
    let start = ephemeral_range_start();
    (1024..start)
        .rev()
        .take(500)
        .find_map(|port| std::net::TcpListener::bind(("127.0.0.1", port)).ok())
        .map(|listener| {
            let port = listener.local_addr().expect("bound listener has an addr").port();
            (listener, port)
        })
}

#[test]
fn port_listening_tracks_a_real_listener() {
    let Some((listener, port)) = bind_below_ephemeral_range() else {
        return;
    };
    assert!(port_listening(port), "a bound listener must read as listening");
    drop(listener);

    // `drop` closes *our* descriptor, not necessarily the socket: a
    // subprocess forked while the listener was open inherits a duplicate
    // and holds it in LISTEN. So the honest assertion is that the port
    // frees up promptly, not that it is free the instant we let go.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while port_listening(port) {
        assert!(
            std::time::Instant::now() < deadline,
            "port {port} still listening 10s after its listener was dropped"
        );
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
}

#[test]
fn an_outbound_connections_source_port_is_occupied_but_not_listening() {
    // The false "port in use" that blocked deletes: a claimed port the kernel
    // handed out as some connection's ephemeral source port refuses a bind,
    // yet nothing listens there for the removal guard to stop.
    let server = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let client = std::net::TcpStream::connect(server.local_addr().unwrap()).unwrap();
    let source = client.local_addr().unwrap().port();
    assert!(port_occupied(source));
    assert!(!port_listening(source));
}

#[test]
fn the_socket_table_counts_only_listen_rows_on_the_port() {
    let table = "  sl  local_address rem_address   st tx_queue\n\
   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000\n\
   1: 0100007F:BB00 0100007F:1144 06 00000000:00000000\n";
    assert!(table_has_listener(table, 3000), "LISTEN on 0.0.0.0:3000");
    assert!(!table_has_listener(table, 0xBB00), "TIME_WAIT source port is not a listener");
    assert!(!table_has_listener(table, 4420));
}
