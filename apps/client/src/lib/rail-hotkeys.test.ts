import { describe, expect, it } from "vitest";
import type { RepoData, WindowsPayload } from "@/lib/agentboard";
import { railHotkeyTargets } from "@/lib/rail-hotkeys";

/** Only the fields the numbering reads — the fixture shape `editor-open.test.ts` uses. */
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

function targets(args: Partial<Parameters<typeof railHotkeyTargets>[0]> = {}) {
  return railHotkeyTargets({
    repos: [SOLO, MULTI],
    idleDirs: new Map(),
    idleRevealed: new Set(),
    unmanagedDirs: new Map(),
    unmanagedRevealed: new Set(),
    collapsed: {},
    wins: null,
    ...args,
  }).map((t) => t.sessionId);
}

describe("railHotkeyTargets", () => {
  it("numbers every visible session top-down, across repos and checkouts", () => {
    expect(targets()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("carries the checkout each session belongs to, so a jump can select it", () => {
    const [first] = railHotkeyTargets({
      repos: [MULTI],
      idleDirs: new Map(),
      idleRevealed: new Set(),
      unmanagedDirs: new Map(),
      unmanagedRevealed: new Set(),
      collapsed: {},
      wins: null,
    });
    expect(first).toEqual({ sessionId: "c", folderDir: "/code/tt" });
  });

  it("skips a collapsed repo — a badge is a promise about a row you can see", () => {
    expect(targets({ collapsed: { [SOLO.key]: true } })).toEqual(["c", "d", "e"]);
  });

  it("skips a collapsed checkout inside an expanded repo", () => {
    expect(targets({ collapsed: { [`${MULTI.key}::/code/tt`]: true } })).toEqual([
      "a",
      "b",
      "d",
      "e",
    ]);
  });

  it("ignores a folder-level collapse key on a solo repo, which has no such row", () => {
    expect(targets({ collapsed: { [`${SOLO.key}::/code/dotfiles`]: true } })).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("skips an idle checkout folded behind its stub", () => {
    const idleDirs = new Map([[MULTI.key, new Set(["/code/tt/wt/feat-x"])]]);
    expect(targets({ idleDirs })).toEqual(["a", "b", "c"]);
  });

  it("numbers an idle checkout that is peeked open", () => {
    const idleDirs = new Map([[MULTI.key, new Set(["/code/tt/wt/feat-x"])]]);
    expect(targets({ idleDirs, idleRevealed: new Set([MULTI.key]) })).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("follows the rail's window-grouped order: windowed panes, then loose rows", () => {
    const wins: WindowsPayload = {
      windows: [{ id: "w1", name: "w", folderDir: "/code/dotfiles", panes: ["b"] }],
      activeWindows: {},
    };
    expect(targets({ wins })).toEqual(["b", "a", "c", "d", "e"]);
  });

  it("passes over a window's view panes, which have no session to jump to", () => {
    const wins: WindowsPayload = {
      windows: [
        { id: "w1", name: "w", folderDir: "/code/dotfiles", panes: ["diff:/code/dotfiles", "b"] },
      ],
      activeWindows: {},
    };
    expect(targets({ wins })).toEqual(["b", "a", "c", "d", "e"]);
  });

  it("stops at nine, because the digits do", () => {
    const big = repo("/code/big", {
      "/code/big": Array.from({ length: 12 }, (_, i) => `s${i}`),
    });
    expect(targets({ repos: [big] })).toEqual([
      "s0",
      "s1",
      "s2",
      "s3",
      "s4",
      "s5",
      "s6",
      "s7",
      "s8",
    ]);
  });
});
