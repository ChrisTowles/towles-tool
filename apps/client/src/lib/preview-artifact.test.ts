import { describe, expect, it } from "vitest";
import type { RepoData } from "@/lib/agentboard";
import { folderForArtifact, showArtifactNav } from "@/lib/preview-artifact";

/** A rail repo row with only the fields the routing reads. */
function repo(dir: string, folders: string[]): RepoData {
  return {
    key: `path:${dir}`,
    dir,
    name: dir.split("/").pop() ?? dir,
    originUrl: null,
    folders: folders.map((d) => ({ dir: d, name: d.split("/").pop() ?? d })),
  } as unknown as RepoData;
}

const REPOS = [
  repo("/code/p/tt-rs", [
    "/code/p/tt-rs",
    "/code/p/tt-rs/.claude/worktrees/feat-x",
    "/code/p/tt-rs/.claude/worktrees/feat-y",
  ]),
  repo("/code/p/dawn", ["/code/p/dawn"]),
];

describe("folderForArtifact", () => {
  it("places an artifact in the folder it lives under", () => {
    expect(folderForArtifact(REPOS, "/code/p/dawn/plan.html")?.dir).toBe("/code/p/dawn");
  });

  /** A worktree task nests inside its checkout, so both match — and the task is
   * the one whose terminal the agent is sitting in. */
  it("prefers the deepest match, so a task beats its parent checkout", () => {
    expect(folderForArtifact(REPOS, "/code/p/tt-rs/.claude/worktrees/feat-x/out.html")?.dir).toBe(
      "/code/p/tt-rs/.claude/worktrees/feat-x",
    );
  });

  it("has nowhere to put an artifact outside every tracked folder", () => {
    expect(folderForArtifact(REPOS, "/tmp/scratch/report.html")).toBeUndefined();
  });

  /** A sibling whose path merely starts with the same characters is not inside
   * it — the separator is what makes it a child. */
  it("doesn't match a folder that is only a string prefix", () => {
    expect(folderForArtifact(REPOS, "/code/p/dawncaster/plan.html")).toBeUndefined();
  });

  /** The folder dir itself is not a file in it. */
  it("doesn't match the folder directory itself", () => {
    expect(folderForArtifact(REPOS, "/code/p/dawn")).toBeUndefined();
  });
});

describe("showArtifactNav", () => {
  it("routes to the owning folder's preview pane", () => {
    const nav = showArtifactNav(
      { path: "/code/p/tt-rs/.claude/worktrees/feat-y/plan.html", title: "The plan" },
      REPOS,
    );
    expect(nav).toMatchObject({
      kind: "show-artifact",
      folderDir: "/code/p/tt-rs/.claude/worktrees/feat-y",
      title: "The plan",
    });
  });

  /** Re-showing the same file must re-read it, so every request is distinct. */
  it("stamps a fresh nonce per request", () => {
    const args = { path: "/code/p/dawn/a.html", title: "A" };
    expect(showArtifactNav(args, REPOS)?.nonce).not.toBe(showArtifactNav(args, REPOS)?.nonce);
  });

  it("returns nothing for an artifact no folder owns, rather than guessing", () => {
    expect(showArtifactNav({ path: "/tmp/a.html", title: "A" }, REPOS)).toBeUndefined();
  });
});
