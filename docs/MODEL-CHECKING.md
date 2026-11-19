# Model checking (TLA+ with everystate)

The app's hardest bugs are interleavings: a reply that lands after the next
mount, a store that lands after the invalidation, a reader between two
atomic stores. Tests rarely reach those orders. A model checker reaches every
one of them in a small model. The checker is
[everystate](https://github.com/mattzcarey/everystate), a TLA+ checker with
TLC's semantics and no Java. It is pinned in `package.json`, and its
`formal-verification` skill is installed under `.claude/skills/` (tracked in
`skills-lock.json`).

```sh
bun run check:tla        # every */tla/*.tla against every cfg beside it
```

A spec sits in a `tla/` directory next to the code it models.
`<Module>.cfg` is the shipped design and must pass. Every other
`<Module><Variant>.cfg` is a broken design: it opens with
`\* Expected to FAIL (<Invariant>)` and must fail on exactly that invariant.
This keeps a check honest, because one that can no longer fail proves
nothing. CI runs the script (`.github/workflows/tla.yml`) whenever a model or
the checker changes.

A model checks the design, not the code. Each action names the function it
stands for. When you change that function, re-read its action. When a model
fails, read the trace as a story in the code's words, then decide which is
wrong, the code or the model.

## The models

Last confirmed against the code when they landed with this doc.

| Spec | Code | Promise | Bounds | Broken variants |
|---|---|---|---|---|
| [`PtyStatus`](../crates/tt-agentboard/tla/PtyStatus.tla) | `pty_status.rs`, `PtyActivity` in `terminal/session.rs` | A blocked agent shows Waiting until it is answered. A finished pane never reads as Busy. A turn that has painted for a second reads Busy. | 500ms ticks, 8s | `LastFirst`: `note_output`'s old store order (a torn read). `NoSustain`: no sustained-run rule. `FastTwitch`: idle repaints closer together than `OUTPUT_ACTIVE_MS`. That last one is an assumption about Claude Code's idle cadence, not something the code can enforce. |
| [`PtySession`](../crates-tauri/tt-app/tla/PtySession.tla) | `terminal-view.tsx` mount effect; `term_start`, `term_kill`, reader EOF in `terminal/spawn.rs` | A pane showing a running shell has one. No shell outlives every pane. | 3 mounts of one id | `ById`: kill and insert by id alone. A disposed mount's late kill, or a stale start, takes the next mount's shell, and no `terminal://exit` reports it. |
| [`GitCache`](../crates/tt-agentboard/tla/GitCache.tla) | `stale_git_targets`, `store_git_info`, `invalidate_git`, `drop_git_cache` | Once settled, a fresh entry matches the repo. A removed checkout's entry stays gone. | 2 pollers, 3 commits | `Blind` and `BlindDrop`: a store blind to an invalidation or a drop since its claim. |

Two things the models leave out. A claim outliving `GIT_PENDING_GUARD_MS`
(a compute longer than 30s). And `term_start` calls reordered across
generations: the generation is the client's call order.

## Adding one

Load the `formal-verification` skill and follow it. In short:

1. Take one promise from the code.
2. Model the steps that can interleave, one action per indivisible step.
3. Bound the model small.
4. Watch it pass at the shipped design.
5. Add a variant cfg that fails the way the code could break.

Report a counterexample in the code's words before fixing either side.
