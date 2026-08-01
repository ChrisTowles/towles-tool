//! The PTY registry: one [`Session`] per live terminal, plus what the rest of
//! the app reads off it.
//!
//! **Every lock of the session map is taken in this file**, and only ever for map
//! surgery — never across a PTY write, a subprocess, or a kill/wait. The command
//! modules keep to that by going through the accessors below; a fresh
//! `sessions.lock()` elsewhere is how the contract gets lost.
//!
//! [`PtyActivity`] is written by the vt thread on its render path and read by the
//! emit path, so it is atomics rather than a mutex: nothing waits, and no two
//! fields need to agree.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::mpsc::{SyncSender, TrySendError};
use std::sync::{Arc, Mutex};

use portable_pty::{Child, MasterPty, PtySize};
use sysinfo::{Pid as SysPid, ProcessRefreshKind, ProcessesToUpdate, System};
use tt_vt::{Input as VtInput, KeyEvent, Sender as VtSender};

use super::open_path::process_cwd;

/// A webview reload restarts every terminal, so id reuse is routine — and a
/// replaced PTY's reader must recognize it was superseded, not close its
/// successor.
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

pub(super) fn next_generation() -> u64 {
    NEXT_GENERATION.fetch_add(1, Ordering::Relaxed)
}

#[derive(Debug, Default)]
pub struct PtyActivity {
    /// The vt session renders only on a changed screen, so this tracks the
    /// program, not a timer.
    last_output_ms: AtomicI64,
    output_since_ms: AtomicI64,
    pub(super) attention_at_ms: AtomicI64,
    /// Answers a pending attention notification, so **every write on the user's
    /// behalf must stamp it**; the `stamp_and_*` accessors are how.
    input_at_ms: AtomicI64,
}

impl PtyActivity {
    pub(super) fn stamp(field: &AtomicI64, now: i64) {
        field.store(now, Ordering::Relaxed);
    }

    fn read(field: &AtomicI64) -> Option<i64> {
        match field.load(Ordering::Relaxed) {
            0 => None,
            ms => Some(ms),
        }
    }

    fn signal(&self) -> tt_agentboard::pty_status::PtySignal {
        tt_agentboard::pty_status::PtySignal {
            last_output_ms: Self::read(&self.last_output_ms),
            output_since_ms: Self::read(&self.output_since_ms),
            attention_at_ms: Self::read(&self.attention_at_ms),
            input_at_ms: Self::read(&self.input_at_ms),
        }
    }

    /// Whether this began a fresh burst — the only edge worth waking the emitter
    /// for, since per frame rebuilds the payload ~90 times a second.
    pub(super) fn note_output(&self, now: i64) -> bool {
        let previous = self.last_output_ms.swap(now, Ordering::Relaxed);
        let fresh_burst = previous == 0
            || now.saturating_sub(previous) >= tt_agentboard::pty_status::OUTPUT_ACTIVE_MS;
        if fresh_burst {
            Self::stamp(&self.output_since_ms, now);
        }
        fresh_burst
    }
}

pub(super) struct Session {
    pub(super) master: Box<dyn MasterPty + Send>,
    pub(super) input: SyncSender<Vec<u8>>,
    pub(super) vt: VtSender,
    pub(super) child: Box<dyn Child + Send + Sync>,
    pub(super) generation: u64,
    pub(super) shell_kind: String,
    /// Dropped with the session, lockfile and all. `None` if it failed to start:
    /// the shell works, it just gets no IDE pairing.
    pub(super) ide: Option<crate::ide::IdeServer>,
    pub(super) dir: Option<PathBuf>,
    /// OSC 7, restamped by the vt sink. Many shells never emit it, hence
    /// [`TermState::open_base_dirs`].
    pub(super) pwd: Arc<Mutex<Option<PathBuf>>>,
    pub(super) env_ports_at_spawn: BTreeMap<String, u16>,
    pub(super) activity: Arc<PtyActivity>,
}

pub struct PtyEmitState {
    pub live: HashSet<String>,
    pub shell_kinds: HashMap<String, String>,
    pub signals: HashMap<String, tt_agentboard::pty_status::PtySignal>,
    pub port_drift: HashMap<String, Vec<tt_agentboard::env_drift::PortDrift>>,
}

#[derive(Default)]
pub struct TermState {
    sessions: Mutex<HashMap<String, Session>>,
    focused: Mutex<Option<String>>,
}

