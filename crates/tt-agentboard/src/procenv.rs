//! Read a live process's environment to link a detected agent back to the PTY
//! session it runs in. Every agentboard PTY carries `TT_SESSION_ID` and
//! `TT_APP_INSTANCE` (the spawning app's pid); a Claude process launched inside
//! that shell inherits both.
//!
//! The instance stamp exists because `sessions.json` is shared across app
//! instances: two running apps materialize the same session records and stamp the
//! same `TT_SESSION_ID` on their own PTYs. Without the instance check, an agent
//! waiting in one app's PTY would flag "needs you" in every other app, on a pane
//! visibly doing something else. [`InstanceScope`] picks the policy: an app
//! window scopes to its own instance, the MCP server (no PTYs) to any.
//!
//! Linux reads `/proc/<pid>/environ`. Other platforms return `None` for now; the
//! platform-specific surface is confined to [`session_id_in_scope`].

use std::path::PathBuf;

/// The env var injected into every agentboard PTY at spawn, read back here to
/// attribute a detected agent to its session.
pub const TT_SESSION_ENV: &str = "TT_SESSION_ID";

/// The env var identifying which app instance spawned the PTY (the app's pid).
/// Distinguishes PTYs of two concurrently running app instances that host the
/// same shared session record.
pub const TT_INSTANCE_ENV: &str = "TT_APP_INSTANCE";

/// The instance id this process stamps on its PTYs: its pid. Unique among
/// concurrently live processes, which is the only window where two instances
/// can host the same session id at once.
pub fn instance_id() -> String {
    std::process::id().to_string()
}

/// Which app-spawned agents an engine host reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstanceScope {
    /// Only agents in PTYs stamped with this `TT_APP_INSTANCE` — an app window
    /// reports just the agents living in its own PTYs.
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

/// A live `claude` process discovered by scanning `/proc`, tagged with the
/// `TT_SESSION_ID` of the PTY it runs in and the transcript it has open. Lets
/// the engine surface an app-spawned agent even when `claude agents --all
/// --json` fails to enumerate it (e.g. a `--chrome` interactive session) — the
/// robust realization of the env-var linkage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionAgentProc {
    pub session_id: String,
    pub pid: i32,
    pub transcript: Option<PathBuf>,
}

/// Scan `/proc` for live `claude` processes carrying `TT_SESSION_ID` and
/// matching `scope`, one entry per matching process (the shell + MCP children
/// carry the vars too but are filtered out by process name). Linux-only; empty
/// elsewhere.
#[cfg(target_os = "linux")]
pub fn scan_session_agents(scope: &InstanceScope) -> Vec<SessionAgentProc> {
    let mut out = Vec::new();
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return out;
    };
    for entry in dir.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|s| s.parse::<i32>().ok()) else {
            continue;
        };
        // Only the Claude process itself, not the shell or the MCP children it
        // spawned (they all inherit the env var). `comm` is the truncated name.
        let comm = std::fs::read_to_string(format!("/proc/{pid}/comm")).unwrap_or_default();
        if comm.trim() != "claude" {
            continue;
        }
        // The shared `claude daemon` also reports `comm == "claude"` and can
        // inherit a PTY's TT_SESSION_ID when first spawned from an app shell;
        // without this it would be surfaced as an agent occupying that session.
        if is_claude_daemon(pid) {
            continue;
        }
        // Deliberately *not* `session_id_in_scope`: that re-verifies liveness
        // (another `comm` read plus another `cmdline` read) for callers who
        // take a pid from the stale CLI snapshot. This loop just established
        // both facts from `/proc` itself, so re-reading them is pure waste on
        // a path that runs on every payload rebuild.
        if let Some(sid) = scoped_session_id_of(pid, scope) {
            out.push(SessionAgentProc { session_id: sid, pid, transcript: open_transcript(pid) });
        }
    }
    out
}

