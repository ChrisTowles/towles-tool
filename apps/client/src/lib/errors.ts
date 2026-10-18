// Tagged unions, not thrown `unknown` — .claude/rules/typescript.md.
import { Schema } from "effect";

/** No Tauri host (browser dev) — distinct so a real backend failure can't
 * masquerade as it. Test with `NotInTauri.is(error)`. */
export class NotInTauri extends Schema.TaggedError<NotInTauri>()("NotInTauri", {
  command: Schema.String,
}) {
  static is = (u: unknown): u is NotInTauri => u instanceof NotInTauri;
  override get message() {
    return `not running under Tauri (${this.command})`;
  }
}

/** The Rust command rejected. `cause` is whatever Tauri's `invoke` threw. */
export class IpcFailed extends Schema.TaggedError<IpcFailed>()("IpcFailed", {
  command: Schema.String,
  cause: Schema.Unknown,
}) {
  static is = (u: unknown): u is IpcFailed => u instanceof IpcFailed;
  override get message() {
    return `${this.command}: ${describe(this.cause)}`;
  }
}

/** Resolved, but the payload missed the call site's schema — contract drift.
 * `detail` is the schema's own formatted issue list. */
export class SchemaMismatch extends Schema.TaggedError<SchemaMismatch>()("SchemaMismatch", {
  command: Schema.String,
  detail: Schema.String,
}) {
  static is = (u: unknown): u is SchemaMismatch => u instanceof SchemaMismatch;
  override get message() {
    return `${this.command}: response failed validation — ${this.detail}`;
  }
}

/** Abandons the *promise* only — Tauri commands aren't cancelable. */
export class IpcTimeout extends Schema.TaggedError<IpcTimeout>()("IpcTimeout", {
  command: Schema.String,
  timeoutMs: Schema.Number,
}) {
  static is = (u: unknown): u is IpcTimeout => u instanceof IpcTimeout;
  override get message() {
    return `${this.command}: timed out after ${this.timeoutMs}ms`;
  }
}

export type IpcError = NotInTauri | IpcFailed | SchemaMismatch | IpcTimeout;

const toMb = (n: number) => Math.round(n / 1024 / 1024);

/** Over the new-task form's cap (mirrors `MAX_IMAGE_BYTES` in `tt_tasks::pasted`). */
export class ImageTooLarge extends Schema.TaggedError<ImageTooLarge>()("ImageTooLarge", {
  name: Schema.String,
  bytes: Schema.Number,
  limitBytes: Schema.Number,
}) {
  override get message() {
    return `${this.name} is ${toMb(this.bytes)}MB — over the ${toMb(
      this.limitBytes,
    )}MB limit for an attached image.`;
  }
}

/** Display text — `String(error)` gives `"[object Object]"` for a Tauri reject. */
export function errorMessage(error: unknown): string {
  return describe(error);
}

function describe(cause: unknown): string {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) return cause.message;
  if (cause === null || cause === undefined) return "unknown error";
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}
