//! Read a live process's environment to link a detected agent back to the PTY
//! session it runs in. Every agentboard PTY carries `TT_SESSION_ID` and
//! `TT_APP_INSTANCE` (the spawning app's pid); a Claude process launched inside
//! that shell inherits both.
//!
//! The instance stamp exists because `sessions.json` is shared across app
//! instances: two running apps materialize the same session records and stamp
//! the same `TT_SESSION_ID` on their own PTYs. Without it, an agent waiting in
//! one app's PTY would flag "needs you" in every other app. [`InstanceScope`]
//! picks the policy: an app window scopes to its own instance, the MCP server
//! (no PTYs) to any. Linux reads `/proc/<pid>/environ`; other platforms return
//! `None` for now.

use std::path::PathBuf;

/// Injected into every agentboard PTY at spawn, read back here to attribute a
/// detected agent to its session.
pub const TT_SESSION_ENV: &str = "TT_SESSION_ID";

/// Which app instance spawned the PTY (that app's pid).
pub const TT_INSTANCE_ENV: &str = "TT_APP_INSTANCE";

/// The instance id this process stamps on its PTYs: its pid.
pub fn instance_id() -> String {
    std::process::id().to_string()
}

/// Which app-spawned agents an engine host reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstanceScope {
    /// Only agents in PTYs stamped with this `TT_APP_INSTANCE`.
    Instance(String),
    /// Agents in any app instance's PTYs — the MCP server's cross-cutting view.
    Any,
}

impl InstanceScope {
    /// Scope to the running process ([`instance_id`]) — what an app host uses.
    pub fn this_app() -> Self {
        Self::Instance(instance_id())
    }
}

/// A live `claude` process found by scanning `/proc`, tagged with its PTY's
/// `TT_SESSION_ID` and the transcript it has open. Surfaces an app-spawned
/// agent even when `claude agents --all --json` fails to enumerate it (e.g. a
/// `--chrome` interactive session).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionAgentProc {
    pub session_id: String,
    pub pid: i32,
    pub transcript: Option<PathBuf>,
    /// Epoch ms, like the CLI's `startedAt`.
    pub started_at: Option<i64>,
}

/// Find the live `claude` processes under `shell_pids` (the host's PTY shells,
/// themselves included) that carry `TT_SESSION_ID` and match `scope`. Walks only
/// those trees, never all of `/proc`, and stops at the first `claude` on a
/// branch. Linux-only; empty elsewhere.
#[cfg(target_os = "linux")]
pub fn scan_session_agents(shell_pids: &[u32], scope: &InstanceScope) -> Vec<SessionAgentProc> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut stack: Vec<i32> = shell_pids.iter().filter_map(|&p| i32::try_from(p).ok()).collect();
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        let comm = std::fs::read_to_string(format!("/proc/{pid}/comm")).unwrap_or_default();
        if comm.trim() != "claude" {
            stack.extend(child_pids(pid));
            continue;
        }
        // The shared `claude daemon` also reports `comm == "claude"` and can
        // inherit a PTY's TT_SESSION_ID, showing up as an agent in that session.
        if is_claude_daemon(pid) {
            continue;
        }
        // Deliberately *not* `session_id_in_scope`: this loop just established
        // liveness from `/proc`, so its re-check is pure waste here.
        if let Some(sid) = scoped_session_id_of(pid, scope) {
            out.push(SessionAgentProc {
                session_id: sid,
                pid,
                transcript: open_transcript(pid),
                started_at: process_started_at_ms(pid),
            });
        }
    }
    out
}

/// A child is listed under the thread that forked it, so read every thread's.
#[cfg(target_os = "linux")]
fn child_pids(pid: i32) -> Vec<i32> {
    let Ok(tasks) = std::fs::read_dir(format!("/proc/{pid}/task")) else {
        return Vec::new();
    };
    tasks
        .flatten()
        .filter_map(|task| std::fs::read_to_string(task.path().join("children")).ok())
        .flat_map(|list| {
            list.split_whitespace().filter_map(|s| s.parse::<i32>().ok()).collect::<Vec<_>>()
        })
        .collect()
}

/// Resolve `pid`'s scoped `TT_SESSION_ID` with **no** liveness re-check. Only
/// safe once the caller has proven `pid` is a live, non-daemon `claude`
/// process; [`session_id_in_scope`] is the checked entry point.
#[cfg(target_os = "linux")]
fn scoped_session_id_of(pid: i32, scope: &InstanceScope) -> Option<String> {
    let bytes = std::fs::read(format!("/proc/{pid}/environ")).ok()?;
    scoped_session_id(&bytes, scope)
}

