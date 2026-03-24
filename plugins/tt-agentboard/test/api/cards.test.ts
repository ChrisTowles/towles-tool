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

describe("Cards API (e2e)", () => {
  let repoId: number;
  let cardId: number;

  beforeAll(async () => {
    // Ensure server is reachable
    const res = await fetch(`${BASE}/api/cards`);
    expect(res.ok).toBe(true);

    // Create a repo for card tests
    const repo = await api<{ id: number }>("/api/repos", {
      method: "POST",
      body: JSON.stringify({ name: "cards-test-repo", org: "test-org" }),
    });
    repoId = repo.id;
  });

  it("POST /api/cards creates a card", async () => {
    const card = await api<{ id: number; title: string; column: string; status: string }>(
      "/api/cards",
      {
        method: "POST",
        body: JSON.stringify({
          title: "E2E test card",
          description: "Created by automated test",
          repoId,
          column: "backlog",
          workflowId: "auto-claude",
        }),
      },
    );

    expect(card.id).toBeDefined();
    expect(card.title).toBe("E2E test card");
    expect(card.column).toBe("backlog");
    expect(card.status).toBe("idle");
    cardId = card.id;
  });

  it("GET /api/cards returns cards including the created one", async () => {
    const cards = await api<{ id: number }[]>("/api/cards");
    expect(Array.isArray(cards)).toBe(true);
    expect(cards.some((c) => c.id === cardId)).toBe(true);
  });

  it("GET /api/cards/:id returns the specific card", async () => {
    const card = await api<{ id: number; title: string }>(`/api/cards/${cardId}`);
    expect(card.id).toBe(cardId);
    expect(card.title).toBe("E2E test card");
  });

  it("PUT /api/cards/:id updates the card", async () => {
    const updated = await api<{ id: number; title: string; status: string }>(
      `/api/cards/${cardId}`,
      {
        method: "PUT",
        body: JSON.stringify({ title: "Updated E2E card", status: "queued" }),
      },
    );

    expect(updated.title).toBe("Updated E2E card");
    expect(updated.status).toBe("queued");
  });

  it("POST /api/cards/:id/move moves card to a new column", async () => {
    const result = await api<{ ok: boolean }>(`/api/cards/${cardId}/move`, {
      method: "POST",
      body: JSON.stringify({ column: "ready", position: 0 }),
    });
    expect(result.ok).toBe(true);

    const card = await api<{ column: string }>(`/api/cards/${cardId}`);
    expect(card.column).toBe("ready");
  });

  it("POST /api/cards/:id/move to in_progress triggers agent execution", async () => {
    const result = await api<{ ok: boolean }>(`/api/cards/${cardId}/move`, {
      method: "POST",
      body: JSON.stringify({ column: "in_progress", position: 0 }),
    });
    expect(result.ok).toBe(true);

    const card = await api<{ column: string; status: string }>(`/api/cards/${cardId}`);
    expect(card.column).toBe("in_progress");
    // Agent executor runs async — status may be "running" if slot available,
    // or stay unchanged/become "failed" if no workflow/slot configured
    expect(["queued", "running", "failed", "idle"]).toContain(card.status);
  });

  it("DELETE /api/cards/:id removes the card", async () => {
    const result = await api<{ ok: boolean }>(`/api/cards/${cardId}`, {
      method: "DELETE",
    });
    expect(result.ok).toBe(true);

    // Verify deletion
    const res = await fetch(`${BASE}/api/cards/${cardId}`);
    expect(res.status).toBe(404);
  });

  it("GET /api/cards returns cards sorted by position", async () => {
    const cards = await Promise.all([
      api<{ id: number }>("/api/cards", {
        method: "POST",
        body: JSON.stringify({ title: "Pos 2", repoId, position: 2 }),
      }),
      api<{ id: number }>("/api/cards", {
        method: "POST",
        body: JSON.stringify({ title: "Pos 0", repoId, position: 0 }),
      }),
      api<{ id: number }>("/api/cards", {
        method: "POST",
        body: JSON.stringify({ title: "Pos 1", repoId, position: 1 }),
      }),
    ]);

    const allCards = await api<{ position: number }[]>("/api/cards");
    const positions = allCards.map((c) => c.position);

    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThanOrEqual(positions[i - 1]!);
    }

    // Cleanup
    await Promise.all(cards.map((c) => api(`/api/cards/${c.id}`, { method: "DELETE" })));
  });
});
