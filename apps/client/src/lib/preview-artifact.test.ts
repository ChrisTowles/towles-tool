import { describe, expect, it } from "vitest";
import type { RepoData } from "@/lib/agentboard";
import {
  fileUrl,
  folderForPath,
  folderForSession,
  showFileNav,
  typedPreviewRequest,
} from "@/lib/preview-artifact";

/** A rail repo row with only the fields the routing reads; each folder gets one
 * session id derived from its own dir. */
function repo(dir: string, folders: string[]): RepoData {
  return {
    key: `path:${dir}`,
    dir,
    name: dir.split("/").pop() ?? dir,
    originUrl: null,
    folders: folders.map((d) => ({
      dir: d,
      name: d.split("/").pop() ?? d,
      sessions: [{ id: sessionIn(d) }],
    })),
  } as unknown as RepoData;
}

function sessionIn(dir: string) {
  return `s-${dir.split("/").pop()}`;
}

const REPOS = [
  repo("/code/p/tt-rs", [
    "/code/p/tt-rs",
    "/code/p/tt-rs/.claude/worktrees/feat-x",
    "/code/p/tt-rs/.claude/worktrees/feat-y",
  ]),
  repo("/code/p/dawn", ["/code/p/dawn"]),
];

describe("folderForPath", () => {
  it("places an artifact in the folder it lives under", () => {
    expect(folderForPath(REPOS, "/code/p/dawn/plan.html")?.dir).toBe("/code/p/dawn");
  });

  /** A worktree task nests inside its checkout, so both match. */
  it("prefers the deepest match, so a task beats its parent checkout", () => {
    expect(folderForPath(REPOS, "/code/p/tt-rs/.claude/worktrees/feat-x/out.html")?.dir).toBe(
      "/code/p/tt-rs/.claude/worktrees/feat-x",
    );
  });

  it("has nowhere to put an artifact outside every tracked folder", () => {
    expect(folderForPath(REPOS, "/tmp/scratch/report.html")).toBeUndefined();
  });

  /** The separator is what makes a path a child, not a shared prefix. */
  it("doesn't match a folder that is only a string prefix", () => {
    expect(folderForPath(REPOS, "/code/p/dawncaster/plan.html")).toBeUndefined();
  });

  it("doesn't match the folder directory itself", () => {
    expect(folderForPath(REPOS, "/code/p/dawn")).toBeUndefined();
  });
});

describe("folderForSession", () => {
  it("finds the folder whose pane the calling agent is sitting in", () => {
    expect(folderForSession(REPOS, "s-feat-x")?.dir).toBe("/code/p/tt-rs/.claude/worktrees/feat-x");
  });

  it("ignores the file's location entirely", () => {
    expect(folderForSession(REPOS, sessionIn("/code/p/dawn"))?.dir).toBe("/code/p/dawn");
  });

  it("has no folder for a session no pane claims", () => {
    expect(folderForSession(REPOS, "s-closed-pane")).toBeUndefined();
  });

  it("has no folder when the caller named no session", () => {
    expect(folderForSession(REPOS, null)).toBeUndefined();
    expect(folderForSession(REPOS, undefined)).toBeUndefined();
    expect(folderForSession(REPOS, "")).toBeUndefined();
  });
});

describe("showFileNav", () => {
  it("routes to the owning folder's preview pane", () => {
    const nav = showFileNav(
      {
        path: "/code/p/tt-rs/.claude/worktrees/feat-y/plan.html",
        title: "The plan",
        session: null,
      },
      REPOS,
    );
    expect(nav).toMatchObject({
      kind: "show-file",
      folderDir: "/code/p/tt-rs/.claude/worktrees/feat-y",
      title: "The plan",
    });
  });

  /** The regression this routing exists for: a scratch file under no tracked
   * folder used to land in whichever folder was on screen. */
  it("sends a /tmp artifact to the calling agent's own task", () => {
    const nav = showFileNav(
      { path: "/tmp/scratch/hello.html", title: "Hello", session: "s-feat-x" },
      REPOS,
    );
    expect(nav.folderDir).toBe("/code/p/tt-rs/.claude/worktrees/feat-x");
  });

  /** An agent may write into a sibling checkout it is inspecting. */
  it("prefers the caller's session over the path when they disagree", () => {
    const nav = showFileNav(
      {
        path: "/code/p/tt-rs/.claude/worktrees/feat-y/plan.html",
        title: "The plan",
        session: "s-feat-x",
      },
      REPOS,
    );
    expect(nav.folderDir).toBe("/code/p/tt-rs/.claude/worktrees/feat-x");
  });

  /** A session the rail no longer knows is no worse off than one never sent. */
  it("falls back to the path for an unknown session", () => {
    const nav = showFileNav(
      { path: "/code/p/dawn/plan.html", title: "P", session: "s-gone" },
      REPOS,
    );
    expect(nav.folderDir).toBe("/code/p/dawn");
  });

  it("stamps a fresh nonce per request", () => {
    const args = { path: "/code/p/dawn/a.html", title: "A", session: null };
    expect(showFileNav(args, REPOS)?.nonce).not.toBe(showFileNav(args, REPOS)?.nonce);
  });

  /** A caller with neither a known session nor a tracked path is normal — it
   * just has no preferred folder, and the screen resolves that. */
  it("leaves the folder null for an artifact no folder owns, rather than dropping it", () => {
    expect(showFileNav({ path: "/tmp/a.html", title: "A", session: null }, REPOS)).toMatchObject({
      kind: "show-file",
      folderDir: null,
      path: "/tmp/a.html",
    });
  });
});

describe("fileUrl", () => {
  it("encodes a space so the browser gets the whole path", () => {
    expect(fileUrl("/tmp/my plan.html")).toBe("file:///tmp/my%20plan.html");
  });

  /** `encodeURI` leaves both alone, and either silently truncates the path —
   * `#` into a fragment, `?` into a query. */
  it("escapes # and ?, which encodeURI does not", () => {
    expect(fileUrl("/tmp/plan #2.html")).toBe("file:///tmp/plan%20%232.html");
    expect(fileUrl("/tmp/what?.html")).toBe("file:///tmp/what%3F.html");
  });

  it("leaves an ordinary path unchanged", () => {
    expect(fileUrl("/code/p/dawn/report.html")).toBe("file:///code/p/dawn/report.html");
  });

  /** A `%` already in the name is data, not an existing escape. */
  it("keeps a literal % in the file name", () => {
    expect(fileUrl("/tmp/100%25.html")).toBe("file:///tmp/100%2525.html");
  });
});

describe("typedPreviewRequest", () => {
  it("titles the request with the file's own name", () => {
    const req = typedPreviewRequest("/tmp/notes/plan.md");
    expect(req).toMatchObject({ path: "/tmp/notes/plan.md", title: "plan.md" });
  });

  it("trims what was typed", () => {
    expect(typedPreviewRequest("  /tmp/a.md \n")?.path).toBe("/tmp/a.md");
  });

  /** The app has no working directory to resolve a relative path against — the
   * same reason the MCP tool refuses one. */
  it("refuses anything but an absolute path", () => {
    expect(typedPreviewRequest("docs/plan.md")).toBeNull();
    expect(typedPreviewRequest("")).toBeNull();
  });

  /** Two opens of the same path must differ, or re-opening a rewritten file
   * would be a no-op. */
  it("mints a fresh nonce per call", () => {
    const a = typedPreviewRequest("/tmp/a.md");
    const b = typedPreviewRequest("/tmp/a.md");
    expect(a?.nonce).not.toBe(b?.nonce);
  });
});
