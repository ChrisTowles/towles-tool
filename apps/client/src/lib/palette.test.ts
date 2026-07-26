import { defaultFilter } from "cmdk";
import { describe, expect, it } from "vitest";
import type { AgentStatus, FolderData, RepoData, SessionData } from "./agentboard";
import type { IssueItem, PrItem } from "./data";
import {
  paletteRepoEntries,
  paletteSessionEntries,
  palettePrEntries,
  paletteIssueEntries,
  paletteQuickAddEntry,
  paletteFilter,
  paletteRecentScreens,
} from "./palette";
import { SCREENS } from "./screens";

const agent = (status: AgentStatus) => ({ agent: "claude-code", session: "", status, ts: 1 });

function session(overrides: Partial<SessionData>): SessionData {
  return {
    id: "s1",
    name: "shell 1",
    createdAt: 0,
    live: false,
    unseen: false,
    agents: [],
    ...overrides,
  };
}

function folder(overrides: Partial<FolderData>): FolderData {
  return {
    name: "proj",
    dir: "/home/me/code/p/proj",
    dirMissing: false,
    branch: "main",
    isWorktree: false,
    committedFiles: 0,
    committedAdded: 0,
    committedRemoved: 0,
    uncommittedFiles: 0,
    uncommittedAdded: 0,
    uncommittedRemoved: 0,
    commitsAhead: 0,
    commitsBehind: 0,
    dirty: false,
    commitsUnlanded: 0,
    landed: null,
    sessions: [],
    needs: 0,
    hasPortDrift: false,
    hasLaunchConfig: false,
    quiet: false,
    ...overrides,
  };
}

function repo(name: string, folders: FolderData[]): RepoData {
  return { key: name, dir: name, name, folders, needs: 0 };
}

function pr(overrides: Partial<PrItem>): PrItem {
  return {
    repo: "octo/widgets",
    number: 1,
    title: "a pr",
    branch: "feat/x",
    state: "open",
    checks: "passing",
    reviewState: "",
    url: "https://github.com/octo/widgets/pull/1",
    updatedTs: 0,
    dismissedTs: 0,
    ...overrides,
  };
}

describe("paletteRepoEntries", () => {
  it("emits one entry per checkout with rail order preserved when none need attention", () => {
    const repos = [
      repo("octo/widgets", [folder({ dir: "/a", name: "widgets" })]),
      repo("octo/gizmos", [folder({ dir: "/b", name: "gizmos" })]),
    ];
    expect(paletteRepoEntries(repos).map((e) => e.folderDir)).toEqual(["/a", "/b"]);
  });

  it("surfaces checkouts that need attention first", () => {
    const repos = [
      repo("octo/widgets", [folder({ dir: "/a", name: "widgets" })]),
      repo("octo/gizmos", [
        folder({
          dir: "/b",
          name: "gizmos",
          sessions: [session({ live: true, agentState: agent("waiting") })],
        }),
      ]),
    ];
    const entries = paletteRepoEntries(repos);
    expect(entries[0].folderDir).toBe("/b");
    expect(entries[0].needs).toBe(1);
  });

  it("skips checkouts without an on-disk dir", () => {
    const repos = [repo("octo/widgets", [folder({ dir: "" })])];
    expect(paletteRepoEntries(repos)).toEqual([]);
  });
});

describe("paletteSessionEntries", () => {
  it("lists sessions needing attention before the rest", () => {
    const repos = [
      repo("octo/widgets", [
        folder({
          dir: "/a",
          sessions: [
            session({ id: "calm", live: true }),
            session({ id: "hot", live: true, agentState: agent("waiting") }),
          ],
        }),
      ]),
    ];
    expect(paletteSessionEntries(repos).map((e) => e.sessionId)).toEqual(["hot", "calm"]);
  });

  it("labels a session by its agent thread name when running", () => {
    const repos = [
      repo("octo/widgets", [
        folder({
          dir: "/a",
          sessions: [
            session({
              id: "s1",
              live: true,
              agentState: { ...agent("busy"), threadName: "fix the parser" },
            }),
          ],
        }),
      ]),
    ];
    expect(paletteSessionEntries(repos)[0].label).toBe("fix the parser");
  });
});

describe("palettePrEntries", () => {
  it("keeps only open PRs, newest-updated first", () => {
    const entries = palettePrEntries([
      pr({ number: 1, updatedTs: 100 }),
      pr({ number: 2, updatedTs: 300 }),
      pr({ number: 3, state: "closed", updatedTs: 999 }),
    ]);
    expect(entries.map((e) => e.number)).toEqual([2, 1]);
  });
});