/// Whether `pid` is still a live, interactive `claude` process. Guards every
/// environ read: `claude agents --all --json` is cached for up to a minute
/// ([`crate::watchers::claude_code::CLI_CACHE_TTL_MS`]), so a pid it reported
/// can be recycled onto another of our shells inside that window — attributing
/// the agent to the wrong pane, silently.
#[cfg(target_os = "linux")]
fn is_live_claude_process(pid: i32) -> bool {
    let comm = std::fs::read_to_string(format!("/proc/{pid}/comm")).unwrap_or_default();
    comm.trim() == "claude" && !is_claude_daemon(pid)
}

#[cfg(not(target_os = "linux"))]
pub fn scan_session_agents(_shell_pids: &[u32], _scope: &InstanceScope) -> Vec<SessionAgentProc> {
    Vec::new()
}

/// The session transcript (`…/<uuid>.jsonl`) open on `/proc/<pid>/fd`, skipping
/// subagent ones. Derives name + status for an agent the CLI didn't report.
#[cfg(target_os = "linux")]
fn open_transcript(pid: i32) -> Option<PathBuf> {
    let fd_dir = std::fs::read_dir(format!("/proc/{pid}/fd")).ok()?;
    fd_dir.flatten().find_map(|e| {
        let target = std::fs::read_link(e.path()).ok()?;
        let s = target.to_string_lossy();
        let ok =
            s.ends_with(".jsonl") && s.contains("/.claude/projects/") && !s.contains("/subagents/");
        ok.then_some(target)
    })
}

/// `pid`'s start time: its `/proc/<pid>/stat` start tick past boot, at the
/// fixed `USER_HZ` of 100 that `/proc` reports in.
#[cfg(target_os = "linux")]
fn process_started_at_ms(pid: i32) -> Option<i64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let ticks: i64 = stat.rsplit_once(')')?.1.split_whitespace().nth(19)?.parse().ok()?;
    let boot = std::fs::read_to_string("/proc/stat").ok()?;
    let btime: i64 = boot.lines().find_map(|l| l.strip_prefix("btime "))?.trim().parse().ok()?;
    Some(btime * 1000 + ticks * 10)
}

/// Whether `pid` is the shared `claude daemon` rather than a session.
#[cfg(target_os = "linux")]
fn is_claude_daemon(pid: i32) -> bool {
    std::fs::read(format!("/proc/{pid}/cmdline")).map(|b| is_daemon_argv(&b)).unwrap_or(false)
}

/// Whether NUL-separated `argv` bytes describe `claude daemon …`.
#[cfg(target_os = "linux")]
fn is_daemon_argv(cmdline: &[u8]) -> bool {
    cmdline.split(|&b| b == 0).nth(1) == Some(b"daemon".as_slice())
}

/// The `TT_SESSION_ID` of the PTY `pid` runs in, if that PTY was spawned by an
/// app instance `scope` admits. Re-checks liveness first
/// ([`is_live_claude_process`]) because callers pass pids from a stale snapshot.
#[cfg(target_os = "linux")]
pub fn session_id_in_scope(pid: i32, scope: &InstanceScope) -> Option<String> {
    if !is_live_claude_process(pid) {
        return None;
    }
    scoped_session_id_of(pid, scope)
}

#[cfg(not(target_os = "linux"))]
pub fn session_id_in_scope(_pid: i32, _scope: &InstanceScope) -> Option<String> {
    // macOS/other: no `/proc`. Follow-up: `ps eww <pid>` or libproc.
    None
}

/// Whether the process `pid` was launched by an app instance `scope` admits —
/// what keeps foreign Claude sessions off the board. Without `/proc` we cannot
/// tell, so non-Linux returns `true` rather than hide every agent.
#[cfg(target_os = "linux")]
pub fn in_scope(pid: i32, scope: &InstanceScope) -> bool {
    session_id_in_scope(pid, scope).is_some()
}

#[cfg(not(target_os = "linux"))]
pub fn in_scope(_pid: i32, _scope: &InstanceScope) -> bool {
    true
}

