import { Schema } from "effect";
import { requestAgentboardNav } from "@/lib/agentboard/requests";
import type { RepoData } from "@/lib/agentboard/types";
import { nextOpenFileNonce } from "@/lib/agentboard/windows";
import { folderForPath, folderForSession } from "@/lib/preview-artifact";
import { subscribe } from "@/lib/run";

/** Delivery for the MCP `file_open` tool and `tt open`. Structured like
 * `preview-artifact.ts`, except the path fallback is a *good* guess here: a
 * file names its checkout, which is how `tt open` resolves with no session. */

/** Mirrors `FileOpenPayload` in `mcp_http.rs`. Validated, not trusted. */
const FileOpenPayloadSchema = Schema.Struct({
  path: Schema.String,
  /** Decided in Rust because the webview has no `stat`: a directory opens the
   * pane on the folder, a file also selects it. */
  isDir: Schema.Boolean,
  line: Schema.optional(Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0)))),
  session: Schema.optional(Schema.NullOr(Schema.String)),
});

export type FileOpenPayload = typeof FileOpenPayloadSchema.Type;

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
  return subscribe(
    "editor://open-file",
    (payload) => {
      requestAgentboardNav(openFileNav(payload, reposNow()));
      onRouted();
    },
    FileOpenPayloadSchema,
  );
}
