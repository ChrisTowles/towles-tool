/** Frontend half of the Claude Code IDE bridge (docs/CLAUDE-CODE-IDE.md): every
 * embedded terminal hosts an IDE server in Rust. The app no longer owns an
 * editor, so all this half does is report connectedness and carry `openFile`. */

import { useEffect, useMemo, useState } from "react";
import { invoke, isTauri } from "@/lib/tauri";

export type IdeStatus = {
  termId: string;
  dir: string;
  port: number;
  connected: boolean;
};

const STATUS_EVENT = "ide://status";

export function useIdeConnected(dir: string | undefined): boolean {
  const [statuses, setStatuses] = useState<Record<string, IdeStatus>>({});

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const initial = await invoke<IdeStatus[]>("ide_status");
      if (disposed) return;
      if (initial.isOk()) setStatuses(Object.fromEntries(initial.value.map((s) => [s.termId, s])));
      if (!isTauri()) return;
      const { listen } = await import("@tauri-apps/api/event");
      const sub = await listen<IdeStatus>(STATUS_EVENT, (e) => {
        setStatuses((prev) => ({ ...prev, [e.payload.termId]: e.payload }));
      });
      if (disposed) sub();
      else unlisten = sub;
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return useMemo(
    () => !!dir && Object.values(statuses).some((s) => s.connected && s.dir === dir),
    [statuses, dir],
  );
}

/** Claude's `openFile` tool, intercepted in `ide.rs` and sent on as `ide://open-file`. */
export type OpenFileRequest = { dir: string; filePath: string };
