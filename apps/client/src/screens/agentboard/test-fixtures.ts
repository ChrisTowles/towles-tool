import { vi } from "vitest";
import type { FolderData, RepoData, SessionData } from "@/lib/agentboard/types";

export function session(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: "s1",
    name: "shell 1",
    createdAt: 0,
    live: false,
    unseen: false,
    working: false,
    agents: [],
    ...overrides,
  };
}

export function folder(overrides: Partial<FolderData> = {}): FolderData {
  return {
    name: "proj",
    dir: "/code/proj",
    repoRoot: "/code/proj",
    record: { origin: "checkout" },
    dirMissing: false,
    branch: "main",
    isWorktree: false,
    committedFiles: 0,
    committedAdded: 0,
    committedRemoved: 0,
    uncommittedFiles: 0,
    uncommittedAdded: 0,
    uncommittedRemoved: 0,
    uncommittedCapped: false,
    stagedFiles: 0,
    stagedAdded: 0,
    stagedRemoved: 0,
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

export function repo(key: string, folders: FolderData[]): RepoData {
  return { key, dir: key, name: key, folders, needs: 0, color: "blue" };
}

/** A mock any handler prop accepts; the lint rule wants its signature stated. */
export const mockFn = () => vi.fn<(...args: unknown[]) => unknown>();
