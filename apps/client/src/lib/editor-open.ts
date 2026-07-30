import { z } from "zod";
import { nextOpenFileNonce, requestAgentboardNav, type RepoData } from "@/lib/agentboard";
import { folderForPath, folderForSession } from "@/lib/preview-artifact";
import { isTauri } from "@/lib/tauri";

/**
 * Delivery for the MCP `file_open` tool and `tt open`. Structured exactly like
 * `preview-artifact.ts`, except the path fallback is a *good* guess here: a file
 * names its checkout, which is how `tt open` resolves with no session.
 */

/** Mirrors `FileOpenPayload` in `mcp_http.rs`. Validated, not trusted. */
const FileOpenPayloadSchema = z.object({
  path: z.string(),
  /** Decided in Rust because the webview has no `stat`: a directory opens the
   * pane on the folder, a file also selects it. */
  isDir: z.boolean(),
  line: z.number().int().positive().nullish(),
  session: z.string().nullish(),
});

export type FileOpenPayload = z.infer<typeof FileOpenPayloadSchema>;

/** `path` stays absolute: only the screen knows which folder the request landed
 * in once `folderDir` is null, so it makes the path relative. Pure, so the
 * routing is testable without Tauri. */
export function openFileNav(payload: FileOpenPayload, repos: RepoData[]) {
  return {
    kind: "open-file" as const,
    folderDir:
      folderForSession(repos, payload.session)?.dir ??
      folderForPath(repos, payload.path)?.dir ??
      null,
    path: payload.path,
    isDir: payload.isDir,
    line: payload.line ?? null,
    nonce: nextOpenFileNonce(),
  };
}

/** Subscribe for the app's lifetime; returns an unsubscribe. `reposNow` is read
 * at delivery time so an open before the first snapshot still routes. */
export function subscribeEditorOpenFile(
  reposNow: () => RepoData[],
  onRouted: () => void,
): () => void {
  if (!isTauri()) return () => {};
  let unlisten: (() => void) | undefined;
  let cancelled = false;
  void (async () => {
    const { listen } = await import("@tauri-apps/api/event");
    const sub = await listen<unknown>("editor://open-file", (event) => {
      const parsed = FileOpenPayloadSchema.safeParse(event.payload);
      // Malformed means the Rust struct and this schema drifted — drop it
      // loudly rather than opening a pane on nothing.
      if (!parsed.success) {
        console.error("editor://open-file: unexpected payload", parsed.error);
        return;
      }
      requestAgentboardNav(openFileNav(parsed.data, reposNow()));
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
