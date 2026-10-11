import { describe, expect, it } from "vitest";
import type { RepoData, WindowsPayload } from "@/lib/agentboard";
import { railCollapseAll, railExpandAll } from "@/lib/rail-collapse";
import { railMove, railNodes, resolveCursor, type RailNode } from "@/lib/rail-nodes";

/** Only the fields the walk reads — the fixture shape `rail-hotkeys.test.ts` uses. */
function repo(dir: string, folders: Record<string, string[]>): RepoData {
  return {
    key: `path:${dir}`,
    dir,
    name: dir.split("/").pop() ?? dir,
    folders: Object.entries(folders).map(([d, sessions]) => ({
      dir: d,
      name: d.split("/").pop() ?? d,
      sessions: sessions.map((id) => ({ id })),
    })),
  } as unknown as RepoData;
}

const SOLO = repo("/code/dotfiles", { "/code/dotfiles": ["a", "b"] });
const MULTI = repo("/code/tt", { "/code/tt": ["c"], "/code/tt/wt/feat-x": ["d", "e"] });
const REPOS = [SOLO, MULTI];
const REPO_KEY = "path:/code/tt";
const FOLDER_KEY = "path:/code/tt::/code/tt/wt/feat-x";

function nodes(collapsed: Record<string, boolean> = {}, wins: WindowsPayload | null = null) {
  return railNodes({
    repos: REPOS,
    idleDirs: new Map(),
    idleRevealed: new Set(),
    unmanagedDirs: new Map(),
    unmanagedRevealed: new Set(),
    collapsed,
    wins,
  });
}

const keys = (ns: RailNode[]) =>
  ns.map((n) => `${n.kind[0]}${n.depth}:${(n.sessionId ?? n.key).split("/").pop()}`);

function move(
  direction: "up" | "down" | "left" | "right",
  cursor: string | null,
  collapsed: Record<string, boolean> = {},
) {
  return railMove({ nodes: nodes(collapsed), cursor, direction, collapsed });
}

describe("railNodes", () => {
  it("emits every visible row in render order, sessions under their checkout", () => {
    expect(keys(nodes())).toEqual([
      "r0:dotfiles",
      "s1:a",
      "s1:b",
      "r0:tt",
      "f1:tt",
      "s2:c",
      "f1:feat-x",
      "s2:d",
      "s2:e",
    ]);
  });

  it("keeps a folded row and drops only what it holds", () => {
    expect(keys(nodes({ [FOLDER_KEY]: true }))).toEqual([
      "r0:dotfiles",
      "s1:a",
      "s1:b",
      "r0:tt",
      "f1:tt",
      "s2:c",
      "f1:feat-x",
    ]);
    expect(keys(nodes({ [REPO_KEY]: true }))).toEqual(["r0:dotfiles", "s1:a", "s1:b", "r0:tt"]);
    expect(keys(nodes({ "path:/code/dotfiles": true }))).toEqual([
      "r0:dotfiles",
      "r0:tt",
      "f1:tt",
      "s2:c",
      "f1:feat-x",
      "s2:d",
      "s2:e",
    ]);
  });

  it("gives a solo repo one row carrying its checkout, and the repo key to fold", () => {
    const [solo] = nodes();
    expect(solo).toMatchObject({
      kind: "repo",
      dir: "/code/dotfiles",
      collapseKey: "path:/code/dotfiles",
      depth: 0,
    });
  });

  it("drops a repo the filter emptied — it renders as a stub, not a header", () => {
    const hidden = railNodes({
      repos: REPOS,
      idleDirs: new Map([["path:/code/dotfiles", new Set(["/code/dotfiles"])]]),
      idleRevealed: new Set(),
      unmanagedDirs: new Map(),
      unmanagedRevealed: new Set(),
      collapsed: {},
      wins: null,
    });
    expect(keys(hidden).some((k) => k.endsWith("dotfiles"))).toBe(false);
  });

  it("drops the worktrees agents made until their stub is peeked open", () => {
    const v = {
      repos: [MULTI],
      idleDirs: new Map(),
      idleRevealed: new Set<string>(),
      unmanagedDirs: new Map([[REPO_KEY, new Set(["/code/tt/wt/feat-x"])]]),
      unmanagedRevealed: new Set<string>(),
      collapsed: {},
      wins: null,
    };
    expect(keys(railNodes(v))).toEqual(["r0:tt", "f1:tt", "s2:c"]);
    expect(keys(railNodes({ ...v, unmanagedRevealed: new Set([REPO_KEY]) }))).toEqual([
      "r0:tt",
      "f1:tt",
      "s2:c",
      "f1:feat-x",
      "s2:d",
      "s2:e",
    ]);
  });

  it("orders a checkout's sessions window-grouped first, as the rail draws them", () => {
    const wins = {
      windows: [{ id: "w1", folderDir: "/code/tt/wt/feat-x", panes: ["e"] }],
      activeWindows: {},
    } as unknown as WindowsPayload;
    expect(keys(nodes({}, wins)).slice(-2)).toEqual(["s2:e", "s2:d"]);
  });
});

