import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentStatus } from "../contracts/agent";
import { TERMINAL_STATUSES } from "../contracts/agent";
import type { SidebarPane } from "../contracts/mux";
import type { ServerContext, PaneAgentPresence } from "./context";
import { shell } from "./git-info";

const AGENT_TITLE_PATTERNS: Record<string, string[]> = {
  amp: ["amp"],
  "claude-code": ["claude"],
  codex: ["codex"],
  opencode: ["opencode"],
};

/** Build parent->children map from a single ps snapshot (avoids per-pane pgrep calls).
 *  Skips stopped (T) and zombie (Z) processes — they have a comm but aren't actively running. */
function buildProcessTree(): { childrenOf: Map<number, number[]>; commOf: Map<number, string> } {
  const childrenOf = new Map<number, number[]>();
  const commOf = new Map<number, string>();
  const psResult = Bun.spawnSync(["ps", "-eo", "pid=,ppid=,stat=,comm="], {
    stdout: "pipe",
    stderr: "pipe",
  });
  for (const line of psResult.stdout.toString().trim().split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const pid = Number.parseInt(parts[0], 10);
    const ppid = Number.parseInt(parts[1], 10);
    const stat = parts[2] ?? "";
    const comm = parts.slice(3).join(" ").toLowerCase();
    if (Number.isNaN(pid) || Number.isNaN(ppid)) continue;
    // First char of stat is the primary process state.
    // T = stopped (e.g. Ctrl+Z), Z = zombie, X = dead. Treat all as not-running.
    const state = stat.charAt(0);
    if (state === "T" || state === "Z" || state === "X") continue;
    commOf.set(pid, comm);
    let arr = childrenOf.get(ppid);
    if (!arr) {
      arr = [];
      childrenOf.set(ppid, arr);
    }
    arr.push(pid);
  }
  return { childrenOf, commOf };
}

/** Walk up to 3 levels of child processes using a pre-built process tree. */
function matchProcessTreeFast(
  pid: number,
  patterns: string[],
  tree: ReturnType<typeof buildProcessTree>,
  depth = 0,
): boolean {
  if (depth > 2) return false;
  const children = tree.childrenOf.get(pid);
  if (!children) return false;
  for (const childPid of children) {
    const comm = tree.commOf.get(childPid);
    if (comm && patterns.some((pat) => comm.includes(pat))) return true;
    if (matchProcessTreeFast(childPid, patterns, tree, depth + 1)) return true;
  }
  return false;
}

