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

describe("Agents API (e2e)", () => {
  let repoId: number;
  let cardId: number;

  beforeAll(async () => {
    const res = await fetch(`${BASE}/api/cards`);
    expect(res.ok).toBe(true);

    const repo = await api<{ id: number }>("/api/repos", {
      method: "POST",
      body: JSON.stringify({ name: "agents-test-repo", org: "test-org" }),
    });
    repoId = repo.id;

    const card = await api<{ id: number }>("/api/cards", {
      method: "POST",
      body: JSON.stringify({ title: "Agent test card", repoId }),
    });
    cardId = card.id;
  });

  describe("GET /api/agents/:cardId/terminal", () => {
    it("returns exists:false when no tmux session", async () => {
      const result = await api<{ exists: boolean; output: string }>(
        `/api/agents/${cardId}/terminal`,
      );
      expect(result.exists).toBe(false);
      expect(result.output).toBe("");
    });

    it("returns 400 for invalid cardId (NaN)", async () => {
      const res = await rawFetch("/api/agents/notanumber/terminal");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/agents/:cardId/diff", () => {
    it("returns hasDiff:false when no slot claimed", async () => {
      const result = await api<{ hasDiff: boolean; files: unknown[]; raw: string }>(
        `/api/agents/${cardId}/diff`,
      );
      expect(result.hasDiff).toBe(false);
      expect(result.files).toEqual([]);
      expect(result.raw).toBe("");
    });

    it("returns 400 for invalid cardId (NaN)", async () => {
      const res = await rawFetch("/api/agents/notanumber/diff");
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/agents/:cardId/respond", () => {
    it("returns 400 without response field", async () => {
      const res = await rawFetch(`/api/agents/${cardId}/respond`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("returns 409 when no tmux session exists", async () => {
      const res = await rawFetch(`/api/agents/${cardId}/respond`, {
        method: "POST",
        body: JSON.stringify({ response: "test input" }),
      });
      expect(res.status).toBe(409);
    });

    it("returns 400 for invalid cardId (NaN)", async () => {
      const res = await rawFetch("/api/agents/notanumber/respond", {
        method: "POST",
        body: JSON.stringify({ response: "test" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 for non-existent card", async () => {
      const res = await rawFetch("/api/agents/999999/respond", {
        method: "POST",
        body: JSON.stringify({ response: "test" }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("invalid cardId across endpoints", () => {
    it("terminal returns 400 for cardId=0", async () => {
      const res = await rawFetch("/api/agents/0/terminal");
      expect(res.status).toBe(400);
    });

    it("diff returns 400 for cardId=0", async () => {
      const res = await rawFetch("/api/agents/0/diff");
      expect(res.status).toBe(400);
    });

    it("respond returns 400 for cardId=0", async () => {
      const res = await rawFetch("/api/agents/0/respond", {
        method: "POST",
        body: JSON.stringify({ response: "test" }),
      });
      expect(res.status).toBe(400);
    });
  });

  // Cleanup
  it("cleanup test data", async () => {
    await api(`/api/cards/${cardId}`, { method: "DELETE" });
  });
});
