// Typed failures for the dev-tooling scripts — the scripts-side twin of
// apps/client/src/lib/errors.ts. `TaggedError("Tag")<Props>()` is TypeScript
// syntax and these are `.mjs`, so each class casts the factory's return to name
// its Props; without the cast `Tag.is(value)` and the props go untyped.
import { TaggedError } from "better-result";

/** @type {import("better-result").TaggedErrorClass<"EnvFileUnreadable", { path: string; cause: unknown; message: string }>} */
const EnvFileUnreadableBase = TaggedError("EnvFileUnreadable")();

/** Distinct from "absent", the normal case for a checkout with no `.env.local`. */
export class EnvFileUnreadable extends EnvFileUnreadableBase {
  /** @param {{ path: string; cause: unknown }} args */
  constructor(args) {
    super({ ...args, message: `could not read ${args.path}: ${describe(args.cause)}` });
  }
}

/** @type {import("better-result").TaggedErrorClass<"DevPortUnset", { message: string }>} */
const DevPortUnsetBase = TaggedError("DevPortUnset")();

/** Recoverable: the launchers render the task's `.env` and retry. */
export class DevPortUnset extends DevPortUnsetBase {
  constructor() {
    super({ message: "no TT_DEV_PORT for this checkout" });
  }
}

/** @type {import("better-result").TaggedErrorClass<"DevPortInvalid", { value: string; message: string }>} */
const DevPortInvalidBase = TaggedError("DevPortInvalid")();

/** Unlike {@link DevPortUnset}, a typo the user has to fix. */
export class DevPortInvalid extends DevPortInvalidBase {
  /** @param {{ value: string }} args */
  constructor(args) {
    super({ ...args, message: `TT_DEV_PORT=${args.value} is not a valid port (1-65535)` });
  }
}

/** @type {import("better-result").TaggedErrorClass<"TaskEnvRenderFailed", { name: string; cause: unknown; message: string }>} */
const TaskEnvRenderFailedBase = TaggedError("TaskEnvRenderFailed")();

export class TaskEnvRenderFailed extends TaskEnvRenderFailedBase {
  /** @param {{ name: string; cause: unknown }} args */
  constructor(args) {
    super({
      ...args,
      message: `\`tt task env ${args.name}\` failed: ${describe(args.cause)}`,
    });
  }
}

/** @type {import("better-result").TaggedErrorClass<"SpawnFailed", { command: string; cause: unknown; message: string }>} */
const SpawnFailedBase = TaggedError("SpawnFailed")();

/** A child that never started — not one that ran and exited non-zero. */
export class SpawnFailed extends SpawnFailedBase {
  /** @param {{ command: string; cause: unknown }} args */
  constructor(args) {
    super({ ...args, message: `could not run \`${args.command}\`: ${describe(args.cause)}` });
  }
}

/** @type {import("better-result").TaggedErrorClass<"BadVersion", { version: string; message: string }>} */
const BadVersionBase = TaggedError("BadVersion")();

export class BadVersion extends BadVersionBase {
  /** @param {{ version: string }} args */
  constructor(args) {
    super({
      ...args,
      message: `plugin.json version "${args.version}" is not major.minor.patch`,
    });
  }
}

/** @type {import("better-result").TaggedErrorClass<"VersionLineMissing", { needle: string; message: string }>} */
const VersionLineMissingBase = TaggedError("VersionLineMissing")();

export class VersionLineMissing extends VersionLineMissingBase {
  /** @param {{ needle: string }} args */
  constructor(args) {
    super({ ...args, message: `could not find ${args.needle} to replace` });
  }
}

/** @type {import("better-result").TaggedErrorClass<"PortNeverListened", { port: number; timeoutMs: number; message: string }>} */
const PortNeverListenedBase = TaggedError("PortNeverListened")();

export class PortNeverListened extends PortNeverListenedBase {
  /** @param {{ port: number; timeoutMs: number }} args */
  constructor(args) {
    super({ ...args, message: `port ${args.port} not up in ${args.timeoutMs}ms` });
  }
}

/** @type {import("better-result").TaggedErrorClass<"RequestFailed", { url: string; cause: unknown; message: string }>} */
const RequestFailedBase = TaggedError("RequestFailed")();

/** Nothing answered on the socket at all. */
export class RequestFailed extends RequestFailedBase {
  /** @param {{ url: string; base: string; cause: unknown }} args */
  constructor(args) {
    const code = errnoCode(args.cause) ?? describe(args.cause);
    super({
      url: args.url,
      cause: args.cause,
      message:
        `can't reach the automation server at ${args.base} (${code}).\n` +
        "Is `npm run dev:drive` running in this task?",
    });
  }
}

/** @type {import("better-result").TaggedErrorClass<"RemoteRejected", { detail: string; message: string }>} */
const RemoteRejectedBase = TaggedError("RemoteRejected")();

/** It answered, but with a non-2xx, a WebDriver error, or a missing field. */
export class RemoteRejected extends RemoteRejectedBase {
  /** @param {{ action: string; detail: string }} args */
  constructor(args) {
    super({ detail: args.detail, message: `${args.action}: ${args.detail}` });
  }
}

/**
 * `fetch` buries a Node errno one level down, in the `TypeError`'s `cause`.
 * @param {unknown} cause
 * @returns {string | undefined}
 */
function errnoCode(cause) {
  const nested = cause instanceof Error && cause.cause !== undefined ? cause.cause : cause;
  if (!(nested instanceof Error)) return undefined;
  const code = /** @type {NodeJS.ErrnoException} */ (nested).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * `String(e)` degrades to `"[object Object]"` on the non-`Error` values
 * `execFileSync` and `fetch` can reject with.
 * @param {unknown} cause
 * @returns {string} */
export function describe(cause) {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) return cause.message;
  if (cause === null || cause === undefined) return "unknown error";
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}
