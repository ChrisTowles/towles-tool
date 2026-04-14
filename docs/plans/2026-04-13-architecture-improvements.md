# Architecture Improvements Plan

2026-04-13 | 10 improvements | Focus: AI agent collaboration, testability, boundary hygiene

Selected from an architecture audit of 148 TS files (~20K LOC). Ordered by dependency: early items unlock later ones.

---

## 1. Standardize error handling + logging

**Problem**: Three+ logging patterns across the codebase.

- Silent `catch {}` appears 6+ times in `packages/agentboard/packages/runtime/src/server/index.ts` for file I/O (e.g., lines 41-43, 113).
- `src/commands/auto-claude/` uses a custom `log()` helper.
- `src/commands/journal/list.ts` and `search.ts` use raw `console.log`.
- No shared error class; retry logic (`PROCESS_RETRIES`) is hand-rolled.

**Fix**:

- Pick `consola` as the single logger. Remove ad-hoc `log()` and `console.log` call sites in command/server code.
- Add a small `AppError` base class in `@towles/shared` with `.code`, `.cause`. Subclass for auto-claude process failures and config validation.
- Enable oxlint `no-empty` (specifically for `catch` blocks) so silent catches require an explicit `// intentionally ignored: <reason>` comment.

**Affected areas**: `packages/agentboard/packages/runtime/src/server/index.ts`, `src/commands/auto-claude/*`, `src/commands/journal/*`, `packages/shared/src/`, `.oxlintrc` (or equivalent config).

**Test impact**: Most changes are non-behavioral. Tests importing the old `log()` helper must switch to consola.

**Effort**: small-to-medium (~1-2 hrs)

**Unlocks**: Makes diffs in #2, #4, #5 smaller because they stop needing to choose a logger.

---

## 2. Unify config loading

**Problem**: Two independent config loaders exist.

- `src/config.ts` (`loadSettings()`) reads from one set of paths.
- `packages/agentboard/packages/runtime/src/config.ts` reads env vars + JSON with its own parsing.
- No shared interface. Tests hard-code paths or mock `fs`.

**Fix**:

- Define a single `Config` type in `@towles/shared`.
- One `loadConfig()` entry point; both `tt` CLI and agentboard runtime consume it.
- Commands and server accept `config` as a parameter (constructor DI at the entry point only).

**Affected areas**: `src/config.ts`, `packages/agentboard/packages/runtime/src/config.ts`, `packages/shared/src/`, any command or server subsystem that currently reads settings directly.

**Test impact**: Tests can pass a config object instead of stubbing file reads. Delete any `vi.mock('fs')` patterns that exist for this purpose.

**Effort**: small (~45 min)

**Unlocks**: Makes #4 and #5 cleaner — DI surface becomes obvious.

---

## 3. Introduce watcher interface seam in server

**Problem**: `server/index.ts` imports concrete watcher/tracker/sidebar/git modules directly. There is already an `AgentWatcher` contract in `contracts/agent-watcher.ts` and `MuxProviderV1` is a working example of an interface-based seam — but the server doesn't use it.

**Fix**:

- Change `server/index.ts` to depend on `AgentWatcher[]` and `MuxProvider` passed in at construction, not imported directly.
- Move watcher instantiation to a composition root (new `packages/agentboard/packages/runtime/src/bootstrap.ts` or the existing `plugins/loader.ts`).
- Keep the concrete watcher classes where they are.

**Affected areas**: `packages/agentboard/packages/runtime/src/server/index.ts`, `plugins/loader.ts`, any file that currently does `import { ClaudeCodeWatcher } from '...'` inside server code.

**Test impact**: Enables fake/stub watchers in tests. Unlocks unit tests for server event flow.

**Effort**: small (~1 hr), given `contracts/` already exists.

**Unlocks**: #4 (splitting server/index.ts) becomes mechanical once dependencies are already injected.

---

## 4. Split `server/index.ts` god-file (1,779 lines)

**Problem**: One file contains session management, event dispatching, sidebar handling, git watchers, port scanning, and WebSocket communication. 15+ imports. No boundary between concerns.

**Fix**: Split into focused modules under `packages/agentboard/packages/runtime/src/server/`:

- `session-manager.ts` — session lifecycle, state maps.
- `event-broker.ts` — dispatch, subscriber registry.
- `watcher-coordinator.ts` — start/stop watchers, translate their events.
- `sidebar.ts` — sidebar-specific state and messaging.
- `websocket.ts` — connection lifecycle and message routing.
- `index.ts` — thin composition root (~100 lines) that wires the above together.

Git watchers and port scanning get extracted to their own files if still needed after the split.

**Affected areas**: `packages/agentboard/packages/runtime/src/server/index.ts` and all call sites that import from it.

**Test impact**: Each new module gets its own adjacent `.test.ts`. Existing e2e tests should continue to pass.

**Effort**: large (~4-6 hrs) — biggest single item.

**Depends on**: #3 (watcher seam) so dependencies are already injected at split time.

