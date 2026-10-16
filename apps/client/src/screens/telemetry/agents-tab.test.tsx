// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { AgentsTab } from "@/screens/telemetry/agents-tab";
import type { AgentsSummary } from "@/lib/telemetry";
import { renderWithProviders } from "@/test/render";

const summary: AgentsSummary = {
  spendByDay: [
    {
      day: "2026-08-29",
      usd: 0.75,
      calls: 3,
      bySource: [{ source: "task_suggest", usd: 0.75, calls: 3 }],
    },
    { day: "2026-08-30", usd: 0, calls: 0, bySource: [] },
  ],
  spendBySource: [{ source: "task_suggest", usd: 0.75, calls: 3 }],
  totalUsd: 0.75,
  timeByFolder: [{ folder: "feat-a", workingMs: 1_800_000, waitingMs: 600_000, sessions: 1 }],
};

const noop = () => {};

describe("AgentsTab", () => {
  it("renders spend and the per-checkout time split", () => {
    renderWithProviders(
      <AgentsTab summary={summary} loading={false} range={7} onRange={noop} onRefresh={noop} />,
    );
    expect(screen.getByText("App model spend")).toBeInTheDocument();
    expect(screen.getAllByText("$0.75").length).toBeGreaterThan(0);
    expect(screen.getByText("feat-a")).toBeInTheDocument();
    expect(screen.getByTitle("feat-a · waiting on you 10m")).toBeInTheDocument();
  });

  it("shows the empty state without a summary", () => {
    renderWithProviders(
      <AgentsTab summary={null} loading={false} range={7} onRange={noop} onRefresh={noop} />,
    );
    expect(screen.getByText("No telemetry for this range.")).toBeInTheDocument();
  });
});
