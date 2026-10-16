// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { uiAction } from "@/lib/ui-action";
import { togglePeek, usePeekReveal } from "./use-peek-reveal";
import { mockFn } from "./test-fixtures";

vi.mock("@/lib/ui-action", () => ({ uiAction: vi.fn<(...args: unknown[]) => unknown>() }));

beforeEach(() => {
  vi.mocked(uiAction).mockClear();
});

describe("togglePeek", () => {
  it("reports show for a hidden stub and hide for a revealed one, outside the updater", () => {
    const set = mockFn();
    togglePeek(new Set(), set, "agentboard.idle_peek", "agentboard")("repo-a");
    expect(uiAction).toHaveBeenLastCalledWith("agentboard.idle_peek", "agentboard", "show");
    togglePeek(new Set(["repo-a"]), set, "agentboard.idle_peek", "agentboard")("repo-a");
    expect(uiAction).toHaveBeenLastCalledWith("agentboard.idle_peek", "agentboard", "hide");
    expect(uiAction).toHaveBeenCalledTimes(2);
  });

  it("hands the state setter a pure flip", () => {
    const set = mockFn();
    togglePeek(new Set(), set, "agentboard.unmanaged_peek", "agentboard")("repo-a");
    const updater = set.mock.calls[0][0] as (keys: Set<string>) => Set<string>;
    expect([...updater(new Set())]).toEqual(["repo-a"]);
    expect([...updater(new Set(["repo-a"]))]).toEqual([]);
  });
});

describe("usePeekReveal", () => {
  it("keeps the idle and unmanaged peeks independent per repo", () => {
    const { result } = renderHook(() => usePeekReveal());
    act(() => result.current.toggleIdleRevealed("a"));
    expect([...result.current.idleRevealed]).toEqual(["a"]);
    expect(result.current.unmanagedRevealed.size).toBe(0);
    act(() => result.current.toggleUnmanagedRevealed("b"));
    expect([...result.current.unmanagedRevealed]).toEqual(["b"]);
    act(() => result.current.toggleIdleRevealed("a"));
    expect(result.current.idleRevealed.size).toBe(0);
  });
});