---

## 5. Extract I/O boundaries in auto-claude

**Problem**: Business logic is entangled with I/O.

- `src/commands/auto-claude/claude-cli.ts`: `runClaude()` reads config, logs, writes temp files, and spawns a process in one function.
- `src/commands/auto-claude/pipeline.ts`: `runPipeline()` manages labels, writes artifacts, calls Claude, and mutates git state in a single flow with no transaction semantics.

**Fix**:

- Split each into a pure planner that returns a description of operations, plus a runner that executes them.
- `planRun(config, input)` → `RunPlan` (pure, tested).
- `executeRun(plan, io)` → performs spawn, writes, git ops (thin, tested via fakes).

**Affected areas**: `src/commands/auto-claude/claude-cli.ts`, `pipeline.ts`, and their existing tests.

**Test impact**: Unit tests on the planner without spawning real Claude. Existing `pipeline-execution.test.ts` (281 lines) can shrink significantly.

**Effort**: medium (~2-3 hrs)

**Depends on**: #1 (logging) and #2 (config) to avoid carrying ad-hoc patterns forward.

---

## 6. Test coverage for `auto-claude` commands

**Problem**: 40+ files under `src/commands/` have no adjacent `.test.ts`. Highest-risk gaps:

- `src/commands/auto-claude/index.ts` (258 lines) — main command handler.
- `src/commands/auto-claude/claude-cli.ts` (186 lines) — Claude invocation.
- `src/commands/graph/index.ts` (186 lines).
- `src/commands/journal/search.ts` (256 lines), `templates.ts` (251 lines).
- `src/commands/config/`, `doctor/`, `gh/` entirely untested.

**Fix**:

- After #5 lands, write unit tests for the pure planner and pure helpers.
- Use real SQLite / real fs in a tmpdir where feasible (honoring `feedback_testing_approach.md`).
- Accept that process-spawning paths stay e2e-only.

**Affected areas**: New `*.test.ts` files co-located with the modules above.

**Test impact**: Additive.

**Effort**: medium (~3-4 hrs, can be incremental)

**Depends on**: #5 (creates the seams); #2 (config injection).

---

## 7. Consolidate journal command cluster (8 files)

**Problem**: `src/commands/journal/` contains `index.ts`, `list.ts`, `search.ts`, `daily-notes.ts`, `templates.ts`, `editor.ts`, `meeting.ts`, `note.ts`, `fs.ts`. Each couples UI rendering (consola), data access, and command dispatch. Adding a note type requires edits across 5+ files.

**Fix**:

- Extract a `src/lib/journal/` domain module exposing `listNotes`, `searchNotes`, `renderTemplate`, `createNote`, `createMeeting`, `createDailyNote`.
- Command files under `src/commands/journal/` become thin shells: parse flags, call domain, format output.
- Share path/fs helpers already extracted in the 2026-03-17 plan.

**Affected areas**: `src/commands/journal/**`, new `src/lib/journal/*.ts` files.

**Test impact**: Domain module gets unit tests. Command files may not need tests beyond flag parsing.

**Effort**: medium (~2 hrs)

---

## 8. Split `themes.ts` (769 lines)

**Problem**: Four inline theme palettes (Catppuccin, Mocha, Green, Transparent) in one module.

**Fix**:

- One file per palette under `packages/agentboard/packages/runtime/src/themes/<name>.ts`.
- `themes/index.ts` re-exports a `THEMES` map.

**Affected areas**: `packages/agentboard/packages/runtime/src/themes.ts`, call sites that import specific palettes.

**Test impact**: None; data-only change.

**Effort**: small (~20 min)

---

## 9. Unified state store helper

**Problem**: Three independent state-management implementations reinvent `Map` + prune + persistence:

- `packages/agentboard/packages/runtime/src/agents/tracker.ts` — `Map<string, AgentEvent>` with custom pruning.
- `packages/agentboard/packages/runtime/src/server/index.ts` — in-memory session maps updated via event emission.
- Metadata store (`metadata-store.ts`) — synchronous JSON read/write with no atomic transactions.

**Fix**:

- Add a `createStore<T>(options)` helper in `@towles/shared` with `get/set/delete/prune/subscribe` and optional JSON persistence.
- Adopt gradually — new code uses it; existing stores migrate opportunistically during other refactors.

**Affected areas**: `packages/shared/src/` (new helper); adoption deferred.

**Test impact**: One new test file for the helper.

**Effort**: medium (~1-2 hrs for helper; adoption amortized).

**Depends on**: nothing hard; best tackled after #4 so sessions can be first adopter.

---

## Sequencing

1. **Foundation** (parallel-safe): #1 logging, #2 config, #8 themes split.
2. **Seams**: #3 watcher interface.
3. **Big split**: #4 server/index.ts.
4. **Auto-claude**: #5 I/O extraction, then #6 tests.
5. **Journal**: #7 domain extraction (can happen any time after #1).
6. **Store helper**: #9 once #4 lands so sessions can adopt it.
