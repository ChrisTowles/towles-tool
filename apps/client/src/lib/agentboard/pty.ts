import { Result } from "better-result";
import { type IpcError } from "@/lib/errors";
import { invoke } from "@/lib/tauri";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const termWrite = (termId: string, data: string) => invoke<void>("term_write", { termId, data });

/** Retries while the PTY spawns — `term_start` registers a beat after mount. */
export async function termWriteRetry(
  termId: string,
  data: string,
): Promise<Result<void, IpcError>> {
  let last = await termWrite(termId, data);
  for (let i = 1; i < 20 && last.isErr(); i++) {
    await sleep(150);
    last = await termWrite(termId, data);
  }
  return last;
}

/** The shell's first output — the only proof the PTY is reading input. A bare
 * `term_write` can still race the shell sourcing its rc files. */
export async function waitForFirstFrame(termId: string, timeoutMs = 5000): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;
  const { listen } = await import("@tauri-apps/api/event");
  await new Promise<void>((resolve) => {
    let settled = false;
    let unlisten: (() => void) | undefined;
    const timer = setTimeout(finish, timeoutMs);
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unlisten?.();
      resolve();
    }
    listen<{ termId: string }>("terminal://frame", (e) => {
      if (e.payload.termId === termId) finish();
    }).then((u) => (settled ? u() : (unlisten = u)));
  });
}

/** POSIX `'...'` escaping for a command typed into a PTY. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}
