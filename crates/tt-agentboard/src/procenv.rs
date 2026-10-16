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

pub const TT_SESSION_ENV: &str = "TT_SESSION_ID";

pub const TT_INSTANCE_ENV: &str = "TT_APP_INSTANCE";

pub fn instance_id() -> String {
    std::process::id().to_string()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstanceScope {
    Instance(String),
    Any,
}

impl InstanceScope {
    pub fn this_app() -> Self {
        Self::Instance(instance_id())
    }
}

/// A live `claude` process found by scanning `/proc`, tagged with its PTY's
/// `TT_SESSION_ID`. Surfaces an app-spawned agent the cached `claude agents
/// --all --json` hasn't listed yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionAgentProc {
    pub session_id: String,
    pub pid: i32,
}

/// Find the live `claude` processes under `shell_pids` (the host's PTY shells,
/// themselves included) that carry `TT_SESSION_ID` and match `scope`. Walks only
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
        if let Some(sid) = scoped_session_id_of(pid, scope) {
            out.push(SessionAgentProc { session_id: sid, pid });
        }
    }
    out
}

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

#[cfg(target_os = "linux")]
fn is_claude_daemon(pid: i32) -> bool {
    std::fs::read(format!("/proc/{pid}/cmdline")).map(|b| is_daemon_argv(&b)).unwrap_or(false)
}

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
        let unstamped = b"TT_SESSION_ID=s00abc\0";
        assert_eq!(scoped_session_id(unstamped, &ours).as_deref(), Some("s00abc"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn session_id_in_scope_refuses_a_pid_that_isnt_claude() {
        let pid = std::process::id() as i32;
        assert!(!is_live_claude_process(pid));
        assert_eq!(session_id_in_scope(pid, &InstanceScope::Any), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn child_pids_lists_a_spawned_child() {
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let pid = child.id() as i32;
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
