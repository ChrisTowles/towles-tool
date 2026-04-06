---
name: typescript-best-practices
description: "Generates Zod validation schemas from types, converts enums to as-const unions, applies branded type patterns with Zod .transform(), builds discriminated unions for results/errors/state machines, and configures DeepImmutable state trees. Use when writing or refactoring .ts/.tsx files that need advanced TypeScript patterns — discriminated unions, branded types, Zod schemas, as-const unions, or strict type composition. Also trigger on mentions of generics, type narrowing, or TypeScript configuration."
---

# TypeScript Best Practices

Opinionated patterns from production codebases. These aren't suggestions — they're the defaults.
Deviate only with a reason.

---

## 1. `as const` + Derived Unions (Never Enums)

Never use TypeScript `enum`. Define a single `as const` source of truth and derive everything from it.

```typescript
export const PERMISSION_MODES = ["acceptEdits", "bypassPermissions", "default", "plan"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
```

For numeric/computed values, use object-style:

```typescript
export const Align = { Auto: 0, FlexStart: 1, Center: 2, FlexEnd: 3 } as const;
export type Align = (typeof Align)[keyof typeof Align];
```

**Compose arrays conditionally** with `as const satisfies` to get both type-checking and literal preservation:

```typescript
export const INTERNAL_MODES = [
  ...EXTERNAL_MODES,
  ...(featureEnabled ? (["auto"] as const) : ([] as const)),
] as const satisfies readonly PermissionMode[];
```

---

## 2. Discriminated Unions — Results, Errors, State Machines

Model outcomes, error domains, and stateful processes as discriminated unions. Pick one
discriminant field name per union family and use it everywhere.

**Result types** instead of exceptions:

```typescript
export type OperationResult =
  | { resultType: "success"; absolutePath: string }
  | { resultType: "emptyPath" }
  | { resultType: "pathNotFound"; directoryPath: string; absolutePath: string };
```

**Error domains** — scale to 20+ variants, each with its own payload:

```typescript
export type PluginError =
  | { errorType: "invalidManifest"; path: string; details: string }
  | { errorType: "loadFailed"; pluginId: string; cause: Error }
  | { errorType: "permissionDenied"; pluginId: string; permission: string }
  | { errorType: "timeout"; pluginId: string; timeoutMs: number };
```

Always pair with an exhaustive switch handler (no `default` needed — TypeScript enforces exhaustiveness).

**State machines** — make illegal states unrepresentable:

```typescript
type SpeculationState =
  | { status: "idle" }
  | { status: "active"; startedAt: number; prediction: string; confidence: number }
  | { status: "resolved"; result: "confirmed" | "rejected"; duration: number };
```

You can't access `prediction` without first narrowing to `status === 'active'`.

---

## 3. Branded Types + Zod Integration

Branded types prevent mixing up same-typed identifiers at zero runtime cost:

```typescript
export type SessionId = string & { readonly __brand: "SessionId" };
export type AgentId = string & { readonly __brand: "AgentId" };

export const SessionId = (id: string) => id as SessionId;
export const AgentId = (id: string) => id as AgentId;
```

**The key pattern most people miss: pair branded types with Zod `.transform()`** so that
validated input arrives pre-branded with no extra step:

```typescript
import { z } from "zod";

const SessionIdSchema = z
  .string()
  .min(1)
  .transform((s) => SessionId(s));
const AgentIdSchema = z
  .string()
  .min(1)
  .transform((s) => AgentId(s));

const RequestSchema = z.object({
  sessionId: SessionIdSchema,
  agentId: AgentIdSchema,
});

// z.infer gives branded types automatically
type Request = z.infer<typeof RequestSchema>;
// { sessionId: SessionId; agentId: AgentId }
```

Brand at system boundaries (API handlers, DB results, route params). The interior of your
application never touches raw strings for these values.

---

## 4. Zod as the Single Source of Truth

Never write a type and a schema separately. Define the Zod schema, then derive the type.

**Basic pattern:**

```typescript
const UserSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  role: z.enum(["admin", "editor", "viewer"]),
});
export type User = z.infer<typeof UserSchema>;
```

**Discriminated unions in Zod** — mirror the TypeScript pattern:

```typescript
const HookCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("command"), command: z.string() }),
  z.object({ type: z.literal("prompt"), prompt: z.string() }),
]);
export type HookCommand = z.infer<typeof HookCommandSchema>;
```

**Extract specific variants** from a Zod-derived union using `Extract` — never redeclare them:

```typescript
export type BashCommandHook = Extract<HookCommand, { type: "command" }>;
export type PromptHook = Extract<HookCommand, { type: "prompt" }>;
```

**Use `z.partialRecord()`** for optional keys instead of `z.record().partial()`.

---

