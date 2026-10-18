// @vitest-environment jsdom
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeThen } from "@/lib/subscribe-then";

const event = vi.hoisted(() => ({
  listen: vi.fn<(name: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>>(),
}));
vi.mock("@tauri-apps/api/event", () => event);

beforeEach(() => {
  event.listen.mockReset();
  Object.assign(window, { __TAURI_INTERNALS__: {} });
});
afterEach(() => Reflect.deleteProperty(window, "__TAURI_INTERNALS__"));

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("subscribeThen", () => {
  it("runs `after` only once every listener is registered, and unlistens all on stop", async () => {
    const order: string[] = [];
    const unlisten = vi.fn<() => void>();
    event.listen.mockImplementation(async (name: string) => {
      order.push(`listen ${name}`);
      return unlisten;
    });
    const stop = subscribeThen(
      { "a://x": () => {}, "b://y": () => {} },
      Effect.sync(() => order.push("after")),
    );
    await tick();
    expect(order).toEqual(["listen a://x", "listen b://y", "after"]);
    stop();
    await tick();
    expect(unlisten).toHaveBeenCalledTimes(2);
  });

  it("cancels a long `after` on stop", async () => {
    event.listen.mockResolvedValue(() => {});
    let finished = false;
    const stop = subscribeThen(
      { "a://x": () => {} },
      Effect.sleep(50).pipe(Effect.andThen(Effect.sync(() => (finished = true)))),
    );
    await tick();
    stop();
    await new Promise((r) => setTimeout(r, 80));
    expect(finished).toBe(false);
  });

  it("is inert outside Tauri", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    const after = vi.fn<() => unknown>();
    subscribeThen({ "a://x": () => {} }, Effect.sync(after))();
    await tick();
    expect(event.listen).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });
});
