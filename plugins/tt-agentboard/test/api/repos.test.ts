import { describe, it, expect } from "vitest";

const BASE = "http://localhost:4200";

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

describe("Repos API (e2e)", () => {
  let repoId: number;

  it("GET /api/repos returns an array", async () => {
    const repos = await api<unknown[]>("/api/repos");
    expect(Array.isArray(repos)).toBe(true);
  });

  it("POST /api/repos creates a repo", async () => {
    const repo = await api<{
      id: number;
      name: string;
      org: string;
      defaultBranch: string;
      githubUrl: string;
    }>("/api/repos", {
      method: "POST",
      body: JSON.stringify({
        name: "e2e-test-repo",
        org: "e2e-org",
        githubUrl: "https://github.com/e2e-org/e2e-test-repo",
      }),
    });

    expect(repo.id).toBeDefined();
    expect(repo.name).toBe("e2e-test-repo");
    expect(repo.org).toBe("e2e-org");
    expect(repo.defaultBranch).toBe("main");
    repoId = repo.id;
  });

  it("GET /api/repos includes the created repo", async () => {
    const repos = await api<{ id: number; name: string }[]>("/api/repos");
    const found = repos.find((r) => r.id === repoId);
    expect(found).toBeDefined();
    expect(found!.name).toBe("e2e-test-repo");
  });
});
