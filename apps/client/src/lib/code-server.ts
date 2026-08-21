/** code-server spike: the swap-in flag plus the two backend calls behind the
 * editor pane. One server per app instance — a pane is `/?folder=<dir>` in an
 * iframe, so this returns URLs, never a per-pane handle. */

import { useCallback } from "react";
import { z } from "zod";
import { persistAgentboardSetting, useLiveSetting } from "./settings";
import { invoke } from "./tauri";

const CodeServerInfoSchema = z.object({
  url: z.string(),
  port: z.number(),
  binary: z.string(),
});

const CodeServerStatusSchema = z.object({
  running: z.boolean(),
  port: z.number().nullable(),
  binary: z.string().nullable(),
});

export type CodeServerInfo = z.infer<typeof CodeServerInfoSchema>;
export type CodeServerStatus = z.infer<typeof CodeServerStatusSchema>;

export function codeServerOpen(dir: string) {
  return invoke<CodeServerInfo>("code_server_open", { dir }, { schema: CodeServerInfoSchema });
}

export function codeServerStatus() {
  return invoke<CodeServerStatus>("code_server_status", {}, { schema: CodeServerStatusSchema });
}

export function codeServerStop() {
  return invoke<null>("code_server_stop", {});
}

/** Which editor the Files pane renders. Off is Monaco, the shipped one. */
export function useCodeServerEditor(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useLiveSetting((s) => s.agentboard?.codeServerEditor, false);
  const persist = useCallback(
    (next: boolean) => {
      setOn(next);
      void persistAgentboardSetting("codeServerEditor", next);
    },
    [setOn],
  );
  return [on, persist];
}
