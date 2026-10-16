import { describe, expect, it } from "vitest";
import { crashGate, reportOfRejection, type CrashReport } from "./crash-report";

const report = (message: string): CrashReport => ({
  kind: "webview-error",
  message,
  location: null,
  stack: null,
});

describe("crashGate", () => {
  it("drops a repeat inside a minute but lets it back in after", () => {
    let now = 0;
    const allow = crashGate(() => now);
    expect(allow(report("boom"))).toBe(true);
    now = 30_000;
    expect(allow(report("boom"))).toBe(false);
    expect(allow(report("other"))).toBe(true);
    now = 200_000;
    expect(allow(report("boom"))).toBe(true);
  });

  it("stops after a session's worth", () => {
    const allow = crashGate(() => 0);
    const sent = Array.from({ length: 50 }, (_, i) => allow(report(`e${i}`))).filter(Boolean);
    expect(sent).toHaveLength(20);
  });
});

describe("reportOfRejection", () => {
  it("names an Error by its type and keeps the stack", () => {
    const err = new TypeError("x is undefined");
    const r = reportOfRejection(err);
    expect(r.message).toBe("TypeError: x is undefined");
    expect(r.stack).toBe(err.stack ?? null);
  });

  it("serializes a non-Error reason", () => {
    expect(reportOfRejection("nope").message).toBe("nope");
    expect(reportOfRejection({ code: 7 }).message).toBe('{"code":7}');
    expect(reportOfRejection(undefined).message).toBe("undefined");
  });
});