/// The frontend can call into a pane whose shell has already exited.
const NO_SHELL: &str = "no shell running";

impl TermState {
    // --- reaching one session --------------------------------------------
    // The whole vocabulary the command modules have: take the lock, do one
    // cheap thing, drop it. Anything that waits happens after the call.

    pub(super) fn send(&self, term_id: &str, input: VtInput) -> Result<(), String> {
        let guard = self.sessions.lock().unwrap();
        let session = guard.get(term_id).ok_or(NO_SHELL)?;
        let _ = session.vt.send(input);
        Ok(())
    }

    pub(super) fn stamp_and_send(&self, term_id: &str, input: VtInput) -> Result<(), String> {
        let guard = self.sessions.lock().unwrap();
        let session = guard.get(term_id).ok_or(NO_SHELL)?;
        PtyActivity::stamp(&session.activity.input_at_ms, crate::agentboard::now_ms());
        let _ = session.vt.send(input);
        Ok(())
    }

    /// Carries a reply channel, so a dead engine must error rather than drop
    /// silently — else the caller waits out its whole timeout for nothing.
    pub(super) fn send_expecting_reply(
        &self,
        term_id: &str,
        stamp: bool,
        input: VtInput,
    ) -> Result<(), String> {
        let guard = self.sessions.lock().unwrap();
        let session = guard.get(term_id).ok_or(NO_SHELL)?;
        if stamp {
            PtyActivity::stamp(&session.activity.input_at_ms, crate::agentboard::now_ms());
        }
        if !session.vt.send(input) {
            return Err("terminal engine gone".to_string());
        }
        Ok(())
    }

