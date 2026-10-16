import { describe, expect, it } from "vitest";
import type { RepeatedError } from "@/lib/schemas/doctor";
import { repeatDetail, takeNew } from "./repeated-errors";

const err = (key: string): RepeatedError => ({
  key,
  level: "WARN",
  target: "tt_app_lib::store",
  message: key,
  error: null,
  count: 25,
  firstTs: "2026-10-10T10:00:00Z",
  lastTs: "2026-10-10T11:00:00Z",
});

describe("takeNew", () => {
  it("hands over each group once per session", () => {
    const seen = new Set<string>();
    expect(takeNew([err("a"), err("b")], seen).map((e) => e.key)).toEqual(["a", "b"]);
    expect(takeNew([err("a"), err("b")], seen)).toEqual([]);
    expect(takeNew([err("a"), err("c")], seen).map((e) => e.key)).toEqual(["c"]);
  });
});

describe("repeatDetail", () => {
  it("cuts long error text and passes short text through", () => {
    expect(repeatDetail({ ...err("a"), error: "x".repeat(200) }, 10)).toBe(`${"x".repeat(10)}…`);
    expect(repeatDetail({ ...err("a"), error: "short" })).toBe("short");
    expect(repeatDetail(err("a"))).toBeUndefined();
  });
});
