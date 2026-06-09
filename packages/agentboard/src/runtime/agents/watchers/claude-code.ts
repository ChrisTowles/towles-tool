/**
 * Claude Code agent watcher
 *
 * Watches ~/.claude/projects/ for JSONL file changes,
 * determines agent status from journal entries, and emits events
 * mapped to mux sessions via the project directory encoded in folder names.
 *
 * Directory structure: ~/.claude/projects/<encoded-path>/<session-id>.jsonl
 * Encoded path: /Users/foo/myproject → -Users-foo-myproject
 *
 * All file I/O is async to avoid blocking the server event loop.
 */

import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { AgentStatus, SubagentInfo, LoopInfo } from "../../contracts/agent";
import type { AgentWatcher, AgentWatcherContext } from "../../contracts/agent-watcher";
import { JOURNAL_IDLE_TIMEOUT_MS } from "../../shared";
import { createClaudePidLookup } from "./claude-pid";
import type { ClaudePidLookup } from "./claude-pid";
import { extractUsageSummary } from "./claude-usage";
import type { ClaudeUsageSummary } from "./claude-usage";

// --- Types ---

interface ContentItem {
  type?: string;
  text?: string;
  name?: string;
  input?: { delaySeconds?: number; reason?: string };
}

interface JournalEntry {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: ContentItem[] | string;
  };
}

interface SessionState {
  status: AgentStatus;
  fileSize: number;
  threadName?: string;
  projectDir?: string;
  usage?: ClaudeUsageSummary;
  lastTool?: string;
  subagents?: SubagentInfo[];
  /** Stable signature of `subagents`, used to detect changes without deep comparison. */
  subagentSig?: string;
  loop?: LoopInfo;
}

const POLL_MS = 2000;
const STALE_MS = 5 * 60 * 1000;
const JSONL_SUFFIX = ".jsonl";

// --- Status detection ---

export function determineStatus(entry: JournalEntry): AgentStatus | null {
  const msg = entry.message;
  if (!msg?.role) return null;

  const content = msg.content;
  const items: ContentItem[] = Array.isArray(content)
    ? content
    : typeof content === "string"
      ? [{ type: "text", text: content }]
      : [];

  if (msg.role === "assistant") {
    const toolUses = items.filter((c) => c.type === "tool_use");
    if (toolUses.length === 0) return "done";
    const allAsking = toolUses.every((c) => c.name === "AskUserQuestion");
    return allAsking ? "question" : "running";
  }

  if (msg.role === "user") return "running";

  return null;
}

function extractThreadName(entry: JournalEntry): string | undefined {
  const msg = entry.message;
  if (msg?.role !== "user") return undefined;

  const content = msg.content;
  let text: string | undefined;

  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content.find((c) => c.type === "text" && c.text)?.text;
  }

  if (!text) return undefined;
  // Skip system/internal messages
  if (text.startsWith("<") || text.startsWith("{")) return undefined;
  return text.slice(0, 80);
}

export function extractLastTool(entries: JournalEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    const msg = entry.message;
    if (msg?.role !== "assistant") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (item.type !== "tool_use") continue;
      if (!item.name) continue;
      if (item.name === "AskUserQuestion") continue;
      return item.name;
    }
  }
  return undefined;
}

/** Extract self-paced `/loop` state from the most recent ScheduleWakeup tool call.
 * Returns the scheduled next-wake time; the caller treats a future `nextWakeAt` as
 * "looping, sleeping between iterations" and a past one as "loop ended". */
export function extractLoopState(entries: JournalEntry[]): LoopInfo | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.message?.role !== "assistant") continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (item.type !== "tool_use" || item.name !== "ScheduleWakeup") continue;
      const delaySeconds = item.input?.delaySeconds;
      const scheduledAt = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
      if (typeof delaySeconds !== "number" || Number.isNaN(scheduledAt)) return undefined;
      return { nextWakeAt: scheduledAt + delaySeconds * 1000, reason: item.input?.reason };
    }
  }
  return undefined;
}

// --- Sub-agent (workflow / background Task) detection ---

interface SubagentMeta {
  agentType?: string;
  description?: string;
}

/** Build a stable, order-independent signature for a set of sub-agents so the watcher
 * can detect changes (a new agent spinning up, one going idle) without deep comparison. */
export function subagentSignature(subagents: SubagentInfo[]): string {
  return subagents
    .map((s) => `${s.agentType ?? ""} ${s.description ?? ""}`)
    .sort()
    .join("");
}

