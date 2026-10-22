use std::io::{BufRead, BufReader, Write};
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
        /// The history to read, passed explicitly: a detached child's env is scrubbed.
        #[arg(long)]
        store: std::path::PathBuf,
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
        Command::Serve { store, id } => {
            let entry = Store::open(&store)?.get(id)?;
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
    let id_arg = id.to_string();
    let store = Store::default_path()?;
    let store = store.to_string_lossy();
    let exe = std::env::current_exe()?;
    let args = ["serve", "--store", &store, &id_arg];
    let mut cmd = tt_exec::detached_command(exe, &args, "clipboard_owner");
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?;
    let mut line = String::new();
    BufReader::new(child.stdout.take().expect("piped")).read_line(&mut line)?;
    if line.trim() != READY {
        return Err(Error::Wayland(
            "the clipboard owner exited before taking the selection".into(),
        ));
    }
    Ok(())
}

/// Paste into whatever regained focus, with the chord settings give the kind.
fn send_paste(kind: Kind) -> Result<()> {
    let settings = tt_config::load().unwrap_or_default().clipboard;
    let chord = match kind {
        Kind::Text => settings.paste_text_keys,
        Kind::Image => settings.paste_image_keys,
    };
    wayland::wait_until_closed(picker::APP_ID, Duration::from_secs(1))?;
    let args = wtype_args(&chord);
    let out = tt_exec::run("wtype", &args.iter().map(String::as_str).collect::<Vec<_>>())?;
    if !out.ok() {
        tracing::warn!("wtype failed: {}", out.stderr.trim());
    }
    Ok(())
}

/// `ctrl+shift+v` → press ctrl, shift; tap v; release shift, ctrl.
fn wtype_args(chord: &str) -> Vec<String> {
    let mut parts: Vec<&str> = chord.split('+').map(str::trim).filter(|p| !p.is_empty()).collect();
    let Some(key) = parts.pop() else {
        return Vec::new();
    };
    let mods: Vec<String> = parts.iter().map(|m| m.to_ascii_lowercase()).collect();
    let press = mods.iter().flat_map(|m| ["-M".to_string(), m.clone()]);
    let release = mods.iter().rev().flat_map(|m| ["-m".to_string(), m.clone()]);
    press.chain(["-k".to_string(), key.to_string()]).chain(release).collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn wtype_args_press_tap_release() {
        assert_eq!(
            super::wtype_args("Ctrl+Shift+v"),
            [
                "-M", "ctrl", "-M", "shift", "-k", "v", "-m", "shift", "-m", "ctrl"
            ]
        );
        assert_eq!(
            super::wtype_args("shift+Insert"),
            ["-M", "shift", "-k", "Insert", "-m", "shift"]
        );
        assert!(super::wtype_args("").is_empty());
    }
}
