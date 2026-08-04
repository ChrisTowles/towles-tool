//! The wrapper's `comment-budget` is the committed shim `pack.sh` packs into
//! the published tarball. An install inside the crate that overwrites it stages
//! a host binary as a source change — and ships one to every platform if that
//! is ever committed.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const FAKE_BINARY: &[u8] = b"#!/bin/sh\nexit 7\n";

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Node runs the wrapper, so a runner without it proves nothing. CI sets
/// REQUIRE_NODE to keep that silence from passing for a green test.
fn node() -> Option<&'static str> {
    let found =
        Command::new("node").arg("--version").output().is_ok_and(|out| out.status.success());
    if !found {
        if std::env::var_os("COMMENT_BUDGET_REQUIRE_NODE").is_some() {
            panic!("COMMENT_BUDGET_REQUIRE_NODE is set but node was not found");
        }
        eprintln!("skipping: node not found");
    }
    found.then_some("node")
}

fn scratch(name: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(name);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create scratch");
    dir
}

/// The wrapper's own files at `dir`, returning the shim they ship with.
fn stage(dir: &Path) -> PathBuf {
    fs::create_dir_all(dir).expect("mkdir");
    for name in ["postinstall.js", "comment-budget"] {
        fs::copy(crate_dir().join("npm/comment-budget").join(name), dir.join(name))
            .expect("copy wrapper file");
    }
    dir.join("comment-budget")
}

fn postinstall(node: &str, dir: &Path) {
    let out = Command::new(node).arg(dir.join("postinstall.js")).output().expect("run postinstall");
    assert!(out.status.success(), "postinstall failed: {}", String::from_utf8_lossy(&out.stderr));
}

/// A resolvable platform package beside the wrapper, so the only thing that can
/// spare the shim is the guard. Without it both tests pass on a wrapper with no
/// guard at all, having proved nothing. Named by asking the wrapper, so the
/// fixture is named the way the resolution under test names it.
fn plant_binary(node: &str, dir: &Path) -> bool {
    let script = format!(
        "const p = require({:?}).platformPackage(); if (p) console.log(p)",
        dir.join("postinstall.js").to_string_lossy()
    );
    let out = Command::new(node).arg("-e").arg(script).output().expect("ask for the package name");
    let pkg = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if pkg.is_empty() {
        eprintln!("skipping: no platform package for this host");
        return false;
    }
    let pkg_dir = dir.join("node_modules").join(pkg.replace('/', std::path::MAIN_SEPARATOR_STR));
    fs::create_dir_all(pkg_dir.join("bin")).expect("mkdir");
    fs::write(
        pkg_dir.join("package.json"),
        format!("{{\"name\":\"{pkg}\",\"version\":\"0.0.0\"}}"),
    )
    .expect("write platform manifest");
    fs::write(pkg_dir.join("bin/comment-budget"), FAKE_BINARY).expect("write binary");
    true
}

#[test]
fn an_install_inside_the_crate_leaves_the_shim_alone() {
    let Some(node) = node() else { return };
    let root = scratch("postinstall-source");
    let wrapper = root.join("npm/comment-budget");
    let shim = stage(&wrapper);
    fs::copy(crate_dir().join("Cargo.toml"), root.join("Cargo.toml")).expect("copy manifest");
    if !plant_binary(node, &wrapper) {
        return;
    }

    let before = fs::read(&shim).expect("read shim");
    postinstall(node, &wrapper);
    assert_eq!(fs::read(&shim).expect("read shim"), before, "the crate's shim was overwritten");
}

#[test]
fn an_install_anywhere_else_still_gets_the_binary() {
    let Some(node) = node() else { return };
    let root = scratch("postinstall-consumer");
    let shim = stage(&root);
    if !plant_binary(node, &root) {
        return;
    }

    postinstall(node, &root);
    assert_eq!(fs::read(&shim).expect("read shim"), FAKE_BINARY, "the guard disabled the install");
}
