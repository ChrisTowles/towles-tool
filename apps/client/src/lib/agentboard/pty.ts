import { Result } from "effect";
import { type IpcError } from "@/lib/errors";
import { subscribe } from "@/lib/run";
import { invoke, runIpc } from "@/lib/tauri";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const termWrite = (termId: string, data: string) =>
  runIpc(invoke<void>("term_write", { termId, data }));

/** Retries while the PTY spawns — `term_start` registers a beat after mount. */
export async function termWriteRetry(
  termId: string,
  data: string,
): Promise<Result.Result<void, IpcError>> {
  let last = await termWrite(termId, data);
  for (let i = 1; i < 20 && Result.isFailure(last); i++) {
    await sleep(150);
    last = await termWrite(termId, data);
  }
  return last;
}

/** The shell's first output — the only proof the PTY is reading input. A bare
 * `term_write` can still race the shell sourcing its rc files. */
export async function waitForFirstFrame(termId: string, timeoutMs = 5000): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;
  await new Promise<void>((resolve) => {
    const stop = subscribe<{ termId: string }>("terminal://frame", (payload) => {
      if (payload.termId === termId) finish();
    });
    const timer = setTimeout(finish, timeoutMs);
    function finish() {
      clearTimeout(timer);
      stop();
      resolve();
    }
  });
}

/** POSIX `'...'` escaping for a command typed into a PTY. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}
