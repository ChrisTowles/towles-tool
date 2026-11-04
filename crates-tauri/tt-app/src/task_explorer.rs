//! Task Explorer: a live process view of what this app is running — the `tt-app` process
//! plus each embedded terminal's shell and everything it spawned. Passive readout only;
//! this module never signals a process (kill lives on `terminal.rs`'s `term_kill`).
//!
//! A terminal's process set resolves the same way `terminal::kill_session_stragglers`
//! resolves what a kill reaches: on Unix, every process sharing the shell's POSIX session
//! id, which also catches a backgrounded subshell reparented to init. Windows has no
//! equivalent, so there it falls back to a parent-child tree walk from the shell pid —
//! less exact, but never pulling in unrelated processes the way a login-session id would.
//!
//! The status bar polls this every 5 s on the main thread, so on Linux it reads
//! `/proc/<pid>/stat` directly (see `procfs`) rather than through sysinfo.

use std::sync::Mutex;

use tauri::State;

use crate::terminal::TermState;

#[derive(Default)]
pub struct ExplorerState(Mutex<sampler::Sampler>);

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessRow {
    pid: u32,
    parent_pid: Option<u32>,
    name: String,
    cpu_percent: f32,
    memory_bytes: u64,
    status: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessGroup {
    term_id: Option<String>,
    label: String,
    rows: Vec<ProcessRow>,
    total_cpu_percent: f32,
    total_memory_bytes: u64,
}

/// What one sample yields: the app's own row, then each shell's rows in the
/// order the shells were given.
struct Sample {
    app: Option<ProcessRow>,
    shells: Vec<Vec<ProcessRow>>,
}

#[tauri::command]
pub fn task_explorer_snapshot(
    explorer: State<'_, ExplorerState>,
    term_state: State<'_, TermState>,
) -> Vec<ProcessGroup> {
    let Ok(mut sampler) = explorer.0.lock() else {
        return Vec::new();
    };
    let shells = term_state.shell_pid_labels();
    let shell_pids: Vec<u32> = shells.iter().map(|(_, pid, _)| *pid).collect();
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1) as f32;
    let sample = sampler.sample(std::process::id(), &shell_pids, cores);

    let mut groups = Vec::new();
    if let Some(row) = sample.app {
        groups.push(group(None, "tt-app".to_string(), vec![row]));
    }
    for ((term_id, _, label), mut rows) in shells.into_iter().zip(sample.shells) {
        if rows.is_empty() {
            continue;
        }
        rows.sort_by_key(|r| r.pid);
        groups.push(group(Some(term_id), label, rows));
    }
    groups
}

fn group(term_id: Option<String>, label: String, rows: Vec<ProcessRow>) -> ProcessGroup {
    ProcessGroup {
        term_id,
        label,
        total_cpu_percent: rows.iter().map(|r| r.cpu_percent).sum(),
        total_memory_bytes: rows.iter().map(|r| r.memory_bytes).sum(),
        rows,
    }
}

#[cfg(target_os = "linux")]
mod sampler {
    use std::collections::{HashMap, HashSet};
    use std::time::Instant;

    use super::{ProcessRow, Sample};
    use crate::procfs::{self, ProcStat};

    /// CPU% is a delta, so each sample keeps the last one's tick counts.
    #[derive(Default)]
    pub struct Sampler {
        last: Option<(Instant, HashMap<u32, u64>)>,
    }

