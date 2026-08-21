/** The backend calls behind the Files pane's workbench. One server per app instance — a
 * pane is `/?folder=<dir>` in an iframe, so this returns URLs, never a per-pane handle. */

import { z } from "zod";
import { invoke } from "./tauri";

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
