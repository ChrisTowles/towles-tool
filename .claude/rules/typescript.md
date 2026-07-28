---
paths:
  - "apps/**/*.ts"
  - "apps/**/*.tsx"
  - "scripts/**/*.mjs"
---

# TypeScript conventions

- **Errors are values** — [better-result](https://better-result.dev)'s
  `Result`, the same as Rust's. An expected failure belongs in the return type,
  never in a `throw`, a rejected promise, or a `null` that conflates "absent"
  with "broken". `src/lib/tauri.ts` is the model: one `invoke` returning
  `Result<T, IpcError>` that never throws or rejects, over tagged errors from
  `src/lib/errors.ts` (`TaggedError`, matched with `SomeError.is(e)`). Branch
  with `.isErr()`; an ignored `Result` is safe by construction. Call-site
  patterns: [`apps/client/CLAUDE.md`](../../apps/client/CLAUDE.md).
- **`throw` is for defects and foreign contracts only** — the shortcuts
  registry's module-eval validation; monaco's `IFileSystemProvider` and
  vscode-jsonrpc, which require it. Translate `Err` → throw at those edges,
  nowhere else.
