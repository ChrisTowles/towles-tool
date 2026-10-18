/** The backend calls behind the Files pane's workbench. One server per app instance — a
 * pane is `/?folder=<dir>` in an iframe, so this returns URLs, never a per-pane handle. */

import { Schema } from "effect";
import { subscribe } from "./run";
import { invoke, runIpc } from "./tauri";

const CodeServerInfoSchema = Schema.Struct({
  url: Schema.String,
  port: Schema.Number,
});

export type CodeServerInfo = typeof CodeServerInfoSchema.Type;

/** The workbench URL for `dir`, starting the server on the first call. A `path`
 * (checkout-relative) rides the URL so the workbench opens it as it boots, and so
 * does the keymap it boots with. */
export function codeServerOpen(
  dir: string,
  path: string | null,
  line: number | null,
  pcKeymap: boolean,
) {
  return runIpc(
    invoke<CodeServerInfo>(
      "code_server_open",
      { dir, path, line, pcKeymap },
      { schema: CodeServerInfoSchema },
    ),
  );
}

/** Open `path` (checkout-relative) in the workbench already running for `dir`. */
export function codeServerReveal(dir: string, path: string, line: number | null) {
  return runIpc(invoke<null>("code_server_reveal", { dir, path, line }));
}

/** End the extension host a just-unmounted pane left behind (`bridge::release`). */
export function codeServerRelease(dir: string, unmountedAtMs: number) {
  return runIpc(invoke<boolean>("code_server_release", { dir, unmountedAtMs }));
}

/** Select `path` (checkout-relative) in the Explorer of `dir`'s workbench. */
export function codeServerRevealInExplorer(dir: string, path: string) {
  return runIpc(invoke<null>("code_server_reveal_in_explorer", { dir, path }));
}

/** Resume ended Claude session `sessionId` in the Claude Code panel of `dir`'s workbench. */
export function codeServerOpenClaudeSession(dir: string, sessionId: string) {
  return runIpc(invoke<null>("code_server_open_claude_session", { dir, sessionId }));
}

/** Progress while the backend provisions code-server on a machine that has none — a
 * ~235 MB download the first time, so the pane shows it rather than a spinner. */
const CodeServerInstallSchema = Schema.Struct({
  phase: Schema.Literals(["downloading", "verifying", "unpacking"]),
  doneBytes: Schema.Number,
  totalBytes: Schema.Number,
});

export type CodeServerInstall = typeof CodeServerInstallSchema.Type;

/** Subscribe to `code-server://install`; unexpected payloads are logged and dropped. */
export function subscribeCodeServerInstall(handler: (p: CodeServerInstall) => void): () => void {
  return subscribe("code-server://install", handler, CodeServerInstallSchema);
}
