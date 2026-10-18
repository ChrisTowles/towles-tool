/** Frontend half of the Claude Code IDE bridge (docs/CLAUDE-CODE-IDE.md): every
 * embedded terminal hosts an IDE server in Rust. This half only reports connectedness and
 * carries `openFile`. */

import { useEffect, useMemo, useState } from "react";
import { Effect, Result, Stream } from "effect";
import { tauriEvents } from "@/lib/events";
import { start } from "@/lib/run";
import { invoke } from "@/lib/tauri";

type IdeStatus = {
  termId: string;
  dir: string;
  port: number;
  connected: boolean;
};

const STATUS_EVENT = "ide://status";

export function useIdeConnected(dir: string | undefined): boolean {
  const [statuses, setStatuses] = useState<Record<string, IdeStatus>>({});

  useEffect(
    () =>
      start(
        Effect.gen(function* () {
          const initial = yield* Effect.result(invoke<IdeStatus[]>("ide_status"));
          if (Result.isSuccess(initial)) {
            setStatuses(Object.fromEntries(initial.success.map((s) => [s.termId, s])));
          }
          yield* tauriEvents(STATUS_EVENT).pipe(
            Stream.runForEach((payload) => {
              const status = payload as IdeStatus;
              return Effect.sync(() =>
                setStatuses((prev) => ({ ...prev, [status.termId]: status })),
              );
            }),
          );
        }),
      ),
    [],
  );

  return useMemo(
    () => !!dir && Object.values(statuses).some((s) => s.connected && s.dir === dir),
    [statuses, dir],
  );
}

/** Claude's `openFile` tool, intercepted in `ide.rs` and sent on as `ide://open-file`. */
export type OpenFileRequest = { dir: string; filePath: string };
