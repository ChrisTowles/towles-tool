import { describe, expect, it } from "vitest";
import type { RepoData } from "@/lib/agentboard";
import { defaultTaskRepo, repoOfFolder } from "./rail-new-task";

const repo = (key: string, ...dirs: string[]) =>
  ({ key, dir: dirs[0], name: key, folders: dirs.map((dir) => ({ dir })) }) as unknown as RepoData;
const a = repo("a", "/a", "/a/wt");
const b = repo("b", "/b");

describe("defaultTaskRepo", () => {
  it("prefers the selected row's repo, then the last used, then the first", () => {
    expect(defaultTaskRepo([a, b], "b", "a")).toBe(b);
    expect(defaultTaskRepo([a, b], undefined, "b")).toBe(b);
    expect(defaultTaskRepo([a, b], undefined, "gone")).toBe(a);
    expect(defaultTaskRepo([], undefined, null)).toBeUndefined();
  });
});

describe("repoOfFolder", () => {
  it("finds the repo by any of its checkouts, and nothing for a checkout-less row", () => {
    expect(repoOfFolder([a, b], "/a/wt")).toBe(a);
    expect(repoOfFolder([a, b], null)).toBeUndefined();
  });
});