/** Find child PID matching a name pattern using pre-built process tree. */
function findChildPidFast(
  pid: number,
  name: string,
  tree: ReturnType<typeof buildProcessTree>,
  depth = 0,
): number | undefined {
  if (depth > 2) return undefined;
  const children = tree.childrenOf.get(pid);
  if (!children) return undefined;
  for (const childPid of children) {
    const comm = tree.commOf.get(childPid);
    if (comm?.includes(name)) return childPid;
    const found = findChildPidFast(childPid, name, tree, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** Resolve threadId/threadName for an amp pane from its title. */
function resolveAmpPaneInfo(title: string): { threadId?: string; threadName?: string } {
  if (!title.toLowerCase().startsWith("amp - ")) return {};
  const rest = title.slice(6);
  const dashIdx = rest.lastIndexOf(" - ");
  const threadName = dashIdx > 0 ? rest.slice(0, dashIdx) : rest;
  return { threadName: threadName || undefined };
}

/** Resolve threadId/threadName/status for a Claude Code pane via ~/.claude/sessions/<pid>.json + journal. */
function resolveClaudeCodePaneInfo(
  panePid: number,
  tree: ReturnType<typeof buildProcessTree>,
): { threadId?: string; threadName?: string; status?: AgentStatus } {
  const agentPid = findChildPidFast(panePid, "claude", tree);
  if (!agentPid) return {};
  const sessionsDir = join(homedir(), ".claude", "sessions");
  try {
    const data = JSON.parse(readFileSync(join(sessionsDir, `${agentPid}.json`), "utf-8"));
    const threadId: string | undefined = data.sessionId;
    if (!threadId) return {};
    const journalInfo = resolveClaudeCodeJournalInfo(threadId);
    // Process is alive (found via process tree), so terminal journal status
    // means it's waiting for user input.
    if (journalInfo.status && TERMINAL_STATUSES.has(journalInfo.status)) {
      journalInfo.status = "waiting";
    }
    return { threadId, ...journalInfo };
  } catch {
    return {};
  }
}

/** Read the JSONL journal to extract thread name and current status. */
function resolveClaudeCodeJournalInfo(threadId: string): {
  threadName?: string;
  status?: AgentStatus;
} {
  const projectsDir = join(homedir(), ".claude", "projects");
  try {
    const dirs = require("node:fs").readdirSync(projectsDir) as string[];
    for (const dir of dirs) {
      const filePath = join(projectsDir, dir, `${threadId}.jsonl`);
      try {
        const text = readFileSync(filePath, "utf-8");
        const lines = text.split("\n").filter(Boolean);
        let threadName: string | undefined;
        let lastStatus: AgentStatus = "idle";

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            const msg = entry.message;
            if (!msg?.role) continue;

            if (!threadName && msg.role === "user") {
              const content = msg.content;
              let t: string | undefined;
              if (typeof content === "string") t = content;
              else if (Array.isArray(content))
                t = content.find((c: any) => c.type === "text" && c.text)?.text;
              if (t && !t.startsWith("<") && !t.startsWith("{")) threadName = t.slice(0, 80);
            }

            if (msg.role === "assistant") {
              const items = Array.isArray(msg.content) ? msg.content : [];
              const toolUses = items.filter((c: any) => c.type === "tool_use");
              if (toolUses.length === 0) {
                lastStatus = "done";
              } else {
                lastStatus = toolUses.every((c: any) => c.name === "AskUserQuestion")
                  ? "question"
                  : "running";
              }
            } else if (msg.role === "user") {
              lastStatus = "running";
            }
          } catch {
            continue;
          }
        }

        return { threadName, status: lastStatus };
      } catch {
        continue;
      }
    }
  } catch {
    // intentionally ignored: Claude projects dir missing or unreadable
  }
  return {};
}

/** Resolve threadId for a Codex pane via logs_1.sqlite. */
function resolveCodexPaneInfo(
  panePid: number,
  tree: ReturnType<typeof buildProcessTree>,
): { threadId?: string; threadName?: string } {
  const agentPid = findChildPidFast(panePid, "codex", tree);
  if (!agentPid) return {};
  const dbPath = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "logs_1.sqlite");
  let db: any;
  try {
    const { Database } = require("bun:sqlite");
    db = new Database(dbPath, { readonly: true });
  } catch {
    return {};
  }
  try {
    const row = db
      .query(
        `SELECT thread_id FROM logs WHERE process_uuid LIKE ? AND thread_id IS NOT NULL ORDER BY ts DESC LIMIT 1`,
      )
      .get(`pid:${agentPid}:%`);
    if (row?.thread_id) return { threadId: row.thread_id };
  } catch {
    // intentionally ignored: Codex sqlite query failed — no thread info available
  } finally {
    try {
      db.close();
    } catch {
      // intentionally ignored: best-effort sqlite handle cleanup
    }
  }
  return {};
}

/** Scan all panes across all tmux sessions and identify running agents.
 *  Uses a single `tmux list-panes -a` call for efficiency. */
