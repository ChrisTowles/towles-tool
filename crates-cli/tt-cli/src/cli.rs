use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "tt")]
#[command(about = "towles-tool (Rust) - developer utilities, config, and diagnostics")]
#[command(version)]
#[command(disable_help_subcommand = true)]
pub struct Cli {
    /// Enable verbose logging (repeat for more detail: -v info, -vv debug, -vvv trace)
    #[arg(long, short, global = true, action = clap::ArgAction::Count)]
    pub verbose: u8,

    /// Override the config directory (defaults to ~/.config/towles-tool)
    #[arg(long, global = true, value_name = "DIR")]
    pub config_dir: Option<PathBuf>,

    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand)]
pub enum Commands {
    /// Journal and note-taking commands
    Journal(JournalArgs),

    /// Open this week's daily-notes file (alias for `journal daily-notes`)
    Today {
        /// Create the file but do not open it in an editor
        #[arg(long)]
        no_open: bool,
    },

    /// Worktree tasks: a main checkout (always the default branch) plus
    /// branch-named worktrees under <checkout>/.claude/worktrees/, each with
    /// rendered per-task ports/env so concurrent tasks never collide
    Task(TaskArgs),
}

impl Commands {
    /// The `(group, subcommand)` pair naming this invocation in the event log.
    ///
    /// Operands stay out of it (see CLAUDE.md's `tt-cli` bullet); `today` keeps
    /// its own name rather than folding into `daily-notes`, so the alias's own
    /// worth stays measurable.
    pub fn telemetry_name(&self) -> (&'static str, &'static str) {
        match self {
            Commands::Journal(args) => ("journal", args.command.name()),
            Commands::Today { .. } => ("journal", "today"),
            Commands::Task(args) => ("task", args.command.name()),
        }
    }
}

#[derive(Args)]
#[command(disable_help_subcommand = true)]
pub struct TaskArgs {
    #[command(subcommand)]
    pub command: TaskCommands,
}

#[derive(Subcommand)]
pub enum TaskCommands {
    /// Create a task (the unit of work): a board-task row in a tracked repo's
    /// swimlane PLUS its worktree under .claude/worktrees/ + rendered .env
    /// (port claims, inherited sibling secrets) + setup step (TT_TASK_SETUP
    /// from the rendered .env, else lockfile-detected install). Mirrors the
    /// MCP `task_create` params, with the worktree stood up in the same shot.
    New {
        /// Task title (also the goal the worktree is created for)
        #[arg(value_name = "TITLE")]
        title: String,

        /// Tracked repo the task belongs to — its name or absolute dir (as
        /// shown by the Agentboard rail). The worktree is created here.
        #[arg(long, value_name = "NAME|DIR")]
        repo: String,

        /// Board column the task starts in
        #[arg(long, default_value = "backlog")]
        status: String,

        /// Free-form notes stored on the board task
        #[arg(long)]
        notes: Option<String>,

        /// The objective the task is meant to accomplish, shown on the board
        /// card under the title (default: none)
        #[arg(long)]
        goal: Option<String>,

        /// Branch to create and check out (default: slugged from TITLE, e.g.
        /// "Fix login" -> fix-login; the task folder is the same slug)
        #[arg(long, short = 'b')]
        branch: Option<String>,

        /// Base ref for the new branch (default: the main checkout's branch)
        #[arg(long, value_name = "REF")]
        base: Option<String>,

        /// Emit the created task as JSON
        #[arg(long)]
        json: bool,
    },

    /// List the main checkout and tasks with branch, work state (uncommitted
    /// changes vs commits that never reached the base), and claimed ports
    Ls {
        /// Emit checkouts as a JSON array
        #[arg(long)]
        json: bool,

        /// Show only tasks with no new commits in the last N days that have not
        /// landed (default 7). Adds an AGE column of days since the branch's
        /// newest own commit; a landed or empty branch is never stale.
        #[arg(long, value_name = "DAYS", num_args = 0..=1, default_missing_value = "7")]
        stale: Option<u64>,

        /// Repo checkout (default: walk up from cwd to the nearest git checkout)
        #[arg(long, value_name = "DIR")]
        root: Option<PathBuf>,
    },

    /// Remove a task: guarded (clean tree, no commits unreachable from a
    /// branch or remote, nothing foreign on its ports), then docker compose
    /// down -v, anchored container/volume sweep, worktree remove
    Rm {
        /// Task directory name under .claude/worktrees/, e.g. task-migrate
        name: String,

        /// Skip guards (each skip is printed) and force worktree removal
        #[arg(long)]
        force: bool,

        /// How the task ended, recorded on its board row (the row is closed,
        /// not deleted). Default: done if a linked PR merged, else abandoned
        #[arg(long, value_parser = ["done", "abandoned"])]
        outcome: Option<String>,

        /// Repo checkout (default: walk up from cwd to the nearest git checkout)
        #[arg(long, value_name = "DIR")]
        root: Option<PathBuf>,
    },

