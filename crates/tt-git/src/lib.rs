//! GitHub/git helper domain logic shared by the app and the task machinery.
//!
//! This crate is Tauri-free, and [`repo`] reads repositories in-process via `gix`;
//! only [`provision`] spawns a `git` subprocess.
//!
//! - [`repo`] — in-process git (cache, refs, graph walks, status, diffs, patch identity).
//! - [`provision`] — `git init` / `git clone` a new repo onto disk.
//! - [`branch_name`] — `feature/<n>-<slug>` from an issue.
//! - [`task_assign`] — clean-tree/remote guard for assigning an issue to a task checkout.

pub mod branch_name;
pub mod provision;
pub mod repo;
pub mod task_assign;
