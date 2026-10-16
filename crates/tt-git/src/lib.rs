//! GitHub/git helper domain logic shared by the app and the task machinery.
//!
//! This crate is Tauri-free, and [`repo`] reads repositories in-process via `gix`;
//! only [`cli`] and [`provision`] spawn a `git` subprocess.
//!
//! - [`testing`] — behind `test-support`: fixture git helpers for other crates' tests.
//! - [`cli`] — the typed `git` subprocess operations (fetch, worktree writes).
//! - [`repo`] — in-process git (cache, refs, graph walks, status, diffs, patch identity).
//! - [`provision`] — `git init` / `git clone` a new repo onto disk.
//! - [`branch_name`] — branch-name slugging.
//! - [`remote`] — remote URL to `owner/name` slug.

pub mod branch_name;
pub mod cli;
pub mod provision;
pub mod remote;
pub mod repo;
#[cfg(feature = "test-support")]
pub mod testing;
