import { describe, expect, it } from "vitest";
import { layoutRows } from "@/screens/telemetry/trace-tree";
import type { TelemetryRecord } from "@/lib/telemetry";

function rec(
  ts: string,
  name: string,
  durationMs: number | null,
  message?: string,
): TelemetryRecord {
  return {
    ts,
    kind: durationMs === null ? "event" : "span",
    level: "INFO",
    target: "tt_app",
    name,
    ttTask: null,
    ttBuildSha: null,
    durationMs,
    pid: 7,
    fields: message ? { message } : {},
    raw: "",
  };
}

describe("layoutRows", () => {
  it("nests a record inside the earlier span whose window contains it", () => {
    const rows = layoutRows([
      rec("2026-07-25T10:00:05Z", "outer", 5_000),
      rec("2026-07-25T10:00:02Z", "inner", 1_000),
      rec("2026-07-25T10:00:03Z", "event x:1", null, "notify_needs_you"),
      rec("2026-07-25T10:00:09Z", "later", 1_000),
    ]);
    expect(rows.map((r) => [r.label, r.depth])).toEqual([
      ["outer", 0],
      ["inner", 1],
      ["notify_needs_you", 1],
      ["later", 0],
    ]);
  });

  it("measures a span from its start, since the log stamps its close", () => {
    const [row] = layoutRows([rec("2026-07-25T10:00:05Z", "s", 5_000)]);
    expect(row.startMs).toBe(new Date("2026-07-25T10:00:00Z").getTime());
  });
});
