---
paths:
  - "crates/**/*.rs"
  - "crates-cli/**/*.rs"
  - "crates-tauri/**/*.rs"
---

# Rust comment discipline

Write comments only where they add information the code cannot express. Good
names and types are the primary documentation; a comment that restates the code
is noise that rots.

Write these:

- `///` rustdoc on public items. Include `# Errors` on `Result`-returning fns,
  `# Safety` on `unsafe` fns, and `# Panics` where a *caller* can trip the panic
  — a precondition it could violate or check. Not for `.lock().unwrap()`: a
  poisoned mutex is only reachable after some other panic, so saying so tells
  the caller nothing it can act on. One line is enough for obvious items.
- `//!` only for crate- and module-level docs.
- `// SAFETY:` on every `unsafe` block, stating the invariant that makes it sound.
- `// TODO:` / `// FIXME:` and workaround notes that link an issue.
- A short `//` explaining *why* for non-obvious logic: a hidden constraint, a
  surprising ordering, a perf tradeoff.

Skip line comments that narrate *what* the next line does (`// increment counter`,
`// parse the hours`, `// loop over items`). If a block needs a "what" comment to
be understood, rename or extract it instead.

Rationale: this matches the Rust API Guidelines and keeps diffs review-dense.

Two things are machine-checked:

- **`unsafe` docs.** `[workspace.lints.clippy]` in the root `Cargo.toml` denies
  `missing_safety_doc` and `undocumented_unsafe_blocks` (inherited via
  `[lints] workspace = true` — a new crate needs that stanza or it opts itself
  out silently), because an unsafe block's soundness argument exists nowhere
  but a comment.
- **Comment volume.** `cargo xtask comment-lint` (a step in the normal `rust`
  CI job; the tool is `xtask/src/main.rs`, tree-sitter over `crates*/`) flags
  two things per file, each with a warning and an error tier: an oversized
  contiguous comment *block* (30+ lines warns, 60+ errors), and a
  *comment-heavy file* — high comment mass **and** high comment-to-code ratio
  together (150+ lines at 50%+ warns, 300+ at 100%+ errors; both at once so
  big well-commented files and tiny doc-headed `lib.rs` stubs don't misfire).
  Warnings are the standing hit list of essays worth trimming; errors fail
  CI. Thresholds are consts in the tool — tighten them as cleanups land.
  Suppressing a deliberate essay is review-visible: a `verbose-ok: <why>`
  line inside the block.

**Don't reach for a doc lint to enforce the rest.** `missing_docs`,
`missing_errors_doc` and `missing_panics_doc` were each tried and dropped: a
lint can tell that a doc section is *absent*, never that the prose filling it
says anything. On this codebase the first two fire ~905 and ~195 times, and
`missing_panics_doc`'s real yield was 10-of-13 stanzas reading "if the mutex is
poisoned" — the lint manufacturing exactly the boilerplate this file exists to
prevent. Judgement is the enforcement mechanism here; that is a deliberate
choice, not a gap waiting to be filled.
