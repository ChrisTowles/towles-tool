# Ralph Run: TASK_DONE vs PLAN_DONE Completion Markers

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Distinguish between single-task completion (TASK_DONE) and all-plans completion (PLAN_DONE) in ralph run.

**Architecture:** Add second completion marker `TASK_DONE` for per-task completion. Keep `RALPH_DONE` (renamed conceptually to `PLAN_DONE`) for all-plans-complete signal. Update prompt to instruct Claude when to use each marker.

**Tech Stack:** TypeScript, vitest

---

## Current State

- Single marker `RALPH_DONE` signals "all plans done"
- Prompt instructs: "ONLY if ALL PLANS are done then Output: `<promise>RALPH_DONE</promise>`"
- No signal when individual task/plan completes

## Target State

- `TASK_DONE` - Claude outputs after completing current plan (before checking other plans)
- `PLAN_DONE` (or keep `RALPH_DONE`) - Claude outputs only when ALL plans are done
- Loop continues after `TASK_DONE`, stops after `PLAN_DONE`

---

### Task 1: Add TASK_DONE marker constant and detection ✅

**Files:**

- Modify: `src/lib/ralph/state.ts:10-15` (constants)
- Modify: `src/lib/ralph/formatter.ts:242-244` (detection function)
- Test: `src/commands/ralph/run.test.ts`

**Step 1: Write failing test for TASK_DONE detection**

Add to `src/commands/ralph/run.test.ts` after the existing `detectCompletionMarker` tests:

```typescript
describe("detectCompletionMarker with TASK_DONE", () => {
  it("should detect TASK_DONE marker", () => {
    expect(detectCompletionMarker("finished <promise>TASK_DONE</promise>", "TASK_DONE")).toBe(true);
  });

  it("should distinguish TASK_DONE from RALPH_DONE", () => {
    const output = "<promise>TASK_DONE</promise>";
    expect(detectCompletionMarker(output, "TASK_DONE")).toBe(true);
    expect(detectCompletionMarker(output, "RALPH_DONE")).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test -- run.test.ts`
Expected: PASS (detection function already works with any marker string)

**Step 3: Add TASK_DONE constant to state.ts**

In `src/lib/ralph/state.ts`, after line 15 (`DEFAULT_COMPLETION_MARKER`):

```typescript
export const DEFAULT_TASK_DONE_MARKER = "TASK_DONE";
```

**Step 4: Export from index.ts**

In `src/lib/ralph/index.ts`, add to exports:

```typescript
export { DEFAULT_TASK_DONE_MARKER } from "./state.js";
```

**Step 5: Update run.test.ts imports**

Add `DEFAULT_TASK_DONE_MARKER` to imports.

**Step 6: Run tests**

Run: `pnpm test -- run.test.ts`
Expected: PASS

**Step 7: Commit**

```bash
git add src/lib/ralph/state.ts src/lib/ralph/index.ts src/commands/ralph/run.test.ts
git commit -m "feat(ralph): add TASK_DONE marker constant"
```

---

### Task 2: Update buildIterationPrompt to include both markers ✅

**Files:**

- Modify: `src/lib/ralph/formatter.ts:205-236`
- Test: `src/commands/ralph/run.test.ts`

**Step 1: Write failing test for prompt with both markers**

Add to `src/commands/ralph/run.test.ts` in `buildIterationPrompt` describe block:

```typescript
it("should include TASK_DONE instruction", () => {
  const prompt = buildIterationPrompt({
    completionMarker: "RALPH_DONE",
    taskDoneMarker: "TASK_DONE",
    plan: testPlan,
    planContent: testPlanContent,
  });
  expect(prompt).toContain("TASK_DONE");
  expect(prompt).toContain("after marking plan done");
});

it("should include RALPH_DONE only for all-plans-done", () => {
  const prompt = buildIterationPrompt({
    completionMarker: "RALPH_DONE",
    taskDoneMarker: "TASK_DONE",
    plan: testPlan,
    planContent: testPlanContent,
  });
  expect(prompt).toContain("RALPH_DONE");
  expect(prompt).toContain("ALL PLANS are done");
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test -- run.test.ts`
Expected: FAIL (no taskDoneMarker param, no TASK_DONE in prompt)

**Step 3: Update BuildPromptOptions interface**

In `src/lib/ralph/formatter.ts`, update interface:

```typescript
export interface BuildPromptOptions {
  completionMarker: string;
  taskDoneMarker: string;
  plan: RalphPlan;
  planContent: string;
  skipCommit?: boolean;
}
```

**Step 4: Update buildIterationPrompt function**

Replace the prompt template in `buildIterationPrompt`:

