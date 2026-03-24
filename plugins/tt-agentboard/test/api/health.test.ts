import { describe, it, expect } from "vitest";

const BASE = "http://localhost:4200";

describe("Health API (e2e)", () => {
  it("GET /api/health returns ok with server info", async () => {
    const res = await fetch(`${BASE}/api/health`);
    expect(res.ok).toBe(true);

    const body = await res.json();
    expect(typeof body.tmuxInstalled).toBe("boolean");
    expect(typeof body.ghAuthenticated).toBe("boolean");
  });
});
