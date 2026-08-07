//! A budget for comment volume, for a codebase an AI writes most of. A model
//! writes comments faster than anyone can review them and keeps adding, pass
//! over pass, until there is more of it than a reader can get through, so the
//! cap is on what review can absorb: `comment / (comment + code)`, plus an
//! over-long run of it and an over-long `.md`. What a comment *says* is never
//! read. What is measured, how hard, and why, live in `comment-budget.toml`.
//!
//! ```no_run
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! use comment_budget::{judge, Config, Diff, Since};
//!
//! let (cfg, root) = Config::discover(&std::env::current_dir()?)?;
//! let diff = Diff::open(&root, &Since::MergeBase("main".into()), false)?;
//! let analysis = comment_budget::analyze(&root, &cfg, Some(&diff))?;
//! for finding in judge(&cfg, &analysis.stats) {
//!     println!("{finding}");
//! }
//! # Ok(()) }
//! ```

pub mod config;
pub mod diff;
pub mod init;
pub mod judge;
pub mod measure;
pub mod report;

pub use config::{CONFIG_FILE, Config};
pub use diff::{DEFAULT_BASE, Diff, Since};
pub use judge::{Finding, Rule, dead_glob_findings, judge, unclaimed_findings};
pub use measure::{Analysis, DeadGlob, FileStats, Run, analyze};

use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Warning,
    Error,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Warning => "warning",
            Severity::Error => "error",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CommentBudgetError {
    #[error("no {CONFIG_FILE} at or above {}", start.display())]
    NoConfig { start: PathBuf },
    #[error("could not read {}: {source}", path.display())]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("could not read the current directory: {0}")]
    CurrentDir(#[source] std::io::Error),
    #[error("could not write {}: {source}", path.display())]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("{}: {message}", path.display())]
    Config { path: PathBuf, message: String },
    #[error("could not parse {file}: {message}")]
    Grammar { file: String, message: String },
    #[error("git: {0}")]
    Git(String),
}
