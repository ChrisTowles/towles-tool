//! Worktree-task convention logic (`tt task`): any plain git checkout, with
//! branch-named ephemeral tasks nested at `<checkout>/.claude/worktrees/<name>/` —
//! Claude Code's native worktree location. A worktree Claude Code makes for itself
//! lands there too but is *not* a task; only `tt task new` and the app's `+` create
//! those. A checkout's identity is its directory basename (the same rule
//! `tt_config::state_scope()` uses), its per-task config a rendered `.env`, and its
//! `.tt-task` marker records name/base for other tooling.
//!
//! The pure logic lives here: the `${tt:...}` renderer with port-pool claims
//! ([`template`]), env parsing/merging ([`envfile`]), task naming ([`layout`]), setup
//! selection ([`ops::setup_command`]) and removal guards ([`guards`]). The CLI gathers
//! real-world state — git output, bind-tests, docker listings — and hands it here.

pub mod clean;
pub mod envfile;
pub mod guards;
pub mod landed;
pub mod layout;
pub mod ops;
pub mod pasted;
pub mod ports;
pub mod staleness;
pub mod suggest;
pub mod template;

pub use guards::{RmBlocked, check_removal, docker_resource_matches};
pub use landed::{LandedVia, WorkState, classify, probe_work_state};
pub use layout::{
    CLAUDE_DIR, MARKER_FILE, WORKTREES_DIR, main_checkout_for, marker_contents, parse_marker,
    read_task_base, task_name_from_branch, task_name_from_dir, worktrees_dir,
};
pub use ops::{
    CleanOpts, CleanReport, CreateOpts, CreatedTask, FinishedTask, KeptTask, OpsError, RemoveOpts,
    RemovedTask, TaskRoot, clean_tasks, create_task, discover_root, remove_task, resolve_task_dir,
};
pub use pasted::{PastedError, PastedImage, write_images};
pub use staleness::{DEFAULT_STALE_DAYS, Staleness, assess as assess_staleness};
pub use suggest::{SuggestError, Suggestion, suggest};
pub use template::{RenderOutcome, TaskContext, TemplateError, render};
