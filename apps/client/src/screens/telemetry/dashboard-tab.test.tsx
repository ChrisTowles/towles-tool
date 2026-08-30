// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { DashboardTab } from "@/screens/telemetry/dashboard-tab";
import { pointOf, type LogPoint } from "@/screens/telemetry/dashboard-charts";
import type { DashboardSummary } from "@/lib/telemetry";
import { renderWithProviders } from "@/test/render";

const summary: DashboardSummary = {
  days: ["2026-08-29", "2026-08-30"],
  bucket: "day",
  groupBy: "executable",
  recordCount: 10,
  spawnCount: 7,
  series: ["gh", "git"],
  buckets: [
    {
      key: "2026-08-29",
      spawnsByExec: [
        { name: "gh", count: 4, failures: 2, totalMs: 4000 },
        { name: "git", count: 1, failures: 0, totalMs: 5 },
      ],
    },
    { key: "2026-08-30", spawnsByExec: [{ name: "git", count: 2, failures: 0, totalMs: 10 }] },
  ],
  byExecutable: [
    { name: "gh", count: 4, failures: 2, p50Ms: 900, p95Ms: 1399, maxMs: 45_000, totalMs: 4000 },
    { name: "git", count: 3, failures: 0, p50Ms: 5, p95Ms: 5, maxMs: 5, totalMs: 15 },
  ],
  waitByDay: [
    { day: "2026-08-29", count: 5, totalMs: 4005 },
    { day: "2026-08-30", count: 2, totalMs: 10 },
  ],
  focus: { focusedMs: 3_600_000, longestMs: 1_800_000 },
  notifications: { fired: 3, skipped: 1 },
};

const noop = () => {};

describe("DashboardTab", () => {
  it("renders every card from a summary and routes a bar click to the log", () => {
    const onOpenLog = vi.fn<(point: LogPoint) => void>();
    renderWithProviders(
      <DashboardTab
        summary={summary}
        loading={false}
        range={7}
        group="executable"
        onRange={noop}
        onGroup={noop}
        onRefresh={noop}
        onOpenLog={onOpenLog}
      />,
    );
    expect(screen.getByText("Spawns by executable")).toBeInTheDocument();
    expect(screen.getByText("50.0%")).toBeInTheDocument();
    expect(screen.getByText("max 45s", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("1h")).toBeInTheDocument();

    // Testing-library's `getByTitle` only sees a `<title>` directly under `<svg>`.
    const bar = [...document.querySelectorAll("rect")].find((r) =>
      r.querySelector("title")?.textContent?.startsWith("2026-08-29 · gh"),
    );
    expect(bar).toBeDefined();
    fireEvent.click(bar as Element);
    expect(onOpenLog).toHaveBeenCalledWith({ day: "2026-08-29", executable: "gh" });
  });

  it("shows the empty state without a summary", () => {
    renderWithProviders(
      <DashboardTab
        summary={null}
        loading={false}
        range={7}
        group="executable"
        onRange={noop}
        onGroup={noop}
        onRefresh={noop}
        onOpenLog={noop}
      />,
    );
    expect(screen.getByText("No telemetry for this range.")).toBeInTheDocument();
  });
});

describe("pointOf", () => {
  it("splits an hour key into day and local hour", () => {
    expect(pointOf("2026-08-29 14", "gh")).toEqual({
      day: "2026-08-29",
      hour: 14,
      executable: "gh",
    });
    expect(pointOf("2026-08-29")).toEqual({ day: "2026-08-29" });
  });
});
