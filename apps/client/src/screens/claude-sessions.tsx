import { Result } from "effect";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowClockwiseIcon,
  ChartBarIcon,
  ClockIcon,
  CopyIcon,
  LightbulbIcon,
  ListIcon,
  MagnifyingGlassIcon,
} from "@phosphor-icons/react";
import { Button, Input, Select, Tabs } from "@cloudflare/kumo";
import { Card, StatTile } from "@/components/store-bits";
import {
  claudeSessionsSearch,
  claudeSessionsSummary,
  type ClaudeSession,
  type ClaudeSessionsSummary,
} from "@/lib/claude-sessions";
import { useRepos } from "@/lib/agentboard/state";
import { seriesColors } from "@/lib/repo-identity";
import { uiAction } from "@/lib/ui-action";
import { fmtTokens, fmtUsd } from "@/lib/format";
import { CadenceTab } from "@/screens/claude-sessions/cadence-tab";
import { DayStackChart, NO_SERIES_COLORS, RankedBarChart } from "@/screens/claude-sessions/charts";
import { InsightsTab } from "@/screens/claude-sessions/insights-tab";
import { SessionTable } from "@/screens/claude-sessions/session-table";
import { ProjectColorsContext, reportSessionsError } from "@/screens/claude-sessions/shared";

const DAY_OPTIONS = [
  { label: "Last 7 days", value: "7" },
  { label: "Last 30 days", value: "30" },
  { label: "Last 90 days", value: "90" },
  { label: "All time", value: "0" },
];

/** Claude Sessions — where the tokens went (day × repo × model) and which
 * sessions are the outliers, with title + prompt-text search over the
 * scanned window. */