    impl Sampler {
        pub fn sample(&mut self, app_pid: u32, shell_pids: &[u32], cores: f32) -> Sample {
            let now = Instant::now();
            let wanted: HashSet<u32> = shell_pids.iter().copied().collect();
            let procs: Vec<ProcStat> = procfs::snapshot()
                .into_iter()
                .filter(|p| p.pid == app_pid || wanted.contains(&p.sid) || wanted.contains(&p.pid))
                .collect();

            let ticks = procfs::clock_ticks_per_sec();
            let page = procfs::page_size();
            let last = self.last.take();
            let row = |p: &ProcStat| {
                let cpu_percent = match &last {
                    Some((at, prev)) => match prev.get(&p.pid) {
                        Some(&before) => {
                            let secs = now.duration_since(*at).as_secs_f32().max(f32::EPSILON);
                            p.cpu_ticks.saturating_sub(before) as f32 / ticks / secs * 100.0 / cores
                        }
                        None => 0.0,
                    },
                    None => 0.0,
                };
                ProcessRow {
                    pid: p.pid,
                    parent_pid: (p.ppid != 0).then_some(p.ppid),
                    name: p.name.clone(),
                    cpu_percent,
                    memory_bytes: p.rss_pages * page,
                    status: procfs::status_label(p.state).to_string(),
                }
            };

            let sample = Sample {
                app: procs.iter().find(|p| p.pid == app_pid).map(row),
                shells: shell_pids
                    .iter()
                    .map(|&shell| {
                        procs.iter().filter(|p| p.sid == shell || p.pid == shell).map(row).collect()
                    })
                    .collect(),
            };
            self.last = Some((now, procs.iter().map(|p| (p.pid, p.cpu_ticks)).collect()));
            sample
        }
    }
}

#[cfg(not(target_os = "linux"))]
mod sampler {
    #[cfg(not(unix))]
    use std::collections::HashMap;
    use std::collections::HashSet;

    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

    use super::{ProcessRow, Sample};

    pub struct Sampler(System);

    impl Default for Sampler {
        fn default() -> Self {
            Self(System::new())
        }
    }

    impl Sampler {
        pub fn sample(&mut self, app_pid: u32, shell_pids: &[u32], cores: f32) -> Sample {
            let sys = &mut self.0;
            // Every live process, not just known pids: the member set isn't
            // known until processes() is walked.
            sys.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing().with_cpu().with_memory(),
            );
            Sample {
                app: process_row(sys, Pid::from_u32(app_pid), cores),
                shells: shell_pids
                    .iter()
                    .map(|&shell| {
                        related_pids(sys, Pid::from_u32(shell))
                            .into_iter()
                            .filter_map(|pid| process_row(sys, pid, cores))
                            .collect()
                    })
                    .collect(),
            }
        }
    }

    /// `None` for a pid sysinfo can't resolve, or one that resolves to a thread
    /// rather than a real process — see `related_pids`'s doc for why threads
    /// must never reach a `ProcessRow`.
    fn process_row(sys: &System, pid: Pid, cores: f32) -> Option<ProcessRow> {
        let p = sys.process(pid)?;
        if p.thread_kind().is_some() {
            return None;
        }
        Some(ProcessRow {
            pid: pid.as_u32(),
            parent_pid: p.parent().map(|pp| pp.as_u32()),
            name: p.name().to_string_lossy().into_owned(),
            cpu_percent: p.cpu_usage() / cores,
            memory_bytes: p.memory(),
            status: p.status().to_string(),
        })
    }

    /// Every pid belonging to `shell_pid`'s process set, including the shell itself.
    /// Threads never qualify: a thread shares its process's session id, and an
    /// unfiltered sweep N-counted one process's memory once per thread.
    #[cfg(unix)]
    fn related_pids(sys: &System, shell_pid: Pid) -> HashSet<Pid> {
        sys.processes()
            .iter()
            .filter(|(pid, p)| {
                p.thread_kind().is_none()
                    && (**pid == shell_pid || p.session_id() == Some(shell_pid))
            })
            .map(|(pid, _)| *pid)
            .collect()
    }

    /// No POSIX session id on Windows, so descend the parent-child tree instead
    /// — still catches ordinary subprocesses, just not a fully detached one.
    #[cfg(not(unix))]
    fn related_pids(sys: &System, shell_pid: Pid) -> HashSet<Pid> {
        let mut children_by_parent: HashMap<Pid, Vec<Pid>> = HashMap::new();
        for (pid, p) in sys.processes() {
            if p.thread_kind().is_some() {
                continue;
            }
            if let Some(parent) = p.parent() {
                children_by_parent.entry(parent).or_default().push(*pid);
            }
        }

        let mut related = HashSet::new();
        let mut stack = vec![shell_pid];
        while let Some(pid) = stack.pop() {
            if !related.insert(pid) {
                continue;
            }
            if let Some(children) = children_by_parent.get(&pid) {
                stack.extend(children.iter().copied());
            }
        }
        related
    }
}
