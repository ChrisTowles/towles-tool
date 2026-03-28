# Agentboard Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure agentboard into domain-driven architecture with typed events, Pinia store, decomposed workflow runner, and proper DB schema.

**Architecture:** 3 server domains (cards, execution, infra) + shared layer. TypedEventBus replaces raw EventEmitter. WorkflowRunner splits into orchestrator + step-executor. Pinia replaces scattered composables. DB gets join table for dependencies and cascade deletes.

**Tech Stack:** Nuxt 4, Vue 3, Pinia, Drizzle ORM, SQLite, TypeScript, Vitest

**Spec:** `docs/superpowers/specs/2026-03-26-agentboard-restructure-design.md`

---

## File Structure

### New files to create

```
server/shared/event-bus.ts                    # TypedEventBus + EventMap
server/shared/db/index.ts                     # DB init (moved from server/db/index.ts)
server/shared/db/schema.ts                    # Re-export all domain schemas
server/domains/cards/schema.ts                # repositories, boards, plans, cards, cardDependencies, cardEvents
server/domains/cards/card-service.ts          # Card state transitions, dependency resolution
server/domains/cards/types.ts                 # Column, CardStatus enums
server/domains/execution/schema.ts            # workspaceSlots, workflowRuns, stepRuns, agentLogs
server/domains/execution/workflow-orchestrator.ts  # Step loop + lifecycle (from workflow-runner.ts)
server/domains/execution/step-executor.ts     # Single step execution (from workflow-runner.ts)
server/domains/execution/types.ts             # Workflow, Step, StepResult types
server/domains/infra/                         # (moved from server/services/ and server/utils/)
app/stores/cards.ts                           # Pinia card store
app/plugins/init-store.client.ts              # Bind store to WS on mount
test/shared/event-bus.test.ts                 # TypedEventBus tests
test/domains/cards/card-service.test.ts       # CardService tests
test/domains/execution/step-executor.test.ts  # StepExecutor tests
test/domains/execution/workflow-orchestrator.test.ts  # Orchestrator tests
```

### Files to delete after migration

```
server/utils/event-bus.ts                     # Replaced by shared/event-bus.ts
server/utils/card-events.ts                   # Absorbed into CardService
server/services/workflow-runner.ts            # Split into orchestrator + step-executor
server/services/dependency-resolver.ts        # Absorbed into CardService
app/composables/useCards.ts                   # Replaced by Pinia store
app/composables/useBoard.ts                   # Replaced by Pinia store getters
```

### Files to move (pure rename, update imports)

```
server/db/index.ts          → server/shared/db/index.ts
server/db/schema.ts         → split into domains/cards/schema.ts + domains/execution/schema.ts
server/db/migrations/       → server/shared/db/migrations/
server/services/agent-executor.ts    → server/domains/execution/agent-executor.ts
server/services/slot-allocator.ts    → server/domains/execution/slot-allocator.ts
server/services/context-bundler.ts   → server/domains/execution/context-bundler.ts
server/services/workflow-loader.ts   → server/domains/execution/workflow-loader.ts
server/services/tmux-manager.ts      → server/domains/infra/tmux-manager.ts
server/services/stream-tailer.ts     → server/domains/infra/stream-tailer.ts
server/services/github-service.ts    → server/domains/infra/github-service.ts
server/services/ttyd-manager.ts      → server/domains/infra/ttyd-manager.ts
server/utils/stream-parser.ts        → server/domains/infra/stream-parser.ts
server/utils/hook-writer.ts          → server/domains/infra/hook-writer.ts
server/utils/git.ts                  → server/domains/infra/git.ts
server/utils/workflow-helpers.ts     → server/domains/execution/workflow-helpers.ts
```

---

## Task 1: Typed Event Bus

**Files:**

- Create: `server/shared/event-bus.ts`
- Create: `test/shared/event-bus.test.ts`
- Modify: `server/utils/event-bus.ts` (keep as re-export for now)

- [ ] **Step 1: Write failing tests for TypedEventBus**

