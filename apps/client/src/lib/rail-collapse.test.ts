import { describe, expect, it } from "vitest";
import type { RepoData } from "@/lib/agentboard";
import { railCollapseMove } from "@/lib/rail-collapse";

/** Only the fields the collapse keys read, as in `rail-hotkeys.test.ts`. */
function repo(dir: string, folderDirs: string[]): RepoData {
  return {
    key: `path:${dir}`,
    dir,
    name: dir.split("/").pop() ?? dir,
    folders: folderDirs.map((d) => ({ dir: d, name: d.split("/").pop() ?? d, sessions: [] })),
  } as unknown as RepoData;
}

const SOLO = repo("/code/dotfiles", ["/code/dotfiles"]);
const MULTI = repo("/code/tt", ["/code/tt", "/code/tt/wt/feat-x"]);
const REPOS = [SOLO, MULTI];
const FOLDER_KEY = "path:/code/tt::/code/tt/wt/feat-x";

function move(
  direction: "left" | "right" | "up" | "down",
  collapsed: Record<string, boolean> = {},
  activeFolderDir: string | null = "/code/tt/wt/feat-x",
) {
  return railCollapseMove({ repos: REPOS, activeFolderDir, collapsed, direction });
}

describe("railCollapseMove", () => {
  it("folds the focused checkout first, then the repo holding it", () => {
    expect(move("left")).toEqual([{ key: FOLDER_KEY, collapsed: true }]);
    expect(move("left", { [FOLDER_KEY]: true })).toEqual([
      { key: "path:/code/tt", collapsed: true },
    ]);
  });

  it("declines once the focused repo is already folded", () => {
    expect(move("left", { [FOLDER_KEY]: true, "path:/code/tt": true })).toEqual([]);
    expect(move("right")).toEqual([]);
  });

  it("unfolds the repo before the checkout inside it", () => {
    const collapsed = { [FOLDER_KEY]: true, "path:/code/tt": true };
    expect(move("right", collapsed)).toEqual([{ key: "path:/code/tt", collapsed: false }]);
    expect(move("right", { [FOLDER_KEY]: true })).toEqual([{ key: FOLDER_KEY, collapsed: false }]);
  });

  it("uses the one repo key for a solo repo, which has no separate checkout row", () => {
    expect(move("left", {}, "/code/dotfiles")).toEqual([
      { key: "path:/code/dotfiles", collapsed: true },
    ]);
    expect(move("right", { "path:/code/dotfiles": true }, "/code/dotfiles")).toEqual([
      { key: "path:/code/dotfiles", collapsed: false },
    ]);
  });

  it("declines when nothing on the rail is focused", () => {
    expect(move("left", {}, null)).toEqual([]);
    expect(move("left", {}, "/code/gone")).toEqual([]);
  });

  it("collapses every still-open repo, and expands both levels back", () => {
    expect(move("up")).toEqual([
      { key: "path:/code/dotfiles", collapsed: true },
      { key: "path:/code/tt", collapsed: true },
    ]);
    expect(move("up", { "path:/code/dotfiles": true })).toEqual([
      { key: "path:/code/tt", collapsed: true },
    ]);
    expect(move("down", { "path:/code/tt": true, [FOLDER_KEY]: true })).toEqual([
      { key: "path:/code/tt", collapsed: false },
      { key: FOLDER_KEY, collapsed: false },
    ]);
    expect(move("down")).toEqual([]);
  });
});
