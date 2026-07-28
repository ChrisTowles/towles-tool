---
paths:
  - "crates/**/*.rs"
  - "crates-cli/**/*.rs"
  - "crates-tauri/**/*.rs"
---

# Rust conventions

- **Errors:** `thiserror` enums in library crates (`crates/`)`.
- **TTY guards:** every interactive prompt must fail with a clear error or
  no-op cleanly when stdin/stdout is not a TTY, so CI and tests never hang.
- **Testing `task_scope_from_dir`/removal scope:** don't use `tt_scoped()`'s
  forced `TT_STATE_SCOPE` (every store resolves to one path, hiding scope
  bugs) — use `current_dir()` on the spawned `tt` command instead. Never
  fixture a removal-scope test's row at the *removed* task's own scope:
  `ops::remove_task`'s `state_cleanup` wipes that scope wholesale regardless
  of the bug under test, giving a false-positive pass.