    /// Onboard this repo onto the task convention (idempotent): pick/create
    /// the env template, gitignore .env, and render the primary checkout's
    /// .env so it claims its ports
    Init {
        /// Repo checkout (default: walk up from cwd to the nearest git checkout)
        #[arg(long, value_name = "DIR")]
        root: Option<PathBuf>,
    },

    /// (Re)render a checkout's .env from the template — idempotent: existing
    /// port claims and keys the template doesn't know are preserved
    Env {
        /// Task directory name under .claude/worktrees/, or `primary` for the
        /// main checkout
        name: String,

        /// Repo checkout (default: walk up from cwd to the nearest git checkout)
        #[arg(long, value_name = "DIR")]
        root: Option<PathBuf>,
    },

    /// The repo's port picture: every claim in any checkout's live .env
    /// merged with the persistent registry, each probed for a listener —
    /// or probe one arbitrary port with --probe
    Ports {
        /// Probe a single port for a listener instead of reporting the
        /// repo's claims (what scripts/task-port.mjs delegates to)
        #[arg(long, value_name = "PORT")]
        probe: Option<u16>,

        /// Emit JSON
        #[arg(long)]
        json: bool,

        /// Repo checkout (default: walk up from cwd to the nearest git checkout)
        #[arg(long, value_name = "DIR")]
        root: Option<PathBuf>,
    },

    /// Remove every task whose branch's work has landed (merged into the
    /// main checkout's branch, or upstream deleted after a squash/rebase
    /// merge) — same guards as rm, never forced — then sweep the
    /// per-checkout state dirs and agentboard windows/sessions left behind
    /// by checkouts that no longer exist
    Clean {
        /// Report what would be removed/swept without touching anything
        #[arg(long)]
        dry_run: bool,

        /// Emit the report as JSON
        #[arg(long)]
        json: bool,

        /// Repo checkout (default: walk up from cwd to the nearest git checkout)
        #[arg(long, value_name = "DIR")]
        root: Option<PathBuf>,
    },

    /// Ask the app instance that owns this terminal to refresh a collector now
    /// rather than on its next poll. Called by the `gh-pr-nudge.sh` hook after
    /// a `gh pr`/`gh issue` mutation; routed by `TT_SESSION_ID`, so a caller
    /// outside an app terminal nudges every instance
    Nudge(NudgeArgs),
}

impl TaskCommands {
    /// This subcommand's name in the event log. See [`Commands::telemetry_name`].
    fn name(&self) -> &'static str {
        match self {
            TaskCommands::New { .. } => "new",
            TaskCommands::Ls { .. } => "ls",
            TaskCommands::Rm { .. } => "rm",
            TaskCommands::Init { .. } => "init",
            TaskCommands::Env { .. } => "env",
            TaskCommands::Ports { .. } => "ports",
            TaskCommands::Clean { .. } => "clean",
            TaskCommands::Nudge(_) => "nudge",
        }
    }
}

#[derive(Args)]
pub struct NudgeArgs {
    /// Which collector to eagerly refresh
    #[arg(value_enum)]
    pub target: NudgeTarget,

    /// Short label for what caused this nudge (e.g. `pr:create`,
    /// `issue:close`), recorded on the telemetry event only — never parsed,
    /// never written to the nudge file itself. Lets `gh pr create`/`merge`
    /// (which run outside `tt-exec`, so no `process.spawn` span exists for
    /// them) still leave a record in the event log.
    #[arg(long)]
    pub trigger: Option<String>,
}

/// Which collector `tt collect nudge` eagerly refreshes. A thin clap-parsing
/// mirror of [`tt_collect::NudgeTarget`], which owns the key ↔ nudge-filename
/// contract the app's scheduler nudge-dir watch reads
/// (`crates-tauri/tt-app/src/scheduler.rs`). The accepted CLI values are the
/// collector keys themselves (`prs`, `issues`, `slack:dm`).
#[derive(Clone, Copy, clap::ValueEnum)]
pub enum NudgeTarget {
    Prs,
    Issues,
    #[value(name = "slack:dm")]
    SlackDm,
}

impl NudgeTarget {
    /// Map to the crate-owned target that carries the filename contract.
    pub fn to_collect(self) -> tt_collect::NudgeTarget {
        match self {
            NudgeTarget::Prs => tt_collect::NudgeTarget::Prs,
            NudgeTarget::Issues => tt_collect::NudgeTarget::Issues,
            NudgeTarget::SlackDm => tt_collect::NudgeTarget::SlackDm,
        }
    }
}

#[derive(Args)]
#[command(disable_help_subcommand = true)]
pub struct JournalArgs {
    #[command(subcommand)]
    pub command: JournalCommands,
}