    pub(super) fn queue_write(&self, term_id: &str, bytes: Vec<u8>) -> Result<(), String> {
        let guard = self.sessions.lock().unwrap();
        let session = guard.get(term_id).ok_or(NO_SHELL)?;
        PtyActivity::stamp(&session.activity.input_at_ms, crate::agentboard::now_ms());
        match session.input.try_send(bytes) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                Err("terminal input backed up (shell not reading)".into())
            }
            Err(TrySendError::Disconnected(_)) => Err(NO_SHELL.into()),
        }
    }

    /// PTY (SIGWINCH) and engine (next frame's shape), which must not drift.
    pub(super) fn resize(
        &self,
        term_id: &str,
        cols: u16,
        rows: u16,
        cell_w: u16,
        cell_h: u16,
    ) -> Result<(), String> {
        let guard = self.sessions.lock().unwrap();
        let session = guard.get(term_id).ok_or(NO_SHELL)?;
        session
            .master
            .resize(PtySize { rows, cols, pixel_width: cols * cell_w, pixel_height: rows * cell_h })
            .map_err(|e| e.to_string())?;
        let _ = session.vt.send(VtInput::Resize {
            cols,
            rows,
            cell_width_px: u32::from(cell_w),
            cell_height_px: u32::from(cell_h),
        });
        Ok(())
    }

    pub(super) fn insert(&self, term_id: String, session: Session) {
        self.sessions.lock().unwrap().insert(term_id, session);
    }

    pub(super) fn take_if_current(&self, term_id: &str, generation: u64) -> Option<Session> {
        let mut guard = self.sessions.lock().unwrap();
        if guard.get(term_id).is_some_and(|s| s.generation == generation) {
            return guard.remove(term_id);
        }
        None
    }

    // --- focus ---------------------------------------------------------------

    pub(super) fn is_focused(&self, term_id: &str) -> bool {
        self.focused.lock().unwrap().as_deref() == Some(term_id)
    }

    /// A blur clears focus only if this terminal still owns it, so a reordered
    /// handoff can't wipe B's focus.
    pub(super) fn set_focus(&self, term_id: String, focused: bool) {
        let mut current = self.focused.lock().unwrap();
        if focused {
            *current = Some(term_id);
        } else if current.as_deref() == Some(term_id.as_str()) {
            *current = None;
        }
    }

    /// Skips the webview; only `macos_keys` needs it, since Cocoa swallows some
    /// Ctrl chords before WKWebView sees a keydown. The return also consumes the
    /// OS event — never report `true` undelivered.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn send_key_to_focused(&self, event: KeyEvent) -> bool {
        let Some(term_id) = self.focused.lock().unwrap().clone() else {
            return false;
        };
        self.stamp_and_send(&term_id, VtInput::Key(event)).is_ok()
    }

    // --- what the rest of the app reads ------------------------------------

    /// What a clicked path might be relative *to*, best guess first. A list
    /// because neither live source is reliable alone: OSC 7 needs a willing
    /// shell, /proc is Linux-only.
    pub(super) fn open_base_dirs(&self, term_id: &str) -> Vec<PathBuf> {
        let (pwd, pid, spawned) = {
            let guard = self.sessions.lock().unwrap();
            let Some(session) = guard.get(term_id) else {
                return Vec::new();
            };
            (Arc::clone(&session.pwd), session.child.process_id(), session.dir.clone())
        };
        let osc7 = pwd.lock().unwrap().clone();
        let mut dirs: Vec<PathBuf> = Vec::new();
        for dir in [osc7, pid.and_then(process_cwd), spawned].into_iter().flatten() {
            if !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
        dirs
    }

    pub fn live_ids(&self) -> HashSet<String> {
        self.sessions.lock().unwrap().keys().cloned().collect()
    }

    /// **One** pass under **one** lock; the alternative retakes the
    /// keystroke-path lock once per accessor.
    pub fn emit_state(&self) -> PtyEmitState {
        let (live, shell_kinds, signals) = {
            let guard = self.sessions.lock().unwrap();
            let live = guard.keys().cloned().collect();
            let shell_kinds =
                guard.iter().map(|(id, s)| (id.clone(), s.shell_kind.clone())).collect();
            let signals = guard.iter().map(|(id, s)| (id.clone(), s.activity.signal())).collect();
            (live, shell_kinds, signals)
        };
        PtyEmitState { live, shell_kinds, signals, port_drift: self.port_drift() }
    }

    /// What each folder's `.env` claimed at spawn vs now. **The reads happen
    /// after the lock drops** — file I/O under the keystroke path's lock puts a
    /// disk read between a keypress and the terminal.
    fn port_drift(&self) -> HashMap<String, Vec<tt_agentboard::env_drift::PortDrift>> {
        let sessions: Vec<(String, PathBuf, BTreeMap<String, u16>)> = {
            let guard = self.sessions.lock().unwrap();
            guard
                .iter()
                .filter_map(|(id, s)| {
                    let dir = s.dir.as_ref()?;
                    Some((id.clone(), dir.clone(), s.env_ports_at_spawn.clone()))
                })
                .collect()
        };
        let mut current_by_dir: HashMap<PathBuf, BTreeMap<String, u16>> = HashMap::new();
        sessions
            .into_iter()
            .filter_map(|(id, dir, at_spawn)| {
                let current = current_by_dir
                    .entry(dir.clone())
                    .or_insert_with(|| tt_agentboard::env_drift::read_current_ports(&dir));
                let drift = tt_agentboard::env_drift::diff(&at_spawn, current);
                (!drift.is_empty()).then_some((id, drift))
            })
            .collect()
    }

    pub fn shell_pid_labels(&self) -> Vec<(String, u32, String)> {
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(id, s)| {
                let pid = s.child.process_id()?;
                let dir_name = s
                    .dir
                    .as_deref()
                    .and_then(|d| d.file_name())
                    .and_then(|n| n.to_str())
                    .unwrap_or("?");
                Some((id.clone(), pid, format!("{} — {dir_name}", s.shell_kind)))
            })
            .collect()
    }

    /// `f` does only cheap in-memory work, so holding the lock across it keeps
    /// the contract.
    pub(crate) fn for_ide_servers(&self, dir: &Path, mut f: impl FnMut(&crate::ide::IdeServer)) {
        let guard = self.sessions.lock().unwrap();
        for session in guard.values() {
            if let Some(ide) = &session.ide
                && same_dir(ide.cwd(), dir)
            {
                f(ide);
            }
        }
    }

    pub(crate) fn ide_statuses(&self) -> Vec<crate::ide::IdeStatus> {
        let guard = self.sessions.lock().unwrap();
        guard.values().filter_map(|s| s.ide.as_ref().map(|ide| ide.status())).collect()
    }

    // --- teardown ----------------------------------------------------------

    /// After the lock is released. `pub(crate)` so task removal can clear a
    /// folder's PTYs before its worktree goes.
    pub(crate) fn kill(&self, term_id: &str) {
        let session = self.sessions.lock().unwrap().remove(term_id);
        if let Some(session) = session {
            reap(session);
        }
    }

    pub(super) fn kill_all(&self) {
        let sessions: Vec<Session> =
            self.sessions.lock().unwrap().drain().map(|(_, s)| s).collect();
        for session in sessions {
            reap(session);
        }
    }
}