export function ClaudeSessionsScreen() {
  const [days, setDays] = useState("30");
  const [tab, setTab] = useState("overview");
  const [summary, setSummary] = useState<ClaudeSessionsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ClaudeSession[] | null>(null);
  // Bumped by the Refresh button so the Treemap tab rebuilds its report too.
  const [refreshNonce, setRefreshNonce] = useState(0);
  // Keyed on the identities, not the snapshot: the board re-sends `repos` every
  // tick, and a new map would rebuild every chart.
  const repos = useRepos();
  const repoKey = repos.map((r) => `${r.name}=${r.color}`).join(",");
  const projectColors = useMemo(
    () => seriesColors(summary?.byProject.map((b) => b.project) ?? [], repos),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `repos` is read through `repoKey`
    [summary, repoKey],
  );

  async function refresh(d: string) {
    setLoading(true);
    Result.match(await claudeSessionsSummary(Number(d)), {
      onSuccess: setSummary,
      onFailure: (e) => {
        setSummary(null);
        reportSessionsError(e);
      },
    });
    setLoading(false);
  }

  useEffect(() => {
    void refresh(days);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch only when the day range changes; refresh is recreated each render and is not a trigger
  }, [days]);

  // Debounced search; empty query falls back to the ranked outlier list.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    const t = setTimeout(() => {
      void claudeSessionsSearch(Number(days), q).then((r) =>
        Result.match(r, {
          onSuccess: setResults,
          onFailure: (e) => {
            setResults([]);
            reportSessionsError(e);
          },
        }),
      );
    }, 250);
    return () => clearTimeout(t);
  }, [query, days]);

  const totals = summary?.totals;
  const searching = query.trim().length > 0;
  const sessions = searching ? (results ?? []) : (summary?.topSessions ?? []);

  return (
    <ProjectColorsContext.Provider value={projectColors}>
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex items-center justify-between gap-2 border-b border-border bg-card px-4 py-3">
          <h2 className="font-heading text-lg font-semibold">Claude Sessions</h2>
          <div className="flex items-center gap-2">
            <Select
              size="sm"
              label="Range"
              value={days}
              onValueChange={(v) => {
                if (typeof v !== "string") return;
                uiAction("claude_sessions.range", "claude-sessions", v);
                setDays(v);
              }}
              className="w-36"
            >
              {DAY_OPTIONS.map((o) => (
                <Select.Option key={o.value} value={o.value}>
                  {o.label}
                </Select.Option>
              ))}
            </Select>
            <Button
              variant="outline"
              size="sm"
              icon={<ArrowClockwiseIcon className="size-3.5" />}
              onClick={() => {
                uiAction("claude_sessions.refresh", "claude-sessions");
                setRefreshNonce((n) => n + 1);
                void refresh(days);
              }}
            >
              Refresh
            </Button>
          </div>
        </header>

        {loading && !summary ? (
          <p className="p-6 text-sm text-muted-foreground">Scanning sessions…</p>
        ) : summary && totals ? (
          <>
            <div
              data-testid="claude-sessions-totals"
              className="grid grid-cols-2 gap-3 border-b border-border p-4 lg:grid-cols-5"
            >
              <StatTile label="Sessions" value={String(totals.sessions)} />
              <StatTile
                label="In + Out"
                value={fmtTokens(totals.inputTokens + totals.outputTokens)}
                detail={`${fmtTokens(totals.inputTokens)} in · ${fmtTokens(totals.outputTokens)} out`}
              />
              <StatTile label="Cache read" value={fmtTokens(totals.cacheReadTokens)} />
              <StatTile label="Cache write" value={fmtTokens(totals.cacheCreationTokens)} />
              <StatTile
                label="Est. cost"
                value={fmtUsd(totals.costUsd)}
                detail="approx · per-model rates"
              />
            </div>

            <Tabs
              variant="underline"
              value={tab}
              onValueChange={(v) => {
                uiAction("claude_sessions.tab", "claude-sessions", v);
                setTab(v as typeof tab);
              }}
              className="shrink-0 border-b border-kumo-hairline bg-kumo-base px-2"
              tabs={[
                {
                  value: "overview",
                  label: (
                    <span className="flex items-center gap-2">
                      <ChartBarIcon className="size-4" />
                      Overview
                    </span>
                  ),
                },
                {
                  value: "sessions",
                  label: (
                    <span className="flex items-center gap-2">
                      <ListIcon className="size-4" />
                      {"Sessions" + (searching ? " · search" : "")}
                    </span>
                  ),
                },
                {
                  value: "insights",
                  label: (
                    <span className="flex items-center gap-2">
                      <LightbulbIcon className="size-4" />
                      Insights
                    </span>
                  ),
                },
                {
                  value: "cadence",
                  label: (
                    <span className="flex items-center gap-2">
                      <ClockIcon className="size-4" />
                      Cadence
                    </span>
                  ),
                },
              ]}
            />

            <div
              role="tabpanel"
              aria-label={tab[0].toUpperCase() + tab.slice(1)}
              className="min-h-0 flex-1 overflow-y-auto"
            >
              {tab === "overview" && (
                <div className="flex flex-col gap-4 p-4">
                  <Card title="Tokens by day">
                    <DayStackChart days={summary.days} colors={projectColors} />
                  </Card>

                  <div className="grid gap-4 md:grid-cols-2">
                    <Card title="By repo">
                      <RankedBarChart
                        bars={summary.byProject.map((b) => ({ label: b.project, ...b }))}
                        colors={projectColors}
                      />
                    </Card>
                    <Card title="By model">
                      <RankedBarChart
                        bars={summary.byModel.map((b) => ({ label: b.model, ...b }))}
                        colors={NO_SERIES_COLORS}
                      />
                    </Card>
                  </div>
                </div>
              )}

              {tab === "sessions" && (
                <div className="p-4">
                  <Card
                    title={searching ? "Search results" : "Top sessions"}
                    action={
                      <div className="relative w-72 self-center">
                        <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          size="sm"
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                          placeholder="Search titles & prompts…"
                          aria-label="Search sessions"
                          className="pl-8"
                        />
                      </div>
                    }
                  >
                    <SessionTable sessions={sessions} searching={searching} />
                    <p className="mt-2 text-mini text-muted-foreground">
                      {searching
                        ? "Matches session titles and what you typed, newest first."
                        : "Ranked by input+output tokens; amber marks outliers vs the median."}{" "}
                      Click <CopyIcon className="inline size-3 align-[-2px]" /> to copy the session
                      ID or file path.
                    </p>
                  </Card>
                </div>
              )}

              {tab === "insights" && (
                <div>
                  <InsightsTab days={days} nonce={refreshNonce} active={tab === "insights"} />
                </div>
              )}

              {tab === "cadence" && (
                <div>
                  <CadenceTab days={days} nonce={refreshNonce} active={tab === "cadence"} />
                </div>
              )}
            </div>
          </>
        ) : (
          <p className="p-6 text-sm text-muted-foreground">Not available outside the app.</p>
        )}
      </div>
    </ProjectColorsContext.Provider>
  );
}