describe("railMove", () => {
  it("steps one visible row and stops at both ends", () => {
    expect(move("down", "path:/code/dotfiles")).toEqual({ kind: "cursor", key: "session:a" });
    expect(move("up", "session:a")).toEqual({ kind: "cursor", key: "path:/code/dotfiles" });
    expect(move("up", "path:/code/dotfiles")).toBeNull();
    expect(move("down", "session:e")).toBeNull();
  });

  it("adopts an end of the rail when nothing is under the cursor yet", () => {
    expect(move("down", null)).toEqual({ kind: "cursor", key: "path:/code/dotfiles" });
    expect(move("up", null)).toEqual({ kind: "cursor", key: "session:e" });
    // Left and right need a row: there is nothing to fold or descend into.
    expect(move("left", null)).toBeNull();
    expect(move("right", null)).toBeNull();
  });

  it("folds under the cursor with left, then climbs to what holds it", () => {
    expect(move("left", FOLDER_KEY)).toEqual({
      kind: "collapse",
      key: FOLDER_KEY,
      collapsed: true,
    });
    expect(move("left", FOLDER_KEY, { [FOLDER_KEY]: true })).toEqual({
      kind: "cursor",
      key: REPO_KEY,
    });
    expect(move("left", "session:d")).toEqual({ kind: "cursor", key: FOLDER_KEY });
    // A folded repo is the top of the tree — nothing left of it.
    expect(move("left", REPO_KEY, { [REPO_KEY]: true })).toBeNull();
  });

  it("unfolds with right, else descends into the first child", () => {
    expect(move("right", REPO_KEY, { [REPO_KEY]: true })).toEqual({
      kind: "collapse",
      key: REPO_KEY,
      collapsed: false,
    });
    expect(move("right", REPO_KEY)).toEqual({ kind: "cursor", key: "path:/code/tt::/code/tt" });
  });

  it("hands a leaf's right edge to the panes", () => {
    expect(move("right", "session:e")).toEqual({ kind: "exit" });
    // An expanded row with nothing under it is a leaf too.
    const empty = repo("/code/empty", { "/code/empty": [] });
    expect(
      railMove({
        nodes: railNodes({
          repos: [empty],
          idleDirs: new Map(),
          idleRevealed: new Set(),
          unmanagedDirs: new Map(),
          unmanagedRevealed: new Set(),
          collapsed: {},
          wins: null,
        }),
        cursor: "path:/code/empty",
        direction: "right",
        collapsed: {},
      }),
    ).toEqual({ kind: "exit" });
  });
});

describe("resolveCursor", () => {
  it("keeps the row while it is on the rail", () => {
    const ns = nodes();
    expect(
      resolveCursor(
        ns,
        ns.find((n) => n.key === FOLDER_KEY)!,
      )?.key,
    ).toBe(FOLDER_KEY);
    expect(resolveCursor(ns, null)).toBeNull();
  });

  it("hands a vanished row to whatever now stands for it", () => {
    const all = nodes();
    const session = all.find((n) => n.key === "session:d")!;
    const folded = nodes({ [FOLDER_KEY]: true });
    expect(resolveCursor(folded, session)?.key).toBe(FOLDER_KEY);
    // With the whole repo folded, the repo row is what is left of it.
    expect(resolveCursor(nodes({ [REPO_KEY]: true }), session)?.key).toBe(REPO_KEY);
    expect(resolveCursor([], session)).toBeNull();
  });
});

describe("railCollapseAll / railExpandAll", () => {
  it("folds every still-open repo and unfolds both levels back", () => {
    expect(railCollapseAll(REPOS, {})).toEqual([
      { key: "path:/code/dotfiles", collapsed: true },
      { key: REPO_KEY, collapsed: true },
    ]);
    expect(railCollapseAll(REPOS, { "path:/code/dotfiles": true })).toEqual([
      { key: REPO_KEY, collapsed: true },
    ]);
    expect(railExpandAll(REPOS, { [REPO_KEY]: true, [FOLDER_KEY]: true })).toEqual([
      { key: REPO_KEY, collapsed: false },
      { key: FOLDER_KEY, collapsed: false },
    ]);
    expect(railExpandAll(REPOS, {})).toEqual([]);
  });
});