## 5. Lazy Schemas to Break Circular Dependencies

When schemas reference each other (common in recursive or mutually-dependent types), construction
at module init time creates circular import failures. Defer with a lazy wrapper:

```typescript
export function lazySchema<T>(factory: () => T): () => T {
  let cached: T | undefined;
  return () => (cached ??= factory());
}

export const HookCommandSchema = lazySchema(() => {
  const { BashCommandHookSchema, PromptHookSchema } = buildHookSchemas();
  return z.discriminatedUnion("type", [BashCommandHookSchema, PromptHookSchema]);
});
```

The companion strategy: extract type-only files to `types/` that both modules import.
Types have no runtime, so they can't create cycles. Keep implementation in the original files,
put only `type` and `interface` declarations in the extracted file.

---

## 6. `satisfies` for Literal Preservation

`satisfies` validates shape without widening. This is critical when you need both type-checking
AND literal types preserved (which `as Type` destroys).

**Object literals:**

```typescript
const addDir = {
  type: "local-jsx",
  name: "add-dir",
  description: "Add a directory to the context",
  run: () => {
    /* ... */
  },
} satisfies Command;

// typeof addDir.type is 'local-jsx', not string
// With `as Command`, it would be string — losing the literal
```

**`as const` array validation:**

```typescript
export const INTERNAL_MODES = [
  ...EXTERNAL_MODES,
  ...(featureEnabled ? (["auto"] as const) : ([] as const)),
] as const satisfies readonly PermissionMode[];
```

---

## 7. DeepImmutable State Trees

Wrap state types in `DeepImmutable<T>` so mutation is a compile error everywhere:

```typescript
type DeepImmutable<T> =
  T extends Map<infer K, infer V>
    ? ReadonlyMap<DeepImmutable<K>, DeepImmutable<V>>
    : T extends Set<infer V>
      ? ReadonlySet<DeepImmutable<V>>
      : T extends object
        ? { readonly [K in keyof T]: DeepImmutable<T[K]> }
        : T;

export type AppState = DeepImmutable<{
  messages: Message[];
  settings: UserSettings;
  permissions: PermissionMap;
}>;
```

Use `ReadonlyMap` and `ReadonlySet` in type signatures by default.

**Escape hatch** — when a deeply-nested value changes frequently (e.g., a streaming message
list), use a mutable ref. The ref container is readonly, but its `.current` is mutable:

```typescript
type AppState = DeepImmutable<{
  messagesRef: { current: Message[] }; // mutable by design
  writtenPathsRef: { current: Set<string> }; // mutable by design
}>;
```

This is an intentional, documented escape, not an accidental loophole.

---

## 8. Error Chain Walking

When extracting structured info from nested errors (common with HTTP clients, DB drivers),
walk `.cause` with a depth limit:

```typescript
export function extractConnectionErrorDetails(error: unknown): ConnectionErrorDetails | null {
  let current: unknown = error;
  let depth = 0;
  while (current && depth < 5) {
    if (current instanceof Error && "code" in current && typeof current.code === "string") {
      return { code: current.code, message: current.message };
    }
    current = (current as Error).cause;
    depth++;
  }
  return null;
}
```

---

## 9. Async Generators for Streaming + Retries

Use `AsyncGenerator` to yield progress from retryable operations and return the final value:

```typescript
export async function* withRetry<T>(
  getClient: () => Promise<Client>,
  operation: (client: Client, attempt: number) => Promise<T>,
  options: RetryOptions,
): AsyncGenerator<ProgressMessage, T> {
  for (let attempt = 0; attempt < options.maxRetries; attempt++) {
    try {
      const client = await getClient();
      return await operation(client, attempt);
    } catch (error) {
      yield { type: "retry", attempt, error };
      await sleep(getRetryDelay(attempt, options));
    }
  }
  throw new Error("Max retries exceeded");
}
```

---

## Quick Reference

| Pattern                           | Use When                                                  |
| --------------------------------- | --------------------------------------------------------- |
| `as const` + derived union        | Fixed set of string/number values (never `enum`)          |
| `as const satisfies Type`         | Validating composed arrays/objects while keeping literals |
| Discriminated union               | Outcomes, errors, state machines — anything with variants |
| `satisfies`                       | Object literals where literal types must be preserved     |
| Branded type + Zod `.transform()` | IDs that must not be confused, validated at boundaries    |
| `z.infer` + `Extract`             | Pulling variants from Zod unions without redeclaring      |
| `lazySchema()`                    | Breaking circular schema/import dependencies              |
| `DeepImmutable<T>`                | State trees — with mutable ref escape hatch for hot paths |
| Error chain walking               | Extracting structured data from nested `.cause` chains    |
| `AsyncGenerator`                  | Streaming progress from retryable/long-running operations |
