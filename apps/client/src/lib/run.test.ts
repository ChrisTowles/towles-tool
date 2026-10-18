// @vitest-environment jsdom
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { poll, startPoll, subscribe } from "@/lib/run";

const event = vi.hoisted(() => ({
  listen: vi.fn<(name: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>>(),
}));
vi.mock("@tauri-apps/api/event", () => event);

let hidden = false;
beforeEach(() => {
  vi.useFakeTimers();
  event.listen.mockReset();
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
});
afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("poll", () => {
  it("runs at once, then spaced after each run settles", async () => {
    const task = vi.fn<() => void>();
    const stop = startPoll(task, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2500);
    expect(task).toHaveBeenCalledTimes(3);
    stop();
  });

  it("stops on interruption", async () => {
    const task = vi.fn<() => void>();
    const stop = startPoll(task, 1000);
    await vi.advanceTimersByTimeAsync(1500);
    stop();
    const seen = task.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(task).toHaveBeenCalledTimes(seen);
  });

  it("skips ticks while the document is hidden and resumes after", async () => {
    const task = vi.fn<() => void>();
    const stop = startPoll(task, 1000);
    await vi.advanceTimersByTimeAsync(0);
    hidden = true;
    await vi.advanceTimersByTimeAsync(3000);
    expect(task).toHaveBeenCalledTimes(1);
    hidden = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(task).toHaveBeenCalledTimes(2);
    stop();
  });

  it("survives a failing task and a rejecting promise", async () => {
    let n = 0;
    const stop = startPoll(() => {
      n++;
      if (n === 1) return Effect.fail("boom");
      if (n === 2) return Promise.reject(new Error("nope"));
    }, 100);
    await vi.advanceTimersByTimeAsync(350);
    expect(n).toBeGreaterThanOrEqual(3);
    stop();
  });

  it("is an effect, so it composes before it runs", () => {
    const task = vi.fn<() => void>();
    poll(task, 10);
    expect(task).not.toHaveBeenCalled();
  });
});

describe("subscribe", () => {
  const withListen = () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    const unlisten = vi.fn<() => void>();
    let emit: (payload: unknown) => void = () => {};
    event.listen.mockImplementation(
      async (_name: string, cb: (e: { payload: unknown }) => void) => {
        emit = (payload) => cb({ payload });
        return unlisten;
      },
    );
    return { unlisten, emit: (p: unknown) => emit(p) };
  };

  it("delivers payloads and unlistens exactly once on stop", async () => {
    const { unlisten, emit } = withListen();
    const seen: unknown[] = [];
    const stop = subscribe("demo://changed", (p) => seen.push(p));
    await vi.advanceTimersByTimeAsync(0);
    emit(1);
    emit(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([1, 2]);
    stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("unlistens when stopped before listen resolved — no disposed flag needed", async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    const unlisten = vi.fn<() => void>();
    let release: (fn: () => void) => void = () => {};
    event.listen.mockReturnValue(new Promise((r) => (release = r)));
    const stop = subscribe("demo://late", () => {});
    await vi.advanceTimersByTimeAsync(0);
    stop();
    release(unlisten);
    await vi.advanceTimersByTimeAsync(0);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("keeps listening after a handler throws", async () => {
    const { emit } = withListen();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: unknown[] = [];
    const stop = subscribe("demo://throws", (p) => {
      if (p === 1) throw new Error("bad handler");
      seen.push(p);
    });
    await vi.advanceTimersByTimeAsync(0);
    emit(1);
    emit(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([2]);
    stop();
    err.mockRestore();
  });

  it("is inert outside Tauri", async () => {
    const stop = subscribe("demo://none", () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(event.listen).not.toHaveBeenCalled();
    stop();
  });
});
