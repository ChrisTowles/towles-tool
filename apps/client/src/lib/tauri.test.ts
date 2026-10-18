// @vitest-environment jsdom
import { Effect, Result, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcFailed, IpcTimeout, NotInTauri, SchemaMismatch } from "@/lib/errors";
import { fire, invoke, ipcOr, runIpc } from "@/lib/tauri";

const core = vi.hoisted(() => ({ invoke: vi.fn<(...a: unknown[]) => unknown>() }));
vi.mock("@tauri-apps/api/core", () => core);

const inTauri = () => Object.assign(window, { __TAURI_INTERNALS__: {} });
const outOfTauri = () => Reflect.deleteProperty(window, "__TAURI_INTERNALS__");

beforeEach(() => {
  core.invoke.mockReset();
  inTauri();
});
afterEach(() => {
  vi.useRealTimers();
  outOfTauri();
});

describe("invoke", () => {
  it("is lazy: nothing is sent until the effect runs", async () => {
    core.invoke.mockResolvedValue(1);
    const effect = invoke<number>("count");
    expect(core.invoke).not.toHaveBeenCalled();
    expect(Result.getOrNull(await runIpc(effect))).toBe(1);
    expect(core.invoke).toHaveBeenCalledWith("count", {});
  });

  it("is NotInTauri in a bare browser, decided when it runs", async () => {
    const effect = invoke("anything");
    outOfTauri();
    const r = await runIpc(effect);
    expect(Result.isFailure(r) && NotInTauri.is(r.failure)).toBe(true);
    expect(core.invoke).not.toHaveBeenCalled();
  });

  it("wraps a rejected command in IpcFailed with the bare-string cause", async () => {
    core.invoke.mockRejectedValue("db locked");
    const r = await runIpc(invoke("store_add_task"));
    expect(Result.isFailure(r) && IpcFailed.is(r.failure)).toBe(true);
    expect(Result.match(r, { onSuccess: () => "", onFailure: (e) => e.message })).toBe(
      "store_add_task: db locked",
    );
  });

  it("reports SchemaMismatch, not a defect, when the payload misses the schema", async () => {
    core.invoke.mockResolvedValue({ name: 3 });
    const r = await runIpc(invoke("x", {}, { schema: Schema.Struct({ name: Schema.String }) }));
    expect(Result.isFailure(r) && SchemaMismatch.is(r.failure)).toBe(true);
  });

  it("decodes through the schema on success", async () => {
    core.invoke.mockResolvedValue({ name: "ok", extra: 1 });
    const r = await runIpc(invoke("x", {}, { schema: Schema.Struct({ name: Schema.String }) }));
    expect(Result.getOrNull(r)).toEqual({ name: "ok" });
  });

  it("times out with IpcTimeout and abandons only the promise", async () => {
    vi.useFakeTimers();
    core.invoke.mockReturnValue(new Promise(() => {}));
    const pending = runIpc(invoke("slow", {}, { timeout: 50 }));
    await vi.advanceTimersByTimeAsync(60);
    const r = await pending;
    expect(Result.isFailure(r) && IpcTimeout.is(r.failure)).toBe(true);
    expect(Result.match(r, { onSuccess: () => "", onFailure: (e) => e.message })).toBe(
      "slow: timed out after 50ms",
    );
    expect(core.invoke).toHaveBeenCalledTimes(1);
  });

  it("makes a fresh call each time the effect is run", async () => {
    core.invoke.mockResolvedValue(0);
    const effect = invoke("tick");
    await runIpc(effect);
    await runIpc(effect);
    expect(core.invoke).toHaveBeenCalledTimes(2);
  });
});

describe("helpers", () => {
  it("ipcOr degrades to the fallback on any failure", async () => {
    core.invoke.mockRejectedValue("no");
    expect(await ipcOr(invoke<string[]>("list"), [])).toEqual([]);
    core.invoke.mockResolvedValue(["a"]);
    expect(await ipcOr(invoke<string[]>("list"), [])).toEqual(["a"]);
  });

  it("fire never produces an unhandled rejection, even for a rejected command or a defect", async () => {
    const unhandled = vi.fn<() => unknown>();
    process.on("unhandledRejection", unhandled);
    core.invoke.mockRejectedValue("pty gone");
    fire(invoke("term_write", { termId: "t", data: "x" }));
    fire(Effect.die(new Error("bug")));
    await new Promise((r) => setTimeout(r, 20));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(core.invoke).toHaveBeenCalledTimes(1);
  });
});
