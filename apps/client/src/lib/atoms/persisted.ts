import { Result, Schema } from "effect";
import * as Atom from "effect/reactivity/Atom";

const readRaw = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

/** A state atom remembered in localStorage under `key`, JSON-encoded through
 * `schema`. A missing, unreadable or invalid entry reads as `fallback`; a
 * failed write still updates the value, so the UI never waits on storage. */
export function persistedAtom<A, I>(
  key: string,
  schema: Schema.Codec<A, I>,
  fallback: A,
): Atom.Writable<A> {
  const codec = Schema.fromJsonString(schema);
  const raw = readRaw(key);
  const decoded = raw === null ? null : Schema.decodeUnknownResult(codec)(raw);
  const state = Atom.make<A>(
    decoded !== null && Result.isSuccess(decoded) ? decoded.success : fallback,
  ).pipe(Atom.keepAlive);
  const encode = Schema.encodeResult(codec);
  return Atom.writable(
    (get) => get(state),
    (ctx, next: A) => {
      ctx.set(state, next);
      const encoded = encode(next);
      if (Result.isFailure(encoded)) return;
      try {
        localStorage.setItem(key, encoded.success);
      } catch {
        // Unremembered, the value still applies for this session.
      }
    },
  ).pipe(Atom.keepAlive);
}
