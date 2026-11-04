//! The Linux process table, read as one `/proc/<pid>/stat` per process.
//!
//! sysinfo's process refresh also lists every thread on the box
//! (`/proc/<pid>/task/*`), even for `ProcessesToUpdate::Some`. On a loaded
//! machine (~13k threads) the status bar's 5 s poll cost the main thread ~3 s
//! of every 5 and kept ~12k stat files open. This reads processes only.

use std::fs;

#[derive(Debug, Clone, PartialEq)]
pub struct ProcStat {
    pub pid: u32,
    pub ppid: u32,
    pub sid: u32,
    pub name: String,
    pub state: char,
    /// utime + stime, in clock ticks.
    pub cpu_ticks: u64,
    pub rss_pages: u64,
}

/// Every live process. One that exits mid-scan is skipped.
pub fn snapshot() -> Vec<ProcStat> {
    let Ok(dir) = fs::read_dir("/proc") else {
        return Vec::new();
    };
    dir.filter_map(|entry| {
        let pid: u32 = entry.ok()?.file_name().to_str()?.parse().ok()?;
        let text = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        parse_stat(pid, &text)
    })
    .collect()
}

/// Field numbers are `proc_pid_stat(5)`'s. `comm` may hold spaces or `)`,
/// so it runs to the last `)`.
fn parse_stat(pid: u32, text: &str) -> Option<ProcStat> {
    let (head, rest) = text.rsplit_once(')')?;
    let name = head.split_once('(')?.1.to_string();
    let f: Vec<&str> = rest.split_whitespace().collect();
    let num = |field: usize| f.get(field - 3)?.parse::<u64>().ok();
    Some(ProcStat {
        pid,
        state: f.first()?.chars().next()?,
        ppid: num(4)? as u32,
        sid: num(6)? as u32,
        cpu_ticks: num(14)? + num(15)?,
        rss_pages: num(24)?,
        name,
    })
}

/// sysinfo's `ProcessStatus` labels, so the Task Explorer reads the same on
/// every platform.
pub fn status_label(state: char) -> &'static str {
    match state {
        'R' => "Runnable",
        'S' => "Sleeping",
        'I' => "Idle",
        'D' => "UninterruptibleDiskSleep",
        'Z' => "Zombie",
        'T' => "Stopped",
        't' => "Tracing",
        'X' | 'x' => "Dead",
        'K' => "Wakekill",
        'W' => "Waking",
        'P' => "Parked",
        _ => "Unknown",
    }
}

pub fn clock_ticks_per_sec() -> f32 {
    // SAFETY: sysconf reads a constant and touches no memory of ours.
    let n = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if n > 0 { n as f32 } else { 100.0 }
}

pub fn page_size() -> u64 {
    // SAFETY: as above.
    let n = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if n > 0 { n as u64 } else { 4096 }
}

/// SIGKILL every process in session `sid` except its leader.
pub fn kill_session_members(sid: u32) {
    for p in snapshot() {
        if p.sid == sid && p.pid != sid {
            // SAFETY: kill takes plain scalars.
            unsafe { libc::kill(p.pid as libc::pid_t, libc::SIGKILL) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_comm_with_spaces_and_parens() {
        let line = "4242 (Web Content (x)) S 100 4242 4200 0 -1 4194560 1 0 0 0 \
                    250 50 0 0 20 0 30 0 123 999 777 18446744073709551615";
        let p = parse_stat(4242, line).expect("parses");
        assert_eq!(p.name, "Web Content (x)");
        assert_eq!(p.state, 'S');
        assert_eq!(p.ppid, 100);
        assert_eq!(p.sid, 4200);
        assert_eq!(p.cpu_ticks, 300);
        assert_eq!(p.rss_pages, 777);
    }

    #[test]
    fn rejects_a_truncated_line() {
        assert_eq!(parse_stat(1, "1 (init) S 0 1"), None);
    }

    #[test]
    fn snapshot_finds_this_process() {
        let me = std::process::id();
        let p = snapshot().into_iter().find(|p| p.pid == me).expect("self listed");
        assert!(p.rss_pages > 0);
    }
}
