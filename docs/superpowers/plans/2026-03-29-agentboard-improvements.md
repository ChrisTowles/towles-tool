# Agentboard Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add output persistence, retry context, card templates, and slot health to agentboard.

**Architecture:** Four independent features. Output persistence pipes stream-json to a per-card NDJSON log file via `tee`. Retry context prepends failure reasons to the prompt. Card templates are YAML files served via API and consumed by NewCardForm. Slot health adds git state fields to the existing git-info endpoint.

**Tech Stack:** Nuxt/Nitro, Drizzle ORM, SQLite, Vue 3, VueUse, tmux, `claude -p --output-format stream-json`

---

### Task 1: Persist agent output — build command with tee

**Files:**
- Modify: `plugins/tt-agentboard/server/domains/execution/agent-executor.ts`
- Modify: `plugins/tt-agentboard/server/domains/execution/workflow-helpers.ts`

- [ ] **Step 1: Add `getLogDir` and `getCardLogPath` helpers to workflow-helpers.ts**

```typescript
// Add at bottom of plugins/tt-agentboard/server/domains/execution/workflow-helpers.ts
import { resolve } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

const LOG_DIR = resolve(
  process.env.AGENTBOARD_DATA_DIR ??
    resolve(process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"), "towles-tool", "agentboard"),
  "logs",
);

export function getCardLogPath(cardId: number): string {
  mkdirSync(LOG_DIR, { recursive: true });
  return resolve(LOG_DIR, `card-${cardId}.ndjson`);
}
```

- [ ] **Step 2: Update `runSinglePrompt` to pipe output to log file**

In `agent-executor.ts`, replace the command building block (around line 205-213):

```typescript
// Replace:
//   command = `tt auto-claude ${shellEscape(prompt)}`;
// With:
import { getCardLogPath } from "./workflow-helpers";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Write prompt to temp file for @file arg
const promptDir = resolve(slot.path, ".agentboard");
mkdirSync(promptDir, { recursive: true });
const promptFile = resolve(promptDir, `card-${cardId}-prompt.md`);
writeFileSync(promptFile, prompt);

const logPath = getCardLogPath(cardId);
command = buildStreamingCommand(
  ["-p", "--dangerously-skip-permissions", `@${promptFile}`],
  logPath,
);
```

Add imports at top of agent-executor.ts:
```typescript
import { buildStreamingCommand, getCardLogPath } from "./workflow-helpers";
import { mkdirSync, writeFileSync } from "node:fs";
```

- [ ] **Step 3: Run dev server and verify log file is created**

Run: `cd plugins/tt-agentboard && pnpm dev`
Create a test card, check that `~/.config/towles-tool/agentboard/logs/card-{id}.ndjson` exists after the agent runs.

- [ ] **Step 4: Commit**

```bash
git add plugins/tt-agentboard/server/domains/execution/agent-executor.ts plugins/tt-agentboard/server/domains/execution/workflow-helpers.ts
git commit -m "feat(agentboard): persist agent output to NDJSON log file via tee"
```

---

### Task 2: Persist agent output — API endpoint and cleanup in complete.post.ts

**Files:**
- Create: `plugins/tt-agentboard/server/api/agents/[cardId]/output.get.ts`
- Modify: `plugins/tt-agentboard/server/api/agents/[cardId]/complete.post.ts`

- [ ] **Step 1: Create output.get.ts endpoint**

```typescript
// plugins/tt-agentboard/server/api/agents/[cardId]/output.get.ts
import { existsSync, readFileSync } from "node:fs";
import { getCardId } from "~~/server/utils/params";
import { getCardLogPath } from "~~/server/domains/execution/workflow-helpers";

export default defineEventHandler(async (event) => {
  const cardId = getCardId(event);
  const logPath = getCardLogPath(cardId);

  if (!existsSync(logPath)) {
    return { exists: false, lines: [] };
  }

  const content = readFileSync(logPath, "utf-8").trim();
  const lines = content ? content.split("\n") : [];
  return { exists: true, lines };
});
```

- [ ] **Step 2: Remove tmux capture-pane snapshot from complete.post.ts**

In `complete.post.ts`, replace the capture-pane block (lines 97-111) with a log file summary:

```typescript
  // Save summary from NDJSON log file (replaces tmux capture-pane snapshot)
  const sessionName = `card-${cardId}`;
  tmuxManager.stopCapture(sessionName);
  try {
    const { getCardLogPath } = await import("~~/server/domains/execution/workflow-helpers");
    const { existsSync, readFileSync } = await import("node:fs");
    const logPath = getCardLogPath(cardId);
    if (existsSync(logPath)) {
      const lines = readFileSync(logPath, "utf-8").trim().split("\n");
      // Store last result line as completion summary
      const resultLine = lines.findLast((l) => {
        try { return JSON.parse(l).type === "result"; } catch { return false; }
      });
      if (resultLine) {
        await cardService.logEvent(cardId, "agent_result", resultLine);
      }
    }
  } catch {
    // Non-fatal
  }
```

- [ ] **Step 3: Verify endpoint returns log data**

Run: `curl http://127.0.0.1:4200/api/agents/{cardId}/output`
Expected: `{ "exists": true, "lines": [...] }` for a card that has run.

- [ ] **Step 4: Commit**

```bash
git add plugins/tt-agentboard/server/api/agents/[cardId]/output.get.ts plugins/tt-agentboard/server/api/agents/[cardId]/complete.post.ts
git commit -m "feat(agentboard): add output endpoint and save result summary on completion"
```

---

### Task 3: Retry with failure context

**Files:**
- Modify: `plugins/tt-agentboard/server/domains/execution/agent-executor.ts`

- [ ] **Step 1: Add retry context injection to runSinglePrompt**

In `agent-executor.ts`, after the `const prompt = card.description ?? card.title;` line (around line 203), add:

```typescript
    // Check if this is a retry — if previous runs exist, prepend failure context
    let finalPrompt = prompt;
    if (previousRuns.length > 0) {
      const failureEvents = await this.deps.db
        .select({ detail: cardEvents.detail })
        .from(cardEvents)
        .where(
          and(
            eq(cardEvents.cardId, cardId),
            eq(cardEvents.event, "failed"),
          ),
        )
        .orderBy(desc(cardEvents.id))
        .limit(1);

      const failureReason = failureEvents[0]?.detail;
      if (failureReason) {
        finalPrompt = `PREVIOUS ATTEMPT FAILED:\n${failureReason}\n\nPlease try a different approach. Original task:\n${prompt}`;
      }
    }
```

Add imports at top:
```typescript
import { cardEvents } from "../../shared/db/schema";
import { and, desc } from "drizzle-orm";
```

Then update the prompt file write to use `finalPrompt`:
```typescript
    writeFileSync(promptFile, finalPrompt);
```

- [ ] **Step 2: Verify by retrying a failed card**

1. Create a card with a prompt that will fail
2. After failure, retry it (move back to in_progress)
3. Check the `.agentboard/card-{id}-prompt.md` file in the slot — it should contain the failure context prefix

- [ ] **Step 3: Commit**

```bash
git add plugins/tt-agentboard/server/domains/execution/agent-executor.ts
git commit -m "feat(agentboard): prepend failure context on card retry"
```

---

### Task 4: Card templates — YAML files and API endpoint

**Files:**
- Create: `plugins/tt-agentboard/templates/card-templates/review-codebase.yaml`
- Create: `plugins/tt-agentboard/templates/card-templates/update-dependencies.yaml`
- Create: `plugins/tt-agentboard/templates/card-templates/fix-failing-tests.yaml`
- Create: `plugins/tt-agentboard/templates/card-templates/refactor-module.yaml`
- Create: `plugins/tt-agentboard/server/api/cards/templates.get.ts`

- [ ] **Step 1: Create template YAML files**

`templates/card-templates/review-codebase.yaml`:
```yaml
name: Review Codebase
description: Full codebase review for bugs, security, and quality
prompt: |
  Review the entire codebase for bugs, security vulnerabilities,
  code quality issues, and suggest improvements. Focus on:
  - Logic errors and edge cases
  - Security vulnerabilities (injection, auth, data exposure)
  - Code duplication and opportunities for reuse
  - Performance bottlenecks
executionMode: headless
branchMode: current
column: ready
```

`templates/card-templates/update-dependencies.yaml`:
```yaml
name: Update Dependencies
description: Update all deps to latest compatible versions and fix breakages
prompt: |
  Update all dependencies to their latest compatible versions.
  Run the test suite after each major update. Fix any breakages
  caused by the updates. Commit each update separately.
executionMode: headless
branchMode: create
column: ready
```