/**
 * Scan a session's `subagents/` directory for currently-active sub-agents.
 *
 * Claude Code writes each sub-agent (workflow fan-out, background Task/Agent) to
 * `<session-id>/subagents/agent-<id>.jsonl` with a sibling `agent-<id>.meta.json`.
 * A sub-agent counts as "active" when its journal was modified within
 * `JOURNAL_IDLE_TIMEOUT_MS` — finished agents leave stale files behind.
 *
 * Returns most-recently-active first. Best-effort: missing dir / unreadable meta yields fewer entries.
 */
export async function readActiveSubagents(
  subagentsDir: string,
  now: number,
): Promise<SubagentInfo[]> {
  let files: string[];
  try {
    files = await readdir(subagentsDir);
  } catch {
    return [];
  }

  const active: { info: SubagentInfo; mtimeMs: number }[] = [];
  for (const file of files) {
    if (!file.startsWith("agent-") || !file.endsWith(JSONL_SUFFIX)) continue;
    const filePath = join(subagentsDir, file);

    let mtimeMs: number;
    try {
      mtimeMs = (await stat(filePath)).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtimeMs > JOURNAL_IDLE_TIMEOUT_MS) continue;

    let info: SubagentInfo = {};
    const metaPath = `${filePath.slice(0, -JSONL_SUFFIX.length)}.meta.json`;
    try {
      const meta = JSON.parse(await Bun.file(metaPath).text()) as SubagentMeta;
      info = { agentType: meta.agentType, description: meta.description };
    } catch {
      // intentionally ignored: meta may not be written yet; still count the agent
    }
    active.push({ info, mtimeMs });
  }

  active.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return active.map((a) => a.info);
}

/** Decode Claude's encoded project dir name back to a path.
 * Claude Code encodes `/` as `-` with no escape for literal dashes,
 * so paths like `/home/user/my-project` are ambiguous with `/home/user/my/project`.
 * This is a known Claude Code limitation. */
function decodeProjectDir(encoded: string): string {
  return encoded.replace(/-/g, "/");
}

// --- Usage summary → AgentEventDetails ---

export function summaryToDetails(
  s: ClaudeUsageSummary,
): import("../../contracts/agent").AgentEventDetails {
  return {
    model: s.model,
    contextUsed: s.contextUsed,
    contextMax: s.contextMax,
    cacheExpiresAt: s.cacheExpiresAt ?? undefined,
    cacheTtlMs: s.cacheTtlMs ?? undefined,
    lastActivityAt: s.lastActivityAt,
  };
}

function buildDetails(
  usage: ClaudeUsageSummary | undefined,
  lastTool: string | undefined,
  subagents: SubagentInfo[] | undefined,
  loop: LoopInfo | undefined,
): import("../../contracts/agent").AgentEventDetails | undefined {
  const hasSubagents = subagents != null && subagents.length > 0;
  if (!usage && !lastTool && !hasSubagents && !loop) return undefined;
  const base = usage ? summaryToDetails(usage) : {};
  if (lastTool) base.lastTool = lastTool;
  if (hasSubagents) base.subagents = subagents;
  if (loop) base.loop = loop;
  return base;
}

// --- Watcher implementation ---

export class ClaudeCodeAgentWatcher implements AgentWatcher {
  readonly name = "claude-code";

