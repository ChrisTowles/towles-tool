---
paths:
  - "apps/**/*.ts"
  - "apps/**/*.tsx"
  - "scripts/**/*.mjs"
---

# TypeScript conventions

- **Errors are values** — the same as Rust's `Result`. An expected failure
  belongs in the return type, never in a `throw`, a rejected promise, or a
  `null` that conflates "absent" with "broken". In `apps/client`,
  `src/lib/tauri.ts` is the model: one `invoke` returning a lazy
  `Effect<A, IpcError>` over `Schema.TaggedError`s from `src/lib/errors.ts`
  (matched with `SomeError.is(e)`), run at the React edge with `runIpc`,
  `ipcOr` or `fire`. Call-site patterns:
  [`apps/client/CLAUDE.md`](../../apps/client/CLAUDE.md). Node `scripts/*.mjs`
  keep [better-result](https://better-result.dev)'s `Result` (`.isErr()`).
- **`throw` is for defects and foreign contracts only** — the shortcuts
  registry's module-eval validation, or a foreign interface that requires a
  rejection. Translate a failure → throw at that edge, nowhere else.