/// Sweeps the POSIX session too: SIGHUP reaches only jobs the shell tracks.
fn reap(mut session: Session) {
    let shell_pid = session.child.process_id();
    let _ = session.child.kill();
    if let Some(pid) = shell_pid {
        kill_session_stragglers(pid);
    }
    let _ = session.child.wait();
}

/// A backgrounded subshell keeps the session id for life, even reparented to
/// init; one that called `setsid` is spared, being a real detach. Unix-only —
/// Windows' `session_id` is the login session.
#[cfg(unix)]
fn kill_session_stragglers(shell_pid: u32) {
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let sid = SysPid::from_u32(shell_pid);
    for (pid, process) in sys.processes() {
        if *pid != sid && process.session_id() == Some(sid) {
            process.kill();
        }
    }
}

#[cfg(not(unix))]
fn kill_session_stragglers(_shell_pid: u32) {}

fn same_dir(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

#[cfg(test)]
mod tests {
    use super::TermState;

    /// `kill(pid, 0)` — no signal sent, just an existence probe.
    #[cfg(unix)]
    fn pid_alive(pid: i32) -> bool {
        // SAFETY: `kill` is async-signal-safe and takes plain scalars; signal 0
        // sends nothing, so no process state can be observed or corrupted.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    /// `(sleep 30 &)` reparents to init, beyond the shell's `SIGHUP`, but keeps
    /// the session id. It must still be killed; the leader must not be.
    #[cfg(unix)]
    #[test]
    fn kill_session_stragglers_reaps_detached_background_jobs() {
        use std::io::Read;
        use std::os::unix::process::CommandExt;
        use std::process::{Command, Stdio};

        let pid_file =
            std::env::temp_dir().join(format!("tt-term-test-{}-{}.pid", std::process::id(), 0));
        let script = format!("(sleep 30 & echo $! > {}); sleep 30", pid_file.to_string_lossy());

        // A session leader via setsid in pre_exec, as unix.rs does for every
        // PTY child.
        // SAFETY: `pre_exec` runs between fork and exec, where only
        // async-signal-safe calls are legal; this allocates and locks nothing.
        let mut leader = unsafe {
            Command::new("sh")
                .arg("-c")
                .arg(&script)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .pre_exec(|| {
                    if libc::setsid() == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                })
                .spawn()
                .expect("spawn session leader")
        };
        let leader_pid = leader.id() as i32;

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut detached_pid = None;
        while std::time::Instant::now() < deadline {
            if let Ok(mut f) = std::fs::File::open(&pid_file) {
                let mut s = String::new();
                let _ = f.read_to_string(&mut s);
                if let Ok(pid) = s.trim().parse::<i32>() {
                    detached_pid = Some(pid);
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let _ = std::fs::remove_file(&pid_file);
        let detached_pid = detached_pid.expect("detached process wrote its pid in time");
        assert!(pid_alive(detached_pid), "detached process should have started");

        super::kill_session_stragglers(leader_pid as u32);

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < deadline && pid_alive(detached_pid) {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(!pid_alive(detached_pid), "detached process should have been killed");
        assert!(pid_alive(leader_pid), "the session leader itself must survive the sweep");

        let _ = leader.kill();
        let _ = leader.wait();
    }

    #[test]
    fn focus_gate_tracks_the_focused_terminal() {
        let state = TermState::default();
        assert!(!state.is_focused("a"), "nothing focused initially");

        state.set_focus("a".into(), true);
        assert!(state.is_focused("a"));
        assert!(!state.is_focused("b"));

        // Focus handoff a -> b: b becomes focused, a is not.
        state.set_focus("b".into(), true);
        assert!(state.is_focused("b"));
        assert!(!state.is_focused("a"));

        // A reordered blur from a must NOT clear b's focus.
        state.set_focus("a".into(), false);
        assert!(state.is_focused("b"), "stale blur from a leaves b focused");

        state.set_focus("b".into(), false);
        assert!(!state.is_focused("b"));
    }
}
