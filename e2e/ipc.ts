/** Narrowers for `browser.tauri.execute` replies. The bridge types `core.invoke`
 * as answering `unknown` and there is no Zod here, so these make a backend
 * contract change fail as a named assertion, not an `undefined` dereference. */

/** Narrow an IPC reply to an array. */
export function expectArray(value: unknown, command: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${command} should answer an array, got ${describe(value)}`);
  }
  return value;
}

/**
 * Narrow an IPC reply to an object with the given shape. The caller supplies
 * the expected type; this only proves the reply is a non-null object, which is
 * what distinguishes "the command answered" from "the command returned null".
 */
export function expectObject<T extends object>(value: unknown, command: string): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${command} should answer an object, got ${describe(value)}`);
  }
  // SAFETY: the caller names the payload type it expects from `command`; this
  // checks only the object-ness TypeScript can't see through `unknown`. A
  // field-level mismatch is the assertion's job, not this parser's.
  return value as T;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}