```typescript
export function buildIterationPrompt({
  completionMarker,
  taskDoneMarker,
  plan,
  planContent,
  skipCommit = false,
}: BuildPromptOptions): string {
  let step = 1;

  const prompt = `
<plan>
${planContent}
</plan>

<instructions>
${step++}. Work on the plan above.
${step++}. Run type checks and tests.
${step++}. Mark done: \`tt ralph plan done ${plan.id}\`
${step++}. Output: <promise>${taskDoneMarker}</promise> (after marking plan done)
${skipCommit ? "" : `${step++}. Make a git commit.`}

**Before ending:** Run \`tt ralph plan list\` to check remaining plans.
**ONLY if ALL PLANS are done** then Output: <promise>${completionMarker}</promise>
</instructions>
`;
  return prompt.trim();
}
```

**Step 5: Run tests**

Run: `pnpm test -- run.test.ts`
Expected: FAIL (existing tests don't pass taskDoneMarker)

**Step 6: Update existing tests to include taskDoneMarker**

Update all `buildIterationPrompt` tests to include `taskDoneMarker: "TASK_DONE"`:

```typescript
const prompt = buildIterationPrompt({
  completionMarker: "RALPH_DONE",
  taskDoneMarker: "TASK_DONE",
  plan: testPlan,
  planContent: testPlanContent,
});
```

**Step 7: Run tests**

Run: `pnpm test -- run.test.ts`
Expected: PASS

**Step 8: Commit**

```bash
git add src/lib/ralph/formatter.ts src/commands/ralph/run.test.ts
git commit -m "feat(ralph): update prompt to include TASK_DONE and RALPH_DONE markers"
```

---

### Task 3: Update run.ts to pass taskDoneMarker and detect both markers ✅

**Files:**

- Modify: `src/commands/ralph/run.ts:17-26` (imports)
- Modify: `src/commands/ralph/run.ts:93-97` (flags)
- Modify: `src/commands/ralph/run.ts:259-264` (prompt building)
- Modify: `src/commands/ralph/run.ts:291` (marker detection)
- Modify: `src/commands/ralph/run.ts:331-340` (completion logic)

**Step 1: Add taskDoneMarker flag**

In `src/commands/ralph/run.ts`, add import:

```typescript
import {
  DEFAULT_STATE_FILE,
  DEFAULT_LOG_FILE,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_COMPLETION_MARKER,
  DEFAULT_TASK_DONE_MARKER,
  // ... rest of imports
} from "../../lib/ralph/state.js";
```

Add flag after `completionMarker` flag (~line 96):

```typescript
taskDoneMarker: Flags.string({
  description: "Task done marker",
  default: DEFAULT_TASK_DONE_MARKER,
}),
```

**Step 2: Update prompt building**

In run.ts, update the `buildIterationPrompt` calls (~line 164, ~line 259):

```typescript
const prompt = buildIterationPrompt({
  completionMarker: flags.completionMarker,
  taskDoneMarker: flags.taskDoneMarker,
  plan: currentPlan,
  planContent,
  skipCommit: !flags.autoCommit,
});
```

**Step 3: Update marker detection logic**

Around line 291, update to detect both markers:

```typescript
const taskMarkerFound = detectCompletionMarker(iterResult.output, flags.taskDoneMarker);
const planMarkerFound = detectCompletionMarker(iterResult.output, flags.completionMarker);
```

**Step 4: Update completion logic**

Around line 331-340, update the completion check:

```typescript
// Log marker status
if (taskMarkerFound) {
  consola.log(colors.cyan(`Task marker found - current plan done, checking for more plans`));
  logStream.write(`Task marker found - continuing to next plan\n`);
}

