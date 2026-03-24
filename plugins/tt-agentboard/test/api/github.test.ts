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

describe("GitHub API (e2e)", () => {
  let repoId: number;
  let cardId: number;

  beforeAll(async () => {
    const res = await fetch(`${BASE}/api/health`);
    expect(res.ok).toBe(true);

    const repo = await api<{ id: number }>("/api/repos", {
      method: "POST",
      body: JSON.stringify({ name: "github-test-repo", org: "test-org" }),
    });
    repoId = repo.id;

    const card = await api<{ id: number }>("/api/cards", {
      method: "POST",
      body: JSON.stringify({ title: "GitHub test card", repoId }),
    });
    cardId = card.id;
  });

  describe("GET /api/github/status", () => {
    it("returns configured boolean", async () => {
      const status = await api<{ configured: boolean }>("/api/github/status");
      expect(typeof status.configured).toBe("boolean");
    });
  });

  describe("GET /api/github/issues", () => {
    it("requires repoId or owner+repo params", async () => {
      const res = await rawFetch("/api/github/issues");
      expect(res.status).toBe(400);
    });

    it("returns 404 for non-existent repoId", async () => {
      const res = await rawFetch("/api/github/issues?repoId=999999");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/github/issues", () => {
    it("returns error when cardId is missing", async () => {
      const res = await rawFetch("/api/github/issues", {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 when card does not exist", async () => {
      const res = await rawFetch("/api/github/issues", {
        method: "POST",
        body: JSON.stringify({ cardId: 999999 }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/cards/:id/link-issue", () => {
    it("links an issue number to a card", async () => {
      const updated = await api<{ id: number; githubIssueNumber: number }>(
        `/api/cards/${cardId}/link-issue`,
        {
          method: "POST",
          body: JSON.stringify({ issueNumber: 42 }),
        },
      );

      expect(updated.id).toBe(cardId);
      expect(updated.githubIssueNumber).toBe(42);
    });

    it("verifies the linked issue persists on GET", async () => {
      const card = await api<{ githubIssueNumber: number }>(`/api/cards/${cardId}`);
      expect(card.githubIssueNumber).toBe(42);
    });

    it("returns error when issueNumber is missing", async () => {
      const res = await rawFetch(`/api/cards/${cardId}/link-issue`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 for non-existent card", async () => {
      const res = await rawFetch("/api/cards/999999/link-issue", {
        method: "POST",
        body: JSON.stringify({ issueNumber: 1 }),
      });
      expect(res.status).toBe(404);
    });
  });

  // Cleanup
  it("cleanup test data", async () => {
    await api(`/api/cards/${cardId}`, { method: "DELETE" });
  });
});
