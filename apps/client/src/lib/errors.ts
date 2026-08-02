// Tagged unions, not thrown `unknown` — .claude/rules/typescript.md.
import { TaggedError, isTaggedError } from "better-result";
import type { ZodError } from "zod";

type ZodIssues = ZodError["issues"];

/** No Tauri host (browser dev) — distinct so a real backend failure can't
 * masquerade as it. Test with `NotInTauri.is(error)`. */
export class NotInTauri extends TaggedError("NotInTauri")<{
  command: string;
  message: string;
}>() {
  constructor(args: { command: string }) {
    super({ ...args, message: `not running under Tauri (${args.command})` });
  }
}

/** The Rust command rejected. `cause` is whatever Tauri's `invoke` threw. */
export class IpcFailed extends TaggedError("IpcFailed")<{
  command: string;
  cause: unknown;
  message: string;
}>() {
  constructor(args: { command: string; cause: unknown }) {
    super({ ...args, message: `${args.command}: ${describe(args.cause)}` });
  }
}

/** Resolved, but the payload missed the call site's schema — contract drift. */
export class SchemaMismatch extends TaggedError("SchemaMismatch")<{
  command: string;
  issues: ZodIssues;
  message: string;
}>() {
  constructor(args: { command: string; issues: ZodIssues }) {
    const summary = args.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    super({ ...args, message: `${args.command}: response failed validation — ${summary}` });
  }
}

/** Abandons the *promise* only — Tauri commands aren't cancelable. */
export class IpcTimeout extends TaggedError("IpcTimeout")<{
  command: string;
  timeoutMs: number;
  message: string;
}>() {
  constructor(args: { command: string; timeoutMs: number }) {
    super({ ...args, message: `${args.command}: timed out after ${args.timeoutMs}ms` });
  }
}

export type IpcError = NotInTauri | IpcFailed | SchemaMismatch | IpcTimeout;

const toMb = (n: number) => Math.round(n / 1024 / 1024);

/** Over the new-task form's cap (mirrors `MAX_IMAGE_BYTES` in `tt_tasks::pasted`). */
export class ImageTooLarge extends TaggedError("ImageTooLarge")<{
  name: string;
  bytes: number;
  limitBytes: number;
  message: string;
}>() {
  constructor(args: { name: string; bytes: number; limitBytes: number }) {
    super({
      ...args,
      message: `${args.name} is ${toMb(args.bytes)}MB — over the ${toMb(
        args.limitBytes,
      )}MB limit for an attached image.`,
    });
  }
}

/** Display text — `String(error)` gives `"[object Object]"` for a Tauri reject. */
export function errorMessage(error: unknown): string {
  if (isTaggedError(error)) return error.message;
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
