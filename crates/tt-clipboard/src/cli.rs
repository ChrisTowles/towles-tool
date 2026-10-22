use std::io::{BufRead, BufReader, Write};
use std::os::unix::process::CommandExt;
use std::process::{ExitCode, Stdio};
use std::time::Duration;

use clap::{Parser, Subcommand};
use tt_clipboard::picker;
use tt_clipboard::query::Query;
use tt_clipboard::wayland::{self, Capture};
use tt_clipboard::{Error, Kind, Result, Store, cliphist};

/// Clipboard history with search and images, for Wayland.
#[derive(Parser)]
#[command(name = "tt-clip", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Record every clipboard selection (run once per session).
    Watch,
    /// Open the history window; Enter pastes into the focused app.
    Pick {
        /// Only copy the choice; never send the paste keystroke.
        #[arg(long)]
        no_paste: bool,
    },
    /// Print the newest entries matching a query.
    List {
        #[arg(short = 'n', long, default_value_t = 20)]
        limit: usize,
        /// Terms that must all appear; `is:image` / `is:text` filter by kind.
        query: Vec<String>,
    },
    /// Write an entry's content to stdout.
    Get {
        id: i64,
    },
    /// Make an entry the clipboard selection.
    Copy {
        id: i64,
    },
    Delete {
        id: i64,
    },
    /// Copy a cliphist history into this one.
    ImportCliphist,
    /// Own the selection for an entry until replaced (what `copy` runs detached).
    #[command(hide = true)]
    Serve {
        id: i64,
    },
}

pub fn main() -> ExitCode {
    let _ = tt_telemetry::init("tt-clip", "info");
    match run(Cli::parse().command) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("tt-clip: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(command: Command) -> Result<()> {
    match command {
        Command::Watch => watch(),
        Command::Pick { no_paste } => {
            let Some(picked) = picker::run(Store::open_default()?)? else {
                return Ok(());
            };
            copy(picked.id)?;
            if picked.paste && !no_paste {
                send_paste(picked.kind)?;
            }
            Ok(())
        }
        Command::List { limit, query } => {
            let store = Store::open_default()?;
            let now = tt_config::now_ms();
            for e in store.search(&Query::parse(&query.join(" ")), limit)? {
                let what = match e.kind {
                    Kind::Text => e.first_line().0.chars().take(100).collect(),
                    Kind::Image => format!("[{} {}×{}]", e.mime, e.width, e.height),
                };
                println!("{}\t{}s\t{what}", e.id, (now - e.used_at) / 1000);
            }
            Ok(())
        }
        Command::Get { id } => {
            let entry = Store::open_default()?.get(id)?;
            std::io::stdout().write_all(&entry.data)?;
            Ok(())
        }
        Command::Copy { id } => copy(id),
        Command::Delete { id } => match Store::open_default()?.delete(id)? {
            true => Ok(()),
            false => Err(Error::NotFound(id)),
        },
        Command::ImportCliphist => {
            let n = cliphist::import(&Store::open_default()?, tt_config::now_ms())?;
            println!("imported {n} entries");
            Ok(())
        }
        Command::Serve { id } => {
            let entry = Store::open_default()?.get(id)?;
            wayland::serve(entry.kind, &entry.mime, entry.data, || {
                // The parent waits for this line; closing stdout after lets it exit.
                let mut out = std::io::stdout();
                let _ = writeln!(out, "{READY}");
                let _ = out.flush();
            })
        }
    }
}

/// Record selections until the session ends. One watcher per machine: a second
/// exits instead of double-recording.
fn watch() -> Result<()> {
    let dir = tt_config::clipboard_dir()?;
    std::fs::create_dir_all(&dir)?;
    let lock = std::fs::File::create(dir.join("watch.lock"))?;
    if lock.try_lock().is_err() {
        return Err(Error::AlreadyRunning);
    }
    let store = Store::open_default()?;
    let (tx, rx) = std::sync::mpsc::channel::<Capture>();
    let watcher = std::thread::spawn(move || wayland::watch(tx));
    for capture in rx {
        match store.insert(capture.kind, &capture.mime, &capture.data, capture.at_ms) {
            Ok(Some(id)) => tracing::debug!(id, mime = capture.mime, "recorded"),
            Ok(None) => {}
            Err(e) => tracing::warn!("recording a selection: {e}"),
        }
    }
    watcher.join().map_err(|_| Error::Wayland("watcher panicked".into()))?
}

/// What `serve` prints once it owns the selection.
const READY: &str = "ready";

/// Hand the entry to a detached `serve`, returning once it owns the selection.
fn copy(id: i64) -> Result<()> {
    let exe = std::env::current_exe()?;
    let id_arg = id.to_string();
    tt_exec::record_detached_spawn("tt-clip", &["serve", &id_arg], "clipboard_owner");
    // Its own process group, so closing the launching terminal doesn't end the copy.
    let mut child = std::process::Command::new(exe)
        .args(["serve", &id_arg])
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut line = String::new();
    BufReader::new(child.stdout.take().expect("piped")).read_line(&mut line)?;
    if line.trim() != READY {
        return Err(Error::Wayland(
            "the clipboard owner exited before taking the selection".into(),
        ));
    }
    Ok(())
}

/// Paste into whatever regained focus: Ctrl+Shift+V for text (a terminal's paste,
/// plain-text paste elsewhere), Ctrl+V for an image.
fn send_paste(kind: Kind) -> Result<()> {
    // Let focus return to the window the picker covered.
    std::thread::sleep(Duration::from_millis(120));
    let args: &[&str] = match kind {
        Kind::Text => &[
            "-M", "ctrl", "-M", "shift", "-k", "v", "-m", "shift", "-m", "ctrl",
        ],
        Kind::Image => &["-M", "ctrl", "-k", "v", "-m", "ctrl"],
    };
    let out = tt_exec::run("wtype", args)?;
    if !out.ok() {
        tracing::warn!("wtype failed: {}", out.stderr.trim());
    }
    Ok(())
}