`templates/card-templates/fix-failing-tests.yaml`:
```yaml
name: Fix Failing Tests
description: Run tests, identify failures, and fix them
prompt: |
  Run the full test suite. For each failing test:
  1. Identify the root cause of the failure
  2. Fix the underlying code (not the test) unless the test is wrong
  3. Verify the fix by re-running the test
  4. Commit the fix with a descriptive message
executionMode: headless
branchMode: create
column: ready
```

`templates/card-templates/refactor-module.yaml`:
```yaml
name: Refactor Module
description: Refactor a specific module for clarity and maintainability
prompt: |
  Refactor the codebase for improved clarity, maintainability,
  and consistency. Look for:
  - Functions that are too long or do too many things
  - Unclear naming
  - Missing or excessive abstractions
  - Code that could use existing utilities
  Keep all existing behavior — this is a pure refactor.
executionMode: headless
branchMode: create
column: ready
```

- [ ] **Step 2: Create the templates API endpoint**

```typescript
// plugins/tt-agentboard/server/api/cards/templates.get.ts
import { readdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse } from "yaml";

interface CardTemplate {
  name: string;
  description: string;
  prompt: string;
  executionMode: "headless" | "interactive";
  branchMode: "create" | "current";
  column: "ready" | "backlog";
}

export default defineEventHandler(() => {
  const templatesDir = resolve(process.cwd(), "templates", "card-templates");
  let files: string[];
  try {
    files = readdirSync(templatesDir).filter((f) => f.endsWith(".yaml"));
  } catch {
    return [];
  }

  return files.map((file) => {
    const content = readFileSync(join(templatesDir, file), "utf-8");
    return parse(content) as CardTemplate;
  });
});
```

- [ ] **Step 3: Verify endpoint**

Run: `curl -s http://127.0.0.1:4200/api/cards/templates | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).map(t => t.name)"`
Expected: `["Review Codebase", "Update Dependencies", "Fix Failing Tests", "Refactor Module"]`

- [ ] **Step 4: Commit**

```bash
git add plugins/tt-agentboard/templates/card-templates/ plugins/tt-agentboard/server/api/cards/templates.get.ts
git commit -m "feat(agentboard): add card template YAML files and API endpoint"
```

---

### Task 5: Card templates — UI template picker in NewCardForm

**Files:**
- Modify: `plugins/tt-agentboard/app/components/board/NewCardForm.vue`

- [ ] **Step 1: Add template fetching and selection to script setup**

Add after the `useVoice()` line (around line 30):

```typescript
interface CardTemplate {
  name: string;
  description: string;
  prompt: string;
  executionMode: "headless" | "interactive";
  branchMode: "create" | "current";
  column: "ready" | "backlog";
}

const { data: templates } = useFetch<CardTemplate[]>("/api/cards/templates");

function applyTemplate(template: CardTemplate) {
  prompt.value = template.prompt.trim();
  executionMode.value = template.executionMode;
  branchMode.value = template.branchMode;
  startColumn.value = template.column;
}
```

- [ ] **Step 2: Add template picker to the template section**

Add above the prompt textarea in the template:

```html
    <!-- Template picker -->
    <div v-if="templates?.length" class="mb-3">
      <label class="mb-1 block text-xs font-medium text-zinc-400">Template</label>
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="tmpl in templates"
          :key="tmpl.name"
          class="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-400 transition-colors hover:border-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          :title="tmpl.description"
          @click="applyTemplate(tmpl)"
        >
          {{ tmpl.name }}
        </button>
      </div>
    </div>
```

- [ ] **Step 3: Verify in browser**

Open `http://127.0.0.1:4200`, click "+ New Card", verify template buttons appear above the prompt area. Click one and verify form fields are pre-filled.

- [ ] **Step 4: Commit**

```bash
git add plugins/tt-agentboard/app/components/board/NewCardForm.vue
git commit -m "feat(agentboard): add template picker to new card form"
```

---

### Task 6: Slot health — enhanced git-info endpoint

**Files:**
- Modify: `plugins/tt-agentboard/server/api/slots/[id]/git-info.get.ts`

