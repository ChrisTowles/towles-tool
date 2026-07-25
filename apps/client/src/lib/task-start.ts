import { z } from "zod";
import { requestAgentboardNav, ownerRepoFromOrigin, type RepoData } from "@/lib/agentboard";
import { isTauri } from "@/lib/tauri";

/**
 * Delivery for the MCP `task_start` tool: the backend emits `task://start`
 * (`crates-tauri/tt-app/src/mcp_http.rs`), and this turns it into the same
 * `start-task` Agentboard request the UI would make.
 *
 * It lives outside any screen and is subscribed from `App.tsx` on purpose.
 * Agentboard's screen mounts on first visit, so on a fresh launch it doesn't
 * exist yet — a listener registered there would miss the event entirely. The
 * nav request is a one-shot mailbox (`requestAgentboardNav`), so handing it off
 * from here works whether or not Agentboard has ever been opened: it delivers
 * now if the screen is mounted, and is consumed by its mount effect if not.
 */

/** Mirrors `TaskStartPayload` in `mcp_http.rs`. Validated rather than trusted:
 * it crosses the IPC boundary, same rule as every other event payload. */
const TaskStartPayloadSchema = z.object({
  taskId: z.number(),
  repoRoot: z.string(),
  branch: z.string(),
  base: z.string().nullish(),
  prompt: z.string(),
});

export type TaskStartPayload = z.infer<typeof TaskStartPayloadSchema>;

/**
 * Resolve the payload's `repoRoot` to a tracked Agentboard repo row.
 *
 * Matched on the repo's own directory *or* any of its folders, because a task's
 * bound `repoRoot` names the checkout the worktree branches from, which for a
 * repo tracked by one of its worktrees is a folder rather than the row's `dir`.
 * Exported for unit tests — the failure it guards (starting a task in a repo the
 * app isn't tracking) has no sensible fallback, so it must be reported, never
 * guessed.
 */
export function repoForRoot(repos: RepoData[], repoRoot: string): RepoData | undefined {
  const root = repoRoot.replace(/[/\\]+$/, "");
  return repos.find(
    (r) =>
      r.dir.replace(/[/\\]+$/, "") === root ||
      r.folders.some((f) => f.dir.replace(/[/\\]+$/, "") === root),
  );
}

/** Build the Agentboard request for a validated payload, or `undefined` when the
 * payload's repo isn't tracked. Pure, so the routing is testable without Tauri. */
export function startTaskNav(payload: TaskStartPayload, repos: RepoData[]) {
  const repo = repoForRoot(repos, payload.repoRoot);
  if (!repo) return undefined;
  return {
    kind: "start-task" as const,
    repoDir: repo.dir,
    repoName: repo.name,
    repoKey: repo.key,
    originUrl: repo.originUrl ?? undefined,
    taskId: payload.taskId,
    goal: payload.prompt,
    branch: payload.branch,
    base: payload.base ?? undefined,
  };
}

/**
 * Subscribe to `task://start` for the lifetime of the app. `reposNow` reads the
 * current Agentboard repo list at delivery time rather than closing over it, so
 * a start that arrives before the first snapshot doesn't resolve against a stale
 * empty array.
 *
 * Returns an unsubscribe. A no-op outside Tauri (browser dev has no backend to
 * emit).
 */
export function subscribeTaskStart(
  reposNow: () => RepoData[],
  onUntracked: (payload: TaskStartPayload) => void,
  onRouted: () => void,
): () => void {
  if (!isTauri()) return () => {};
  let unlisten: (() => void) | undefined;
  let cancelled = false;
  void (async () => {
    const { listen } = await import("@tauri-apps/api/event");
    const sub = await listen<unknown>("task://start", (event) => {
      const parsed = TaskStartPayloadSchema.safeParse(event.payload);
      // A malformed payload means the Rust struct and this schema drifted —
      // drop it loudly rather than starting a task with half its fields.
      if (!parsed.success) {
        console.error("task://start: unexpected payload", parsed.error);
        return;
      }
      const nav = startTaskNav(parsed.data, reposNow());
      if (!nav) {
        onUntracked(parsed.data);
        return;
      }
      requestAgentboardNav(nav);
      // Bring Agentboard forward *after* the request, and never by registering a
      // nav listener of our own: `requestAgentboardNav` delivers to listeners
      // when any exist and only stashes the one-shot mailbox when none do, so an
      // app-level listener here would swallow the request before Agentboard's
      // mount effect could ever consume it.
      onRouted();
    });
    if (cancelled) sub();
    else unlisten = sub;
  })();
  return () => {
    cancelled = true;
    unlisten?.();
  };
}

/** The `owner/name` a started task's row should carry, for the caller that
 * binds it. Re-exported so `App.tsx` needn't reach into agentboard.ts. */
export { ownerRepoFromOrigin };
