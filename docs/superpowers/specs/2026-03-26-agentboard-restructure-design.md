# Agentboard Restructure: Domain-Driven Architecture

**Date:** 2026-03-26
**Scope:** Typed event bus, domain-driven directory restructure, workflow-runner decomposition, DB schema improvements, Pinia store
**Backwards compatibility:** None required — hard cutover

---

## 1. Typed Event Bus

Replace the raw `EventEmitter` singleton with a compile-time-safe typed bus.

### EventMap

```typescript
// server/shared/event-bus.ts

import type { Column, CardStatus } from "../domains/cards/schema";
import type { AgentActivityEvent } from "../domains/execution/types";

export interface EventMap {
  // Card domain
  "card:created": { cardId: number };
  "card:moved": { cardId: number; fromColumn: Column; toColumn: Column };
  "card:status-changed": { cardId: number; status: CardStatus };
  "card:deleted": { cardId: number };

  // Execution domain
  "slot:claimed": { slotId: number; cardId: number };
  "slot:released": { slotId: number };
  "step:started": { cardId: number; stepId: string };
  "step:completed": { cardId: number; stepId: string; passed: boolean };
  "step:failed": { cardId: number; stepId: string; retryNumber: number };
  "workflow:completed": { cardId: number; status: "success" | "failed" };
  "agent:output": { cardId: number; content: string };
  "agent:activity": { cardId: number; event: AgentActivityEvent; timestamp: number };
  "agent:waiting": { cardId: number; question: string };

  // Infrastructure domain
  "github:issue-found": { issueNumber: number; repoId: number };
}
```

### TypedEventBus class

```typescript
import { EventEmitter } from "node:events";

class TypedEventBus {
  private ee = new EventEmitter();

  emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void {
    this.ee.emit(event, data);
  }

  on<K extends keyof EventMap>(event: K, handler: (data: EventMap[K]) => void): void {
    this.ee.on(event, handler as (...args: unknown[]) => void);
  }

  off<K extends keyof EventMap>(event: K, handler: (data: EventMap[K]) => void): void {
    this.ee.off(event, handler as (...args: unknown[]) => void);
  }

  once<K extends keyof EventMap>(event: K, handler: (data: EventMap[K]) => void): void {
    this.ee.once(event, handler as (...args: unknown[]) => void);
  }
}

export const eventBus = new TypedEventBus();
```

All 14 events typed. Wrong payload = compile error. The WebSocket bridge subscribes via `Object.keys(EventMap)` and forwards with the same type.

---

## 2. Domain-Driven Directory Structure

Reorganize `server/` from flat folders into 3 domains + shared layer.

### New structure

```
server/
  shared/
    event-bus.ts          # TypedEventBus + EventMap
    db/
      index.ts            # Drizzle setup, migrations
      schema.ts           # Re-exports all domain schemas
      migrations/         # Drizzle migration files

  domains/
    cards/
      schema.ts           # repositories, boards, plans, cards, cardDependencies, cardEvents tables
      card-service.ts     # CRUD, move, status transitions, dependency resolution
      types.ts            # Column, CardStatus, Card enums/types

    execution/
      schema.ts           # workspaceSlots, workflowRuns, stepRuns, agentLogs tables
      agent-executor.ts   # Dispatcher: workflow vs single-prompt routing
      workflow-orchestrator.ts  # Multi-step execution (replaces workflow-runner.ts)
      step-executor.ts    # Single step: spawn Claude, wait for callback, check artifact
      slot-allocator.ts   # Claim/release workspace slots
      context-bundler.ts  # Build prompt from template + artifacts + CLAUDE.md
      workflow-loader.ts  # Parse YAML workflows, chokidar watching
      types.ts            # Workflow, Step, StepRun types

  api/                    # Nitro auto-routed H3 handlers (MUST stay under server/api/)
    cards/                # Card CRUD, move, delete
    agents/               # Agent lifecycle hooks (start, complete, failure, respond)
    slots/                # Workspace slot management
    workflows/            # Workflow listing
    repos/                # Repository registry
    plans/                # Plan management
    github/               # GitHub integration

    infra/
      tmux-manager.ts     # Tmux session lifecycle
      stream-tailer.ts    # .claude-stream.ndjson watcher
      stream-parser.ts    # NDJSON line → AgentActivityEvent
      github-service.ts   # GitHub API via gh CLI
      hook-writer.ts      # Claude Code settings.local.json generation
      git.ts              # Git command wrappers

  plugins/                # Nitro startup plugins (stay in server/plugins/)
    queue-manager.ts      # Auto-start queued cards
    session-reconnect.ts  # Orphaned session recovery
    github-poll.ts        # Issue polling → card creation
    github-label-sync.ts  # PR label transitions
    dependency-watcher.ts # Unblock dependent cards
    seed.ts               # Default board creation

  routes/
    ws.ts                 # WebSocket bridge (typed via EventMap)

  utils/
    logger.ts             # Consola wrapper
    config.ts             # YAML config persistence
    params.ts             # H3 request parameter helpers
```

