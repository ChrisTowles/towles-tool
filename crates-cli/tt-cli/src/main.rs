mod cli;
mod commands;
mod ui;

use clap::Parser;
use cli::{Cli, Commands, JournalCommands};
use std::path::Path;

fn main() {
    let Cli { verbose, config_dir, command } = Cli::parse();

    init_logging(verbose);

    let exit_code = dispatch(command, config_dir.as_deref());

    if exit_code != 0 {
        std::process::exit(exit_code);
    }
}

/// Run one invocation inside the span that records it.
///
/// Separate from `main` so the span closes on return, before `process::exit` —
/// that call runs no destructors, so a span still open across it is never
/// written and every *failing* command would go unrecorded.
fn dispatch(command: Commands, config_dir: Option<&Path>) -> i32 {
    let (group, subcommand) = command.telemetry_name();
    let span = tracing::info_span!(
        "cli.command",
        "cli.group" = group,
        "cli.subcommand" = subcommand,
        exit_code = tracing::field::Empty,
        outcome = tracing::field::Empty,
    );
    let _entered = span.enter();

    let exit_code = match command {
        Commands::Journal(args) => commands::journal::run(args.command, config_dir),
        Commands::Today { no_open } => {
            commands::journal::run(JournalCommands::DailyNotes { no_open }, config_dir)
        }
        Commands::Open { path, line } => {
            // A `:<line>` suffix on the operand wins over `--line`: it is the
            // more specific spelling, and it came from whatever printed the path.
            let (path, suffix_line) = commands::open::split_line_suffix(&path);
            commands::open::run(Path::new(path), suffix_line.or(line))
        }
        Commands::Task(args) => commands::task::run(args.command),
    };

    span.record("exit_code", exit_code);
    span.record("outcome", if exit_code == 0 { "ok" } else { "error" });
    exit_code
}

/// Install telemetry, mapping the `-v` count onto the stderr level. `RUST_LOG`
/// still overrides when set. The `-v` count only affects what reaches the
/// terminal — the on-disk event log always records at debug (see `tt_telemetry`).
///
/// A failure here is ignored: telemetry must never stop the CLI from running
/// its command.
fn init_logging(verbose: u8) {
    let default_level = match verbose {
        0 => "warn",
        1 => "info",
        2 => "debug",
        _ => "trace",
    };
    let _ = tt_telemetry::init("tt", default_level);
}
