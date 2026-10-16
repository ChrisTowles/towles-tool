//! Who holds a claimed port, and how to stop them. The removal guard learns only
//! "something is listening" from the bind probe, which refuses a removal without being
//! actionable: "port 4424 is in use" leaves the user hunting by hand.
//!
//! Mirrors `scripts/task-port.mjs`'s `killPort`, for the same reasons:
//! - `lsof` for the listeners — its absence reads as "nothing listening", either way
//!   leaving no pid to offer.
//! - Signal the listener's POSIX **process group**, not its pid: a `npm run dev` tree
//!   leaves vite/esbuild orphaned and still bound when you signal only `lsof`'s pid.
//! - SIGTERM, wait, then SIGKILL — a dev server gets a clean shutdown first.

use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::{Duration, Instant};

use thiserror::Error;

use crate::guards::PortHolder;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum PortError {
    #[error("stopping a port's process needs POSIX process groups (unsupported on this platform)")]
    Unsupported,

    #[error(
        "couldn't identify what is listening on port {0} — `lsof` found no process to stop (is it running as another user?)"
    )]
    NoListenerFound(u16),

    #[error("port {port} is still in use after SIGKILL — stop the process by hand")]
    StillInUse { port: u16 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stopped {
    pub pgids: Vec<i32>,
    pub graceful: bool,
}

pub fn holder(port: u16) -> Option<PortHolder> {
    let pid = *listening_pids(port).first()?;
    let command = probe_processes(&[pid])
        .into_iter()
        .next()
        .map_or_else(|| "unknown".to_string(), |p| p.command);
    Some(PortHolder { pid, command })
}

/// Whether every listener on `port` runs from inside `dir` — the task's own dev server,
/// which removing the task may stop. An unreadable cwd, or this process, answers no.
pub fn listeners_inside(port: u16, dir: &Path) -> bool {
    let Ok(dir) = dir.canonicalize() else {
        return false;
    };
    let me = std::process::id() as i32;
    let pids = listening_pids(port);
    !pids.is_empty()
        && pids
            .iter()
            .all(|&pid| pid != me && process_cwd(pid).is_some_and(|c| c.starts_with(&dir)))
}

#[cfg(target_os = "linux")]
fn process_cwd(pid: i32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
}

#[cfg(not(target_os = "linux"))]
fn process_cwd(pid: i32) -> Option<PathBuf> {
    let out = tt_exec::run("lsof", &["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"]).ok()?;
    parse_lsof_cwd(&out.stdout)
}

/// `lsof -Fn`'s name field: the line starting with `n`.
#[cfg_attr(target_os = "linux", allow(dead_code))]
fn parse_lsof_cwd(stdout: &str) -> Option<PathBuf> {
    stdout
        .lines()
        .find_map(|l| l.strip_prefix('n'))
        .filter(|p| p.starts_with('/'))
        .map(PathBuf::from)
}

/// Stop whatever is listening on `port`: SIGTERM its process group(s), then SIGKILL if
/// the port is still held. Returns only once the port is actually free, since the caller
/// usually retries whatever the listener was blocking.
pub(crate) fn stop_listeners(port: u16) -> Result<Stopped, PortError> {
    if !cfg!(unix) {
        return Err(PortError::Unsupported);
    }
    // Already free is success, not failure: the user reads "a dev server may be
    // running", quits it in their own terminal, *then* clicks the button.
    if !crate::ops::port_occupied(port) {
        return Ok(Stopped { pgids: Vec::new(), graceful: true });
    }
    let pgids = listening_pgids(port);
    if pgids.is_empty() {
        return Err(PortError::NoListenerFound(port));
    }

    signal_groups(&pgids, TERM);
    if wait_until_free(port, Duration::from_secs(3)) {
        return Ok(Stopped { pgids, graceful: true });
    }
    signal_groups(&pgids, KILL);
    if wait_until_free(port, Duration::from_secs(2)) {
        return Ok(Stopped { pgids, graceful: false });
    }
    Err(PortError::StillInUse { port })
}

/// Distinct process groups of everything listening on `port`. Deduplicated: a dev-server
/// tree usually puts several listeners in one group.
fn listening_pgids(port: u16) -> Vec<i32> {
    let mut pgids: Vec<i32> = Vec::new();
    // A process that died between the `lsof` listing and this call is dropped rather
    // than falling back to its bare pid, which would leave its children bound.
    for proc in probe_processes(&listening_pids(port)) {
        if !pgids.contains(&proc.pgid) {
            pgids.push(proc.pgid);
        }
    }
    pgids
}

fn listening_pids(port: u16) -> Vec<i32> {
    tt_exec::run("lsof", &["-ti", &format!("tcp:{port}"), "-sTCP:LISTEN"])
        .map(|out| parse_lsof_pids(&out.stdout))
        .unwrap_or_default()
}

struct ProcInfo {
    pgid: i32,
    command: String,
}

fn probe_processes(pids: &[i32]) -> Vec<ProcInfo> {
    if pids.is_empty() {
        return Vec::new();
    }
    let list = pids.iter().map(i32::to_string).collect::<Vec<_>>().join(",");
    let Ok(out) = tt_exec::run("ps", &["-o", "pgid=,args=", "-p", &list]) else {
        return Vec::new();
    };
    if !out.ok() {
        return Vec::new();
    }
    out.stdout.lines().filter_map(parse_ps_row).collect()
}

/// One `ps -o pgid=,args=` row: whitespace-padded pgid, then the command line.
///
/// **A pgid below 2 is rejected, not signaled.** `signal_groups` negates it for
/// `kill(2)`, where `kill(0)` hits this app's own process group and `kill(-1)` the
/// user's entire login session. This parse is all that stands between a malformed row
/// and taking out the machine.
fn parse_ps_row(row: &str) -> Option<ProcInfo> {
    let mut fields = row.trim().splitn(2, char::is_whitespace);
    let pgid: i32 = fields.next()?.parse().ok()?;
    if pgid < 2 {
        return None;
    }
    let command = fields.next().and_then(command_name).unwrap_or_else(|| "unknown".to_string());
    Some(ProcInfo { pgid, command })
}

/// `argv[0]`'s basename: `/usr/bin/node -e …` → `node`, `npm run dev` → `npm`.
///
/// Not `ps -o comm=`: on Linux that is the *thread* name, and Node renames its main
/// thread, so a vite dev server would introduce itself as "MainThread (pid 1234)". Not
/// the whole command line either — hundreds of characters of absolute paths bury the one
/// word the user is scanning a dialog row for.
fn command_name(args: &str) -> Option<String> {
    let argv0 = args.split_whitespace().next()?;
    let name = argv0.rsplit('/').next().unwrap_or(argv0);
    (!name.is_empty()).then(|| name.to_string())
}

fn parse_lsof_pids(stdout: &str) -> Vec<i32> {
    let mut pids: Vec<i32> = Vec::new();
    for pid in stdout.lines().filter_map(|line| line.trim().parse::<i32>().ok()) {
        if pid > 0 && !pids.contains(&pid) {
            pids.push(pid);
        }
    }
    pids
}

const TERM: i32 = 15;
const KILL: i32 = 9;

#[cfg(unix)]
fn signal_groups(pgids: &[i32], signal: i32) {
    for &pgid in pgids {
        if pgid < 2 {
            continue;
        }
        // SAFETY: `kill(2)` with a negative pid targets a process group; no
        // memory-safety implications, and every failure lands in errno, ignored here.
        unsafe {
            libc::kill(-pgid, signal);
        }
    }
}

#[cfg(not(unix))]
fn signal_groups(_pgids: &[i32], _signal: i32) {}

fn wait_until_free(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if !crate::ops::port_occupied(port) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        sleep(Duration::from_millis(100));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lsof_pids_are_parsed_and_deduped() {
        assert_eq!(parse_lsof_pids("123\n456\n123\n"), vec![123, 456]);
    }

    #[test]
    fn lsof_noise_is_ignored() {
        assert!(parse_lsof_pids("").is_empty());
        assert!(parse_lsof_pids("lsof: WARNING: can't stat() fuse.gvfsd\n").is_empty());
        assert!(parse_lsof_pids("0\n-1\n").is_empty());
    }

    #[test]
    fn command_name_is_argv0s_basename() {
        assert_eq!(command_name("/usr/bin/node -e require('net')").as_deref(), Some("node"));
        assert_eq!(command_name("npm run dev").as_deref(), Some("npm"));
        assert_eq!(
            command_name(
                "/home/x/.nvm/versions/node/v22.0.0/bin/node /home/x/p/node_modules/.bin/vite"
            )
            .as_deref(),
            Some("node")
        );
    }

    #[test]
    fn command_name_declines_when_there_is_nothing_to_name() {
        assert_eq!(command_name(""), None);
        assert_eq!(command_name("   "), None);
        assert_eq!(command_name("/"), None);
    }

    #[test]
    fn holder_reads_as_a_name_and_a_pid() {
        let holder = PortHolder { pid: 4242, command: "node".to_string() };
        assert_eq!(holder.describe(), "node (pid 4242)");
    }

    #[test]
    fn ps_rows_yield_a_pgid_and_a_name() {
        let row = parse_ps_row(" 12345 /usr/bin/node /p/node_modules/.bin/vite --host").unwrap();
        assert_eq!(row.pgid, 12345);
        assert_eq!(row.command, "node");
    }

    #[test]
    fn ps_rows_without_a_pgid_are_dropped() {
        assert!(parse_ps_row("").is_none());
        assert!(parse_ps_row("  PGID COMMAND").is_none());
    }

    #[test]
    fn pgids_that_kill_would_read_as_wildcards_are_refused() {
        assert!(parse_ps_row("0 /usr/bin/node server.js").is_none());
        assert!(parse_ps_row("1 /sbin/init").is_none());
        assert!(parse_ps_row("-1 whatever").is_none());
        assert_eq!(parse_ps_row("2 /usr/bin/node").unwrap().pgid, 2);
    }

    #[test]
    fn lsof_cwd_is_the_name_field() {
        assert_eq!(
            parse_lsof_cwd("p123\nfcwd\nn/home/x/task\n"),
            Some(PathBuf::from("/home/x/task"))
        );
        assert_eq!(parse_lsof_cwd("p123\n"), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_listener_started_in_the_task_dir_is_the_tasks_own() {
        let (Ok(_), Ok(_)) = (which("lsof"), which("python3")) else {
            return;
        };
        let task = tempfile::TempDir::new().unwrap();
        let elsewhere = tempfile::TempDir::new().unwrap();
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let script = format!(
            "import socket,time;s=socket.socket();s.bind(('127.0.0.1',{port}));s.listen();time.sleep(30)"
        );
        let mut child = std::process::Command::new("python3")
            .args(["-c", &script])
            .current_dir(task.path())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while listening_pids(port).is_empty() && Instant::now() < deadline {
            sleep(Duration::from_millis(50));
        }
        let inside = listeners_inside(port, task.path());
        let outside = listeners_inside(port, elsewhere.path());
        let _ = child.kill();
        let _ = child.wait();
        assert!(inside, "a listener whose cwd is the task dir is the task's own");
        assert!(!outside, "a listener elsewhere is foreign");
    }

    #[cfg(target_os = "linux")]
    fn which(bin: &str) -> std::io::Result<std::process::Output> {
        std::process::Command::new("which").arg(bin).output().and_then(|o| {
            if o.status.success() { Ok(o) } else { Err(std::io::Error::other("missing")) }
        })
    }

    #[test]
    fn nothing_listening_is_not_the_tasks_own() {
        let dir = tempfile::TempDir::new().unwrap();
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert!(!listeners_inside(port, dir.path()));
    }

    #[test]
    fn a_pgid_with_no_argv_still_signals() {
        let row = parse_ps_row("7 ").unwrap();
        assert_eq!(row.pgid, 7);
        assert_eq!(row.command, "unknown");
    }
}
