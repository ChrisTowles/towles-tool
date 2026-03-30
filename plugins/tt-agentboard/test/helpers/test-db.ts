/**
 * Test helpers for real DB-backed tests.
 *
 * Uses the temp SQLite DB configured in vitest.setup.ts.
 * All tests share the same DB connection — call cleanDb() in beforeEach
 * to ensure isolation between tests.
 */
import { db } from "../../server/shared/db";
import {
  boards,
  cards,
  cardDependencies,
  repositories,
  plans,
  workspaceSlots,
  workflowRuns,
} from "../../server/shared/db/schema";
import { TypedEventBus } from "../../server/shared/event-bus";
import type { EventMap } from "../../server/shared/event-bus";
import { sql } from "drizzle-orm";

export { db };

/** Delete all rows from all tables (order matters for FK constraints) */
export function cleanDb() {
  db.run(sql`DELETE FROM agent_logs`);
  db.run(sql`DELETE FROM step_runs`);
  db.run(sql`DELETE FROM workflow_runs`);
  db.run(sql`DELETE FROM card_events`);
  db.run(sql`DELETE FROM card_dependencies`);
  db.run(sql`DELETE FROM cards`);
  db.run(sql`DELETE FROM workspace_slots`);
  db.run(sql`DELETE FROM plans`);
  db.run(sql`DELETE FROM repositories`);
  db.run(sql`DELETE FROM boards`);
}

/** Create a test board, returns the inserted row */
export async function seedBoard(name = "test-board") {
  const [row] = await db.insert(boards).values({ name }).returning();
  return row;
}

/** Create a test repository, returns the inserted row */
export async function seedRepo(
  overrides: { name?: string; org?: string; defaultBranch?: string } = {},
) {
  const [row] = await db
    .insert(repositories)
    .values({
      name: overrides.name ?? "test-repo",
      org: overrides.org ?? "test-org",
      defaultBranch: overrides.defaultBranch ?? "main",
    })
    .returning();
  return row;
}

/** Create a test card, returns the inserted row */
export async function seedCard(
  boardId: number,
  overrides: Partial<typeof cards.$inferInsert> = {},
) {
  const [row] = await db
    .insert(cards)
    .values({
      boardId,
      title: "Test card",
      ...overrides,
    })
    .returning();
  return row;
}

let slotCounter = 0;

/** Create a test workspace slot, returns the inserted row */
export async function seedSlot(
  repoId: number,
  overrides: Partial<typeof workspaceSlots.$inferInsert> = {},
) {
  const [row] = await db
    .insert(workspaceSlots)
    .values({
      repoId,
      path: `/tmp/test-slot-${++slotCounter}`,
      ...overrides,
    })
    .returning();
  return row;
}

/** Create a test plan, returns the inserted row */
export async function seedPlan(name = "test-plan") {
  const [row] = await db.insert(plans).values({ name }).returning();
  return row;
}

/** Create card dependencies */
export async function seedDependency(cardId: number, dependsOnCardId: number) {
  const [row] = await db.insert(cardDependencies).values({ cardId, dependsOnCardId }).returning();
  return row;
}

/** Create a workflow run */
export async function seedWorkflowRun(
  cardId: number,
  overrides: Partial<typeof workflowRuns.$inferInsert> = {},
) {
  const [row] = await db
    .insert(workflowRuns)
    .values({
      cardId,
      workflowId: overrides.workflowId ?? "test-workflow",
      ...overrides,
    })
    .returning();
  return row;
}

// ---------------------------------------------------------------------------
// EventBus helpers
// ---------------------------------------------------------------------------

export interface CollectedEvent {
  type: string;
  data: unknown;
}

/**
 * Create a fresh TypedEventBus with an event collector attached.
 * Returns { bus, events } where events is a live array of all emitted events.
 */
export function createTestEventBus() {
  const bus = new TypedEventBus();
  const events: CollectedEvent[] = [];

  const allEventTypes: (keyof EventMap)[] = [
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

  for (const eventType of allEventTypes) {
    bus.on(eventType, ((data: unknown) => {
      events.push({ type: eventType, data });
    }) as never);
  }

  return { bus, events };
}

/** Find events of a specific type in collected events */
export function findEvents(events: CollectedEvent[], type: string) {
  return events.filter((e) => e.type === type);
}

// ---------------------------------------------------------------------------
// No-op logger (manual DI, no vi.fn)
// ---------------------------------------------------------------------------

export function createNoopLogger() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop };
}

// ---------------------------------------------------------------------------
// Type aliases for common test patterns
// ---------------------------------------------------------------------------

export type TestBus = ReturnType<typeof createTestEventBus>["bus"];
export type TestEvents = ReturnType<typeof createTestEventBus>["events"];

// ---------------------------------------------------------------------------
// Tmux stub (shared across executor/orchestrator/plugin tests)
// ---------------------------------------------------------------------------

export function createTmuxStub(opts: { isAvailable?: boolean } = {}) {
  const sendCommandCalls: Array<{ session: string; cmd: string }> = [];
  const stopCaptureCalls: string[] = [];
  const killSessionCalls: string[] = [];
  const startCaptureCalls: Array<{ name: string }> = [];
  return {
    isAvailable: () => opts.isAvailable ?? true,
    createSession: (_cardId: number, _cwd: string) => ({
      sessionName: `card-${_cardId}`,
      created: true,
    }),
    startCapture: (name: string, _cb: (data: string) => void) => {
      startCaptureCalls.push({ name });
    },
    stopCapture: (name: string) => {
      stopCaptureCalls.push(name);
    },
    killSession: (name: string) => {
      killSessionCalls.push(name);
      return true;
    },
    sendCommand: (session: string, cmd: string) => {
      sendCommandCalls.push({ session, cmd });
    },
    sendCommandCalls,
    stopCaptureCalls,
    killSessionCalls,
    startCaptureCalls,
  };
}

export type TmuxStub = ReturnType<typeof createTmuxStub>;
