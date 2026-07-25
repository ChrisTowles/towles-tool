import { z } from "zod";
import { nextOpenFileNonce, requestAgentboardNav, type RepoData } from "@/lib/agentboard";
import { invoke, isTauri } from "@/lib/tauri";

/**
 * Delivery for the MCP `preview_show` tool — the agent→human direction of the
 * Preview pane.
 *
 * The backend emits `preview://show` with a path
 * (`crates-tauri/tt-app/src/mcp_http.rs`), and this routes it to the Preview
 * pane of whichever tracked folder the file lives under, as the same
 * `requestAgentboardNav` request the UI would make.
 *
 * Structured exactly like `lib/task-start.ts`, for the reasons documented
 * there: subscribed from `App.tsx` because Agentboard's screen doesn't exist
 * until first visit, and handed off through the one-shot nav mailbox so the
 * request survives that.
 */

/** Mirrors `PreviewShowPayload` in `mcp_http.rs`. Validated, not trusted — it
 * crosses the IPC boundary like every other event payload. */
const PreviewShowPayloadSchema = z.object({
  path: z.string(),
  title: z.string(),
});

export type PreviewShowPayload = z.infer<typeof PreviewShowPayloadSchema>;

/** What the pane renders: the file, its label, and a nonce so showing the
 * *same* artifact again still re-reads it (an agent that rewrote the file and
 * called `preview_show` a second time must not be a no-op). */
export type ArtifactRequest = { path: string; title: string; nonce: number };

/** One artifact read off disk — mirrors `ArtifactDoc` in `preview.rs`. */
const ArtifactDocSchema = z.object({
  path: z.string(),
  html: z.string(),
  modifiedMs: z.number(),
});

export type ArtifactDoc = z.infer<typeof ArtifactDocSchema>;

/** Read an artifact's HTML for the pane's iframe. Re-invoked on reload, which
 * is why the event carries a path rather than the contents. */
export const previewReadArtifact = (path: string) =>
  invoke("preview_read_artifact", { path }, { schema: ArtifactDocSchema, timeoutMs: 10_000 });

/**
 * The tracked folder an artifact belongs to: the folder whose directory is the
 * longest prefix of the file's path.
 *
 * Longest-prefix rather than first-match because worktree tasks nest *inside*
 * their checkout (`<repo>/.claude/worktrees/<task>/`), so a file in a task
 * matches both the task's folder and the main checkout's — and the task is the
 * one whose terminal the agent is sitting in. A path under no tracked folder
 * has no pane to open and comes back undefined; the caller reports that rather
 * than guessing a folder, since showing an artifact in the wrong task's window
 * is worse than saying it couldn't be placed.
 */
export function folderForArtifact(
  repos: RepoData[],
  path: string,
): { dir: string; name: string } | undefined {
  let best: { dir: string; name: string } | undefined;
  for (const repo of repos) {
    for (const folder of repo.folders) {
      const dir = folder.dir.replace(/[/\\]+$/, "");
      if (!dir || !path.startsWith(`${dir}/`)) continue;
      if (!best || dir.length > best.dir.length) best = { dir: folder.dir, name: folder.name };
    }
  }
  return best;
}

/** Build the Agentboard request for a validated payload, or `undefined` when
 * the artifact sits under no tracked folder. Pure, so the routing is testable
 * without Tauri. */
export function showArtifactNav(payload: PreviewShowPayload, repos: RepoData[]) {
  const folder = folderForArtifact(repos, payload.path);
  if (!folder) return undefined;
  return {
    kind: "show-artifact" as const,
    folderDir: folder.dir,
    path: payload.path,
    title: payload.title,
    nonce: nextOpenFileNonce(),
  };
}

/**
 * Subscribe to `preview://show` for the lifetime of the app. `reposNow` reads
 * the current repo list at delivery time rather than closing over it, so an
 * artifact shown before the first snapshot doesn't resolve against a stale
 * empty array.
 *
 * Returns an unsubscribe. A no-op outside Tauri (browser dev has no backend to
 * emit).
 */
export function subscribePreviewShow(
  reposNow: () => RepoData[],
  onUnplaceable: (payload: PreviewShowPayload) => void,
  onRouted: () => void,
): () => void {
  if (!isTauri()) return () => {};
  let unlisten: (() => void) | undefined;
  let cancelled = false;
  void (async () => {
    const { listen } = await import("@tauri-apps/api/event");
    const sub = await listen<unknown>("preview://show", (event) => {
      const parsed = PreviewShowPayloadSchema.safeParse(event.payload);
      // A malformed payload means the Rust struct and this schema drifted —
      // drop it loudly rather than opening a pane on nothing.
      if (!parsed.success) {
        console.error("preview://show: unexpected payload", parsed.error);
        return;
      }
      const nav = showArtifactNav(parsed.data, reposNow());
      if (!nav) {
        onUnplaceable(parsed.data);
        return;
      }
      requestAgentboardNav(nav);
      // Bring Agentboard forward *after* the request, never by registering a
      // nav listener here — see the same note in `task-start.ts`.
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
