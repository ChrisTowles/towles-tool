//! The wrapper's package.json is committed rather than stamped by `pack.sh`,
//! because the platform packages it depends on have to be pinned to an exact
//! version. That makes it the one copy of the crate version nothing generates,
//! and this is the pin that keeps it honest.

use std::path::PathBuf;

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn crate_version() -> String {
    let manifest =
        std::fs::read_to_string(crate_dir().join("Cargo.toml")).expect("read Cargo.toml");
    manifest
        .lines()
        .find_map(|line| line.strip_prefix("version = \""))
        .and_then(|rest| rest.split('"').next())
        .expect("crate version")
        .to_string()
}

fn wrapper_manifest() -> serde_json::Value {
    let path = crate_dir().join("npm/comment-budget/package.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("read package.json")).expect("json")
}

#[test]
fn npm_wrapper_version_matches_the_crate() {
    assert_eq!(
        wrapper_manifest()["version"].as_str().expect("a version string"),
        crate_version(),
        "bump npm/comment-budget/package.json alongside Cargo.toml",
    );
}

#[test]
fn every_platform_dependency_is_pinned_to_that_version() {
    let version = crate_version();
    let manifest = wrapper_manifest();
    let deps = manifest["optionalDependencies"].as_object().expect("optionalDependencies");
    assert!(!deps.is_empty(), "the wrapper resolves its binary through these");
    for (name, pinned) in deps {
        assert_eq!(
            pinned.as_str().expect("a version string"),
            version,
            "{name} would resolve to a different release than the wrapper",
        );
    }
}