function scanAllTmuxPaneAgents(
  listSidebarPanesByProvider: () => { panes: SidebarPane[] }[],
): Map<string, Map<string, PaneAgentPresence>> {
  const result = new Map<string, Map<string, PaneAgentPresence>>();

  const raw = shell([
    "tmux",
    "list-panes",
    "-a",
    "-F",
    "#{session_name}|#{pane_id}|#{pane_pid}|#{pane_current_command}|#{pane_title}",
  ]);
  if (!raw) return result;

  const panes = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const idx1 = line.indexOf("|");
      const idx2 = line.indexOf("|", idx1 + 1);
      const idx3 = line.indexOf("|", idx2 + 1);
      const idx4 = line.indexOf("|", idx3 + 1);
      return {
        session: line.slice(0, idx1),
        id: line.slice(idx1 + 1, idx2),
        pid: Number.parseInt(line.slice(idx2 + 1, idx3), 10),
        cmd: line.slice(idx3 + 1, idx4),
        title: line.slice(idx4 + 1),
      };
    });

  // Exclude sidebar panes
  const sidebarPaneIds = new Set<string>();
  for (const { panes: sbPanes } of listSidebarPanesByProvider()) {
    for (const sb of sbPanes) sidebarPaneIds.add(sb.paneId);
  }

  const nonSidebar = panes.filter((p) => !sidebarPaneIds.has(p.id));
  if (nonSidebar.length === 0) return result;

  // Build process tree once for all panes
  const tree = buildProcessTree();
  const now = Date.now();

  for (const pane of nonSidebar) {
    for (const [agentName, patterns] of Object.entries(AGENT_TITLE_PATTERNS)) {
      if (!matchProcessTreeFast(pane.pid, patterns, tree)) continue;

      let threadId: string | undefined;
      let threadName: string | undefined;
      let status: AgentStatus | undefined;

      if (agentName === "amp") {
        const info = resolveAmpPaneInfo(pane.title);
        threadName = info.threadName;
      } else if (agentName === "claude-code") {
        const info = resolveClaudeCodePaneInfo(pane.pid, tree);
        threadId = info.threadId;
        threadName = info.threadName;
        status = info.status;
      } else if (agentName === "codex") {
        const info = resolveCodexPaneInfo(pane.pid, tree);
        threadId = info.threadId;
      }

      const key = `${agentName}:pane:${pane.id}`;
      let sessionAgents = result.get(pane.session);
      if (!sessionAgents) {
        sessionAgents = new Map();
        result.set(pane.session, sessionAgents);
      }
      sessionAgents.set(key, {
        agent: agentName,
        session: pane.session,
        paneId: pane.id,
        threadId,
        threadName,
        status,
        lastSeenTs: now,
      });
    }
  }

  return result;
}

/** Refresh pane agent cache for all tmux sessions. */
export function refreshPaneAgents(ctx: ServerContext): void {
  const hasTmux = ctx.allProviders.some((p) => p.name === "tmux");
  if (!hasTmux) {
    if (ctx.paneAgentsBySession.size > 0) {
      ctx.paneAgentsBySession.clear();
      ctx.tracker.setPinnedInstancesMulti(new Map());
      ctx.broadcastState();
    }
    return;
  }

  const nextBySession = scanAllTmuxPaneAgents(ctx.listSidebarPanesByProvider);
  const allPinnedKeys = new Map<string, string[]>();
  for (const [session, agents] of nextBySession) {
    allPinnedKeys.set(session, [...agents.keys()]);
  }

  // Check if anything changed
  let changed = ctx.paneAgentsBySession.size !== nextBySession.size;
  if (!changed) {
    for (const [session, agents] of nextBySession) {
      const prev = ctx.paneAgentsBySession.get(session);
      if (!prev || prev.size !== agents.size) {
        changed = true;
        break;
      }
      for (const key of agents.keys()) {
        if (!prev.has(key)) {
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }

  ctx.paneAgentsBySession = nextBySession;
  ctx.tracker.setPinnedInstancesMulti(allPinnedKeys);

  if (changed) ctx.broadcastState();
}

const PANE_SCAN_INTERVAL_MS = 3_000;

export function startPaneScan(ctx: ServerContext): ReturnType<typeof setInterval> {
  return setInterval(() => {
    if (ctx.clientCount === 0) return;
    refreshPaneAgents(ctx);
  }, PANE_SCAN_INTERVAL_MS);
}
