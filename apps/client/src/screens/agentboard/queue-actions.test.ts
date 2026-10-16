import { describe, expect, it } from "vitest";
import { landSummary } from "./queue-actions";

describe("landSummary", () => {
  it("counts the landed and names every row that needs reading", () => {
    const { ok, problems } = landSummary([
      { folderDir: "/a", title: "a", status: "landed", message: null },
      { folderDir: "/b", title: "b", status: "merged", message: "2 uncommitted path(s)" },
      { folderDir: "/c", title: "c", status: "failed", message: "gh pr merge 3: conflict" },
    ]);
    expect(ok).toBe("Landed 1 of 3");
    expect(problems).toEqual([
      "b: merged, task left open — 2 uncommitted path(s)",
      "c: failed — gh pr merge 3: conflict",
    ]);
  });

  it("has nothing to report when every row landed", () => {
    expect(
      landSummary([{ folderDir: "/a", title: "a", status: "landed", message: null }]).problems,
    ).toEqual([]);
  });
});
