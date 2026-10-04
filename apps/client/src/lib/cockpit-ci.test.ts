import { describe, expect, it } from "vitest";
import type { CiRun } from "@/lib/data";
import {
  ciEmptyCopy,
  ciRunTitle,
  ciTone,
  groupCiRunsByRepo,
  latestPerWorkflow,
  orderCiRuns,
} from "./cockpit-ci";

function run(over: Partial<CiRun> & Pick<CiRun, "repo" | "workflow">): CiRun {
  return {
    status: "completed",
    conclusion: "success",
    createdMs: 1_000,
    updatedMs: 2_000,
    url: `https://github.com/${over.repo}/actions/runs/1`,
    headSha: "2981502e1234",
    event: "push",
    ...over,
  };
}

describe("ciTone", () => {
  it("maps status and conclusion onto the four chip tints", () => {
    expect(ciTone({ status: "in_progress", conclusion: "" })).toBe("running");
    expect(ciTone({ status: "queued", conclusion: "" })).toBe("running");
    expect(ciTone({ status: "completed", conclusion: "success" })).toBe("passing");
    expect(ciTone({ status: "completed", conclusion: "failure" })).toBe("failed");
    expect(ciTone({ status: "completed", conclusion: "timed_out" })).toBe("failed");
    expect(ciTone({ status: "completed", conclusion: "cancelled" })).toBe("plain");
    expect(ciTone({ status: "completed", conclusion: "skipped" })).toBe("plain");
  });
});

describe("orderCiRuns", () => {
  it("puts red first, then in flight, green, muted, with stable ties", () => {
    const ordered = orderCiRuns([
      run({ repo: "o/b", workflow: "CI" }),
      run({ repo: "o/a", workflow: "Nightly", conclusion: "failure" }),
      run({ repo: "o/a", workflow: "CI", status: "in_progress", conclusion: "" }),
      run({ repo: "o/a", workflow: "Docs", conclusion: "cancelled" }),
      run({ repo: "o/a", workflow: "Build" }),
    ]);
    expect(ordered.map((r) => `${r.repo}:${r.workflow}`)).toEqual([
      "o/a:Nightly",
      "o/a:CI",
      "o/a:Build",
      "o/b:CI",
      "o/a:Docs",
    ]);
  });

  it("keeps one chip per workflow, the newest run winning", () => {
    const kept = latestPerWorkflow([
      run({ repo: "o/a", workflow: "Nightly", conclusion: "failure", updatedMs: 5 }),
      run({ repo: "o/a", workflow: "Nightly", conclusion: "success", updatedMs: 9 }),
      run({ repo: "o/b", workflow: "Nightly", conclusion: "failure", updatedMs: 1 }),
    ]);
    expect(kept.map((r) => `${r.repo}:${r.conclusion}`)).toEqual(["o/a:success", "o/b:failure"]);
  });
});

describe("groupCiRunsByRepo", () => {
  it("leads with the repo whose workflow is red and keeps red first inside it", () => {
    const groups = groupCiRunsByRepo(
      orderCiRuns([
        run({ repo: "o/a", workflow: "CI" }),
        run({ repo: "o/b", workflow: "Nightly", conclusion: "failure" }),
        run({ repo: "o/b", workflow: "CI" }),
      ]),
    );
    expect(groups.map(([repo, runs]) => [repo, runs.map((r) => r.workflow)])).toEqual([
      ["o/b", ["Nightly", "CI"]],
      ["o/a", ["CI"]],
    ]);
  });
});

describe("ciEmptyCopy", () => {
  it("names the reason: no shell, nothing collected, or a filtered repo without CI", () => {
    expect(ciEmptyCopy(false, 0, null)).toBe("Not connected yet.");
    expect(ciEmptyCopy(true, 0, "octo/widgets")).toBe(
      "No default-branch workflow runs collected yet.",
    );
    expect(ciEmptyCopy(true, 4, "octo/dotfiles")).toBe("No workflow runs for octo/dotfiles.");
    expect(ciEmptyCopy(true, 4, null)).toBe("No workflow runs.");
  });
});

describe("ciRunTitle", () => {
  it("names the run, its verdict, trigger and short sha, skipping an empty verdict", () => {
    expect(ciRunTitle(run({ repo: "o/a", workflow: "Nightly", conclusion: "failure" }))).toBe(
      "Nightly · completed · failure · push · 2981502e",
    );
    expect(
      ciRunTitle(run({ repo: "o/a", workflow: "CI", status: "in_progress", conclusion: "" })),
    ).toBe("CI · in_progress · push · 2981502e");
  });
});
