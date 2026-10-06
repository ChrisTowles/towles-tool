//! The binary end to end, against a repository committed with `gix` so no
//! `git` is needed to build the fixture.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn debt(comments: usize, code: usize) -> String {
    let mut s = String::new();
    for i in 0..comments {
        s.push_str("// c\n");
        if i % 4 == 3 {
            s.push_str("fn a() {}\n");
        }
    }
    s + &"fn a() {}\n".repeat(code - comments / 4)
}

/// A repository whose `HEAD` commit holds `files` at its root.
fn committed(name: &str, files: &[(&str, &str)]) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(name);
    let _ = fs::remove_dir_all(&dir);
    let mut repo = gix::init(&dir).expect("init");
    {
        let mut config = repo.config_snapshot_mut();
        config.set_raw_value("user.name", "t").expect("name");
        config.set_raw_value("user.email", "t@example.com").expect("email");
    }
    let mut entries: Vec<gix::objs::tree::Entry> = files
        .iter()
        .map(|(rel, body)| {
            fs::write(dir.join(rel), body).expect("write");
            gix::objs::tree::Entry {
                mode: gix::objs::tree::EntryKind::Blob.into(),
                filename: (*rel).into(),
                oid: repo.write_blob(body.as_bytes()).expect("blob").detach(),
            }
        })
        .collect();
    entries.sort_by(|a, b| a.filename.cmp(&b.filename));
    let tree = repo.write_object(gix::objs::Tree { entries }).expect("tree").detach();
    repo.commit("HEAD", "base", tree, gix::commit::NO_PARENT_IDS).expect("commit");
    dir
}

fn run(dir: &Path, args: &[&str]) -> (i32, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_comment-budget"))
        .args(args)
        .current_dir(dir)
        .env_remove("GITHUB_BASE_REF")
        .output()
        .expect("run");
    (out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).into_owned())
}

#[test]
fn old_debt_passes_and_growing_it_fails() {
    let dir = committed("ratchet-growth", &[("a.rs", &debt(20, 40))]);
    fs::write(dir.join("a.rs"), debt(20, 40) + "fn b() {}\n").expect("edit");
    assert_eq!(run(&dir, &["HEAD"]).0, 0, "touching a file does not make its debt yours");

    fs::write(dir.join("a.rs"), debt(28, 40)).expect("grow");
    let (code, out) = run(&dir, &["HEAD"]);
    assert_eq!(code, 1, "{out}");
    assert!(
        out.contains("error a.rs: 21 comment lines over the 15% budget, up 8 from 13"),
        "{out}"
    );
}

#[test]
fn an_untracked_file_is_judged_as_new() {
    let dir = committed("ratchet-new", &[("a.rs", "fn a() {}\n")]);
    fs::write(dir.join("b.ts"), "// x\n".repeat(13) + "let b = 1;\n").expect("new file");
    let (code, out) = run(&dir, &["HEAD"]);
    assert_eq!(code, 1, "{out}");
    assert!(out.contains("error b.ts:1-13: a 13-line comment block, new or grown"), "{out}");
}

#[test]
fn a_moved_file_is_unchanged() {
    let dir = committed("ratchet-move", &[("a.rs", &debt(60, 40))]);
    fs::rename(dir.join("a.rs"), dir.join("moved.rs")).expect("move");
    let (code, out) = run(&dir, &["HEAD"]);
    assert_eq!(code, 0, "{out}");
}

#[test]
fn all_judges_every_file_from_zero() {
    let dir = committed("ratchet-all", &[("a.rs", &debt(60, 40)), ("b.rs", "fn b() {}\n")]);
    let (code, out) = run(&dir, &["--all"]);
    assert_eq!(code, 1, "{out}");
    assert!(out.contains("error a.rs:"), "{out}");
    assert!(out.contains("2 file(s) in the repository, 1 failure(s)"), "{out}");
}

#[test]
fn a_bad_invocation_exits_two() {
    let dir = committed("ratchet-args", &[("a.rs", "fn a() {}\n")]);
    assert_eq!(run(&dir, &["--all", "main"]).0, 2);
    assert_eq!(run(&dir, &["--config", "x.toml"]).0, 2);
    assert_eq!(run(&dir, &["no-such-branch"]).0, 2);
}