### Domain boundaries

| Domain        | Owns                                                    | Depends on                                         |
| ------------- | ------------------------------------------------------- | -------------------------------------------------- |
| **cards**     | Card state, columns, dependencies, repos, boards, plans | shared/db                                          |
| **execution** | Running agents, workflows, steps, slots, logs           | cards (read card state), infra (tmux, git, github) |
| **infra**     | External tool wrappers (tmux, git, gh, stream parsing)  | nothing                                            |
| **shared**    | Event bus, DB connection                                | nothing                                            |

Dependency rule: `infra` depends on nothing. `cards` depends on `shared`. `execution` depends on `cards` + `infra` + `shared`. No circular dependencies.

### Migration approach

Move files one domain at a time. Update imports. No functionality changes in this step — pure reorganization.

---

## 3. Workflow-Runner Decomposition

Split the 572-LOC monolith into 3 focused services.

### Current responsibilities in workflow-runner.ts

1. **Orchestration** — init context, iterate steps, handle post-steps, cleanup
2. **Step execution** — spawn Claude, write hooks, wait for callback, check artifacts, evaluate pass conditions
3. **Context init** — fetch card/repo/workflow, claim slot, create tmux session, create branch
4. **Failure handling** — update DB, emit events, release slot

### New services

#### workflow-orchestrator.ts (~200 LOC)

Owns the step loop and workflow lifecycle. Does NOT know how to run a step.

```typescript
export class WorkflowOrchestrator {
  constructor(deps: {
    db;
    eventBus;
    logger;
    cardService: CardService;
    stepExecutor: StepExecutor;
    slotAllocator: SlotAllocator;
    tmuxManager;
    contextBundler;
    workflowLoader;
    logCardEvent;
    execSync;
    existsSync;
    readFileSync; // from node:fs/child_process, injected for testability
  }) {}

  async run(cardId: number): Promise<void> {
    const ctx = await this.initContext(cardId);
    if (!ctx) return;

    try {
      for (const step of ctx.workflow.steps) {
        const result = await this.deps.stepExecutor.execute(ctx, step);
        if (!result.passed) {
          if (step.on_fail?.goto) {
            /* jump to step */
          } else {
            await this.fail(ctx, step.id);
            return;
          }
        }
      }
      await this.runPostSteps(ctx);
      await this.complete(ctx);
    } finally {
      await this.cleanup(ctx);
    }
  }
}
```

Responsibilities: init context, step iteration, goto handling, post-steps (PR creation), success/failure transitions, cleanup (kill session, release slot).

#### step-executor.ts (~200 LOC)

Runs a single step. Knows about Claude CLI, hooks, artifacts, pass conditions.

