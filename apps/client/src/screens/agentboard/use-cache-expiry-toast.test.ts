// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { RepoData, SessionData } from "@/lib/agentboard/types";
import { toast } from "@/lib/toast";
import { useCacheExpiryToast } from "./use-cache-expiry-toast";

vi.mock("@/lib/toast", () => ({ toast: vi.fn<(msg: string) => void>() }));

const NOW = 1_000_000;

function repoWith(cacheExpiresAt: number): RepoData {
  const session = {
    id: "s1",
    name: "shell 1",
    createdAt: 0,
    live: true,
    unseen: false,
    working: false,
    agents: [],
    agentState: {
      agent: "claude-code",
      status: "idle",
      details: { cacheExpiresAt, cacheTtlMs: 5 * 60_000 },
    },
  } as unknown as SessionData;
  return {
    key: "r",
    dir: "/r",
    name: "r",
    needs: 0,
    color: "#000",
    folders: [{ name: "main", dir: "/r", sessions: [session] }],
  } as unknown as RepoData;
}

beforeEach(() => {
  vi.mocked(toast).mockClear();
});

describe("useCacheExpiryToast", () => {
  it("warns once per cache generation, not on every tick", () => {
    const repos = [repoWith(NOW + 60_000)];
    const { rerender } = renderHook(({ now }) => useCacheExpiryToast(repos, now), {
      initialProps: { now: NOW },
    });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast).mock.calls[0][0]).toContain("expires in ~1m");
    rerender({ now: NOW + 5_000 });
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("stays quiet while the cache is nowhere near expiring", () => {
    renderHook(() => useCacheExpiryToast([repoWith(NOW + 10 * 60_000)], NOW));
    expect(toast).not.toHaveBeenCalled();
  });
});
