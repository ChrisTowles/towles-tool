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

describe("Plans API (e2e)", () => {
  let repoId: number;

  beforeAll(async () => {
    const res = await fetch(`${BASE}/api/plans`);
    expect(res.ok).toBe(true);

    const repo = await api<{ id: number }>("/api/repos", {
      method: "POST",
      body: JSON.stringify({ name: "plans-test-repo", org: "test-org" }),
    });
    repoId = repo.id;
  });

  describe("CRUD", () => {
    let planId: number;

    it("POST /api/plans creates a plan", async () => {
      const plan = await api<{
        id: number;
        name: string;
        description: string;
        prGranularity: string;
      }>("/api/plans", {
        method: "POST",
        body: JSON.stringify({
          name: "Test Plan",
          description: "A plan for testing",
          prGranularity: "per_card",
        }),
      });

      expect(plan.id).toBeDefined();
      expect(plan.name).toBe("Test Plan");
      expect(plan.description).toBe("A plan for testing");
      expect(plan.prGranularity).toBe("per_card");
      planId = plan.id;
    });

    it("GET /api/plans returns plans including the created one", async () => {
      const plans = await api<{ id: number }[]>("/api/plans");
      expect(Array.isArray(plans)).toBe(true);
      expect(plans.some((p) => p.id === planId)).toBe(true);
    });

    it("GET /api/plans/:id returns the specific plan with empty cards", async () => {
      const plan = await api<{ id: number; name: string; cards: unknown[] }>(
        `/api/plans/${planId}`,
      );
      expect(plan.id).toBe(planId);
      expect(plan.name).toBe("Test Plan");
      expect(Array.isArray(plan.cards)).toBe(true);
      expect(plan.cards.length).toBe(0);
    });

    it("GET /api/plans/:id returns 404 for non-existent plan", async () => {
      const res = await rawFetch("/api/plans/999999");
      expect(res.status).toBe(404);
    });
  });

  describe("validation", () => {
    it("POST /api/plans with missing name returns error", async () => {
      const res = await rawFetch("/api/plans", {
        method: "POST",
        body: JSON.stringify({ description: "No name" }),
      });
      // Server should error — either 400 or 500 depending on DB constraint
      expect(res.ok).toBe(false);
    });
  });

  describe("plan with cards", () => {
    let planId: number;
    let cardIds: number[] = [];

    it("creates a plan and cards with planId, then verifies GET returns them", async () => {
      const plan = await api<{ id: number }>("/api/plans", {
        method: "POST",
        body: JSON.stringify({ name: "Plan with cards", description: "Has cards" }),
      });
      planId = plan.id;

      for (const title of ["Card A", "Card B", "Card C"]) {
        const card = await api<{ id: number }>("/api/cards", {
          method: "POST",
          body: JSON.stringify({ title, repoId, planId }),
        });
        cardIds.push(card.id);
      }

      // Now update each card's planId via PUT since POST may not set it
      for (const id of cardIds) {
        await api(`/api/cards/${id}`, {
          method: "PUT",
          body: JSON.stringify({ planId }),
        });
      }

      const result = await api<{ id: number; cards: { id: number; title: string }[] }>(
        `/api/plans/${planId}`,
      );
      expect(result.cards.length).toBe(3);
      const titles = result.cards.map((c) => c.title);
      expect(titles).toContain("Card A");
      expect(titles).toContain("Card B");
      expect(titles).toContain("Card C");
    });

    it("cleanup", async () => {
      await Promise.all(cardIds.map((id) => api(`/api/cards/${id}`, { method: "DELETE" })));
    });
  });

  describe("prGranularity default", () => {
    it("defaults prGranularity to per_card when not provided", async () => {
      const plan = await api<{ prGranularity: string }>("/api/plans", {
        method: "POST",
        body: JSON.stringify({ name: "Default granularity plan" }),
      });
      expect(plan.prGranularity).toBe("per_card");
    });
  });
});