/// The session id from environ bytes, if the stamped instance passes `scope`.
///
/// Under [`InstanceScope::Instance`] a shell is ours unless it carries a
/// *different* app's stamp. A **missing** stamp is admitted: a concurrent app
/// always stamps its own pid, so an unstamped shell is one we spawned before
/// stamping existed — dropping those blanked the board on upgrade.
#[cfg(any(target_os = "linux", test))]
fn scoped_session_id(bytes: &[u8], scope: &InstanceScope) -> Option<String> {
    let sid = read_var_from_environ(bytes, TT_SESSION_ENV).filter(|s| !s.is_empty())?;
    match scope {
        InstanceScope::Any => Some(sid),
        InstanceScope::Instance(id) => match read_var_from_environ(bytes, TT_INSTANCE_ENV) {
            Some(stamp) if stamp != *id => None,
            _ => Some(sid),
        },
    }
}

/// Extract a variable's value from NUL-separated `KEY=VALUE` environ bytes.
#[cfg(any(target_os = "linux", test))]
fn read_var_from_environ(bytes: &[u8], key: &str) -> Option<String> {
    let prefix = format!("{key}=");
    bytes.split(|&b| b == 0).find_map(|entry| {
        let s = std::str::from_utf8(entry).ok()?;
        s.strip_prefix(&prefix).map(str::to_string)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_var_from_nul_separated_environ() {
        let environ = b"PATH=/usr/bin\0TT_SESSION_ID=s00abc\0SHELL=/bin/zsh\0";
        assert_eq!(read_var_from_environ(environ, TT_SESSION_ENV).as_deref(), Some("s00abc"));
        assert_eq!(read_var_from_environ(environ, "SHELL").as_deref(), Some("/bin/zsh"));
    }

    #[test]
    fn missing_var_is_none_and_no_prefix_false_match() {
        let environ = b"NOT_TT_SESSION_ID=x\0OTHER=1\0";
        assert_eq!(read_var_from_environ(environ, TT_SESSION_ENV), None);
    }

    #[test]
    fn any_scope_admits_every_stamped_session() {
        let environ = b"TT_SESSION_ID=s00abc\0TT_APP_INSTANCE=1234\0";
        assert_eq!(scoped_session_id(environ, &InstanceScope::Any).as_deref(), Some("s00abc"));
        let unstamped = b"TT_SESSION_ID=s00abc\0";
        assert_eq!(scoped_session_id(unstamped, &InstanceScope::Any).as_deref(), Some("s00abc"));
    }

    #[test]
    fn instance_scope_excludes_only_a_foreign_stamp() {
        let environ = b"TT_SESSION_ID=s00abc\0TT_APP_INSTANCE=1234\0";
        let ours = InstanceScope::Instance("1234".into());
        let theirs = InstanceScope::Instance("5678".into());
        assert_eq!(scoped_session_id(environ, &ours).as_deref(), Some("s00abc"));
        assert_eq!(scoped_session_id(environ, &theirs), None);
        // No stamp at all → still ours; dropping those blanked every
        // pre-existing shell's agent after an app upgrade.
        let unstamped = b"TT_SESSION_ID=s00abc\0";
        assert_eq!(scoped_session_id(unstamped, &ours).as_deref(), Some("s00abc"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn session_id_in_scope_refuses_a_pid_that_isnt_claude() {
        // Live pid, wrong `comm` — the shape of a recycled pid from a stale
        // CLI snapshot, which must be refused rather than read.
        let pid = std::process::id() as i32;
        assert!(!is_live_claude_process(pid));
        assert_eq!(session_id_in_scope(pid, &InstanceScope::Any), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn process_start_is_in_the_past_and_after_boot() {
        let started = process_started_at_ms(std::process::id() as i32).unwrap();
        let now = tt_config::now_ms();
        assert!(started <= now && now - started < 24 * 60 * 60 * 1000, "{started} vs {now}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn child_pids_lists_a_spawned_child() {
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let pid = child.id() as i32;
        // `children` can miss a child while other test threads fork.
        let listed = (0..100).any(|_| {
            std::thread::sleep(std::time::Duration::from_millis(10));
            child_pids(std::process::id() as i32).contains(&pid)
        });
        let _ = child.kill();
        let _ = child.wait();
        assert!(listed);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn daemon_argv_detected_but_interactive_is_not() {
        assert!(is_daemon_argv(b"/home/u/.local/bin/claude\0daemon\0run\0--origin\0transient\0"));
        assert!(!is_daemon_argv(b"claude\0--permission-mode\0auto\0--chrome\0"));
        assert!(!is_daemon_argv(b"claude\0"));
    }

    #[test]
    fn empty_session_id_is_out_of_scope() {
        let environ = b"TT_SESSION_ID=\0TT_APP_INSTANCE=1234\0";
        assert_eq!(scoped_session_id(environ, &InstanceScope::Any), None);
        assert_eq!(scoped_session_id(environ, &InstanceScope::Instance("1234".into())), None);
    }
}
