import { describe, expect, it } from "vitest";
import type { RepoData } from "@/lib/agentboard";
import {
  fileUrl,
  folderForArtifact,
  folderForSession,
  showArtifactNav,
} from "@/lib/preview-artifact";

/** A rail repo row with only the fields the routing reads. Each folder gets one
 * session id derived from its own dir, standing in for the `TT_SESSION_ID` the
 * app stamped on that pane's shell. */
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

/** The fake session id living in folder `dir`. */
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

describe("folderForSession", () => {
  it("finds the folder whose pane the calling agent is sitting in", () => {
    expect(folderForSession(REPOS, "s-feat-x")?.dir).toBe("/code/p/tt-rs/.claude/worktrees/feat-x");
  });

  /** The whole point of routing by caller: where the file lives is irrelevant. */
  it("ignores the artifact's location entirely", () => {
    expect(folderForSession(REPOS, sessionIn("/code/p/dawn"))?.dir).toBe("/code/p/dawn");
  });

  it("has no folder for a session no pane claims", () => {
    expect(folderForSession(REPOS, "s-closed-pane")).toBeUndefined();
  });

  /** A caller outside an app terminal sends nothing; the path decides instead. */
  it("has no folder when the caller named no session", () => {
    expect(folderForSession(REPOS, null)).toBeUndefined();
    expect(folderForSession(REPOS, undefined)).toBeUndefined();
    expect(folderForSession(REPOS, "")).toBeUndefined();
  });
});

describe("showArtifactNav", () => {
  it("routes to the owning folder's preview pane", () => {
    const nav = showArtifactNav(
      {
        path: "/code/p/tt-rs/.claude/worktrees/feat-y/plan.html",
        title: "The plan",
        session: null,
      },
      REPOS,
    );
    expect(nav).toMatchObject({
      kind: "show-artifact",
      folderDir: "/code/p/tt-rs/.claude/worktrees/feat-y",
      title: "The plan",
    });
  });

  /** The regression this routing exists for: a scratch file under no tracked
   * folder used to land in whichever folder was on screen. The caller's session
   * puts it in the caller's own task. */
  it("sends a /tmp artifact to the calling agent's own task", () => {
    const nav = showArtifactNav(
      { path: "/tmp/scratch/hello.html", title: "Hello", session: "s-feat-x" },
      REPOS,
    );
    expect(nav.folderDir).toBe("/code/p/tt-rs/.claude/worktrees/feat-x");
  });

  /** The file living in one task says nothing about which agent wrote it — an
   * agent may write into a sibling checkout it is inspecting. The session wins. */
  it("prefers the caller's session over the path when they disagree", () => {
    const nav = showArtifactNav(
      {
        path: "/code/p/tt-rs/.claude/worktrees/feat-y/plan.html",
        title: "The plan",
        session: "s-feat-x",
      },
      REPOS,
    );
    expect(nav.folderDir).toBe("/code/p/tt-rs/.claude/worktrees/feat-x");
  });

  /** A session the rail no longer knows (its app instance restarted, its pane
   * closed) is no worse off than a caller that sent none. */
  it("falls back to the path for an unknown session", () => {
    const nav = showArtifactNav(
      { path: "/code/p/dawn/plan.html", title: "P", session: "s-gone" },
      REPOS,
    );
    expect(nav.folderDir).toBe("/code/p/dawn");
  });

  /** Re-showing the same file must re-read it, so every request is distinct. */
  it("stamps a fresh nonce per request", () => {
    const args = { path: "/code/p/dawn/a.html", title: "A", session: null };
    expect(showArtifactNav(args, REPOS)?.nonce).not.toBe(showArtifactNav(args, REPOS)?.nonce);
  });

  /** One app instance serves every Claude session on the machine, so a caller
   * with neither a known session nor a tracked path is normal — it just has no
   * preferred folder, and the screen falls back to whatever is on screen. */
  it("leaves the folder null for an artifact no folder owns, rather than dropping it", () => {
    expect(
      showArtifactNav({ path: "/tmp/a.html", title: "A", session: null }, REPOS),
    ).toMatchObject({
      kind: "show-artifact",
      folderDir: null,
      path: "/tmp/a.html",
    });
  });
});

describe("fileUrl", () => {
  it("encodes a space so the browser gets the whole path", () => {
    expect(fileUrl("/tmp/my plan.html")).toBe("file:///tmp/my%20plan.html");
  });

  /** `encodeURI` leaves both of these alone, and either one silently truncates
   * the path — `#` into a fragment, `?` into a query — so the browser opens a
   * shorter path that doesn't exist, or nothing at all. */
  it("escapes # and ?, which encodeURI does not", () => {
    expect(fileUrl("/tmp/plan #2.html")).toBe("file:///tmp/plan%20%232.html");
    expect(fileUrl("/tmp/what?.html")).toBe("file:///tmp/what%3F.html");
  });

  it("leaves an ordinary path unchanged", () => {
    expect(fileUrl("/code/p/dawn/report.html")).toBe("file:///code/p/dawn/report.html");
  });

  /** Percent signs already in the name must survive as data, not be read as an
   * existing escape — `encodeURI` handles this and the two replaces must not
   * undo it. */
  it("keeps a literal % in the file name", () => {
    expect(fileUrl("/tmp/100%25.html")).toBe("file:///tmp/100%2525.html");
  });
});
