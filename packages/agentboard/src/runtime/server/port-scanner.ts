import { debugLog } from "../debug";

// Global port snapshot — refreshed by the port poll timer, read by computeState.
// Runs lsof + ps once for ALL sessions instead of per-session.
let portSnapshot = new Map<string, number[]>();

export function refreshPortSnapshot(sessionNames: string[]): boolean {
  try {
    // 1. Gather pane PIDs for all sessions in one tmux call per session
    const panePidsBySession = new Map<string, number[]>();
    for (const name of sessionNames) {
      const r = Bun.spawnSync(["tmux", "list-panes", "-s", "-t", name, "-F", "#{pane_pid}"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const pids = r.stdout
        .toString()
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(Number)
        .filter((n) => !Number.isNaN(n));
      if (pids.length > 0) panePidsBySession.set(name, pids);
    }

    if (panePidsBySession.size === 0) {
      portSnapshot = new Map();
      return false;
    }

    // 2. Build parent->children map from a single ps call
    const childrenOf = new Map<number, number[]>();
    const psResult = Bun.spawnSync(["ps", "-eo", "pid=,ppid="], { stdout: "pipe", stderr: "pipe" });
    for (const line of psResult.stdout.toString().trim().split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const pid = Number.parseInt(parts[0], 10);
      const ppid = Number.parseInt(parts[1], 10);
      if (Number.isNaN(pid) || Number.isNaN(ppid)) continue;
      let arr = childrenOf.get(ppid);
      if (!arr) {
        arr = [];
        childrenOf.set(ppid, arr);
      }
      arr.push(pid);
    }

    // 3. BFS from pane PIDs to get full descendant tree per session
    const pidToSessions = new Map<number, string[]>();
    for (const [name, panePids] of panePidsBySession) {
      const allPids = new Set<number>(panePids);
      const queue = [...panePids];
      while (queue.length > 0) {
        const pid = queue.pop()!;
        const kids = childrenOf.get(pid);
        if (!kids) continue;
        for (const kid of kids) {
          if (!allPids.has(kid)) {
            allPids.add(kid);
            queue.push(kid);
          }
        }
      }
      for (const pid of allPids) {
        let arr = pidToSessions.get(pid);
        if (!arr) {
          arr = [];
          pidToSessions.set(pid, arr);
        }
        arr.push(name);
      }
    }

    // 4. Single lsof call for all listening TCP ports
    const lsofResult = Bun.spawnSync(["lsof", "-iTCP", "-sTCP:LISTEN", "-nP", "-F", "pn"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (lsofResult.exitCode !== 0) {
      debugLog("ports", "lsof failed", {
        exitCode: lsofResult.exitCode,
        stderr: lsofResult.stderr.toString().slice(0, 200),
      });
      return false;
    }

    // 5. Parse and attribute ports to sessions
    const sessionPorts = new Map<string, Set<number>>();
    let currentPid = 0;
    for (const line of lsofResult.stdout.toString().split("\n")) {
      if (line.startsWith("p")) {
        currentPid = Number.parseInt(line.slice(1), 10);
      } else if (line.startsWith("n")) {
        const sessions = pidToSessions.get(currentPid);
        if (!sessions) continue;
        const match = line.match(/:(\d+)$/);
        if (!match) continue;
        const port = Number.parseInt(match[1], 10);
        if (Number.isNaN(port)) continue;
        for (const name of sessions) {
          let set = sessionPorts.get(name);
          if (!set) {
            set = new Set();
            sessionPorts.set(name, set);
          }
          set.add(port);
        }
      }
    }

    // 6. Build the new snapshot
    const next = new Map<string, number[]>();
    for (const name of sessionNames) {
      const set = sessionPorts.get(name);
      next.set(name, set ? [...set].sort((a, b) => a - b) : []);
    }

    const changed = !mapsEqual(portSnapshot, next);
    portSnapshot = next;
    return changed;
  } catch (err) {
    debugLog("ports", "refreshPortSnapshot failed", { error: String(err) });
    return false;
  }
}

function mapsEqual(a: Map<string, number[]>, b: Map<string, number[]>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const bv = b.get(k);
    if (!bv || bv.length !== v.length || v.some((n, i) => n !== bv[i])) return false;
  }
  return true;
}

export function getSessionPorts(sessionName: string): number[] {
  return portSnapshot.get(sessionName) ?? [];
}

export function startPortPoll(ctx: {
  lastState: { sessions: { name: string }[] } | null;
  clientCount: number;
  broadcastState: () => void;
}): ReturnType<typeof setInterval> {
  // Run initial snapshot immediately so first broadcast has ports
  if (ctx.lastState) {
    refreshPortSnapshot(ctx.lastState.sessions.map((s) => s.name));
  }
  const PORT_POLL_INTERVAL_MS = 10_000;
  return setInterval(() => {
    if (!ctx.lastState || ctx.clientCount === 0) return;
    const changed = refreshPortSnapshot(ctx.lastState.sessions.map((s) => s.name));
    if (changed) ctx.broadcastState();
  }, PORT_POLL_INTERVAL_MS);
}
