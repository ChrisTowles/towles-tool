// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { abSetSessionPurpose } from "@/lib/agentboard/ipc";
import { termWriteRetry } from "@/lib/agentboard/pty";
import { useSessionSpawn } from "./use-session-spawn";
import { mockFn } from "./test-fixtures";

vi.mock("@/lib/agentboard/ipc", () => ({
  abSetSessionPurpose: vi.fn<(...args: unknown[]) => unknown>(),
}));
vi.mock("@/lib/agentboard/pty", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agentboard/pty")>()),
  sleep: vi.fn<() => Promise<void>>(async () => {}),
  termWriteRetry: vi.fn<(id: string, data: string) => Promise<{ isErr: () => boolean }>>(
    async () => ({ isErr: () => false }),
  ),
  waitForFirstFrame: vi.fn<() => Promise<void>>(async () => {}),
}));
vi.mock("@/lib/toast", () => ({
  toast: Object.assign(vi.fn<(...args: unknown[]) => unknown>(), {
    error: vi.fn<(...args: unknown[]) => unknown>(),
  }),
}));

const target = { folderDir: "/r", sessionId: "s1", sessionName: "shell 1", restart: false };

function spawn() {
  const selectSession = vi.fn<(...args: unknown[]) => unknown>();
  const setOverlay = vi.fn<(...args: unknown[]) => unknown>();
  const hook = renderHook(() =>
    useSessionSpawn({
      folderOf: new Map(),
      cwds: { current: {} },
      collapsed: {},
      selectSession,
      setOverlay,
      applyCollapse: mockFn(),
      setFocusLevel: mockFn(),
      setFocusTerminalRequest: mockFn(),
      updateWins: mockFn(),
    }),
  );
  return { ...hook, selectSession, setOverlay };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("commitStartClaude", () => {
  it("does nothing with no dialog open", () => {
    const { result } = spawn();
    act(() => result.current.commitStartClaude());
    expect(termWriteRetry).not.toHaveBeenCalled();
  });

  it("launches blank without labelling the session", async () => {
    const { result, selectSession } = spawn();
    act(() => result.current.setStartClaudeTarget(target));
    act(() => result.current.commitStartClaude());
    expect(result.current.startClaudeTarget).toBeNull();
    expect(abSetSessionPurpose).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(termWriteRetry).toHaveBeenCalledOnce());
    expect(selectSession).toHaveBeenCalledWith("/r", "s1");
  });

  it("records the typed prompt as the session's purpose, then clears it", async () => {
    const { result } = spawn();
    act(() => {
      result.current.setStartClaudeTarget(target);
      result.current.setStartClaudePrompt("  fix the flaky test  ");
    });
    act(() => result.current.commitStartClaude());
    expect(abSetSessionPurpose).toHaveBeenCalledWith("s1", "fix the flaky test");
    expect(result.current.startClaudePrompt).toBe("");
    await vi.waitFor(() => expect(termWriteRetry).toHaveBeenCalledOnce());
  });
});

describe("launchClaudeIn", () => {
  it("interrupts and exits the running Claude first on a restart", async () => {
    const { result, setOverlay } = spawn();
    await act(() => result.current.launchClaudeIn({ ...target, restart: true }, "go"));
    expect(setOverlay).toHaveBeenCalledOnce();
    const typed = vi.mocked(termWriteRetry).mock.calls.map(([, data]) => data);
    expect(typed.slice(0, 2)).toEqual(["\x03", "\x04"]);
    expect(typed).toHaveLength(3);
  });
});

describe("withLiveSession", () => {
  it("skips a session with no known checkout", async () => {
    const { result, selectSession } = spawn();
    const fn = vi.fn<() => Promise<void>>(async () => {});
    await act(() => result.current.withLiveSession("ghost", fn));
    expect(selectSession).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });
});
