import { Schema } from "effect";

/** An array the consuming code may mutate, as zod's `z.array` was. */
export const list = <S extends Schema.Top>(item: S) => Schema.mutable(Schema.Array(item));

/** Keeps unknown keys on decode — the Rust side round-trips them too, so a
 * hand-edited file's extras survive a read-modify-save. */
export const open = <const F extends Schema.Struct.Fields>(fields: F) =>
  Schema.StructWithRest(Schema.Struct(fields), [Schema.Record(Schema.String, Schema.Unknown)]);
