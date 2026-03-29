# Agentboard Improvements: Output Persistence, Retry Context, Card Templates, Slot Health

## 1. Persist Agent Output to Disk

### Problem
Single-prompt agent execution pipes `tt auto-claude` output to a tmux pane. When the session is killed on completion, the output is lost. For review-only tasks with no code changes, the agent's entire output disappears.

### Solution
Pipe stream-json output to a per-card NDJSON log file via `tee`, matching the existing workflow step pattern in `workflow-helpers.ts`.

### Log location
`~/.config/towles-tool/agentboard/logs/card-{id}.ndjson`

### Changes

**`server/domains/execution/agent-executor.ts`**
- Import `buildClaudeStreamCommand` from `workflow-helpers.ts` (or extract shared helper)
- In `runSinglePrompt()`, replace `tt auto-claude ${shellEscape(prompt)}` with a command that:
  1. Creates logs dir (`mkdir -p`)
  2. Writes prompt to a temp file (for `@file` arg)
  3. Runs `claude -p --output-format stream-json --verbose @promptfile 2>&1 | tee logfile`
- Store log file path on the workflow run record

**`server/api/agents/[cardId]/complete.post.ts`**
- Remove the `tmux capture-pane -S - -E -` snapshot added earlier
- Instead, read last 100 lines of the NDJSON log file and store a summary card event

**New endpoint: `server/api/agents/[cardId]/output.get.ts`**
- Reads the NDJSON log file for the card
- Returns `{ exists: boolean, lines: string[] }`
- Used by the UI to show output for completed cards

**`app/components/card/ActivityPanel.vue`**
- Add "Agent Output" section for cards with a persisted log file
- Render structured output (tool calls, text responses) from parsed NDJSON

### What stays
- Live `tmux capture-pane` polling for active sessions (TerminalPanel.vue) unchanged
- Workflow step execution already uses `tee` — this extends the pattern to single-prompt cards

---

## 2. Retry with Failure Context

### Problem
When a failed card is retried, the agent starts fresh with no knowledge of what went wrong. It may repeat the same mistake.

### Solution
On retry, prepend the failure reason from card events to the prompt.

### Changes

**`server/domains/execution/agent-executor.ts`**
- In `runSinglePrompt()`, before building the command:
  1. Check if `workflowRuns` already has a record for this card (indicates retry)
  2. If retry, query `cardEvents` for the most recent event with `event = 'failed'` or `event = 'stop_hook_received'`
  3. Prepend context block to the prompt:
     ```
     PREVIOUS ATTEMPT FAILED:
     {failure detail from card event}

     Please try a different approach. Original task:
     {original prompt}
     ```

### No schema changes
Failure reasons are already stored in `cardEvents.detail`. No new tables or columns needed.

### Edge cases
- First run (no previous workflow run): skip context injection, use prompt as-is
- Multiple retries: only include the most recent failure, not the full history
- No failure detail available: skip context injection

---

## 3. Card Templates (YAML Files)

### Problem
Creating cards requires typing prompts from scratch and manually configuring execution mode, branch mode, etc. Common tasks like "review codebase" or "update deps" get inconsistent prompts each time.

### Template format
YAML files in `templates/card-templates/`:

```yaml
name: Review Codebase
description: Full codebase review for bugs and quality issues
prompt: |
  Review the entire codebase for bugs, security issues,
  code quality problems, and suggest improvements.
executionMode: headless
branchMode: current
column: ready
```

### Built-in templates
1. **Review Codebase** — read-only review, headless, current branch
2. **Update Dependencies** — update deps + fix breakages, headless, create branch
3. **Fix Failing Tests** — run tests and fix failures, headless, create branch
4. **Refactor Module** — prompt with placeholder for module name, headless, create branch

### Changes

**New directory: `templates/card-templates/`**
- 4 built-in YAML template files

**New endpoint: `server/api/cards/templates.get.ts`**
- Reads all `*.yaml` files from `templates/card-templates/`
- Parses YAML, returns array of template objects
- No write endpoint — templates are files in the repo

**`app/components/board/NewCardForm.vue`**
- Add template picker dropdown at top of form (above prompt textarea)
- Fetches templates from `GET /api/cards/templates` on mount
- Selecting a template pre-fills: prompt, executionMode, branchMode, column
- User can edit any field after template selection
- "None" option to start with blank form (default)

### Not linked to workflows
Card templates pre-fill the creation form only. They don't define multi-step execution. A card template can optionally set `workflowId` to link to an existing workflow template.

---

## 4. Slot Health Dashboard (Git State)

### Problem
Slots can become stale (old branches, uncommitted changes from crashed agents, diverged from main) with no visibility in the UI. The current SlotCard shows basic git info but doesn't flag problems.

### Enhanced git-info fields
Add to `GET /api/slots/:id/git-info` response:

| Field | Source | Description |
|-------|--------|-------------|
| `lastCommitDate` | `git log -1 --format=%ci` | Timestamp of HEAD commit |
| `commitsAhead` | `git rev-list --count origin/main..HEAD` | Commits ahead of main |
| `commitsBehind` | `git rev-list --count HEAD..origin/main` | Commits behind main |
| `isStale` | computed | Branch >7 days old OR >20 commits behind |

`dirty` (uncommitted changes) already exists.

### Changes

**`server/api/slots/[id]/git-info.get.ts`**
- Add `lastCommitDate`, `commitsAhead`, `commitsBehind` fields from git commands
- Compute `isStale` boolean

**`app/components/workspace/SlotCard.vue`**
- Warning badge (amber) for stale slots
- Red indicator for uncommitted changes
- Show last commit date in relative format ("3 days ago")
- Make "Reset to main" button prominent when slot is stale

**`app/pages/workspaces/index.vue`**
- Summary bar at top: "{n}/{total} available, {n} stale, {n} dirty"
- Fetch git-info for all slots on mount (parallel requests)

### Performance
Git-info endpoint already runs `git` commands per slot. Adding 2 more commands (`git log`, `git rev-list`) per request is acceptable since this page is not polled — only loaded on navigation.

---

## File Reference

| Feature | Files to create/modify |
|---------|----------------------|
| Output persistence | `agent-executor.ts`, `complete.post.ts`, new `output.get.ts`, `ActivityPanel.vue` |
| Retry context | `agent-executor.ts` |
| Card templates | new `templates/card-templates/*.yaml`, new `templates.get.ts`, `NewCardForm.vue` |
| Slot health | `git-info.get.ts`, `SlotCard.vue`, `workspaces/index.vue` |