// Check completion (only when ALL plans done marker found)
if (planMarkerFound) {
  completed = true;
  state.status = "completed";
  saveState(state, stateFile);
  consola.log(
    colors.bold(colors.green(`\n✅ All plans completed after ${iteration} iteration(s)`)),
  );
  logStream.write(`\n✅ All plans completed after ${iteration} iteration(s)\n`);
}
```

**Step 5: Update history to track both markers**

Update the `appendHistory` call:

```typescript
appendHistory(
  {
    iteration,
    startedAt: iterationStart,
    completedAt: iterationEnd,
    durationMs,
    durationHuman,
    outputSummary: extractOutputSummary(iterResult.output),
    markerFound: planMarkerFound,
    taskMarkerFound,
    contextUsedPercent: iterResult.contextUsedPercent,
  },
  ralphPaths.historyFile,
);
```

**Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: FAIL (IterationHistory type missing taskMarkerFound)

**Step 7: Update IterationHistory type**

In `src/lib/ralph/state.ts`, update `IterationHistory` type:

```typescript
export const IterationHistorySchema = z.object({
  iteration: z.number(),
  startedAt: z.string(),
  completedAt: z.string(),
  durationMs: z.number(),
  durationHuman: z.string(),
  outputSummary: z.string(),
  markerFound: z.boolean(),
  taskMarkerFound: z.boolean().optional(),
  contextUsedPercent: z.number().optional(),
});
```

**Step 8: Run typecheck and tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

**Step 9: Commit**

```bash
git add src/commands/ralph/run.ts src/lib/ralph/state.ts
git commit -m "feat(ralph): detect TASK_DONE and RALPH_DONE markers separately"
```

---

### Task 4: Update dry run output to show both markers ✅

**Files:**

- Modify: `src/commands/ralph/run.ts:143-177` (dry run section)

**Step 1: Update dry run config display**

Around line 149, add:

```typescript
consola.log(`  Completion marker: ${flags.completionMarker}`);
consola.log(`  Task done marker: ${flags.taskDoneMarker}`);
```

**Step 2: Run manually to verify**

Run: `pnpm start ralph run --dryRun`
Expected: Shows both markers in config output

**Step 3: Commit**

```bash
git add src/commands/ralph/run.ts
git commit -m "feat(ralph): show task done marker in dry run output"
```

---

### Task 5: Update log output to show marker status ✅

**Files:**

- Modify: `src/commands/ralph/run.ts:317-329` (log summary section)

**Step 1: Update log summary**

Update the log summary around line 322-328:

```typescript
const contextInfo =
  iterResult.contextUsedPercent !== undefined
    ? ` | Context: ${iterResult.contextUsedPercent}%`
    : "";
const taskMarkerInfo = taskMarkerFound ? " | Task: done" : "";
logStream.write(
  `\n━━━ Iteration ${iteration} Summary ━━━\nDuration: ${durationHuman}${contextInfo}\nTask marker: ${taskMarkerFound ? "yes" : "no"}\nPlan marker: ${planMarkerFound ? "yes" : "no"}\n`,
);
consola.log(
  colors.dim(
    `Duration: ${durationHuman}${contextInfo} | Task: ${taskMarkerFound ? colors.green("yes") : colors.yellow("no")} | Plan: ${planMarkerFound ? colors.green("yes") : colors.yellow("no")}`,
  ),
);
```

**Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

**Step 3: Commit**

```bash
git add src/commands/ralph/run.ts
git commit -m "feat(ralph): show task and plan marker status in logs"
```

---

### Task 6: Add test for new marker behavior in run loop ✅

**Files:**

- Test: `src/commands/ralph/run.test.ts`

**Step 1: Write test for taskMarkerFound in history**

Add to run.test.ts:

```typescript
describe("appendHistory with taskMarkerFound", () => {
  it("should include taskMarkerFound field", () => {
    const history: IterationHistory = {
      iteration: 1,
      startedAt: "2026-01-19T10:00:00Z",
      completedAt: "2026-01-19T10:01:00Z",
      durationMs: 60000,
      durationHuman: "1m 0s",
      outputSummary: "test output",
      markerFound: false,
      taskMarkerFound: true,
    };

    appendHistory(history, testHistoryFile);

    const content = require("node:fs").readFileSync(testHistoryFile, "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.taskMarkerFound).toBe(true);
  });
});
```

**Step 2: Run tests**

Run: `pnpm test -- run.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add src/commands/ralph/run.test.ts
git commit -m "test(ralph): add test for taskMarkerFound in history"
```

---

### Task 7: Final verification ✅

**Step 1: Run all tests**

Run: `pnpm test`
Expected: All tests PASS

**Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors

**Step 3: Run lint**

Run: `pnpm lint`
Expected: No errors (or fix any)

**Step 4: Test dry run**

Run: `pnpm start ralph run --dryRun`
Expected: Shows both markers in prompt

**Step 5: Commit any fixes**

If needed:

```bash
git add -A
git commit -m "fix(ralph): address lint/type issues"
```

---

## Summary

Changes:

1. New constant `DEFAULT_TASK_DONE_MARKER = "TASK_DONE"`
2. Updated `buildIterationPrompt` to accept `taskDoneMarker` param
3. Prompt now instructs Claude to output `TASK_DONE` after marking plan done
4. Prompt still instructs `RALPH_DONE` only when ALL plans done
5. Run loop detects both markers separately
6. `taskMarkerFound` logged and recorded in history
7. Loop continues after `TASK_DONE`, stops after `RALPH_DONE`

## Unresolved Questions

None.