/// Read `pid`'s environ and resolve its scoped `TT_SESSION_ID`, with **no**
/// liveness re-check. Only safe when the caller has just proven `pid` is a
/// live, non-daemon `claude` process; [`session_id_in_scope`] is the checked
/// entry point for everyone else.
#[cfg(target_os = "linux")]
fn scoped_session_id_of(pid: i32, scope: &InstanceScope) -> Option<String> {
    let bytes = std::fs::read(format!("/proc/{pid}/environ")).ok()?;
    scoped_session_id(&bytes, scope)
}

/// Whether `pid` is still a live, interactive `claude` process — i.e. reading
/// its environ is safe to trust as "this pid's PTY". Guards every
/// `/proc/<pid>/environ` read: `claude agents --all --json` is cached for up
/// to a minute ([`crate::watchers::claude_code::CLI_CACHE_TTL_MS`]), so a pid
/// it reported can exit and be recycled by the kernel for an unrelated
/// process — often another of this app's own shells, freshly spawned in a
/// *different* pane — well within that window. Reading environ from a
/// recycled pid without this check silently attributes the original agent to
/// whatever `TT_SESSION_ID` the new occupant carries: a wrong-pane
/// misattribution, not a crash, so it went unnoticed. Cheap (`comm` + one
/// `cmdline` read on the daemon-name match only) relative to the environ read
/// it guards.
#[cfg(target_os = "linux")]
fn is_live_claude_process(pid: i32) -> bool {
    let comm = std::fs::read_to_string(format!("/proc/{pid}/comm")).unwrap_or_default();
    comm.trim() == "claude" && !is_claude_daemon(pid)
}

#[cfg(not(target_os = "linux"))]
pub fn scan_session_agents(_scope: &InstanceScope) -> Vec<SessionAgentProc> {
    Vec::new()
}

/// The Claude session transcript (`…/<uuid>.jsonl`) the process has open via
/// `/proc/<pid>/fd`, skipping subagent transcripts. Used to derive the task
/// name + status for an agent the CLI snapshot didn't report.
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

/// Whether `pid` is the shared `claude daemon` process rather than an
/// interactive/background session. Reads `/proc/<pid>/cmdline`; the pure test
/// lives on [`is_daemon_argv`].
#[cfg(target_os = "linux")]
fn is_claude_daemon(pid: i32) -> bool {
    std::fs::read(format!("/proc/{pid}/cmdline")).map(|b| is_daemon_argv(&b)).unwrap_or(false)
}

/// Whether NUL-separated `argv` bytes describe `claude daemon …` (i.e. the
/// first argument after the program is `daemon`).
#[cfg(target_os = "linux")]
fn is_daemon_argv(cmdline: &[u8]) -> bool {
    cmdline.split(|&b| b == 0).nth(1) == Some(b"daemon".as_slice())
}

/// The `TT_SESSION_ID` of the PTY `pid` runs in, if that PTY was spawned by an
/// app instance `scope` admits. Verifies `pid` is still a live `claude`
/// process first ([`is_live_claude_process`]) — callers such as
/// [`crate::engine::collect_agent_snapshot`] take `pid` from a CLI snapshot
/// that can be up to a minute stale, so without this check a recycled pid
/// would have its *new* occupant's environ misread as the original agent's.
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

/// Whether the process `pid` was launched by an app instance `scope` admits.
/// Used to keep foreign Claude sessions off the board: externally-started ones
/// (no `TT_SESSION_ID` at all), and — for [`InstanceScope::Instance`] — ones
/// living in another app instance's PTYs.
///
/// Linux reads `/proc`. On platforms without env introspection we cannot tell
/// yet, so this returns `true` (assume ours) rather than hide every agent —
/// see [`session_id_in_scope`]'s follow-up note. Verified on Linux.
#[cfg(target_os = "linux")]
pub fn in_scope(pid: i32, scope: &InstanceScope) -> bool {
    session_id_in_scope(pid, scope).is_some()
}

#[cfg(not(target_os = "linux"))]
pub fn in_scope(_pid: i32, _scope: &InstanceScope) -> bool {
    true
}

