import { describe, it, expect, beforeAll } from "vitest";

const BASE = "http://localhost:4200";

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

async function getCardStatus(cardId: number) {
  return api<{ column: string; status: string }>(`/api/cards/${cardId}`);
}

describe("Card Lifecycle (e2e)", () => {
  let repoId: number;
  let slotId: number;

  beforeAll(async () => {
    // Create a repo and slot for lifecycle tests
    const repo = await api<{ id: number }>("/api/repos", {
      method: "POST",
      body: JSON.stringify({ name: "lifecycle-test-repo", org: "test" }),
    });
    repoId = repo.id;

    const slot = await api<{ id: number }>("/api/slots", {
      method: "POST",
      body: JSON.stringify({ repoId, path: "/tmp/lifecycle-test-workspace" }),
    });
    slotId = slot.id;
  });

  async function createCard(title: string) {
    return api<{ id: number }>("/api/cards", {
      method: "POST",
      body: JSON.stringify({ title, description: `Test: ${title}`, repoId }),
    });
  }

  async function moveCard(cardId: number, column: string) {
    return api<{ ok: boolean }>(`/api/cards/${cardId}/move`, {
      method: "POST",
      body: JSON.stringify({ column, position: 0 }),
    });
  }

  async function resetSlot() {
    // Ensure slot is available for next test
    await api(`/api/slots/${slotId}/lock`, {
      method: "POST",
      body: JSON.stringify({ locked: false }),
    });
  }

  describe("successful completion flow", () => {
    let cardId: number;

    it("card starts as idle in backlog", async () => {
      const card = await createCard("Lifecycle: success");
      cardId = card.id;
      const status = await getCardStatus(cardId);
      expect(status.column).toBe("backlog");
      expect(status.status).toBe("idle");
    });

    it("moving to in_progress sets status to running", async () => {
      await moveCard(cardId, "in_progress");
      // Wait briefly for async executor
      await new Promise((r) => setTimeout(r, 500));
      const status = await getCardStatus(cardId);
      expect(status.column).toBe("in_progress");
      expect(["running", "queued"]).toContain(status.status);
    });

    it("Stop hook callback moves card to review", async () => {
      // Simulate Stop hook firing
      const result = await api<{ ok: boolean }>(`/api/agents/${cardId}/complete`, {
        method: "POST",
        body: JSON.stringify({ session_id: "test", hook_event_name: "Stop" }),
      });
      expect(result.ok).toBe(true);

      const status = await getCardStatus(cardId);
      expect(status.column).toBe("review");
      expect(status.status).toBe("review_ready");
    });

    it("moving to done archives the card", async () => {
      await moveCard(cardId, "done");
      const status = await getCardStatus(cardId);
      expect(status.column).toBe("done");
      expect(status.status).toBe("done");

      // Verify slot is released
      const slots = await api<{ id: number; status: string }[]>("/api/slots");
      const slot = slots.find((s) => s.id === slotId);
      expect(slot?.status).toBe("available");
    });
  });

  describe("failure flow", () => {
    let cardId: number;

    it("card runs then fails via StopFailure hook", async () => {
      await resetSlot();
      const card = await createCard("Lifecycle: failure");
      cardId = card.id;

      await moveCard(cardId, "in_progress");
      await new Promise((r) => setTimeout(r, 500));

      // Simulate StopFailure hook
      const result = await api<{ ok: boolean }>(`/api/agents/${cardId}/failure`, {
        method: "POST",
        body: JSON.stringify({ session_id: "test", hook_event_name: "StopFailure" }),
      });
      expect(result.ok).toBe(true);

      const status = await getCardStatus(cardId);
      expect(status.column).toBe("in_progress");
      expect(status.status).toBe("failed");
    });
  });

  describe("waiting_input flow", () => {
    let cardId: number;

    it("card transitions through waiting_input then completes", async () => {
      await resetSlot();
      const card = await createCard("Lifecycle: waiting");
      cardId = card.id;

      // Start execution
      await moveCard(cardId, "in_progress");
      await new Promise((r) => setTimeout(r, 500));

      // Simulate Notification hook → waiting_input
      await api(`/api/agents/${cardId}/notification`, {
        method: "POST",
        body: JSON.stringify({ session_id: "test", hook_event_name: "Notification" }),
      });

      let status = await getCardStatus(cardId);
      expect(status.status).toBe("waiting_input");

      // User responds — note: tmux session won't exist in test env,
      // so respond endpoint will 409. We test the status update separately.
      await api(`/api/cards/${cardId}`, {
        method: "PUT",
        body: JSON.stringify({ status: "running" }),
      });

      status = await getCardStatus(cardId);
      expect(status.status).toBe("running");

      // Simulate Stop hook → complete
      await api(`/api/agents/${cardId}/complete`, {
        method: "POST",
        body: JSON.stringify({ session_id: "test", hook_event_name: "Stop" }),
      });

      status = await getCardStatus(cardId);
      expect(status.column).toBe("review");
      expect(status.status).toBe("review_ready");
    });
  });

  describe("no slot available", () => {
    it("card is queued when no slots are available", async () => {
      // Create a card for a repo with no slots
      const noSlotRepo = await api<{ id: number }>("/api/repos", {
        method: "POST",
        body: JSON.stringify({ name: "no-slot-repo", org: "test" }),
      });

      const card = await createCard("Lifecycle: no slot");
      // Update card to use the repo with no slots
      await api(`/api/cards/${card.id}`, {
        method: "PUT",
        body: JSON.stringify({ repoId: noSlotRepo.id }),
      });

      await moveCard(card.id, "in_progress");
      await new Promise((r) => setTimeout(r, 500));

      const status = await getCardStatus(card.id);
      expect(status.column).toBe("in_progress");
      expect(["queued", "failed"]).toContain(status.status);
    });
  });

  describe("idempotency", () => {
    it("duplicate Stop hook callback is ignored", async () => {
      await resetSlot();
      const card = await createCard("Lifecycle: idempotent");

      await moveCard(card.id, "in_progress");
      await new Promise((r) => setTimeout(r, 500));

      // First completion
      const result1 = await api<{ ok: boolean }>(`/api/agents/${card.id}/complete`, {
        method: "POST",
        body: JSON.stringify({ session_id: "test", hook_event_name: "Stop" }),
      });
      expect(result1.ok).toBe(true);

      const status1 = await getCardStatus(card.id);
      expect(status1.status).toBe("review_ready");

      // Duplicate completion — should be ignored
      const result2 = await api<{ ok: boolean; ignored?: boolean }>(
        `/api/agents/${card.id}/complete`,
        {
          method: "POST",
          body: JSON.stringify({ session_id: "test", hook_event_name: "Stop" }),
        },
      );
      expect(result2.ok).toBe(true);
      expect(result2.ignored).toBe(true);

      // Status unchanged
      const status2 = await getCardStatus(card.id);
      expect(status2.status).toBe("review_ready");
    });
  });
});