  private sessions = new Map<string, SessionState>();
  private fsWatchers: FSWatcher[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private ctx: AgentWatcherContext | null = null;
  private projectsDir: string;
  private scanning = false;
  private seeded = false;
  private pidLookup: ClaudePidLookup;

  constructor(pidLookup: ClaudePidLookup = createClaudePidLookup()) {
    this.projectsDir = join(homedir(), ".claude", "projects");
    this.pidLookup = pidLookup;
  }

  start(ctx: AgentWatcherContext): void {
    this.ctx = ctx;
    this.setupWatchers();
    setTimeout(() => this.scan(), 50);
    this.pollTimer = setInterval(() => this.scan(), POLL_MS);
  }

  stop(): void {
    for (const w of this.fsWatchers) {
      try {
        w.close();
      } catch {
        // intentionally ignored: watcher may already be closed during shutdown
      }
    }
    this.fsWatchers = [];
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.ctx = null;
  }

  private async processFile(filePath: string, projectDir: string): Promise<void> {
    if (!this.ctx) return;

    let size: number;
    try {
      size = (await stat(filePath)).size;
    } catch {
      return;
    }

    const threadId = basename(filePath, ".jsonl");
    const prev = this.sessions.get(threadId);

    // Sub-agents (workflow fan-out / background Tasks) write to a sibling dir while the
    // parent journal can stay static for minutes — scan on every poll, not just on growth.
    const subagentsDir = join(filePath.slice(0, -JSONL_SUFFIX.length), "subagents");
    const subagents = await readActiveSubagents(subagentsDir, Date.now());
    const subagentSig = subagentSignature(subagents);

    if (prev && size === prev.fileSize) {
      // Post-seed: check if the process is actually still alive.
      if (this.seeded && prev.status === "running") {
        const pid = await this.pidLookup.pidForThread(threadId);
        const processGone = pid != null && !this.pidLookup.isAlive(pid);

        let becomeIdle = false;
        if (processGone) {
          becomeIdle = true;
        } else {
          try {
            const mtime = (await stat(filePath)).mtimeMs;
            if (Date.now() - mtime > JOURNAL_IDLE_TIMEOUT_MS) becomeIdle = true;
          } catch {
            // intentionally ignored: stat failure leaves becomeIdle unchanged
          }
        }

        if (becomeIdle) {
          prev.status = "idle";
          prev.subagents = subagents;
          prev.subagentSig = subagentSig;
          const session = prev.projectDir ? this.ctx?.resolveSession(prev.projectDir) : undefined;
          if (session) {
            this.ctx?.emit({
              agent: "claude-code",
              session,
              status: "idle",
              ts: Date.now(),
              threadId,
              threadName: prev.threadName,
              details: buildDetails(prev.usage, prev.lastTool, subagents, prev.loop),
            });
          }
          return;
        }
      }

      // Main journal unchanged, but the live sub-agent set may have shifted (workflow progress).
      if (subagentSig !== (prev.subagentSig ?? "")) {
        prev.subagents = subagents;
        prev.subagentSig = subagentSig;
        const session = prev.projectDir ? this.ctx?.resolveSession(prev.projectDir) : undefined;
        if (session) {
          this.ctx?.emit({
            agent: "claude-code",
            session,
            status: prev.status,
            ts: Date.now(),
            threadId,
            threadName: prev.threadName,
            details: buildDetails(prev.usage, prev.lastTool, subagents, prev.loop),
          });
        }
      }
      return;
    }

    // Seed mode: read last entry to capture real status for post-seed emit
    if (!this.seeded) {
      let text: string;
      try {
        text = await Bun.file(filePath).text();
      } catch {
        return;
      }

      const lines = text.split("\n").filter(Boolean);

      const parsed: JournalEntry[] = [];
      for (const line of lines) {
        try {
          parsed.push(JSON.parse(line) as JournalEntry);
        } catch {
          continue;
        }
      }

      let latestStatus: AgentStatus = "idle";
      let threadName: string | undefined;
      for (const entry of parsed) {
        if (!threadName) {
          const name = extractThreadName(entry);
          if (name) threadName = name;
        }
        latestStatus = determineStatus(entry) ?? latestStatus;
      }

      const usage = extractUsageSummary(parsed) ?? undefined;
      const lastTool = extractLastTool(parsed);
      const loop = extractLoopState(parsed);

      // If "running" but journal file is stale, the process likely exited
      if (latestStatus === "running") {
        try {
          const mtime = (await stat(filePath)).mtimeMs;
          if (Date.now() - mtime > JOURNAL_IDLE_TIMEOUT_MS) latestStatus = "idle";
        } catch {
          // intentionally ignored: stat failure leaves status unchanged
        }
      }

      this.sessions.set(threadId, {
        status: latestStatus,
        fileSize: size,
        threadName,
        projectDir,
        usage,
        lastTool,
        subagents,
        subagentSig,
        loop,
      });
      return;
    }

    const offset = prev?.fileSize ?? 0;
    if (size <= offset) return;

    let text: string;
    try {
      const buf = await Bun.file(filePath).arrayBuffer();
      text = new TextDecoder().decode(new Uint8Array(buf).subarray(offset, size));
    } catch {
      return;
    }

    const lines = text.split("\n").filter(Boolean);

    const parsed: JournalEntry[] = [];
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line) as JournalEntry);
      } catch {
        continue;
      }
    }

    let latestStatus: AgentStatus = prev?.status ?? "idle";
    let threadName = prev?.threadName;
    for (const entry of parsed) {
      if (!threadName) {
        const name = extractThreadName(entry);
        if (name) threadName = name;
      }
      latestStatus = determineStatus(entry) ?? latestStatus;
    }

    // Merge new usage summary onto the previous one (incremental reads may not include the latest assistant turn)
    const newUsage = extractUsageSummary(parsed);
    const usage = newUsage ?? prev?.usage;
    const newLastTool = extractLastTool(parsed);
    const lastTool = newLastTool ?? prev?.lastTool;
    const loop = extractLoopState(parsed) ?? prev?.loop;

    if (latestStatus === "running") {
      const pid = await this.pidLookup.pidForThread(threadId);
      if (pid != null && !this.pidLookup.isAlive(pid)) {
        latestStatus = "idle";
      }
    }

    const prevStatus = prev?.status;
    this.sessions.set(threadId, {
      status: latestStatus,
      fileSize: size,
      threadName,
      projectDir,
      usage,
      lastTool,
      subagents,
      subagentSig,
      loop,
    });

    if (
      latestStatus !== prevStatus ||
      subagentSig !== (prev?.subagentSig ?? "") ||
      loop?.nextWakeAt !== prev?.loop?.nextWakeAt
    ) {
      const session = this.ctx.resolveSession(projectDir);
      if (session) {
        this.ctx.emit({
          agent: "claude-code",
          session,
          status: latestStatus,
          ts: Date.now(),
          threadId,
          threadName,
          details: buildDetails(usage, lastTool, subagents, loop),
        });
      }
    }
  }

  private async scan(): Promise<void> {
    if (this.scanning || !this.ctx) return;
    this.scanning = true;
    this.pidLookup.invalidate();

    try {
      let dirs: string[];
      try {
        dirs = await readdir(this.projectsDir);
      } catch {
        return;
      }
      const now = Date.now();

      for (const dir of dirs) {
        const dirPath = join(this.projectsDir, dir);
        try {
          if (!(await stat(dirPath)).isDirectory()) continue;
        } catch {
          continue;
        }

        const projectDir = decodeProjectDir(dir);

        let files: string[];
        try {
          files = await readdir(dirPath);
        } catch {
          continue;
        }

        for (const file of files) {
          if (!file.endsWith(".jsonl")) continue;
          const filePath = join(dirPath, file);
          let fileStat;
          try {
            fileStat = await stat(filePath);
          } catch {
            continue;
          }
          if (now - fileStat.mtimeMs > STALE_MS) continue;
          // Lazily watch dirs that become active
          this.watchDir(dirPath);
          await this.processFile(filePath, projectDir);
        }
      }
    } finally {
      if (!this.seeded) {
        this.seeded = true;
        // Emit seeded sessions with non-idle status (like amp watcher does)
        for (const [threadId, state] of this.sessions) {
          if (state.status === "idle" || !state.projectDir) continue;

          let status: AgentStatus = state.status;
          if (status === "running") {
            const pid = await this.pidLookup.pidForThread(threadId);
            if (pid != null && !this.pidLookup.isAlive(pid)) {
              status = "idle";
              state.status = "idle";
              continue;
            }
          }

          const session = this.ctx?.resolveSession(state.projectDir);
          if (!session) continue;
          this.ctx?.emit({
            agent: "claude-code",
            session,
            status,
            ts: Date.now(),
            threadId,
            threadName: state.threadName,
            details: buildDetails(state.usage, state.lastTool, state.subagents, state.loop),
          });
        }
      }
      this.scanning = false;
    }
  }

  private watchedDirs = new Set<string>();

  private watchDir(dirPath: string): void {
    if (this.watchedDirs.has(dirPath)) return;
    const projectDir = decodeProjectDir(basename(dirPath));
    try {
      const w = watch(dirPath, (_eventType, filename) => {
        if (!filename?.endsWith(".jsonl")) return;
        this.processFile(join(dirPath, filename), projectDir);
      });
      this.fsWatchers.push(w);
      this.watchedDirs.add(dirPath);
    } catch {
      // intentionally ignored: watching dir is best-effort, will retry on next setup
    }
  }

  private hasRecentFiles(dirPath: string): boolean {
    const fs = require("node:fs") as typeof import("node:fs");
    try {
      const files = fs.readdirSync(dirPath);
      const now = Date.now();
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        try {
          const s = fs.statSync(join(dirPath, file));
          if (now - s.mtimeMs < STALE_MS) return true;
        } catch {
          // intentionally ignored: skip unreadable file
        }
      }
    } catch {
      // intentionally ignored: dir unreadable, treat as no recent files
    }
    return false;
  }

  private setupWatchers(): void {
    let dirs: string[];
    try {
      dirs = require("node:fs").readdirSync(this.projectsDir);
    } catch {
      return;
    }

    const fs = require("node:fs") as typeof import("node:fs");
    for (const dir of dirs) {
      const dirPath = join(this.projectsDir, dir);
      try {
        if (!fs.statSync(dirPath).isDirectory()) continue;
      } catch {
        continue;
      }

      // Only watch directories that have recently-modified files
      if (this.hasRecentFiles(dirPath)) {
        this.watchDir(dirPath);
      }
    }

    // Watch projects dir for new project directories
    try {
      const w = watch(this.projectsDir, (eventType, filename) => {
        if (eventType !== "rename" || !filename) return;
        const dirPath = join(this.projectsDir, filename);
        try {
          if (!fs.statSync(dirPath).isDirectory()) return;
        } catch {
          return;
        }
        this.watchDir(dirPath);
      });
      this.fsWatchers.push(w);
    } catch {
      // intentionally ignored: top-level watch is best-effort
    }
  }
}
