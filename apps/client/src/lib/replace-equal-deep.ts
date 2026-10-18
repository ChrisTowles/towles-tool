// Structural sharing for snapshots that arrive whole: TanStack Query's
// `replaceEqualDeep` (https://github.com/TanStack/query, utils.ts), same
// semantics, JSON-shaped data only.

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** `next` with every subtree deep-equal to its counterpart in `prev` swapped for
 * the `prev` reference. Returns `prev` itself when nothing differs, so a caller
 * can test `result === prev` to learn that a payload changed nothing. */
export function replaceEqualDeep<T>(prev: unknown, next: T): T {
  if ((prev as unknown) === next) return prev as T;
  const array = Array.isArray(prev) && Array.isArray(next);
  if (!array && !(isPlainObject(prev) && isPlainObject(next))) return next;

  const p = prev as Record<string, unknown>;
  const n = next as Record<string, unknown>;
  const keys = array ? undefined : Object.keys(n);
  const size = array ? (n as unknown as unknown[]).length : keys!.length;
  const copy: Record<string, unknown> | unknown[] = array ? [] : {};

  let equalItems = 0;
  for (let i = 0; i < size; i++) {
    const key = array ? i : keys![i]!;
    const value = replaceEqualDeep(p[key], n[key]);
    (copy as Record<string | number, unknown>)[key] = value;
    if (value === p[key] && (p[key] !== undefined || key in p)) equalItems++;
  }

  const prevSize = array ? (p as unknown as unknown[]).length : Object.keys(p).length;
  return (prevSize === size && equalItems === size ? prev : copy) as T;
}
