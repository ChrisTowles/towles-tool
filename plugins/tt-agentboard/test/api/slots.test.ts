import { describe, it, expect, beforeAll } from "vitest";

const BASE = "http://localhost:4200";

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

describe("Slots API (e2e)", () => {
  let repoId: number;
  let slotId: number;

  beforeAll(async () => {
    const repo = await api<{ id: number }>("/api/repos", {
      method: "POST",
      body: JSON.stringify({ name: "slots-e2e-repo", org: "e2e-org" }),
    });
    repoId = repo.id;
  });

  it("GET /api/slots returns an array", async () => {
    const slots = await api<unknown[]>("/api/slots");
    expect(Array.isArray(slots)).toBe(true);
  });

  it("POST /api/slots creates a workspace slot", async () => {
    const slot = await api<{
      id: number;
      repoId: number;
      path: string;
      status: string;
    }>("/api/slots", {
      method: "POST",
      body: JSON.stringify({
        repoId,
        path: "/tmp/e2e-workspace",
        portConfig: '{"web": 3000}',
        envPath: "/tmp/e2e-workspace/.env",
      }),
    });

    expect(slot.id).toBeDefined();
    expect(slot.repoId).toBe(repoId);
    expect(slot.path).toBe("/tmp/e2e-workspace");
    expect(slot.status).toBe("available");
    slotId = slot.id;
  });

  it("GET /api/slots includes the created slot", async () => {
    const slots = await api<{ id: number }[]>("/api/slots");
    expect(slots.some((s) => s.id === slotId)).toBe(true);
  });

  it("PUT /api/slots/:id updates the slot", async () => {
    const updated = await api<{ id: number; path: string }>(`/api/slots/${slotId}`, {
      method: "PUT",
      body: JSON.stringify({ path: "/tmp/e2e-workspace-updated" }),
    });

    expect(updated.path).toBe("/tmp/e2e-workspace-updated");
  });

  it("POST /api/slots/:id/lock locks the slot", async () => {
    const result = await api<{ id: number; status: string }>(`/api/slots/${slotId}/lock`, {
      method: "POST",
      body: JSON.stringify({ locked: true }),
    });

    expect(result.status).toBe("locked");
  });

  it("POST /api/slots/:id/lock with locked=false unlocks the slot", async () => {
    const result = await api<{ id: number; status: string }>(`/api/slots/${slotId}/lock`, {
      method: "POST",
      body: JSON.stringify({ locked: false }),
    });

    expect(result.status).toBe("available");
  });
});