#[derive(Subcommand)]
pub enum JournalCommands {
    /// Weekly files with daily sections for ongoing work and notes
    DailyNotes {
        /// Create the file but do not open it in an editor
        #[arg(long)]
        no_open: bool,
    },

    /// General-purpose notes with structured sections
    Note {
        /// Note title (prompted for if omitted)
        title: Option<String>,

        /// Create the file but do not open it in an editor
        #[arg(long)]
        no_open: bool,
    },

    /// Structured meeting notes with agenda and action items
    Meeting {
        /// Meeting title (prompted for if omitted)
        title: Option<String>,

        /// Create the file but do not open it in an editor
        #[arg(long)]
        no_open: bool,
    },

    /// Append a timestamped bullet to today's daily note without opening an editor
    Jot {
        /// Text to capture. Use `-` (or omit) to read the bullet from stdin.
        text: Option<String>,
    },

    /// Open the most recent journal entry in the editor
    Open {
        /// Open the most recent entry (the default; accepted for explicitness)
        #[arg(long)]
        last: bool,

        /// Fuzzy-pick a recent entry from an interactive list (requires a TTY)
        #[arg(long)]
        pick: bool,

        /// Filter by entry type: daily-notes, meeting, note
        #[arg(long, short = 't')]
        r#type: Option<String>,

        /// Print the entry's absolute path instead of opening it in an editor
        #[arg(long)]
        no_open: bool,
    },

    /// List recent journal entries
    List {
        /// Filter by entry type: daily-notes, meeting, note
        #[arg(long, short = 't')]
        r#type: Option<String>,

        /// Maximum number of entries to show (default: 20)
        #[arg(long, short = 'l')]
        limit: Option<String>,

        /// Sort by: date, name (default: date)
        #[arg(long, short = 's')]
        sort: Option<String>,

        /// Emit entries as a JSON array instead of a table
        #[arg(long)]
        json: bool,
    },

    /// Search journal entries for matching text
    Search {
        /// Text to search for
        query: String,

        /// Filter by entry type: daily-notes, meeting, note
        #[arg(long, short = 't')]
        r#type: Option<String>,

        /// Filter by date range: YYYY-MM-DD..YYYY-MM-DD
        #[arg(long, short = 'r')]
        range: Option<String>,

        /// Emit matches as a JSON array instead of grouped text
        #[arg(long)]
        json: bool,
    },
}

impl JournalCommands {
    /// This subcommand's name in the event log. See [`Commands::telemetry_name`].
    fn name(&self) -> &'static str {
        match self {
            JournalCommands::DailyNotes { .. } => "daily-notes",
            JournalCommands::Note { .. } => "note",
            JournalCommands::Meeting { .. } => "meeting",
            JournalCommands::Jot { .. } => "jot",
            JournalCommands::Open { .. } => "open",
            JournalCommands::List { .. } => "list",
            JournalCommands::Search { .. } => "search",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// Every command reachable from argv, with the pair it must log.
    const CASES: &[(&[&str], (&str, &str))] = &[
        (&["tt", "journal", "daily-notes"], ("journal", "daily-notes")),
        (&["tt", "journal", "note"], ("journal", "note")),
        (&["tt", "journal", "meeting"], ("journal", "meeting")),
        (&["tt", "journal", "jot"], ("journal", "jot")),
        (&["tt", "journal", "open"], ("journal", "open")),
        (&["tt", "journal", "list"], ("journal", "list")),
        (&["tt", "journal", "search", "needle"], ("journal", "search")),
        (&["tt", "today"], ("journal", "today")),
        (&["tt", "task", "nudge", "prs"], ("task", "nudge")),
        (&["tt", "task", "new", "Title", "--repo", "r"], ("task", "new")),
        (&["tt", "task", "ls"], ("task", "ls")),
        (&["tt", "task", "rm", "some-task"], ("task", "rm")),
        (&["tt", "task", "init"], ("task", "init")),
        (&["tt", "task", "env", "some-task"], ("task", "env")),
        (&["tt", "task", "ports"], ("task", "ports")),
        (&["tt", "task", "clean"], ("task", "clean")),
    ];

    #[test]
    fn every_subcommand_names_itself() {
        for (argv, expected) in CASES {
            let cli = Cli::try_parse_from(*argv).unwrap_or_else(|e| panic!("{argv:?}: {e}"));
            assert_eq!(cli.command.telemetry_name(), *expected, "for {argv:?}");
        }
    }

    /// A copy-pasted arm in one of the `name()` impls would silently file two
    /// commands under one name, and the usage counts read from the event log
    /// would be wrong rather than obviously broken.
    #[test]
    fn no_two_commands_share_a_name() {
        let mut seen = HashSet::new();
        for (argv, _) in CASES {
            let cli = Cli::try_parse_from(*argv).unwrap();
            assert!(seen.insert(cli.command.telemetry_name()), "duplicate name for {argv:?}");
        }
        assert_eq!(seen.len(), CASES.len());
    }
}
