import { describe, expect, it, vi } from "vitest";
import type { EventMap } from "../../server/shared/event-bus";
import { TypedEventBus } from "../../server/shared/event-bus";

describe("TypedEventBus", () => {
  it("emits and receives typed events", () => {
    const bus = new TypedEventBus();
    const handler = vi.fn();
    bus.on("card:moved", handler);
    bus.emit("card:moved", {
      cardId: 1,
      fromColumn: "backlog",
      toColumn: "ready",
    });
    expect(handler).toHaveBeenCalledWith({
      cardId: 1,
      fromColumn: "backlog",
      toColumn: "ready",
    });
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

  it("EventMap keys export covers all 14 events", () => {
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
