# Plan: Rename tasks → plans

## Completed

- [x] `src/lib/ralph/state.ts` - RalphTask→RalphPlan, TaskStatus→PlanStatus, tasks→plans, addTaskToState→addPlanToState
- [x] `src/lib/ralph/formatter.ts` - Updated types, formatTasksAsMarkdown→formatPlansAsMarkdown, task→plan in prompt

## Remaining

### 1. `src/commands/ralph/run.ts`

- Import: `RalphTask` → `RalphPlan`
- Function: `getCurrentTask` → `getCurrentPlan`
- Flag: `taskId` → `planId`
- Variables: `focusedTaskId` → `focusedPlanId`, `remainingTasks` → `remainingPlans`, `currentTask` → `currentPlan`
- Messages: "tasks" → "plans", "Task #" → "Plan #"
- `state.tasks` → `state.plans`
- `task:` → `plan:` in buildIterationPrompt call

### 2. `src/commands/ralph/plan/add.ts`

- Import: `addTaskToState` → `addPlanToState`
- Call: `addTaskToState` → `addPlanToState`
- Messages: "task" → "plan"

### 3. `src/commands/ralph/plan/done.ts`

- `state.tasks` → `state.plans`
- Messages: "task" → "plan"

### 4. `src/commands/ralph/plan/remove.ts`

- `state.tasks` → `state.plans`
- Messages: "task" → "plan"

### 5. `src/commands/ralph/plan/list.ts`

- `state.tasks` → `state.plans`
- Messages: "tasks" → "plans"
- Import/call: `formatTasksAsMarkdown` → `formatPlansAsMarkdown`

### 6. `src/commands/ralph/show.ts`

- `state.tasks` → `state.plans`
- Messages if any

### 7. `src/commands/ralph/run.test.ts`

- Import: `RalphTask` → `RalphPlan`, `addTaskToState` → `addPlanToState`, `formatTasksAsMarkdown` → `formatPlansAsMarkdown`
- All test variables/assertions using old names
- Update test expectations for new output text

### 8. `src/commands/ralph/plan/list.test.ts`

- Update expectations for new output text

## Verification

```bash
pnpm typecheck
pnpm test
pnpm start ralph run --dryRun
```
