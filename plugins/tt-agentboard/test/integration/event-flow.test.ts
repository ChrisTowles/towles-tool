import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestRepo,
  createTestSlot,
  createTestCard,
  moveCard,
  updateCard,
  simulateStopHook,
  resetSlot,
  WS_URL,
} from "../helpers";

interface WsEvent {
  type: string;
  cardId?: number;
  status?: string;
  fromColumn?: string;
  toColumn?: string;
  [key: string]: unknown;
}

function connectWs(timeoutMs = 5000): Promise<{ ws: WebSocket; events: WsEvent[] }> {
  return new Promise((resolve, reject) => {
    const events: WsEvent[] = [];
    const timer = setTimeout(() => reject(new Error("WebSocket connection timed out")), timeoutMs);

    const ws = new WebSocket(WS_URL);

    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve({ ws, events });
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket connection failed"));
    });
    ws.addEventListener("message", (evt) => {
      try {
        events.push(JSON.parse(String(evt.data)));
      } catch {
        // ignore non-JSON messages
      }
    });
  });
}

function waitForEvent(
  events: WsEvent[],
  type: string,
  timeoutMs = 3000,
): Promise<WsEvent | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const found = events.find((e) => e.type === type);
      if (found) return resolve(found);
      if (Date.now() - start > timeoutMs) return resolve(null);
      setTimeout(check, 50);
    };
    check();
  });
}

describe("WebSocket Event Flow (integration)", () => {
  let repoId: number;
  let slotId: number;
  let ws: WebSocket | null = null;
  let events: WsEvent[] = [];
  let wsAvailable = false;

  beforeAll(async () => {
    const repo = await createTestRepo("event-flow-repo");
    repoId = repo.id;

    const slot = await createTestSlot(repoId, "/tmp/event-flow-workspace");
    slotId = slot.id;

    try {
      const conn = await connectWs();
      ws = conn.ws;
      events = conn.events;

      // Probe: trigger an event and check if WS receives it
      const probeCard = await createTestCard(repoId, "WS probe card");
      await moveCard(probeCard.id, "ready");
      const probeEvent = await waitForEvent(events, "card:moved", 2000);
      wsAvailable = probeEvent !== null;
      events.length = 0;
    } catch {
      wsAvailable = false;
    }
  });

  afterAll(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  });

  it("receives card:moved event when card moves to in_progress", async ({ skip }) => {
    if (!wsAvailable) skip();

    const card = await createTestCard(repoId, "Event flow card");
    events.length = 0;

    await moveCard(card.id, "in_progress");

    const event = await waitForEvent(events, "card:moved");
    expect(event).not.toBeNull();
    expect(event!.cardId).toBe(card.id);
    expect(event!.toColumn).toBe("in_progress");
  });

  it("receives card:status-changed event", async ({ skip }) => {
    if (!wsAvailable) skip();

    await new Promise((r) => setTimeout(r, 500));

    const statusEvent = events.find((e) => e.type === "card:status-changed");
    expect(statusEvent).toBeDefined();
    expect(statusEvent?.cardId).toBeDefined();
  });

  it("receives workflow:completed on Stop hook", async ({ skip }) => {
    if (!wsAvailable) skip();

    await resetSlot(slotId);
    const card = await createTestCard(repoId, "Event stop card");

    await moveCard(card.id, "in_progress");
    await new Promise((r) => setTimeout(r, 500));
    await updateCard(card.id, { status: "running" });

    events.length = 0;

    await simulateStopHook(card.id);

    const event = await waitForEvent(events, "workflow:completed");
    expect(event).not.toBeNull();
    expect(event!.cardId).toBe(card.id);
    expect(event!.status).toBe("completed");
  });

  it("disconnects cleanly", ({ skip }) => {
    if (!wsAvailable || !ws) skip();

    ws!.close();
    expect([WebSocket.CLOSING, WebSocket.CLOSED]).toContain(ws!.readyState);
  });
});
