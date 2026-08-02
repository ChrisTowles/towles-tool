import type { ZodType } from "zod";
import { Result } from "better-result";
import { IpcFailed, IpcTimeout, NotInTauri, SchemaMismatch } from "@/lib/errors";
import type { IpcError } from "@/lib/errors";

export const isTauri = () => "__TAURI_INTERNALS__" in window;

export type InvokeOptions<T> = {
  /** Contract drift is an expected failure: a mismatch is {@link SchemaMismatch}, not a throw. */
  schema?: ZodType<T>;
  /** Abandons *this* promise only — the backend command runs to completion
   * regardless, since Tauri commands aren't cancelable. */
  timeoutMs?: number;
};

/** Never throws or rejects; every failure is a typed `Err`. See apps/client/CLAUDE.md. */
export async function invoke<T>(
  cmd: string,
  args: Record<string, unknown> = {},
  options: InvokeOptions<T> = {},
): Promise<Result<T, IpcError>> {
  if (!isTauri()) return Result.err(new NotInTauri({ command: cmd }));

  const { schema, timeoutMs } = options;
  const core = await import("@tauri-apps/api/core");

  // Invoked inside the thunk so each attempt is a fresh call; re-awaiting a
  // settled promise would make any future `retry` config a silent no-op.
  const settled = await Result.tryPromise({
    try: () => {
      const call = core.invoke<T>(cmd, args);
      return timeoutMs === undefined ? call : withTimeout(call, timeoutMs, cmd);
    },
    catch: (cause): IpcError =>
      IpcTimeout.is(cause) ? cause : new IpcFailed({ command: cmd, cause }),
  });

  return settled.andThen((value) => {
    if (!schema) return Result.ok<T, IpcError>(value);
    const parsed = schema.safeParse(value);
    return parsed.success
      ? Result.ok<T, IpcError>(parsed.data)
      : Result.err<T, IpcError>(new SchemaMismatch({ command: cmd, issues: parsed.error.issues }));
  });
}

/** Callers must already hold an `isTauri()` gate — hence a raw channel, not a `Result`. */
export async function rawChannel(onData: (bytes: Uint8Array) => void): Promise<unknown> {
  const core = await import("@tauri-apps/api/core");
  const channel = new core.Channel<ArrayBuffer | number[]>();
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  channel.onmessage = (data) =>
    onData(data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data));
  return channel;
}

/** Rejects rather than resolving an `Err`, to stay composable with `Result.tryPromise`. */
function withTimeout<T>(promise: Promise<T>, ms: number, command: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new IpcTimeout({ command, timeoutMs: ms })), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
