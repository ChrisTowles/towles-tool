import { describe, expect, it } from "vitest";
import type { FolderData, SessionData } from "@/lib/agentboard";
import type { LaunchConfigStatus } from "@/lib/launch";
import {
  devServersOf,
  feedbackLaunch,
  feedbackNote,
  folderSendTargets,
  normRect,
} from "@/lib/preview";

const cfg = (over: Partial<LaunchConfigStatus>): LaunchConfigStatus => ({
  name: "dev",
  runtimeExecutable: "npm",
  runtimeArgs: ["run", "dev"],
  port: 1420,
  portListening: false,
  ...over,
});

describe("devServersOf", () => {
  it("maps port-bearing configs to dev servers and drops port-less ones", () => {
    const servers = devServersOf("app", "/repo", [
      cfg({ name: "vite", port: 1420, portListening: true }),
      cfg({ name: "storybook", port: null }),
    ]);
    expect(servers).toEqual([
      {
        key: "/repo\0vite",
        label: "app · vite :1420",
        url: "http://localhost:1420/",
        listening: true,
        folderDir: "/repo",
      },
    ]);
  });
});

describe("normRect", () => {
  it("normalizes any drag direction to a positive-size rect", () => {
    expect(normRect({ x: 10, y: 20 }, { x: 4, y: 50 })).toEqual({ x: 4, y: 20, w: 6, h: 30 });
    expect(normRect({ x: 0, y: 0 }, { x: 0, y: 0 })).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe("feedbackLaunch", () => {
  it("launches claude in a plain shell with the note and image paths, newline-free", () => {
    const launch = feedbackLaunch("fix\nit", "http://x", []);
    expect(launch).toBe("claude 'fix it (annotated screenshot of the app preview at http://x)'\r");
  });
});

describe("feedbackNote", () => {
  it("keeps the comment's lines, since a note is never typed into a shell", () => {
    expect(feedbackNote("a\nb", "u")).toBe("a\nb (annotated screenshot of the app preview at u)");
  });
});

const session = (over: Partial<SessionData>): SessionData =>
  ({
    id: "s1",
    name: "shell",
    createdAt: 0,
    live: false,
    unseen: false,
    agents: [],
    agentState: null,
    ...over,
  }) as SessionData;

const folder = (sessions: SessionData[]): FolderData =>
  ({
    name: "primary",
    dir: "/repo",
    dirMissing: false,
    branch: "main",
    isWorktree: false,
    sessions,
  }) as unknown as FolderData;

describe("folderSendTargets", () => {
  it("keeps only PTY-live sessions in the folder, Claude sessions first", () => {
    const targets = folderSendTargets(
      folder([
        session({ id: "dead", live: false }),
        session({ id: "shell", live: true, name: "zsh" }),
        session({
          id: "agent",
          live: true,
          name: "claude",
          agentState: { status: "busy" } as SessionData["agentState"],
        }),
      ]),
      [],
    );
    expect(targets.map((t) => t.sessionId)).toEqual(["agent", "shell"]);
    expect(targets[0].agentRunning).toBe(true);
    expect(targets[0].label).toBe("claude");
  });

  it("notes an agent whose mod listens, launches in a shell, never types into another agent", () => {
    const agent = (id: string) =>
      session({ id, live: true, agentState: { status: "busy" } as SessionData["agentState"] });
    const targets = folderSendTargets(
      folder([agent("modded"), agent("bare"), session({ id: "shell", live: true })]),
      ["modded"],
    );
    expect(Object.fromEntries(targets.map((t) => [t.sessionId, t.mode]))).toEqual({
      modded: "note",
      bare: "unreachable",
      shell: "launch",
    });
  });

  it("is empty for an undefined or session-less folder", () => {
    expect(folderSendTargets(undefined, [])).toEqual([]);
    expect(folderSendTargets(folder([]), [])).toEqual([]);
  });
});
