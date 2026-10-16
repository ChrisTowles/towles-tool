//! GitHub/git helper domain logic shared by the app and the task machinery.
//!
//! This crate is Tauri-free, and [`repo`] reads repositories in-process via
//! `gix` rather than parsing a `git` subprocess; only [`provision`] spawns one. The rest is pure decision logic that takes
//! data and returns data, unit-testable without `gh` or a terminal.
//!
//! - [`repo`] — in-process git: the per-folder [`repo::RepoCache`], refs,
//!   graph walks, status, diffs, and patch identity. Start there; its module
//!   docs cover what still shells out to `git` and why.
//! - [`provision`] — `git init` / `git clone` a new repo onto disk.
//! - [`branch_name`] — branch-name slugging (`branch-name.ts`).
//! - [`task_assign`] — remote URL to `owner/name` slug.

pub mod branch_name;
pub mod provision;
pub mod repo;
pub mod task_assign;
