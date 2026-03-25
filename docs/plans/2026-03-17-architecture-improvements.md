# Architecture Improvements Plan

2026-03-17 | 6 improvements | Est. effort: ~2-3 hours total

## 1. Split `src/lib/journal/utils.ts` (399 lines)

**Problem**: Single file handles templates, path resolution, directory management, and editor launching — four distinct concerns.

**Split into**:

- `src/lib/journal/templates.ts` — `TEMPLATE_FILES`, `getDefault*Template()`, `loadTemplate()`, `ensureTemplatesExist()`, `renderTemplate()`, `createJournalContent()`, `createMeetingContent()`, `createNoteContent()` (~170 lines)
- `src/lib/journal/paths.ts` — `resolvePathTemplate()`, `generateJournalFileInfoByType()`, `GenerateJournalFileResult`, `GenerateJournalFileParams` (~70 lines)
- `src/lib/journal/editor.ts` — `openInEditor()` (~25 lines)
- `src/lib/journal/fs.ts` — `ensureDirectoryExists()` (~10 lines)
- `src/lib/journal/index.ts` — barrel re-exports (new file)

**Imports to update**: `src/commands/journal/daily-notes.ts`, `meeting.ts`, `note.ts` — change from `../../lib/journal/utils.js` to `../../lib/journal/index.js`.

**Test impact**: Move existing journal tests alongside new files or keep `utils.test.ts` importing from barrel. Existing tests should pass without changes if barrel re-exports everything.

**Effort**: small (~30 min)

---

## 2. Tighten graph module

**Problem**: `analyzer.ts` (341 lines) mixes session analysis, label extraction, string utils, and tool data extraction. `render.ts` (341 lines) mixes HTML generation with treemap/bar-chart data building.

**Split `analyzer.ts` into**:

- `src/lib/graph/analyzer.ts` — keep `analyzeSession()`, `aggregateSessionTools()`, `getPrimaryModel()`, `getModelName()`, `extractProjectName()` (~100 lines)
- `src/lib/graph/tools.ts` — `sanitizeString()`, `truncateDetail()`, `extractToolDetail()`, `extractToolData()` (~90 lines)
- `src/lib/graph/labels.ts` — `extractSessionLabel()` (~80 lines)

**Split `render.ts` into**:

- `src/lib/graph/render.ts` — keep `generateTreemapHtml()` only (~15 lines)
- `src/lib/graph/treemap.ts` — `buildTurnNodes()`, `buildSessionTreemap()`, `buildAllSessionsTreemap()` (~170 lines)
- `src/lib/graph/sessions.ts` — `findRecentSessions()`, `findSessionPath()`, `buildBarChartData()` (~100 lines)

**Add barrel**: `src/lib/graph/index.ts` — public API surface.

**Imports to update**: `src/commands/graph/index.ts` — update to import from barrel.

**Test impact**: Existing `analyzer.test.ts` and `render.test.ts` may need import updates. No logic changes.

**Effort**: medium (~45 min)

---

## 3. Consolidate trivial auto-claude steps

**Problem**: `plan.ts` (16 lines), `simplify.ts` (14 lines), `review.ts` (14 lines) are near-identical wrappers around `runStepWithArtifact()`. They add indirection without clarity. `implement.ts` (56 lines) has real logic and should stay separate.

**Change**: Merge plan/simplify/review into `src/lib/auto-claude/steps/simple-steps.ts`:

```
export async function stepPlan(ctx) { ... }
export async function stepSimplify(ctx) { ... }
export async function stepReview(ctx) { ... }
```

Delete `plan.ts`, `simplify.ts`, `review.ts`. Keep `implement.ts` and `create-pr.ts` as-is.

**Imports to update**: `src/lib/auto-claude/pipeline.ts` — update step imports. `steps.test.ts` — update imports.

**Effort**: small (~15 min)

---

## 4. Document error handling convention

**Problem**: Two patterns exist without documented guidance:

- `exec()` (throws on failure) + `git()` wrapper in `src/utils/git/exec.ts`
- `execSafe()` (returns `{ stdout, ok }`) in same file
- `neverthrow` Result types imported but usage is sparse

**Action**: Add a section to `docs/architecture.md`:

```
## Error Handling Convention

- **Internal pipeline calls**: Use `git()` / throwing `exec()` — failures are exceptional and should abort the step.
- **Probing / optional operations**: Use `execSafe()` — when failure is an expected branch (e.g., checking if a branch exists).
- **neverthrow**: Reserved for `runClaude()` results where the caller must explicitly handle success/failure.
- **Never** mix: don't catch a throwing call just to convert to `{ ok }`. Pick the right function upfront.
```

**Effort**: trivial (~10 min)

---

## 5. Fix stale docs

**Problem**: `docs/architecture.md` line 13 references `src/config/context.ts` which doesn't exist — settings.ts handles this now. Line 66 lists `refactor-claude-md` command which may have been renamed.

**Action**:

- Remove the `src/config/context.ts` line from architecture.md
- Verify all listed commands in architecture.md match actual files in `plugins/tt-core/commands/` and `plugins/tt-auto-claude/commands/`
- Fix any other stale references found

**Effort**: trivial (~10 min)

---

## 6. Extract install.ts config logic

**Problem**: `src/commands/install.ts` (197 lines) mixes three concerns: settings detection/modification, plugin management, and OTEL instructions. The settings logic is untestable because it's embedded in the command class.

**Extract to**: `src/lib/install/claude-settings.ts`:

- `loadClaudeSettings(path): ClaudeSettings` — reads and parses, returns empty object on missing/invalid
- `applyRecommendedSettings(settings): { settings, changes: string[] }` — pure function returning what changed
- `saveClaudeSettings(path, settings): void`

The command becomes a thin orchestrator calling these functions and printing results.

**Test benefit**: `applyRecommendedSettings()` becomes trivially testable as a pure function.

**Imports to update**: Only `src/commands/install.ts`.

**Effort**: small (~20 min)

---

## Execution Order

Recommended sequence (each is independently mergeable):

1. **Fix stale docs** (#5) — zero risk warmup
2. **Document error handling** (#4) — docs only
3. **Consolidate auto-claude steps** (#3) — smallest code change
4. **Split journal/utils.ts** (#1) — straightforward file split
5. **Extract install.ts logic** (#6) — small refactor
6. **Tighten graph module** (#2) — largest change, do last

Each step: refactor → `pnpm typecheck` → `pnpm test` → commit.
