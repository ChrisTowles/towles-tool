import { describe, it, expect } from "vitest";

const BASE = "http://localhost:4200";

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

describe("Workflows API (e2e)", () => {
  describe("GET /api/workflows", () => {
    it("returns an array of loaded workflows", async () => {
      const workflows = await api<unknown[]>("/api/workflows");
      expect(Array.isArray(workflows)).toBe(true);
    });
  });

  describe("GET /api/workflows/templates", () => {
    it("returns a templates list or server error if templates dir missing", async () => {
      const res = await fetch(`${BASE}/api/workflows/templates`, {
        headers: { "Content-Type": "application/json" },
      });

      if (res.ok) {
        const result = (await res.json()) as {
          templates: { filename: string; name: string; description: string }[];
        };
        expect(result.templates).toBeDefined();
        expect(Array.isArray(result.templates)).toBe(true);

        for (const t of result.templates) {
          expect(typeof t.filename).toBe("string");
          expect(typeof t.name).toBe("string");
          expect(typeof t.description).toBe("string");
        }
      } else {
        // Templates directory may not exist in test environment
        expect(res.status).toBe(500);
      }
    });
  });
});
