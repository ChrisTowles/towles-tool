import { describe, expect, it } from "vitest";
import type { RepoData } from "@/lib/agentboard";
import { openFileNav } from "@/lib/editor-open";

/** A rail repo row with only the fields the routing reads — the same fixture
 * shape as `preview-artifact.test.ts`, since both route on the same two facts. */
function repo(dir: string, folders: string[]): RepoData {
  return {
    key: `path:${dir}`,
    dir,
    name: dir.split("/").pop() ?? dir,
    originUrl: null,
    folders: folders.map((d) => ({
      dir: d,
      name: d.split("/").pop() ?? d,
      sessions: [{ id: `s-${d.split("/").pop()}` }],
    })),
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

describe("openFileNav", () => {
  it("routes to the task whose terminal asked, not the one the file is in", () => {
    const nav = openFileNav(
      {
        path: "/code/p/tt-rs/.claude/worktrees/feat-y/src/main.rs",
        isDir: false,
        line: 42,
        session: "s-feat-x",
      },
      REPOS,
    );
    expect(nav).toMatchObject({
      kind: "open-file",
      folderDir: "/code/p/tt-rs/.claude/worktrees/feat-x",
      line: 42,
      isDir: false,
    });
  });

  /** `tt open` from a plain terminal has no `TT_SESSION_ID`. Unlike an artifact,
   * a path someone asked to read names its checkout, so this fallback is the
   * normal way the CLI resolves. Longest prefix, so a file in a nested worktree
   * lands in the worktree rather than its main checkout. */
  it("falls back to the checkout containing the path, nested worktree first", () => {
    const nav = openFileNav(
      {
        path: "/code/p/tt-rs/.claude/worktrees/feat-y/src/main.rs",
        isDir: false,
        line: null,
        session: null,
      },
      REPOS,
    );
    expect(nav.folderDir).toBe("/code/p/tt-rs/.claude/worktrees/feat-y");
  });

  it("leaves the folder unresolved when nothing claims the path", () => {
    const nav = openFileNav(
      { path: "/etc/hosts", isDir: false, line: null, session: null },
      REPOS,
    );
    expect(nav.folderDir).toBeNull();
  });

  it("carries a directory through as one", () => {
    const nav = openFileNav(
      { path: "/code/p/dawn", isDir: true, line: null, session: null },
      REPOS,
    );
    expect(nav).toMatchObject({ isDir: true, folderDir: null });
  });

  /** Two opens of the same path must not collapse into a no-op — the pane keys
   * off the nonce, exactly as the artifact route does. */
  it("gives every request its own nonce", () => {
    const one = openFileNav({ path: "/code/p/dawn/x.rs", isDir: false, session: null }, REPOS);
    const two = openFileNav({ path: "/code/p/dawn/x.rs", isDir: false, session: null }, REPOS);
    expect(one.nonce).not.toBe(two.nonce);
  });
});
