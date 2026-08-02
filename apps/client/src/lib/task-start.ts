import { z } from "zod";
import { requestAgentboardNav, ownerRepoFromOrigin, type RepoData } from "@/lib/agentboard";
import { isTauri } from "@/lib/tauri";

/** MCP `task_start` delivery: `task://start` becomes the `start-task` Agentboard
 * request. Subscribed from `App.tsx` — Agentboard mounts only on first visit. */

/** Mirrors `TaskStartPayload` in `mcp_http.rs`; validated because it crosses IPC. */
const TaskStartPayloadSchema = z.object({
  taskId: z.number(),
  repoRoot: z.string(),
  branch: z.string(),
  base: z.string().nullish(),
  prompt: z.string(),
});

export type TaskStartPayload = z.infer<typeof TaskStartPayloadSchema>;

/** Matched on the row's own dir *or* any of its folders: a repo tracked by one
 * of its worktrees binds `repoRoot` to a folder rather than to `dir`. */
export function repoForRoot(repos: RepoData[], repoRoot: string): RepoData | undefined {
  const root = repoRoot.replace(/[/\\]+$/, "");
  return repos.find(
    (r) =>
      r.dir.replace(/[/\\]+$/, "") === root ||
      r.folders.some((f) => f.dir.replace(/[/\\]+$/, "") === root),
  );
}

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

/** `reposNow` reads the repo list at delivery time rather than closing over it,
 * so a start arriving before the first snapshot doesn't see a stale empty array. */
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
      // After the request, and never via a nav listener here: that would swallow
      // the one-shot mailbox before Agentboard's mount effect could consume it.
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

export { ownerRepoFromOrigin };
