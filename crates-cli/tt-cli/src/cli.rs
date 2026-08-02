//! comment-budget: allow(every `///` below is `--help` text clap prints, not prose — deleting one silently removes user-facing help)
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

    /// Show a file/folder in the app's Files pane, in this terminal's task; accepts `<path>:<line>`
    Open {
        /// File or folder to show, optionally with a `:<line>` suffix
        #[arg(value_name = "PATH")]
        path: String,

        /// 1-based line to scroll to (overridden by a `:<line>` suffix on PATH)
        #[arg(long, value_name = "N")]
        line: Option<u32>,
    },

    /// Worktree tasks: a main checkout plus branch-named worktrees with rendered per-task ports/env
    Task(TaskArgs),
}

impl Commands {
    pub fn telemetry_name(&self) -> (&'static str, &'static str) {
        match self {
            Commands::Journal(args) => ("journal", args.command.name()),
            Commands::Today { .. } => ("journal", "today"),
            Commands::Open { .. } => ("open", "open"),
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
    /// Create a task: board row + worktree + rendered .env + setup step (the MCP `task_create` params)
    New {
        /// Task title (also the goal the worktree is created for)
        #[arg(value_name = "TITLE")]
        title: String,

        /// Tracked repo (name or absolute dir, as the Agentboard rail shows it)
        #[arg(long, value_name = "NAME|DIR")]
        repo: String,

        /// Board column the task starts in
        #[arg(long, default_value = "backlog")]
        status: String,

        /// Free-form notes stored on the board task
        #[arg(long)]
        notes: Option<String>,

        /// Objective shown on the board card under the title (default: none)
        #[arg(long)]
        goal: Option<String>,

        /// Branch to create and check out (default: slugged from TITLE)
        #[arg(long, short = 'b')]
        branch: Option<String>,

        /// Base ref for the new branch (default: the main checkout's branch)
        #[arg(long, value_name = "REF")]
        base: Option<String>,

        /// Emit the created task as JSON
        #[arg(long)]
        json: bool,
    },

    /// List the main checkout and tasks: branch, work state, claimed ports
    Ls {
        /// Emit checkouts as a JSON array
        #[arg(long)]
        json: bool,

        /// Only tasks with no unlanded commits in the last N days (default 7); adds an AGE column
        #[arg(long, value_name = "DAYS", num_args = 0..=1, default_missing_value = "7")]
        stale: Option<u64>,

        /// Repo checkout (default: walk up from cwd to the nearest git checkout)
        #[arg(long, value_name = "DIR")]
        root: Option<PathBuf>,
    },

    /// Remove a task: guarded, then docker cleanup and worktree remove
    Rm {
        /// Task directory name under .claude/worktrees/, e.g. task-migrate
        name: String,

        /// Skip guards (each skip is printed) and force worktree removal
        #[arg(long)]
        force: bool,

        /// Outcome recorded on the closed board row (default: done if a linked PR merged)
        #[arg(long, value_parser = ["done", "abandoned"])]
        outcome: Option<String>,

        /// Repo checkout (default: walk up from cwd to the nearest git checkout)
        #[arg(long, value_name = "DIR")]
        root: Option<PathBuf>,
    },

    /// Onboard this repo onto the task convention (idempotent): template, gitignore, primary .env
    Init {
        /// Repo checkout (default: walk up from cwd to the nearest git checkout)
        #[arg(long, value_name = "DIR")]
        root: Option<PathBuf>,
    },

    /// (Re)render a checkout's .env from the template, preserving existing claims and unknown keys
    Env {
        /// Task directory name under .claude/worktrees/, or `primary`
        name: String,

        /// Repo checkout (default: walk up from cwd to the nearest git checkout)
        #[arg(long, value_name = "DIR")]
        root: Option<PathBuf>,
    },

    /// Every port claim across checkouts merged with the registry, each probed for a listener
    Ports {
        /// Probe a single port for a listener instead of reporting claims
        #[arg(long, value_name = "PORT")]
        probe: Option<u16>,

        /// Emit JSON
        #[arg(long)]
        json: bool,

        /// Repo checkout (default: walk up from cwd to the nearest git checkout)
        #[arg(long, value_name = "DIR")]
        root: Option<PathBuf>,
    },

    /// Remove every landed task (same guards as rm, never forced), then sweep gone checkouts' state
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

    /// Refresh a collector in this terminal's app instance now rather than on its next poll
    Nudge(NudgeArgs),
}

impl TaskCommands {
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

    /// Label for the telemetry event only (e.g. `pr:create`) — never parsed nor written to the file
    #[arg(long)]
    pub trigger: Option<String>,

    /// Skip, successfully, unless some app instance would act on this nudge. For the
    /// `gh` hook, which runs in every project on the machine — see `nudge::admits`
    #[arg(long)]
    pub only_if_tracked: bool,
}

#[derive(Clone, Copy, clap::ValueEnum)]
pub enum NudgeTarget {
    Prs,
    Issues,
    #[value(name = "slack:dm")]
    SlackDm,
}

impl NudgeTarget {
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