- [ ] **Step 1: Add lastCommitDate and isStale to git-info response**

Replace the full file content:

```typescript
import { db } from "~~/server/shared/db";
import { repositories, workspaceSlots } from "~~/server/shared/db/schema";
import { eq } from "drizzle-orm";
import { gitQuery } from "~~/server/domains/infra/git";

export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, "id"));
  const rows = await db.select().from(workspaceSlots).where(eq(workspaceSlots.id, id));
  if (rows.length === 0) {
    throw createError({ statusCode: 404, statusMessage: "Slot not found" });
  }

  const slot = rows[0];
  const cwd = slot.path;

  const repos = await db.select().from(repositories).where(eq(repositories.id, slot.repoId));
  const defaultBranch = repos[0]?.defaultBranch ?? "main";

  const [branch, aheadStr, behindStr, porcelain, lastCommitDate] = await Promise.all([
    gitQuery(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitQuery(cwd, ["rev-list", `origin/${defaultBranch}..HEAD`, "--count"]),
    gitQuery(cwd, ["rev-list", `HEAD..origin/${defaultBranch}`, "--count"]),
    gitQuery(cwd, ["status", "--porcelain"]),
    gitQuery(cwd, ["log", "-1", "--format=%cI"]),
  ]);

  const ahead = aheadStr !== null ? Number(aheadStr) : null;
  const behind = behindStr !== null ? Number(behindStr) : null;
  const dirty = porcelain !== null ? porcelain.length > 0 : null;

  // Stale: branch >7 days old OR >20 commits behind main
  let isStale = false;
  if (lastCommitDate) {
    const daysSinceCommit = (Date.now() - new Date(lastCommitDate).getTime()) / 86_400_000;
    isStale = daysSinceCommit > 7;
  }
  if (behind !== null && behind > 20) {
    isStale = true;
  }

  return { branch, ahead, behind, dirty, lastCommitDate, isStale };
});
```

- [ ] **Step 2: Verify endpoint returns new fields**

Run: `curl -s http://127.0.0.1:4200/api/slots/6/git-info`
Expected: response includes `lastCommitDate` (ISO string) and `isStale` (boolean).

- [ ] **Step 3: Commit**

```bash
git add plugins/tt-agentboard/server/api/slots/[id]/git-info.get.ts
git commit -m "feat(agentboard): add lastCommitDate and isStale to slot git-info"
```

---

### Task 7: Slot health — UI indicators in SlotCard

**Files:**
- Modify: `plugins/tt-agentboard/app/components/workspace/SlotCard.vue`

- [ ] **Step 1: Update GitInfo interface and add computed helpers**

In `SlotCard.vue`, update the `GitInfo` interface and add computed:

```typescript
interface GitInfo {
  branch: string | null;
  ahead: number | null;
  behind: number | null;
  dirty: boolean | null;
  lastCommitDate: string | null;
  isStale: boolean;
}

const lastCommitAgo = computed(() => {
  if (!gitInfo.value?.lastCommitDate) return null;
  const days = Math.floor((Date.now() - new Date(gitInfo.value.lastCommitDate).getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
});
```

- [ ] **Step 2: Add stale/dirty badges to the template**

In the SlotCard template, after the status badge, add health indicators:

```html
        <!-- Health indicators -->
        <span
          v-if="gitInfo?.isStale"
          class="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400"
        >
          Stale
        </span>
        <span
          v-if="gitInfo?.dirty"
          class="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-400"
        >
          Dirty
        </span>
```

Add last commit date in the git info section:

```html
        <span v-if="lastCommitAgo" class="text-[10px] text-zinc-600">
          Last commit: {{ lastCommitAgo }}
        </span>
```

Make the "Reset to main" button more prominent when stale:

```html
        <button
          v-if="gitInfo?.isStale || gitInfo?.dirty"
          class="rounded border border-amber-700 bg-amber-950/50 px-2 py-1 text-[10px] font-medium text-amber-400 transition-colors hover:bg-amber-900/50"
          :disabled="resetting"
          @click="resetToMain"
        >
          {{ resetting ? "Resetting..." : "Reset to main" }}
        </button>
```

- [ ] **Step 3: Verify in browser**

Navigate to `http://127.0.0.1:4200/workspaces`. Check that slots show "Stale" badge for old branches, "Dirty" badge for uncommitted changes, and last commit date.

