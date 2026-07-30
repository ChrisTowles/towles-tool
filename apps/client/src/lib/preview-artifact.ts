import { z } from "zod";
import { nextOpenFileNonce, requestAgentboardNav, type RepoData } from "@/lib/agentboard";
import { invoke, isTauri } from "@/lib/tauri";

// Delivery for the MCP `preview_file` tool: `preview://show` (`mcp_http.rs`) →
// the Preview pane of the folder owning the *calling agent's terminal*. The
// file's location is consulted only when the caller didn't identify itself.
// Structured like `lib/task-start.ts`, for the reasons documented there.

/** Validated, not trusted — it crosses the IPC boundary. */
const PreviewShowPayloadSchema = z.object({
  path: z.string(),
  title: z.string(),
  /** The caller's PTY session (`X-TT-Session`) — the routing key. */
  session: z.string().nullish(),
});

export type PreviewShowPayload = z.infer<typeof PreviewShowPayloadSchema>;

/** The `nonce` is why re-showing a rewritten file isn't a no-op. */
export type PreviewRequest = { path: string; title: string; nonce: number };

/** Mirrors `PreviewDoc` in `preview.rs`. `kind` comes from the extension, in
 * Rust, so it can't flip between reloads of a file still being written. */
const PreviewDocSchema = z.object({
  path: z.string(),
  kind: z.enum(["html", "markdown", "text"]),
  content: z.string(),
});

export type PreviewDoc = z.infer<typeof PreviewDocSchema>;

/** A path the *user* typed, in the agent's own shape so nothing downstream
 * forks. Absolute-only, like the tool: there is no cwd to resolve against. */
export function typedPreviewRequest(raw: string): PreviewRequest | null {
  const path = raw.trim();
  if (!path.startsWith("/")) return null;
  const name = path.split("/").filter(Boolean).at(-1) ?? path;
  return { path, title: name, nonce: nextOpenFileNonce() };
}

/** `encodeURI` alone leaves `#` and `?`, either of which truncates the path
 * into a fragment or query — `/tmp/plan #2.html` would open `/tmp/plan%20`. */
export function fileUrl(path: string) {
  return `file://${encodeURI(path).replaceAll("#", "%23").replaceAll("?", "%3F")}`;
}

/** Re-invoked on reload: manual, and per `preview://file-changed`. */
export const previewReadFile = (path: string) =>
  invoke("preview_read_file", { path }, { schema: PreviewDocSchema, timeoutMs: 10_000 });

/** Refcounted in Rust, so two panes on one file share a watch. */
export const previewWatchFile = (path: string) => invoke("preview_watch_file", { path });
export const previewUnwatchFile = (path: string) => invoke("preview_unwatch_file", { path });

/** One event per debounce batch, so a pane filters for its own path. */
const PreviewChangedSchema = z.object({ paths: z.array(z.string()) });

/** The hot-reload half: the agent rewrites the page and the pane repaints.
 * Returns an unsubscribe; a no-op outside Tauri. */
export function onPreviewFileChanged(path: string, cb: () => void): () => void {
  if (!isTauri()) return () => {};
  let cancelled = false;
  let unlisten: (() => void) | undefined;
  void (async () => {
    const { listen } = await import("@tauri-apps/api/event");
    const sub = await listen<unknown>("preview://file-changed", (event) => {
      const parsed = PreviewChangedSchema.safeParse(event.payload);
      if (!parsed.success) {
        console.error("preview://file-changed: unexpected payload", parsed.error);
        return;
      }
      if (parsed.data.paths.includes(path)) cb();
    });
    if (cancelled) sub();
    else unlisten = sub;
  })();
  return () => {
    cancelled = true;
    unlisten?.();
  };
}

/** The destination, resolved from the caller rather than the file: a session id
 * is the pane's own id (`term_id`, `TT_SESSION_ID`), so this is exact. Undefined
 * when no live folder claims it — a restarted app, a closed pane. */
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

/** **The fallback, not the rule** — a guess, wrong in the ordinary case: a
 * scratch page under no checkout surfaces in whichever folder is on screen.
 * Longest-prefix, because worktree tasks nest inside their checkout. */
export function folderForPath(
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

/** `folderDir`: the caller's session first, the path only if that can't answer,
 * `null` when neither does — only the screen resolves that last fallback. */
export function showFileNav(payload: PreviewShowPayload, repos: RepoData[]) {
  return {
    kind: "show-file" as const,
    folderDir:
      folderForSession(repos, payload.session)?.dir ??
      folderForPath(repos, payload.path)?.dir ??
      null,
    path: payload.path,
    title: payload.title,
    nonce: nextOpenFileNonce(),
  };
}

/** `reposNow` reads the repo list at delivery time rather than closing over it,
 * so a file shown before the first snapshot loses only its *preferred* folder. */
export function subscribePreviewShow(reposNow: () => RepoData[], onRouted: () => void): () => void {
  if (!isTauri()) return () => {};
  let unlisten: (() => void) | undefined;
  let cancelled = false;
  void (async () => {
    const { listen } = await import("@tauri-apps/api/event");
    const sub = await listen<unknown>("preview://show", (event) => {
      const parsed = PreviewShowPayloadSchema.safeParse(event.payload);
      // Drifted from the Rust struct — drop it loudly, don't open an empty pane.
      if (!parsed.success) {
        console.error("preview://show: unexpected payload", parsed.error);
        return;
      }
      requestAgentboardNav(showFileNav(parsed.data, reposNow()));
      // After the request, never via a nav listener — see `task-start.ts`.
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
