import { Schema } from "effect";
import { requestAgentboardNav } from "@/lib/agentboard/requests";
import type { RepoData } from "@/lib/agentboard/types";
import { nextOpenFileNonce } from "@/lib/agentboard/windows";
import { list } from "@/lib/schemas/shape";
import { invoke, runIpc } from "@/lib/tauri";
import { subscribe } from "@/lib/run";

// Delivery for the MCP `preview_file` tool: `preview://show` → the Preview pane
// of the folder owning the *calling agent's terminal*. The file's location is
// consulted only when the caller didn't identify itself.

/** Validated, not trusted — it crosses the IPC boundary. */
const PreviewShowPayloadSchema = Schema.Struct({
  path: Schema.String,
  title: Schema.String,
  /** The caller's PTY session (`X-TT-Session`) — the routing key. */
  session: Schema.optional(Schema.NullOr(Schema.String)),
});

export type PreviewShowPayload = typeof PreviewShowPayloadSchema.Type;

/** The `nonce` is why re-showing a rewritten file isn't a no-op. */
export type PreviewRequest = { path: string; title: string; nonce: number };

/** `kind` comes from the extension, in Rust, so it can't flip between reloads
 * of a file still being written. */
const PreviewDocSchema = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literals(["html", "markdown", "text"]),
  content: Schema.String,
});

export type PreviewDoc = typeof PreviewDocSchema.Type;

/** Absolute-only, like the tool: there is no cwd to resolve against. */
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

export const previewReadFile = (path: string) =>
  runIpc(invoke("preview_read_file", { path }, { schema: PreviewDocSchema, timeout: 10_000 }));

/** Refcounted in Rust, so two panes on one file share a watch. */
export const previewWatchFile = (path: string) => runIpc(invoke("preview_watch_file", { path }));
export const previewUnwatchFile = (path: string) =>
  runIpc(invoke("preview_unwatch_file", { path }));

/** One event per debounce batch, so a pane filters for its own path. */
const PreviewChangedSchema = Schema.Struct({ paths: list(Schema.String) });

export function onPreviewFileChanged(path: string, cb: () => void): () => void {
  return subscribe(
    "preview://file-changed",
    (payload) => {
      if (payload.paths.includes(path)) cb();
    },
    PreviewChangedSchema,
  );
}

/** Resolved from the caller rather than the file, so it is exact. Undefined
 * when no live folder claims the session — a restarted app, a closed pane. */
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

/** **The fallback, not the rule** — a guess. Longest-prefix, because worktree
 * tasks nest inside their checkout. */
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

/** `folderDir`: session first, path only if that can't answer, `null` when
 * neither does — only the screen resolves that last fallback. */
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

/** `reposNow` reads the repo list at delivery time, so a file shown before the
 * first snapshot loses only its *preferred* folder. */
export function subscribePreviewShow(reposNow: () => RepoData[], onRouted: () => void): () => void {
  return subscribe(
    "preview://show",
    (payload) => {
      requestAgentboardNav(showFileNav(payload, reposNow()));
      onRouted();
    },
    PreviewShowPayloadSchema,
  );
}
