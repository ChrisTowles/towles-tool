import { z } from "zod";
import { nextOpenFileNonce, requestAgentboardNav, type RepoData } from "@/lib/agentboard";
import { invoke, isTauri } from "@/lib/tauri";

/**
 * Delivery for the MCP `preview_show` tool — the agent→human direction of the
 * Preview pane.
 *
 * The backend emits `preview://show` (`crates-tauri/tt-app/src/mcp_http.rs`),
 * and this routes it to the Preview pane of the folder owning the *calling
 * agent's terminal*, as the same `requestAgentboardNav` request the UI would
 * make. The file's own location is only consulted when the caller didn't
 * identify itself — see `folderForSession` and `folderForArtifact`.
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
  /** The PTY session the requesting agent runs in, when it identified itself
   * (`X-TT-Session`, from `TT_SESSION_ID`). The routing key — see
   * `folderForSession`. */
  session: z.string().nullish(),
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
});

export type ArtifactDoc = z.infer<typeof ArtifactDocSchema>;

/** A `file://` URL for an absolute path, for handing an artifact to the real
 * browser. `encodeURI` alone isn't enough: it leaves `#` and `?` intact, and
 * either one truncates the rest of the path into a fragment or query —
 * `/tmp/plan #2.html` would open `/tmp/plan%20`. */
export function fileUrl(path: string) {
  return `file://${encodeURI(path).replaceAll("#", "%23").replaceAll("?", "%3F")}`;
}

/** Read an artifact's HTML for the pane's iframe. Re-invoked on reload. */
export const previewReadArtifact = (path: string) =>
  invoke("preview_read_artifact", { path }, { schema: ArtifactDocSchema, timeoutMs: 10_000 });

/**
 * The folder that owns the session an agent is running in — the artifact's
 * destination, resolved from the caller rather than from the file.
 *
 * A session id is the rail's own id for a pane (`SessionData.id`, the PTY's
 * `term_id`, and the `TT_SESSION_ID` stamped into that shell's environment), so
 * this is an exact lookup with no prefix matching and no ambiguity: the pane
 * opens beside the terminal that asked for it, wherever the file happens to
 * live.
 *
 * Undefined when the caller sent no session, or one no live folder claims — a
 * session from an app instance that has since restarted, or a pane closed
 * between the call and its delivery. Both fall back to the path.
 */
export function folderForSession(
  repos: RepoData[],
  session: string | null | undefined,
): { dir: string; name: string } | undefined {
  if (!session) return undefined;
  for (const repo of repos) {
    for (const folder of repo.folders) {
      if (folder.sessions.some((s) => s.id === session)) {
        return { dir: folder.dir, name: folder.name };
      }
    }
  }
  return undefined;
}

/**
 * The tracked folder an artifact belongs to: the folder whose directory is the
 * longest prefix of the file's path.
 *
 * **The fallback, not the rule** — `folderForSession` answers first. This is a
 * guess from the file's location, and it is wrong in the most ordinary case
 * there is: an agent writing a throwaway page into a scratch directory outside
 * every checkout matches no folder here at all, and the artifact then surfaces
 * in whichever folder the user is looking at. It stays for the callers that
 * genuinely have no session to route on — a Claude Code session started from a
 * plain terminal rather than one of the app's — where a slightly-wrong pane
 * still beats not showing the page at all.
 *
 * Longest-prefix rather than first-match because worktree tasks nest *inside*
 * their checkout (`<repo>/.claude/worktrees/<task>/`), so a file in a task
 * matches both the task's folder and the main checkout's — and the task is the
 * one whose terminal the agent is sitting in.
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

/** Build the Agentboard request for a validated payload. `folderDir` is the
 * folder to show it in — the caller's own session first, the file's location
 * only if that can't answer, and `null` when neither does (only the screen can
 * resolve that last fallback). Pure, so the routing is testable without Tauri. */
export function showArtifactNav(payload: PreviewShowPayload, repos: RepoData[]) {
  return {
    kind: "show-artifact" as const,
    folderDir:
      folderForSession(repos, payload.session)?.dir ??
      folderForArtifact(repos, payload.path)?.dir ??
      null,
    path: payload.path,
    title: payload.title,
    nonce: nextOpenFileNonce(),
  };
}

/**
 * Subscribe to `preview://show` for the lifetime of the app. `reposNow` reads
 * the current repo list at delivery time rather than closing over it, so an
 * artifact shown before the first snapshot doesn't resolve against a stale
 * empty array — which now only costs it the *preferred* folder, not the show.
 *
 * Returns an unsubscribe. A no-op outside Tauri (browser dev has no backend to
 * emit).
 */
export function subscribePreviewShow(reposNow: () => RepoData[], onRouted: () => void): () => void {
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
      requestAgentboardNav(showArtifactNav(parsed.data, reposNow()));
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
