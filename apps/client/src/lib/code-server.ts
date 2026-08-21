/** The backend calls behind the Files pane's workbench. One server per app instance — a
 * pane is `/?folder=<dir>` in an iframe, so this returns URLs, never a per-pane handle. */

import { z } from "zod";
import { invoke, isTauri } from "./tauri";

const CodeServerInfoSchema = z.object({
  url: z.string(),
  port: z.number(),
});

export type CodeServerInfo = z.infer<typeof CodeServerInfoSchema>;

/** The workbench URL for `dir`, starting the server on the first call. A `path`
 * (checkout-relative) rides the URL so the workbench opens it as it boots. */
export function codeServerOpen(dir: string, path: string | null, line: number | null) {
  return invoke<CodeServerInfo>(
    "code_server_open",
    { dir, path, line },
    { schema: CodeServerInfoSchema },
  );
}

/** Open `path` (checkout-relative) in the workbench already running for `dir`. */
export function codeServerReveal(dir: string, path: string, line: number | null) {
  return invoke<null>("code_server_reveal", { dir, path, line });
}

/** Progress while the backend provisions code-server on a machine that has none — a
 * ~235 MB download the first time, so the pane shows it rather than a spinner. */
const CodeServerInstallSchema = z.object({
  phase: z.enum(["downloading", "verifying", "unpacking"]),
  doneBytes: z.number(),
  totalBytes: z.number(),
});

export type CodeServerInstall = z.infer<typeof CodeServerInstallSchema>;

/** Subscribe to `code-server://install`; unexpected payloads are logged and dropped. */
export function subscribeCodeServerInstall(handler: (p: CodeServerInstall) => void): () => void {
  if (!isTauri()) return () => {};
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void (async () => {
    const { listen } = await import("@tauri-apps/api/event");
    const sub = await listen<unknown>("code-server://install", (event) => {
      const parsed = CodeServerInstallSchema.safeParse(event.payload);
      if (parsed.success) handler(parsed.data);
      else console.error("code-server://install: unexpected payload", parsed.error.issues);
    });
    if (disposed) sub();
    else unlisten = sub;
  })();
  return () => {
    disposed = true;
    unlisten?.();
  };
}
