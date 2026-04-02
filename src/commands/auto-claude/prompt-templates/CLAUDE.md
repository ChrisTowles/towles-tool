# Prompt Templates

These templates are **language and toolchain agnostic**. They must not reference specific tools (pnpm, vitest, cargo, pytest, etc.), languages (TypeScript, Rust, Python), or framework conventions (oclif, Zod, consola).

Project-specific details (test commands, lint commands, type-check commands, coding conventions) come from the **target repo's CLAUDE.md**, which Claude Code loads automatically at runtime.

When editing templates:

- Say "run the project's test/lint/type-check commands" — not `pnpm test` or `cargo test`
- Say "test files" — not `*.test.ts` or `*_test.py`
- Say "schema validation" — not "Zod schemas"
- Say "follow the project's coding conventions from CLAUDE.md" — not "use consola" or "use import type"
