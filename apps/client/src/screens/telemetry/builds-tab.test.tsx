// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { BuildsTab } from "@/screens/telemetry/builds-tab";
import type { BuildSnapshot } from "@/lib/telemetry";
import { renderWithProviders } from "@/test/render";

const snap = (sha: string, day: string, recordCount: number): BuildSnapshot => ({
  sha,
  day,
  recordCount,
  measures: {
    ghCalls: 0,
    gitCalls: 0,
    claudeCalls: 0,
    ghFailurePct: null,
    gitFailurePct: null,
    subprocessWaitMs: 0,
    p95SpawnMs: 0,
    focusFlips: 0,
    needsYouFired: 0,
    needsYouSkipped: 0,
    uiActions: 0,
    warnErrorRecords: 0,
    focusedMs: 0,
  },
});

const noop = () => {};

describe("BuildsTab", () => {
  it("lists snapshots newest first and defaults the pair to the substantial ones", () => {
    renderWithProviders(
      <BuildsTab
        snapshots={[
          snap("7196be044025848a", "2026-08-30", 2043),
          snap("2eb5c34da1070a42", "2026-08-29", 41),
          snap("d171032086f56e21", "2026-08-28", 6129),
        ]}
        loading={false}
        onRefresh={noop}
      />,
    );
    expect(screen.getByLabelText("Baseline build")).toHaveTextContent("Baseline: d171032 · Aug 28");
    expect(screen.getByLabelText("Candidate build")).toHaveTextContent("vs 7196be0 · Aug 30");
    expect(screen.getByText("baseline")).toBeInTheDocument();
    expect(screen.getByText("candidate")).toBeInTheDocument();
    // jsdom has no Tauri host, so the compare comes back NotInTauri: empty, no toast.
    expect(screen.getByText("Comparing…")).toBeInTheDocument();
  });

  it("shows the empty state without snapshots", () => {
    renderWithProviders(<BuildsTab snapshots={null} loading={false} onRefresh={noop} />);
    expect(screen.getByText("No builds recorded yet.")).toBeInTheDocument();
  });
});
