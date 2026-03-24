import { describe, it, expect, beforeAll } from "vitest";

const BASE = "http://localhost:4200";

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok && res.status !== 404 && res.status !== 400 && res.status !== 409) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

async function rawFetch(path: string, options?: RequestInit) {
  return fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
}

async function createCard(repoId: number, title: string) {
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

async function getCard(cardId: number) {
  return api<{ id: number; column: string; status: string }>(`/api/cards/${cardId}`);
}

describe("Card Actions (e2e)", () => {
  let repoId: number;

  beforeAll(async () => {
    const res = await fetch(`${BASE}/api/cards`);
    expect(res.ok).toBe(true);

    const repo = await api<{ id: number }>("/api/repos", {
      method: "POST",
      body: JSON.stringify({ name: "card-actions-test-repo", org: "test-org" }),
    });
    repoId = repo.id;
  });

  describe("full lifecycle: backlog → in_progress → complete → done", () => {
    let cardId: number;

    it("creates a card in backlog", async () => {
      const card = await createCard(repoId, "Lifecycle full flow");
      cardId = card.id;
      const status = await getCard(cardId);
      expect(status.column).toBe("backlog");
      expect(status.status).toBe("idle");
    });

    it("moves to in_progress", async () => {
      await moveCard(cardId, "in_progress");
      await new Promise((r) => setTimeout(r, 500));
      const card = await getCard(cardId);
      expect(card.column).toBe("in_progress");
      expect(["queued", "running", "failed", "idle"]).toContain(card.status);
    });

    it("completes via Stop hook → moves to review", async () => {
      await api(`/api/agents/${cardId}/complete`, {
        method: "POST",
        body: JSON.stringify({ session_id: "test", hook_event_name: "Stop" }),
      });
      const card = await getCard(cardId);
      expect(card.column).toBe("review");
      expect(card.status).toBe("review_ready");
    });

    it("moves to done — slot released, status set to done", async () => {
      await moveCard(cardId, "done");
      const card = await getCard(cardId);
      expect(card.column).toBe("done");
      expect(card.status).toBe("done");
    });
  });

  describe("failure and retry: in_progress → fail → retry", () => {
    let cardId: number;

    it("creates card and moves to in_progress", async () => {
      const card = await createCard(repoId, "Failure retry flow");
      cardId = card.id;
      await moveCard(cardId, "in_progress");
      await new Promise((r) => setTimeout(r, 500));
    });

    it("fails via StopFailure hook", async () => {
      await api(`/api/agents/${cardId}/failure`, {
        method: "POST",
        body: JSON.stringify({ session_id: "test", hook_event_name: "StopFailure" }),
      });
      const card = await getCard(cardId);
      expect(card.column).toBe("in_progress");
      expect(card.status).toBe("failed");
    });

    it("retries by moving back to in_progress (re-trigger)", async () => {
      // Move to backlog first, then back to in_progress to re-trigger
      await moveCard(cardId, "backlog");
      await moveCard(cardId, "in_progress");
      await new Promise((r) => setTimeout(r, 500));
      const card = await getCard(cardId);
      expect(card.column).toBe("in_progress");
      expect(["queued", "running", "failed", "idle"]).toContain(card.status);
    });

    it("cleanup", async () => {
      await api(`/api/cards/${cardId}`, { method: "DELETE" });
    });
  });

  describe("move between columns", () => {
    let cardId: number;

    it("creates a card and moves between columns", async () => {
      const card = await createCard(repoId, "Column movement");
      cardId = card.id;

      // backlog → ready
      await moveCard(cardId, "ready");
      let status = await getCard(cardId);
      expect(status.column).toBe("ready");

      // ready → backlog
      await moveCard(cardId, "backlog");
      status = await getCard(cardId);
      expect(status.column).toBe("backlog");

      // backlog → done
      await moveCard(cardId, "done");
      status = await getCard(cardId);
      expect(status.column).toBe("done");
      expect(status.status).toBe("done");
    });
  });

  describe("delete card", () => {
    it("creates and deletes a card, verifies 404", async () => {
      const card = await createCard(repoId, "Delete me");
      const cardId = card.id;

      const result = await api<{ ok: boolean }>(`/api/cards/${cardId}`, {
        method: "DELETE",
      });
      expect(result.ok).toBe(true);

      const res = await rawFetch(`/api/cards/${cardId}`);
      expect(res.status).toBe(404);
    });

    it("delete non-existent card returns 404", async () => {
      const res = await rawFetch("/api/cards/999999", {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });
});
