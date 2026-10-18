// IPC edge for the Tauri host: effects in, promises out only at the React boundary.
// Contract: apps/client/CLAUDE.md "IPC failures are values".
import { Duration, Effect, Result, Schema } from "effect";
import { IpcFailed, IpcTimeout, NotInTauri, SchemaMismatch } from "@/lib/errors";
import type { IpcError } from "@/lib/errors";

export const isTauri = () => "__TAURI_INTERNALS__" in window;

export type InvokeOptions = {
  /** Abandons *this* promise only — the backend command runs to completion
   * regardless, since Tauri commands aren't cancelable. A number is millis. */
  timeout?: Duration.Input;
};

/** Contract drift is an expected failure: a mismatch is {@link SchemaMismatch}, not a defect.
 * Without a schema the payload is trusted as `A`, as before. */
export function invoke<A>(
  cmd: string,
  args: Record<string, unknown>,
  options: InvokeOptions & { schema: Schema.Decoder<A> },
): Effect.Effect<A, IpcError>;
export function invoke<A = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
  options?: InvokeOptions,
): Effect.Effect<A, IpcError>;
export function invoke<A>(
  cmd: string,
  args: Record<string, unknown> = {},
  options: InvokeOptions & { schema?: Schema.Decoder<A> } = {},
): Effect.Effect<A, IpcError> {
  const { schema, timeout } = options;
  const call = Effect.tryPromise({
    // Inside the thunk so each run is a fresh call; a re-run effect must not replay a settled promise.
    try: async () => (await import("@tauri-apps/api/core")).invoke<A>(cmd, args),
    catch: (cause): IpcError => new IpcFailed({ command: cmd, cause }),
  });
  const timed =
    timeout === undefined
      ? call
      : call.pipe(
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () =>
              Effect.fail(new IpcTimeout({ command: cmd, timeoutMs: Duration.toMillis(timeout) })),
          }),
        );
  const decode = schema ? Schema.decodeUnknownEffect(schema) : undefined;
  const decoded = decode
    ? timed.pipe(
        Effect.flatMap((value) =>
          decode(value).pipe(
            Effect.mapError(
              (e): IpcError => new SchemaMismatch({ command: cmd, detail: e.message }),
            ),
          ),
        ),
      )
    : timed;
  // Checked at run time, not construction: the host can appear after a module builds an effect.
  return Effect.suspend(() =>
    isTauri()
      ? (decoded as Effect.Effect<A, IpcError>)
      : Effect.fail(new NotInTauri({ command: cmd })),
  );
}

/** Runs to a settled `Result`; the promise never rejects for an IPC failure. */
export const runIpc = <A, E>(effect: Effect.Effect<A, E>): Promise<Result.Result<A, E>> =>
  Effect.runPromise(Effect.result(effect));

/** Degrade: the success value, else `fallback` — the failure is the call site's to ignore. */
export const ipcOr = <A, B>(effect: Effect.Effect<A, unknown>, fallback: B): Promise<A | B> =>
  runIpc(effect).then((r) => (Result.isSuccess(r) ? r.success : fallback));

/** Fire-and-forget. Ignores every failure and defect, so an unobserved run can't
 * become an unhandled rejection — the hot PTY-write path relies on it. */
export const fire = (effect: Effect.Effect<unknown, unknown>): void => {
  Effect.runFork(Effect.ignoreCause(effect));
};

/** Callers must already hold an `isTauri()` gate — hence a raw channel, not an `Effect`. */
export async function rawChannel(onData: (bytes: Uint8Array) => void): Promise<unknown> {
  const core = await import("@tauri-apps/api/core");
  const channel = new core.Channel<ArrayBuffer | number[]>();
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  channel.onmessage = (data) =>
    onData(data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data));
  return channel;
}
