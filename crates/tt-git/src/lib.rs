//! GitHub/git helper domain logic shared by the app and the task machinery.
//!
//! This crate is Tauri-free and, as of the gitoxide cutover, *process*-free
//! too: [`repo`] reads repositories in-process via `gix` rather than parsing
//! the output of a `git` subprocess. The rest is pure decision logic that takes
//! data and returns data, unit-testable without `gh` or a terminal.
//!
//! - [`repo`] — in-process git: the per-folder [`repo::RepoCache`], refs,
//!   graph walks, status, diffs, and patch identity. Start there; its module
//!   docs cover what still shells out to `git` and why.
//! - [`branch_name`] — `feature/<n>-<slug>` from an issue (`branch-name.ts`).
//! - [`task_assign`] — clean-tree/remote guard for assigning an issue to a
//!   task checkout (the app's issue→task flow).

pub mod branch_name;
pub mod repo;
pub mod task_assign;