```typescript
// test/shared/event-bus.test.ts
import { describe, it, expect, vi } from "vitest";
import { TypedEventBus } from "../../server/shared/event-bus";
import type { EventMap } from "../../server/shared/event-bus";

describe("TypedEventBus", () => {
  it("emits and receives typed events", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    bus.on("card:moved", handler);
    bus.emit("card:moved", { cardId: 1, fromColumn: "backlog", toColumn: "ready" });
    expect(handler).toHaveBeenCalledWith({ cardId: 1, fromColumn: "backlog", toColumn: "ready" });
  });

  it("off removes listener", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    bus.on("card:status-changed", handler);
    bus.off("card:status-changed", handler);
    bus.emit("card:status-changed", { cardId: 1, status: "running" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("once fires only once", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    bus.once("slot:released", handler);
    bus.emit("slot:released", { slotId: 1 });
    bus.emit("slot:released", { slotId: 2 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ slotId: 1 });
  });

  it("multiple listeners on same event", () => {
    const bus = new TypedEventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on("card:created", h1);
    bus.on("card:created", h2);
    bus.emit("card:created", { cardId: 5 });
    expect(h1).toHaveBeenCalledWith({ cardId: 5 });
    expect(h2).toHaveBeenCalledWith({ cardId: 5 });
  });

  it("EventMap keys export covers all events", () => {
    // Compile-time check: if EventMap is missing an event, this won't compile
    const allEvents: (keyof EventMap)[] = [
      "card:created",
      "card:moved",
      "card:status-changed",
      "card:deleted",
      "slot:claimed",
      "slot:released",
      "step:started",
      "step:completed",
      "step:failed",
      "workflow:completed",
      "agent:output",
      "agent:activity",
      "agent:waiting",
      "github:issue-found",
    ];
    expect(allEvents).toHaveLength(14);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/tt-agentboard && pnpm vitest run test/shared/event-bus.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement TypedEventBus + EventMap**

```typescript
// server/shared/event-bus.ts
import { EventEmitter } from "node:events";

// ── Column and status types (inline until domains are created) ──

export type Column = "backlog" | "ready" | "in_progress" | "review" | "done";
export type CardStatus =
  | "idle"
  | "queued"
  | "running"
  | "waiting_input"
  | "review_ready"
  | "done"
  | "failed"
  | "blocked";

export interface AgentActivityEvent {
  kind: "tool_use" | "thinking" | "text" | "result";
  [key: string]: unknown;
}

// ── Event Map ──

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

// ── Typed Event Bus ──