/// The session id from environ bytes, if the stamped instance passes `scope`.
/// Pure and unit-tested (the platform-specific part is only the file read).
///
/// Under [`InstanceScope::Instance`] a shell is ours unless it carries a
/// *different* app's instance stamp. A **missing** stamp is admitted, not dropped:
/// a concurrent app always stamps its own pid, so an unstamped `TT_SESSION_ID` is
/// a shell we spawned before stamping existed — and dropping those blanked the
/// whole board on upgrade until every shell was respawned. Excluding only a
/// present-and-foreign stamp keeps the collision guard.
///
/// Reached only through the Linux `session_id_in_scope` (and tests); gated to
/// match so a macOS build doesn't see it as dead code.
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
///
/// Same gating as [`scoped_session_id`], its only non-test caller.
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
        // A var whose name merely contains the key must not match.
        let environ = b"NOT_TT_SESSION_ID=x\0OTHER=1\0";
        assert_eq!(read_var_from_environ(environ, TT_SESSION_ENV), None);
    }

    #[test]
    fn any_scope_admits_every_stamped_session() {
        let environ = b"TT_SESSION_ID=s00abc\0TT_APP_INSTANCE=1234\0";
        assert_eq!(scoped_session_id(environ, &InstanceScope::Any).as_deref(), Some("s00abc"));
        // Even one with no instance stamp (older spawn) — Any only requires the
        // session id.
        let unstamped = b"TT_SESSION_ID=s00abc\0";
        assert_eq!(scoped_session_id(unstamped, &InstanceScope::Any).as_deref(), Some("s00abc"));
    }

    #[test]
    fn instance_scope_excludes_only_a_foreign_stamp() {
        let environ = b"TT_SESSION_ID=s00abc\0TT_APP_INSTANCE=1234\0";
        let ours = InstanceScope::Instance("1234".into());
        let theirs = InstanceScope::Instance("5678".into());
        // Matching stamp → ours; a *different* app's stamp → not ours (the
        // shared-sessions.json collision the stamp guards against).
        assert_eq!(scoped_session_id(environ, &ours).as_deref(), Some("s00abc"));
        assert_eq!(scoped_session_id(environ, &theirs), None);
        // No stamp at all → still ours. A concurrent app always stamps its own
        // pid, so an unstamped shell can only be one we spawned before instance
        // stamping existed; dropping it (the old exact-match rule) blanked the
        // agent on every pre-existing shell after an app upgrade.
        let unstamped = b"TT_SESSION_ID=s00abc\0";
        assert_eq!(scoped_session_id(unstamped, &ours).as_deref(), Some("s00abc"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn session_id_in_scope_refuses_a_pid_that_isnt_claude() {
        // The test binary's own pid is a real, live process, but its `comm`
        // is the test binary's name, never "claude" — exactly the shape of a
        // recycled pid from a stale CLI snapshot. `session_id_in_scope` must
        // refuse it rather than trust whatever it finds in that process's
        // real environ.
        let pid = std::process::id() as i32;
        assert!(!is_live_claude_process(pid));
        assert_eq!(session_id_in_scope(pid, &InstanceScope::Any), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn daemon_argv_detected_but_interactive_is_not() {
        // `claude daemon run --origin transient` — argv[1] == "daemon".
        assert!(is_daemon_argv(b"/home/u/.local/bin/claude\0daemon\0run\0--origin\0transient\0"));
        // A plain interactive session — argv[1] is a flag, not "daemon".
        assert!(!is_daemon_argv(b"claude\0--permission-mode\0auto\0--chrome\0"));
        // Bare `claude` (no args) — nothing after the program.
        assert!(!is_daemon_argv(b"claude\0"));
    }

    #[test]
    fn empty_session_id_is_out_of_scope() {
        let environ = b"TT_SESSION_ID=\0TT_APP_INSTANCE=1234\0";
        assert_eq!(scoped_session_id(environ, &InstanceScope::Any), None);
        assert_eq!(scoped_session_id(environ, &InstanceScope::Instance("1234".into())), None);
    }
}
