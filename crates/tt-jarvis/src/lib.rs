//! Bevy rendering into a surface it did not create.
//!
//! Tauri-free: acquiring the surface and gluing it to a DOM rect is `tt-pane`'s job,
//! and the two hosts that drive the scene live in `hosts.rs`.
//!
//! **Everything but [`stats`] is behind the `bevy` feature, which is off by
//! default** — see this crate's `Cargo.toml` for why. With it off, the crate is the
//! frame-time maths alone and nothing here pulls Bevy into the build.

pub mod stats;

#[cfg(feature = "bevy")]
pub mod jarvis;
#[cfg(feature = "bevy")]
pub mod scene;
#[cfg(feature = "bevy")]
pub mod surface;

#[cfg(feature = "bevy")]
mod hosts;
#[cfg(feature = "bevy")]
pub use hosts::*;