```typescript
export class StepExecutor {
  constructor(deps: {
    db;
    eventBus;
    logger;
    tmuxManager;
    contextBundler;
    streamTailer;
    hookWriter;
    logCardEvent;
  }) {}

  async execute(ctx: WorkflowContext, step: WorkflowStep): Promise<StepResult> {
    for (let retry = 0; retry <= (step.max_retries ?? 0); retry++) {
      const stepRun = await this.createStepRun(ctx, step, retry);
      await this.spawnClaude(ctx, step, stepRun);
      const callbackResult = await this.waitForCallback(ctx.cardId);

      if (!this.checkArtifact(ctx, step)) {
        this.deps.eventBus.emit("step:failed", {
          cardId: ctx.cardId,
          stepId: step.id,
          retryNumber: retry,
        });
        continue;
      }

      const passed = this.evaluatePassCondition(step, ctx);
      if (passed) {
        this.deps.eventBus.emit("step:completed", {
          cardId: ctx.cardId,
          stepId: step.id,
          passed: true,
        });
        return { passed: true, artifact: this.readArtifact(ctx, step) };
      }
    }
    return { passed: false };
  }
}
```

Responsibilities: retry loop, StepRun record creation, Claude command building, hook writing, stream tailing, callback waiting (600s timeout), artifact existence check, pass condition evaluation.

#### card-service.ts (in cards domain, ~150 LOC)

Owns all card state transitions. Currently these are scattered across workflow-runner, agent-executor, API routes, and plugins.

```typescript
export class CardService {
  constructor(deps: { db; eventBus; logger; logCardEvent }) {}

  async moveToColumn(cardId: number, toColumn: Column): Promise<void>;
  async updateStatus(cardId: number, status: CardStatus): Promise<void>;
  async markFailed(cardId: number, reason?: string): Promise<void>;
  async markComplete(cardId: number): Promise<void>;
  async resolveDependencies(completedCardId: number): Promise<number[]>;
}
```

Every card state change goes through `CardService`. No more ad-hoc `db.update(cards)` + `eventBus.emit("card:status-changed")` scattered across 10+ files.

---

## 4. DB Schema Improvements

### 4a. Replace string dependencies with join table

**Current:** `cards.dependsOn` is a comma-separated string of card IDs. No referential integrity.

**New:** `cardDependencies` join table with foreign keys.

```typescript
export const cardDependencies = sqliteTable("card_dependencies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cardId: integer("card_id")
    .notNull()
    .references(() => cards.id, { onDelete: "cascade" }),
  dependsOnCardId: integer("depends_on_card_id")
    .notNull()
    .references(() => cards.id, { onDelete: "cascade" }),
});
```

Drop the `dependsOn` text column from `cards`.

`DependencyResolver` queries this table instead of parsing comma strings.

### 4b. Add cascade deletes

Add `onDelete: "cascade"` to all foreign key references:

| Child table               | Parent         | Current    | New      |
| ------------------------- | -------------- | ---------- | -------- |
| `cards.boardId`           | boards         | no cascade | cascade  |
| `cards.repoId`            | repositories   | no cascade | set null |
| `cards.planId`            | plans          | no cascade | set null |
| `workspaceSlots.repoId`   | repositories   | no cascade | cascade  |
| `workflowRuns.cardId`     | cards          | no cascade | cascade  |
| `workflowRuns.slotId`     | workspaceSlots | no cascade | set null |
| `stepRuns.workflowRunId`  | workflowRuns   | no cascade | cascade  |
| `cardEvents.cardId`       | cards          | no cascade | cascade  |
| `agentLogs.workflowRunId` | workflowRuns   | no cascade | cascade  |

Deleting a card cascades to its workflow runs, step runs, events, and logs. No orphaned records.

### 4c. Migration

Single Drizzle migration. The `dependsOn` column data is migrated to `cardDependencies` rows before dropping the column.

---

## 5. Pinia Store

Replace scattered composables with a single `useCardStore` as the source of truth.

### Store design