- [ ] **Step 4: Commit**

```bash
git add plugins/tt-agentboard/app/components/workspace/SlotCard.vue
git commit -m "feat(agentboard): add stale/dirty indicators to slot cards"
```

---

### Task 8: Slot health — summary bar on workspaces page

**Files:**
- Modify: `plugins/tt-agentboard/app/pages/workspaces/index.vue`

- [ ] **Step 1: Add slot health summary to workspaces page**

Replace the full file content of `workspaces/index.vue`:

```vue
<script setup lang="ts">
import type { Slot } from "~/components/workspace/SlotCard.vue";

const { data: repos, refresh: refreshRepos } = useFetch<{ id: number }[]>("/api/repos");
const { data: slots, refresh: refreshSlots } = useFetch<Slot[]>("/api/slots");

const needsSetup = computed(() => !repos.value?.length && !slots.value?.length);

// Fetch git info for all slots
interface SlotHealth {
  slotId: number;
  dirty: boolean;
  isStale: boolean;
}

const slotHealth = ref<Map<number, SlotHealth>>(new Map());

async function fetchAllHealth() {
  if (!slots.value) return;
  const results = await Promise.allSettled(
    slots.value.map(async (s) => {
      const info = await $fetch<{ dirty: boolean | null; isStale: boolean }>(
        `/api/slots/${s.id}/git-info`,
      );
      return { slotId: s.id, dirty: info.dirty === true, isStale: info.isStale };
    }),
  );
  const map = new Map<number, SlotHealth>();
  for (const r of results) {
    if (r.status === "fulfilled") map.set(r.value.slotId, r.value);
  }
  slotHealth.value = map;
}

watch(slots, () => fetchAllHealth(), { immediate: true });

const summary = computed(() => {
  if (!slots.value) return null;
  const total = slots.value.length;
  const available = slots.value.filter((s) => s.status === "available").length;
  let stale = 0;
  let dirty = 0;
  for (const h of slotHealth.value.values()) {
    if (h.isStale) stale++;
    if (h.dirty) dirty++;
  }
  return { total, available, stale, dirty };
});
</script>

<template>
  <div class="mx-auto max-w-5xl px-4 py-8 sm:px-6">
    <div class="mb-6 flex items-center justify-between">
      <div class="flex items-center gap-4">
        <NuxtLink
          to="/"
          class="text-xs text-zinc-500 transition-colors hover:text-zinc-300"
        >
          &larr; Board
        </NuxtLink>
        <h1 class="text-xl font-bold text-zinc-100">Workspaces</h1>
      </div>
      <NuxtLink
        to="/workspaces/setup"
        class="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-500"
      >
        Setup Wizard
      </NuxtLink>
    </div>

    <!-- Health summary bar -->
    <div
      v-if="summary && summary.total > 0"
      class="mb-4 flex items-center gap-4 rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-2 text-xs font-mono"
    >
      <span class="text-zinc-400">
        {{ summary.available }}/{{ summary.total }} available
      </span>
      <span v-if="summary.stale > 0" class="text-amber-400">
        {{ summary.stale }} stale
      </span>
      <span v-if="summary.dirty > 0" class="text-red-400">
        {{ summary.dirty }} dirty
      </span>
      <span v-if="summary.stale === 0 && summary.dirty === 0" class="text-emerald-400">
        All healthy
      </span>
    </div>

    <div
      v-if="!needsSetup"
      class="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4"
    >
      <WorkspaceSlotRegistry />
    </div>

    <div v-else class="flex flex-col items-center py-16 text-center">
      <p class="mb-2 text-sm font-semibold text-zinc-300">No workspaces configured</p>
      <p class="mb-4 text-xs text-zinc-500">Run the setup wizard to add repos and slots.</p>
      <NuxtLink
        to="/workspaces/setup"
        class="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-500"
      >
        Run Setup Wizard
      </NuxtLink>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Verify in browser**

Navigate to `http://127.0.0.1:4200/workspaces`. Check that the summary bar shows "X/Y available" and any stale/dirty counts.

- [ ] **Step 3: Commit**

```bash
git add plugins/tt-agentboard/app/pages/workspaces/index.vue
git commit -m "feat(agentboard): add slot health summary bar to workspaces page"
```