function issue(overrides: Partial<IssueItem>): IssueItem {
  return {
    repo: "octo/widgets",
    number: 1,
    title: "an issue",
    labels: [],
    state: "open",
    url: "https://github.com/octo/widgets/issues/1",
    updatedTs: 0,
    dismissedTs: 0,
    ...overrides,
  };
}

describe("paletteIssueEntries", () => {
  it("keeps only open issues, newest-updated first", () => {
    const entries = paletteIssueEntries([
      issue({ number: 1, updatedTs: 100 }),
      issue({ number: 2, updatedTs: 300 }),
      issue({ number: 3, state: "closed", updatedTs: 999 }),
    ]);
    expect(entries.map((e) => e.number)).toEqual([2, 1]);
  });

  it("includes repo, number, title, and labels as fuzzy-match keywords", () => {
    const [entry] = paletteIssueEntries([
      issue({ number: 42, title: "fix the parser", labels: ["bug", "p1"] }),
    ]);
    expect(entry.keywords).toEqual(["octo/widgets", "#42", "fix the parser", "bug", "p1"]);
    expect(entry.url).toBe("https://github.com/octo/widgets/issues/1");
  });

  it("returns nothing for an empty snapshot", () => {
    expect(paletteIssueEntries([])).toEqual([]);
  });
});

describe("paletteQuickAddEntry", () => {
  it("returns null for an empty or whitespace-only query", () => {
    expect(paletteQuickAddEntry("")).toBeNull();
    expect(paletteQuickAddEntry("   ")).toBeNull();
    expect(paletteQuickAddEntry("\t\n ")).toBeNull();
  });

  it("trims surrounding whitespace from the title", () => {
    expect(paletteQuickAddEntry("  ship the release  ")?.title).toBe("ship the release");
  });

  it("preserves long text and internal whitespace verbatim", () => {
    const long =
      "follow up with the platform team about the flaky   deploy and reschedule the postmortem for next week";
    expect(paletteQuickAddEntry(long)?.title).toBe(long);
  });
});

describe("paletteRecentScreens", () => {
  it("drops the active screen and caps the list at four", () => {
    expect(
      paletteRecentScreens(
        ["board", "cockpit", "agentboard", "telemetry", "mcp", "doctor"],
        "board",
        "",
      ),
    ).toEqual(["cockpit", "agentboard", "telemetry", "mcp"]);
  });

  it("ignores ids that are no longer screens", () => {
    expect(paletteRecentScreens(["board", "retired-screen"], "settings", "")).toEqual(["board"]);
  });

  it("renders nothing once a query is typed, so Go to is the first group", () => {
    expect(paletteRecentScreens(["agentboard", "cockpit"], "board", "Board")).toEqual([]);
    expect(paletteRecentScreens(["agentboard", "cockpit"], "board", "b")).toEqual([]);
  });

  it("still renders for a whitespace-only query — nothing has been searched yet", () => {
    expect(paletteRecentScreens(["agentboard"], "board", "   ")).toEqual(["agentboard"]);
  });
});

const screenKeywords = (title: string) =>
  Object.values(SCREENS).find((s) => s.title === title)?.keywords ?? [];

describe("paletteFilter", () => {
  it("scores an exact title match 1, above cmdk's keyword-diluted default", () => {
    const exact = paletteFilter("Board", "Board", screenKeywords("Board"));
    expect(exact).toBe(1);
    expect(exact).toBeGreaterThan(paletteFilter("Board", "Boa", screenKeywords("Board")));
  });

  it("ranks the exact screen above a longer entry that merely contains the query", () => {
    const board = paletteFilter("Board", "Board", screenKeywords("Board"));
    const agentboard = paletteFilter("Agentboard", "Board", screenKeywords("Agentboard"));
    const recent = paletteFilter("recent Agentboard", "Board", screenKeywords("Agentboard"));
    expect(board).toBeGreaterThan(agentboard);
    expect(board).toBeGreaterThan(recent);
  });

  it("matches an exact title case- and whitespace-insensitively", () => {
    expect(paletteFilter("Board", "  bOaRd ", [])).toBe(1);
  });

  it("falls back to the fuzzy default for partial matches and misses", () => {
    expect(paletteFilter("Telemetry", "tele", [])).toBeGreaterThan(0);
    expect(paletteFilter("Telemetry", "zzzz", [])).toBe(0);
  });

  it("does not fire the exact-match boost on an empty query", () => {
    // An empty search means "show everything" — cmdk's default already scores
    // every item alike, and the boost must not fake an exact hit on an
    // empty-valued item.
    expect(paletteFilter("Board", "", [])).toBe(defaultFilter("Board", "", []));
    expect(paletteFilter("Board", "   ", [])).toBe(defaultFilter("Board", "   ", []));
  });
});