```typescript
// app/stores/cards.ts
import { defineStore } from "pinia";

export const useCardStore = defineStore("cards", () => {
  // State
  const cards = ref<Card[]>([]);
  const selectedCardId = ref<number | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  // Getters
  const selectedCard = computed(
    () => cards.value.find((c) => c.id === selectedCardId.value) ?? null,
  );
  const columnCards = computed(() => groupByColumn(cards.value));
  const columnCounts = computed(() => countByColumn(cards.value));
  const activeCards = computed(() => cards.value.filter((c) => c.status === "running"));

  // Actions
  async function fetchCards(boardId?: number) {
    /* GET /api/cards */
  }
  async function moveCard(cardId: number, column: Column, position: number) {
    // Optimistic update
    const card = cards.value.find((c) => c.id === cardId);
    if (card) {
      card.column = column;
      card.position = position;
    }
    // POST /api/cards/{id}/move
    // Revert on error
  }
  async function createCard(data: NewCardData) {
    /* POST /api/cards */
  }
  async function deleteCard(cardId: number) {
    /* DELETE /api/cards/{id} */
  }
  async function startCard(cardId: number) {
    /* move + POST agent start */
  }
  async function retryCard(cardId: number) {
    /* same */
  }
  async function selectCard(cardId: number) {
    /* set selectedCardId, fetch detail */
  }

  // WebSocket integration — called once on app mount
  function bindWebSocket(ws: ReturnType<typeof useWebSocket>) {
    ws.on("card:moved", (data) => {
      const card = cards.value.find((c) => c.id === data.cardId);
      if (card) card.column = data.toColumn;
    });
    ws.on("card:status-changed", (data) => {
      const card = cards.value.find((c) => c.id === data.cardId);
      if (card) card.status = data.status;
    });
    ws.on("card:created", () => fetchCards());
    ws.on("card:deleted", (data) => {
      cards.value = cards.value.filter((c) => c.id !== data.cardId);
    });
    ws.on("workflow:completed", () => fetchCards());
  }

  return {
    cards,
    selectedCardId,
    selectedCard,
    loading,
    error,
    columnCards,
    columnCounts,
    activeCards,
    fetchCards,
    moveCard,
    createCard,
    deleteCard,
    startCard,
    retryCard,
    selectCard,
    bindWebSocket,
  };
});
```

### What it replaces

| Old composable               | Merged into                    | Notes                                  |
| ---------------------------- | ------------------------------ | -------------------------------------- |
| `useCards()`                 | `useCardStore`                 | fetchCards, moveCard, createCard       |
| `useBoard()`                 | `useCardStore` getters         | columnCards, columnCounts, activeCards |
| `useWebSocket().bindCards()` | `useCardStore.bindWebSocket()` | WS event → store mutation              |

### What stays as composables

| Composable               | Reason                                         |
| ------------------------ | ---------------------------------------------- |
| `useWebSocket()`         | Transport layer, not card-specific state       |
| `useVoice()`             | Browser API wrapper, independent               |
| `useKeyboardShortcuts()` | Input handling, independent                    |
| `useNotifications()`     | Browser Notification API, reads from WS events |
| `useCardUrls()`          | Pure computed URL builders                     |

### Integration

`app/plugins/init-store.client.ts`:

```typescript
export default defineNuxtPlugin(() => {
  const cardStore = useCardStore();
  const ws = useWebSocket();
  cardStore.bindWebSocket(ws);
  cardStore.fetchCards();
});
```

Components use `const store = useCardStore()` instead of calling multiple composables. Single source of truth — WS events mutate the store, components react.

---

## 6. Implementation Order

Each phase is independently deployable and testable.

| Phase | What                                                                        | Dependencies                    |
| ----- | --------------------------------------------------------------------------- | ------------------------------- |
| **1** | Typed event bus                                                             | None                            |
| **2** | DB schema improvements (join table, cascades) + migration                   | None                            |
| **3** | Domain directory restructure (move files, update imports)                   | Phase 1 (uses new event bus)    |
| **4** | Workflow-runner decomposition (orchestrator + step-executor + card-service) | Phase 3 (new directories exist) |
| **5** | Pinia store + composable consolidation                                      | Phase 1 (typed events for WS)   |
| **6** | Tests for all new services                                                  | Phase 4                         |

Phases 1 and 2 can run in parallel. Phase 5 can start as soon as Phase 1 is done (independent of server restructure).