export class TypedEventBus {
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/tt-agentboard && pnpm vitest run test/shared/event-bus.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Bridge old imports**

Update `server/utils/event-bus.ts` to re-export from new location:

```typescript
// server/utils/event-bus.ts
export { eventBus, TypedEventBus } from "../shared/event-bus";
export type { EventMap, Column, CardStatus, AgentActivityEvent } from "../shared/event-bus";
```

This keeps all existing imports working while we migrate.

- [ ] **Step 6: Run full agentboard test suite**

Run: `cd plugins/tt-agentboard && pnpm vitest run test/services/ test/plugins/ test/integration/session-reconnect-live.test.ts test/shared/`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add plugins/tt-agentboard/server/shared/ plugins/tt-agentboard/server/utils/event-bus.ts plugins/tt-agentboard/test/shared/
git commit -m "feat(agentboard): add TypedEventBus with compile-time event safety"
```

---

## Task 2: DB Schema — cardDependencies join table + cascade deletes

**Files:**

- Modify: `server/db/schema.ts`
- Create: `test/db/schema-migration.test.ts`

- [ ] **Step 1: Write test for cardDependencies table**

```typescript
// test/db/schema-migration.test.ts
import { describe, it, expect } from "vitest";
import { db } from "../../server/db";
import { cards, boards, cardDependencies } from "../../server/db/schema";
import { eq } from "drizzle-orm";

describe("cardDependencies join table", () => {
  it("inserts and queries card dependencies", async () => {
    // Setup: create board + 2 cards
    const [board] = await db.insert(boards).values({ name: "Test" }).returning();
    const [card1] = await db
      .insert(cards)
      .values({ boardId: board.id, title: "Card 1" })
      .returning();
    const [card2] = await db
      .insert(cards)
      .values({ boardId: board.id, title: "Card 2" })
      .returning();

    // Insert dependency: card2 depends on card1
    await db.insert(cardDependencies).values({ cardId: card2.id, dependsOnCardId: card1.id });

    // Query
    const deps = await db
      .select()
      .from(cardDependencies)
      .where(eq(cardDependencies.cardId, card2.id));
    expect(deps).toHaveLength(1);
    expect(deps[0].dependsOnCardId).toBe(card1.id);
  });

  it("cascade deletes dependencies when card deleted", async () => {
    const [board] = await db.insert(boards).values({ name: "Test Cascade" }).returning();
    const [card1] = await db.insert(cards).values({ boardId: board.id, title: "Dep" }).returning();
    const [card2] = await db.insert(cards).values({ boardId: board.id, title: "Main" }).returning();

    await db.insert(cardDependencies).values({ cardId: card2.id, dependsOnCardId: card1.id });

    // Delete card1 — should cascade to cardDependencies
    await db.delete(cards).where(eq(cards.id, card1.id));

    const deps = await db.select().from(cardDependencies);
    const remaining = deps.filter((d) => d.dependsOnCardId === card1.id);
    expect(remaining).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/tt-agentboard && pnpm vitest run test/db/schema-migration.test.ts`
Expected: FAIL — `cardDependencies` not exported

- [ ] **Step 3: Add cardDependencies table and cascade deletes to schema.ts**

Add to `server/db/schema.ts` after the `cards` table definition:

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

Update existing foreign keys to add cascade/set-null behavior:

- `cards.boardId` → add `{ onDelete: "cascade" }`
- `cards.repoId` → add `{ onDelete: "set null" }`
- `cards.planId` → add `{ onDelete: "set null" }`
- `workspaceSlots.repoId` → add `{ onDelete: "cascade" }`
- `workflowRuns.cardId` → add `{ onDelete: "cascade" }`
- `workflowRuns.slotId` → add `{ onDelete: "set null" }`
- `stepRuns.workflowRunId` → add `{ onDelete: "cascade" }`
- `cardEvents.cardId` → add `{ onDelete: "cascade" }`
- `agentLogs.workflowRunId` → add `{ onDelete: "cascade" }`

Remove the `dependsOn` text column from `cards`.

- [ ] **Step 4: Generate and apply Drizzle migration**

Run:

```bash
cd plugins/tt-agentboard && pnpm db:generate && pnpm db:migrate
```

- [ ] **Step 5: Update dependency-resolver.ts to use join table**

Replace comma-string parsing with join table query in `server/services/dependency-resolver.ts`:

```typescript
import { cardDependencies } from "../db/schema";

// In resolveAfterCompletion():
// OLD: const depIds = card.dependsOn.split(",").map(Number).filter(Boolean);
// NEW:
const deps = await this.deps.db
  .select()
  .from(cardDependencies)
  .where(eq(cardDependencies.cardId, card.id));
const depIds = deps.map((d) => d.dependsOnCardId);
```

- [ ] **Step 6: Update API routes that read/write dependsOn**

Search for `dependsOn` in `server/api/` and update to use `cardDependencies` table. Key files:

- `server/api/cards/index.post.ts` — insert dependencies after card creation
- `server/api/cards/[id].put.ts` — replace dependencies on update
- `server/api/cards/index.get.ts` — join to include dependencies in response

- [ ] **Step 7: Run tests**

Run: `cd plugins/tt-agentboard && pnpm vitest run test/db/ test/services/`
Expected: All pass

- [ ] **Step 8: Commit**

```bash
git add plugins/tt-agentboard/server/db/ plugins/tt-agentboard/server/services/dependency-resolver.ts plugins/tt-agentboard/server/api/ plugins/tt-agentboard/test/db/
git commit -m "feat(agentboard): add cardDependencies join table, cascade deletes, drop dependsOn string"
```

---

## Task 3: Domain Directory Restructure

Pure file moves + import updates. No functionality changes.

**Files:** All files listed in "Files to move" section above.

- [ ] **Step 1: Create domain directories**

```bash
cd plugins/tt-agentboard
mkdir -p server/shared/db server/domains/cards server/domains/execution server/domains/infra
```

- [ ] **Step 2: Move shared/db files**

```bash
mv server/db/index.ts server/shared/db/index.ts
mv server/db/migrations server/shared/db/migrations
# schema.ts stays — will be split in Step 4
```

Update `server/shared/db/index.ts` import paths for schema and migrations dir.

- [ ] **Step 3: Move infra files**

```bash
mv server/services/tmux-manager.ts server/domains/infra/
mv server/services/stream-tailer.ts server/domains/infra/
mv server/services/github-service.ts server/domains/infra/
mv server/services/ttyd-manager.ts server/domains/infra/
mv server/utils/stream-parser.ts server/domains/infra/
mv server/utils/hook-writer.ts server/domains/infra/
mv server/utils/git.ts server/domains/infra/
```

- [ ] **Step 4: Split schema.ts into domain schemas**

Create `server/domains/cards/schema.ts` — move `repositories`, `boards`, `plans`, `cards`, `cardDependencies`, `cardEvents` tables.

Create `server/domains/execution/schema.ts` — move `workspaceSlots`, `workflowRuns`, `stepRuns`, `agentLogs` tables.

Create `server/shared/db/schema.ts` that re-exports everything:

```typescript
export * from "../../domains/cards/schema";
export * from "../../domains/execution/schema";
```

Delete `server/db/schema.ts`. Update `server/shared/db/index.ts` to import from new schema location.

- [ ] **Step 5: Move execution domain files**

```bash
mv server/services/agent-executor.ts server/domains/execution/
mv server/services/slot-allocator.ts server/domains/execution/
mv server/services/context-bundler.ts server/domains/execution/
mv server/services/workflow-loader.ts server/domains/execution/
mv server/utils/workflow-helpers.ts server/domains/execution/
```

- [ ] **Step 6: Create cards domain types**

```typescript
// server/domains/cards/types.ts
export type Column = "backlog" | "ready" | "in_progress" | "review" | "done";
export type CardStatus =
  | "idle"
  | "queued"
  | "running"
  | "waiting_input"
  | "review_ready"
  | "done"
  | "failed"
  | "blocked";
```

Update `server/shared/event-bus.ts` to import from `../domains/cards/types` instead of inline types.

- [ ] **Step 7: Fix all import paths across the codebase**

Use find-and-replace across all `.ts` and `.vue` files:

- `"../db"` or `"../../server/db"` → `"../shared/db"` or `"../../server/shared/db"`
- `"../db/schema"` → `"../shared/db/schema"` (the re-export file)
- `"../services/tmux-manager"` → `"../domains/infra/tmux-manager"` (etc for all moved files)
- `"../utils/event-bus"` → keep working via re-export bridge from Task 1

- [ ] **Step 8: Delete empty old directories**

```bash
rmdir server/db 2>/dev/null  # if empty after moves
# Keep server/services/ for now — still has workflow-runner.ts (split in Task 4)
# Keep server/utils/ — still has logger.ts, config.ts, params.ts
```

- [ ] **Step 9: Run typecheck + tests**

```bash
cd plugins/tt-agentboard
# Typecheck isn't separate for Nuxt — rely on test imports
pnpm vitest run test/services/ test/plugins/ test/integration/session-reconnect-live.test.ts test/shared/ test/db/
```

Expected: All pass

- [ ] **Step 10: Commit**

```bash
git add -A plugins/tt-agentboard/server/ plugins/tt-agentboard/test/
git commit -m "refactor(agentboard): reorganize server into domain-driven structure"
```

---

## Task 4: CardService — Centralize card state transitions

**Files:**

- Create: `server/domains/cards/card-service.ts`
- Create: `test/domains/cards/card-service.test.ts`
- Modify: All files that do ad-hoc `db.update(cards)` + `eventBus.emit("card:status-changed")`

- [ ] **Step 1: Write failing tests for CardService**

```typescript
// test/domains/cards/card-service.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CardService } from "../../server/domains/cards/card-service";

describe("CardService", () => {
  let service: CardService;
  let mockDb: Record<string, ReturnType<typeof vi.fn>>;
  let mockEventBus: { emit: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockDb = {
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      }),
    };
    mockEventBus = { emit: vi.fn() };

    service = new CardService({
      db: mockDb as never,
      eventBus: mockEventBus as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    });
  });

  it("updateStatus updates DB and emits event", async () => {
    await service.updateStatus(1, "running");
    expect(mockDb.update).toHaveBeenCalled();
    expect(mockEventBus.emit).toHaveBeenCalledWith("card:status-changed", {
      cardId: 1,
      status: "running",
    });
  });

  it("moveToColumn updates DB and emits card:moved", async () => {
    // Mock select to return card with current column
    mockDb.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: 1, column: "backlog" }]),
      }),
    });

    await service.moveToColumn(1, "ready");
    expect(mockDb.update).toHaveBeenCalled();
    expect(mockEventBus.emit).toHaveBeenCalledWith("card:moved", {
      cardId: 1,
      fromColumn: "backlog",
      toColumn: "ready",
    });
  });

  it("markFailed sets status and emits event", async () => {
    await service.markFailed(1, "tmux died");
    expect(mockEventBus.emit).toHaveBeenCalledWith("card:status-changed", {
      cardId: 1,
      status: "failed",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/tt-agentboard && pnpm vitest run test/domains/cards/card-service.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement CardService**

```typescript
// server/domains/cards/card-service.ts
import { eq, inArray } from "drizzle-orm";
import { cards, cardDependencies, cardEvents } from "./schema";
import { eventBus as defaultEventBus } from "../../shared/event-bus";
import type { TypedEventBus } from "../../shared/event-bus";
import type { Column, CardStatus } from "./types";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

export interface CardServiceDeps {
  db: BetterSQLite3Database<Record<string, unknown>>;
  eventBus: TypedEventBus;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

export class CardService {
  private deps: CardServiceDeps;

  constructor(deps: Partial<CardServiceDeps> & Pick<CardServiceDeps, "db">) {
    this.deps = { eventBus: defaultEventBus, logger: console, ...deps } as CardServiceDeps;
  }

  async updateStatus(cardId: number, status: CardStatus): Promise<void> {
    await this.deps.db
      .update(cards)
      .set({ status, updatedAt: new Date() })
      .where(eq(cards.id, cardId));
    this.deps.eventBus.emit("card:status-changed", { cardId, status });
  }

  async moveToColumn(cardId: number, toColumn: Column): Promise<void> {
    const [card] = await this.deps.db.select().from(cards).where(eq(cards.id, cardId));
    if (!card) return;

    const fromColumn = card.column as Column;
    await this.deps.db
      .update(cards)
      .set({ column: toColumn, updatedAt: new Date() })
      .where(eq(cards.id, cardId));
    this.deps.eventBus.emit("card:moved", { cardId, fromColumn, toColumn });
  }

  async markFailed(cardId: number, reason?: string): Promise<void> {
    await this.updateStatus(cardId, "failed");
    if (reason) {
      await this.logEvent(cardId, "agent_failed", reason);
    }
  }

  async markComplete(cardId: number): Promise<void> {
    await this.updateStatus(cardId, "review_ready");
    await this.moveToColumn(cardId, "review");
  }

  async logEvent(cardId: number, event: string, detail?: string): Promise<void> {
    await this.deps.db.insert(cardEvents).values({ cardId, event, detail });
  }

  async resolveDependencies(completedCardId: number): Promise<number[]> {
    // Find cards that depend on the completed card
    const dependents = await this.deps.db
      .select()
      .from(cardDependencies)
      .where(eq(cardDependencies.dependsOnCardId, completedCardId));

    const unblockedIds: number[] = [];

    for (const dep of dependents) {
      // Check if ALL dependencies of this card are now done
      const allDeps = await this.deps.db
        .select()
        .from(cardDependencies)
        .where(eq(cardDependencies.cardId, dep.cardId));

      const depCardIds = allDeps.map((d) => d.dependsOnCardId);
      if (depCardIds.length === 0) continue;

      const depCards = await this.deps.db.select().from(cards).where(inArray(cards.id, depCardIds));

      const allDone = depCards.every((c) => c.status === "done");
      if (allDone) {
        await this.moveToColumn(dep.cardId, "ready");
        await this.updateStatus(dep.cardId, "idle");
        unblockedIds.push(dep.cardId);
      }
    }

    return unblockedIds;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd plugins/tt-agentboard && pnpm vitest run test/domains/cards/card-service.test.ts`
Expected: PASS

- [ ] **Step 5: Replace ad-hoc card state changes with CardService calls**

Search for patterns like `db.update(cards).set({ status:` and `eventBus.emit("card:status-changed"` across:

- `server/domains/execution/agent-executor.ts`
- `server/plugins/queue-manager.ts`
- `server/plugins/session-reconnect.ts`
- `server/plugins/dependency-watcher.ts`
- `server/api/cards/[id]/move.post.ts`
- `server/api/agents/[cardId]/complete.post.ts`
- `server/api/agents/[cardId]/failure.post.ts`

Replace each pair of `db.update + eventBus.emit` with a single `cardService.updateStatus()` or `cardService.markFailed()` call.

- [ ] **Step 6: Delete server/utils/card-events.ts and server/services/dependency-resolver.ts**

Their functionality is now in CardService.

- [ ] **Step 7: Run full test suite**

Run: `cd plugins/tt-agentboard && pnpm vitest run test/`
Expected: All pass (some tests may need import updates)

- [ ] **Step 8: Commit**

```bash
git add -A plugins/tt-agentboard/
git commit -m "feat(agentboard): add CardService, centralize all card state transitions"
```

---

## Task 5: Workflow-Runner Decomposition

**Files:**

- Create: `server/domains/execution/step-executor.ts`
- Create: `server/domains/execution/workflow-orchestrator.ts`
- Create: `test/domains/execution/step-executor.test.ts`
- Create: `test/domains/execution/workflow-orchestrator.test.ts`
- Delete: `server/services/workflow-runner.ts` (after migration)

- [ ] **Step 1: Write StepExecutor tests**

Test the core step execution: spawn Claude command, wait for callback, check artifact, evaluate pass condition. Use the same mock helpers pattern from existing tests.

Key test cases:

- Step passes on first attempt
- Step fails and retries up to max_retries
- Artifact missing after Claude exits
- Pass condition fails (first_line_equals check)
- Timeout waiting for callback

- [ ] **Step 2: Implement StepExecutor**

Extract from `workflow-runner.ts` the `executeStep` method and its helpers (`waitForCallback`, `checkArtifact`, `evaluatePassCondition`, `spawnClaude` command building). Accept deps via constructor DI matching the pattern from existing services.

Key responsibility boundary: StepExecutor does NOT know about the workflow loop or post-steps. It runs one step and returns `{ passed: boolean; artifact?: string }`.

- [ ] **Step 3: Run StepExecutor tests**

Run: `cd plugins/tt-agentboard && pnpm vitest run test/domains/execution/step-executor.test.ts`
Expected: PASS

- [ ] **Step 4: Write WorkflowOrchestrator tests**

Test the orchestration loop: init context, iterate steps calling StepExecutor, handle goto on failure, run post-steps, cleanup.

Key test cases:

- Runs all steps in order when all pass
- Stops on step failure (no goto)
- Follows goto directive on step failure
- Runs post-steps (PR creation) on success
- Cleans up (kill tmux, release slot) in finally block
- Returns early when card not found

- [ ] **Step 5: Implement WorkflowOrchestrator**

Extract from `workflow-runner.ts` the `run` method, `initContext`, `runPostSteps`, `cleanup`, and `fail` methods. Inject `StepExecutor` and `CardService` as deps.

- [ ] **Step 6: Run WorkflowOrchestrator tests**

Run: `cd plugins/tt-agentboard && pnpm vitest run test/domains/execution/workflow-orchestrator.test.ts`
Expected: PASS

- [ ] **Step 7: Update agent-executor.ts to use WorkflowOrchestrator**

Replace `workflowRunner.run(cardId)` call with `workflowOrchestrator.run(cardId)`.

- [ ] **Step 8: Update step-complete API route**

`server/api/agents/[cardId]/step-complete.post.ts` calls `resolveStepComplete`. Update to import from new StepExecutor location.

- [ ] **Step 9: Delete workflow-runner.ts**

Remove `server/services/workflow-runner.ts`. All its code now lives in `workflow-orchestrator.ts` and `step-executor.ts`.

- [ ] **Step 10: Run full test suite**

Run: `cd plugins/tt-agentboard && pnpm vitest run test/`
Expected: All pass

- [ ] **Step 11: Commit**

```bash
git add -A plugins/tt-agentboard/
git commit -m "refactor(agentboard): split workflow-runner into orchestrator + step-executor"
```

---

## Task 6: Pinia Store

**Files:**

- Modify: `package.json` (add pinia + @pinia/nuxt)
- Modify: `nuxt.config.ts` (add @pinia/nuxt module)
- Create: `app/stores/cards.ts`
- Create: `app/plugins/init-store.client.ts`
- Modify: `app/pages/index.vue`
- Modify: `app/pages/cards/[id].vue`
- Modify: `app/components/board/KanbanBoard.vue`
- Delete: `app/composables/useCards.ts`
- Delete: `app/composables/useBoard.ts`

- [ ] **Step 1: Install Pinia**

```bash
cd plugins/tt-agentboard && pnpm add @pinia/nuxt pinia
```

- [ ] **Step 2: Add @pinia/nuxt to nuxt.config.ts modules**

```typescript
// nuxt.config.ts — add to modules array
modules: ["@nuxtjs/tailwindcss", "@pinia/nuxt"],
```

- [ ] **Step 3: Create useCardStore**

```typescript
// app/stores/cards.ts
import { defineStore } from "pinia";
import type { Column, CardStatus } from "../../server/shared/event-bus";

export interface Card {
  id: number;
  boardId: number;
  title: string;
  description: string | null;
  repoId: number | null;
  column: Column;
  position: number;
  executionMode: string;
  branchMode: string;
  status: CardStatus;
  planId: number | null;
  workflowId: string | null;
  githubIssueNumber: number | null;
  githubPrNumber: number | null;
  currentStepId: string | null;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
  // Joined fields from API
  repo?: { id: number; name: string; org: string | null; githubUrl: string | null };
  branch?: string;
  dependencies?: number[];
}

export const useCardStore = defineStore("cards", () => {
  const cards = ref<Card[]>([]);
  const selectedCardId = ref<number | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  // Getters
  const selectedCard = computed(
    () => cards.value.find((c) => c.id === selectedCardId.value) ?? null,
  );

  const columnCards = computed(() => {
    const grouped: Record<string, Card[]> = {};
    for (const card of cards.value) {
      (grouped[card.column] ??= []).push(card);
    }
    // Sort each column by position
    for (const col of Object.values(grouped)) {
      col.sort((a, b) => a.position - b.position);
    }
    return grouped;
  });

  const columnCounts = computed(() => {
    const counts: Record<string, number> = {};
    for (const card of cards.value) {
      counts[card.column] = (counts[card.column] ?? 0) + 1;
    }
    return counts;
  });

  const activeCards = computed(() => cards.value.filter((c) => c.status === "running"));

  // Actions
  async function fetchCards(boardId = 1) {
    loading.value = true;
    error.value = null;
    try {
      cards.value = await $fetch<Card[]>(`/api/cards`, { query: { boardId } });
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  async function moveCard(cardId: number, column: Column, position: number) {
    // Optimistic update
    const card = cards.value.find((c) => c.id === cardId);
    const prevColumn = card?.column;
    const prevPosition = card?.position;
    if (card) {
      card.column = column;
      card.position = position;
    }

    try {
      await $fetch(`/api/cards/${cardId}/move`, {
        method: "POST",
        body: { column, position },
      });
    } catch {
      // Revert on error
      if (card && prevColumn !== undefined && prevPosition !== undefined) {
        card.column = prevColumn;
        card.position = prevPosition;
      }
      await fetchCards();
    }
  }

  async function createCard(data: Partial<Card>) {
    const created = await $fetch<Card>("/api/cards", {
      method: "POST",
      body: data,
    });
    cards.value.push(created);
    return created;
  }

  async function deleteCard(cardId: number) {
    cards.value = cards.value.filter((c) => c.id !== cardId);
    await $fetch(`/api/cards/${cardId}`, { method: "DELETE" });
  }

  function selectCard(id: number | null) {
    selectedCardId.value = id;
  }

  // WebSocket binding
  function bindWebSocket(ws: { on: (event: string, handler: (data: never) => void) => void }) {
    ws.on("card:moved", (data: { cardId: number; toColumn: Column }) => {
      const card = cards.value.find((c) => c.id === data.cardId);
      if (card) card.column = data.toColumn;
    });
    ws.on("card:status-changed", (data: { cardId: number; status: CardStatus }) => {
      const card = cards.value.find((c) => c.id === data.cardId);
      if (card) card.status = data.status;
    });
    ws.on("card:created", () => fetchCards());
    ws.on("card:deleted", (data: { cardId: number }) => {
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
    selectCard,
    bindWebSocket,
  };
});
```

- [ ] **Step 4: Create init-store plugin**

```typescript
// app/plugins/init-store.client.ts
export default defineNuxtPlugin(() => {
  const cardStore = useCardStore();
  const ws = useWebSocket();
  cardStore.bindWebSocket(ws);
  cardStore.fetchCards();
});
```

- [ ] **Step 5: Update index.vue to use Pinia store**

Replace all `useCards()` and `useBoard()` calls with `useCardStore()`. Remove local card state management. The page becomes a thin shell that reads from the store.

Key changes:

- `const { cards, fetchCards, moveCard, createCard } = useCards()` → `const store = useCardStore()`
- `const { columnCards, columnCounts } = useBoard(cards)` → `store.columnCards`, `store.columnCounts`
- `selectedCardId` local ref → `store.selectedCardId`
- Remove `bindCards()` call — handled by init-store plugin

- [ ] **Step 6: Update cards/[id].vue to use Pinia store**

Replace local card fetching with `store.selectedCard` computed.

- [ ] **Step 7: Update KanbanBoard.vue to use store**

Replace props-based card data with store reads.

- [ ] **Step 8: Delete old composables**

```bash
rm app/composables/useCards.ts app/composables/useBoard.ts
```

Remove `bindCards()` from `useWebSocket.ts` if it exists.

- [ ] **Step 9: Run dev server and verify manually**

```bash
cd plugins/tt-agentboard && AGENTBOARD_DATA_DIR=~/.config/towles-tool/agentboard pnpm dev
```

Verify board loads, cards display, drag-and-drop works, card selection works.

- [ ] **Step 10: Commit**

```bash
git add -A plugins/tt-agentboard/
git commit -m "feat(agentboard): replace composables with Pinia card store"
```

---

## Task 7: Clean up re-export bridges + final import audit

- [ ] **Step 1: Replace event-bus re-export bridge**

Update all files that still import from `server/utils/event-bus` to import from `server/shared/event-bus` directly. Then delete the re-export in `server/utils/event-bus.ts`.

- [ ] **Step 2: Delete empty old directories**

```bash
rmdir server/services 2>/dev/null
rmdir server/db 2>/dev/null
```

- [ ] **Step 3: Run full test suite + lint + format**

```bash
cd /home/ctowles/code/p/towles-tool
pnpm lint && pnpm typecheck && pnpm test
cd plugins/tt-agentboard && pnpm vitest run test/
```

Expected: All pass, 0 lint errors

- [ ] **Step 4: Commit**

```bash
git add -A plugins/tt-agentboard/
git commit -m "chore(agentboard): remove re-export bridges, clean up empty dirs"
```
