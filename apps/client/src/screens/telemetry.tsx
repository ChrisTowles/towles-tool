import { useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  CircleAlert,
  Gauge,
  GitCompare,
  Keyboard,
  LayoutDashboard,
  Lightbulb,
  RefreshCw,
  ScrollText,
  Search,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BarRow, Card, Empty, maxCount, StatTile } from "@/components/store-bits";
import { cn } from "@/lib/utils";
import { errorMessage, NotInTauri } from "@/lib/errors";
import { keyboardScore, type KeyboardScore } from "@/lib/keyboard-score";
import {
  LEVELS,
  loadTelemetryFilters,
  saveTelemetryFilters,
  TELEMETRY_FILTERS_KEY,
  telemetryAttention,
  telemetryBuilds,
  telemetryDashboard,
  telemetryDays,
  telemetryEvents,
  type AttentionSummary,
  type BuildSnapshot,
  type DashboardGroupBy,
  type DashboardRange,
  type DashboardSummary,
  type KindFilter,
  type LevelFilter,
  type TelemetryRecord,
} from "@/lib/telemetry";
import { AttentionTab } from "@/screens/telemetry/attention-tab";
import { BuildsTab } from "@/screens/telemetry/builds-tab";
import { DEFAULT_GROUP, DEFAULT_RANGE, DashboardTab } from "@/screens/telemetry/dashboard-tab";
import type { LogPoint } from "@/screens/telemetry/dashboard-charts";
import { KeyboardTab } from "@/screens/telemetry/keyboard-tab";
import { useWorkspace } from "@/lib/workspace";
import { uiAction } from "@/lib/ui-action";

/** Telemetry — a viewer over `tt-telemetry`'s `events-<date>.jsonl`, re-read on
 * Refresh and on focus, never live-tailed. Holds a full day in memory (75,000+
 * records is normal) and `RENDER_LIMIT` bounds only the DOM; the fix is paging. */

const LEVEL_TONE: Record<string, string> = {
  ERROR: "text-red-600 dark:text-red-400",
  WARN: "text-amber-600 dark:text-amber-400",
  INFO: "text-foreground",
  DEBUG: "text-muted-foreground",
  TRACE: "text-muted-foreground/70",
};

/** Rendering a day's rows as plain DOM nodes is what froze the page before this
 * cap existed; narrowing the search/filters is the way to see past it. */
const RENDER_LIMIT = 300;

// Read once at module load, so the Log tab reopens with the filters last left on
// it — the same restore-at-import pattern the workspace tabs use.
const restoredFilters = loadTelemetryFilters(localStorage.getItem(TELEMETRY_FILTERS_KEY));

/** Groups `items` by `key`, one pass. */
function countBy<T>(items: T[], key: (item: T) => string): { key: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].map(([k, count]) => ({ key: k, count }));
}

export function TelemetryScreen() {
  const { activeTab } = useWorkspace();
  const [tab, setTab] = useState("overview");
  const [days, setDays] = useState<string[] | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [events, setEvents] = useState<TelemetryRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState(restoredFilters.query);
  const [level, setLevel] = useState<LevelFilter>(restoredFilters.level);
  const [kind, setKind] = useState<KindFilter>(restoredFilters.kind);
  const [target, setTarget] = useState(restoredFilters.target);
  const [selected, setSelected] = useState<TelemetryRecord | null>(null);
  const [attention, setAttention] = useState<AttentionSummary | null>(null);
  const [attentionLoading, setAttentionLoading] = useState(false);
  const [keyboard, setKeyboard] = useState<KeyboardScore | null>(null);
  const [keyboardLoading, setKeyboardLoading] = useState(false);
  const [dashboard, setDashboard] = useState<DashboardSummary | null>(null);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardRange, setDashboardRange] = useState<DashboardRange>(DEFAULT_RANGE);
  const [dashboardGroup, setDashboardGroup] = useState<DashboardGroupBy>(DEFAULT_GROUP);
  const [builds, setBuilds] = useState<BuildSnapshot[] | null>(null);
  const [buildsLoading, setBuildsLoading] = useState(false);

  useEffect(() => {
    saveTelemetryFilters({ level, kind, target, query });
  }, [level, kind, target, query]);

  async function loadEvents(d: string) {
    setLoading(true);
    const r = await telemetryEvents(d);
    r.match({
      ok: setEvents,
      err: (e) => {
        setEvents([]);
        if (!NotInTauri.is(e)) toast.error(`Could not read telemetry: ${errorMessage(e)}`);
      },
    });
    setLoading(false);
  }

  /** Kept separate from `loadEvents` and fired only while the Attention tab
   * shows: it re-reads the same (possibly huge) file, and returns the
   * aggregate rather than the records. */
  async function loadAttention(d: string) {
    setAttentionLoading(true);
    const r = await telemetryAttention(d);
    r.match({
      ok: setAttention,
      err: (e) => {
        setAttention(null);
        if (!NotInTauri.is(e)) toast.error(`Could not summarize telemetry: ${errorMessage(e)}`);
      },
    });
    setAttentionLoading(false);
  }

  /** Takes no day: the habit score spans a fixed 14-day window, so it ignores
   * the day picker every other tab here obeys. */
  async function loadKeyboard() {
    setKeyboardLoading(true);
    const r = await keyboardScore();
    r.match({
      ok: setKeyboard,
      err: (e) => {
        setKeyboard(null);
        if (!NotInTauri.is(e)) toast.error(`Could not score shortcuts: ${errorMessage(e)}`);
      },
    });
    setKeyboardLoading(false);
  }

  /** Range-scoped like the keyboard score, so it ignores the day picker too. */
  async function loadDashboard() {
    setDashboardLoading(true);
    const r = await telemetryDashboard(dashboardRange, dashboardGroup);
    r.match({
      ok: setDashboard,
      err: (e) => {
        setDashboard(null);
        if (!NotInTauri.is(e)) toast.error(`Could not build the dashboard: ${errorMessage(e)}`);
      },
    });
    setDashboardLoading(false);
  }

  /** The whole fortnight on disk, so a baseline can be a build from last week. */
  async function loadBuilds() {
    setBuildsLoading(true);
    const r = await telemetryBuilds(14);
    r.match({
      ok: setBuilds,
      err: (e) => {
        setBuilds(null);
        if (!NotInTauri.is(e)) toast.error(`Could not list builds: ${errorMessage(e)}`);
      },
    });
    setBuildsLoading(false);
  }

  /** Re-lists the available days and resolves the selected one if unset. */
  async function refreshDays() {
    const daysResult = await telemetryDays();
    daysResult.match({
      ok: (d) => {
        setDays(d);
        setDay((current) => current ?? d[0] ?? null);
      },
      err: (e) => {
        if (!NotInTauri.is(e)) toast.error(`Could not list telemetry days: ${errorMessage(e)}`);
      },
    });
  }

  // Mount and every focus regain: `day`'s effect below fires only on a *changed*
  // day, so an unchanged day still needs its own reload here.
  useEffect(() => {
    if (activeTab !== "telemetry") return;
    void refreshDays();
    if (day) void loadEvents(day);
    if (day && tab === "attention") void loadAttention(day);
    if (tab === "keyboard") void loadKeyboard();
    if (tab === "dashboard") void loadDashboard();
    if (tab === "builds") void loadBuilds();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only on focus/mount; refreshDays/loadEvents/day are read fresh, not tracked (a changed day reloads via the effect below)
  }, [activeTab]);

  useEffect(() => {
    if (day) void loadEvents(day);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when the day actually changes; loadEvents' identity is not a trigger
  }, [day]);

  // Attention re-reads on a changed day *and* on every switch back to its tab,
  // scoped to when the tab is actually showing.
  useEffect(() => {
    if (tab === "keyboard") void loadKeyboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadKeyboard is read fresh, not tracked
  }, [tab]);

  useEffect(() => {
    if (tab === "attention" && day) void loadAttention(day);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadAttention is read fresh, not tracked
  }, [tab, day]);

  useEffect(() => {
    if (tab === "dashboard") void loadDashboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadDashboard is read fresh, not tracked
  }, [tab, dashboardRange, dashboardGroup]);

  useEffect(() => {
    if (tab === "builds") void loadBuilds();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadBuilds is read fresh, not tracked
  }, [tab]);

  function manualRefresh() {
    uiAction("telemetry.refresh", "telemetry");
    void refreshDays();
    if (day) void loadEvents(day);
    if (day && tab === "attention") void loadAttention(day);
    if (tab === "keyboard") void loadKeyboard();
    if (tab === "dashboard") void loadDashboard();
    if (tab === "builds") void loadBuilds();
  }

  /** A chart point becomes a Log search: the series name as the query, and the
   * day picker moved to that day when the log has it. */
  function openLogAt(point: LogPoint) {
    setQuery(point.executable ?? "");
    if (days?.includes(point.day)) setDay(point.day);
    switchTab("log");
  }

  function switchTab(next: string) {
    setTab(next);
    uiAction("telemetry.tab", "telemetry", next);
  }

  /** Opens a record's drill-down dialog, from either the Log or Insights tab. */
  function openRecord(record: TelemetryRecord) {
    uiAction("telemetry.record_open", "telemetry", record.name);
    setSelected(record);
  }

  const targets = useMemo(() => [...new Set(events.map((e) => e.target))].toSorted(), [events]);

  // A persisted target the loaded day never wrote would blank the select and
  // hide every row — fall back for this view, leaving the stored choice intact.
  const effectiveTarget = target === "all" || targets.includes(target) ? target : "all";

  // One pass, shared by the stat strip and Overview's "By level" breakdown.
  const levelCounts = useMemo(() => countBy(events, (e) => e.level), [events]);

  // Derived per data change, not per render — otherwise every keystroke in the
  // search box redoes `JSON.stringify`/`Object.entries` for every visible row.
  const indexed = useMemo(
    () => events.map((e) => ({ e, hay: searchHaystack(e), summary: fieldsSummary(e.fields) })),
    [events],
  );

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => {
    const matches: { e: TelemetryRecord; summary: string | null }[] = [];
    for (const { e, hay, summary } of indexed) {
      if (
        (level === "all" || e.level === level) &&
        (kind === "all" || e.kind === kind) &&
        (effectiveTarget === "all" || e.target === effectiveTarget) &&
        (!q || hay.includes(q))
      ) {
        matches.push({ e, summary });
      }
    }
    return matches;
  }, [indexed, level, kind, effectiveTarget, q]);

  // Spans need their own pass (level counts don't cover kind/duration); error
  // count is read off `levelCounts` rather than re-filtered.
  const stats = useMemo(() => {
    let spanCount = 0;
    let spanDurationTotal = 0;
    for (const e of events) {
      if (e.kind === "span") {
        spanCount += 1;
        spanDurationTotal += e.durationMs ?? 0;
      }
    }
    return {
      errorCount: levelCounts.find((r) => r.key === "ERROR")?.count ?? 0,
      spanCount,
      avgDurationMs: spanCount > 0 ? Math.round(spanDurationTotal / spanCount) : null,
    };
  }, [events, levelCounts]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-border bg-card px-4 py-3">
        <h2 className="flex items-center gap-2 font-heading text-lg font-semibold">
          <Zap className="size-5 text-muted-foreground" />
          Telemetry
        </h2>
        <div className="flex items-center gap-2">
          <Select
            value={day ?? ""}
            onValueChange={(v) => {
              setDay(v);
              uiAction("telemetry.day_change", "telemetry", v);
            }}
          >
            <SelectTrigger className="h-8 w-40">
              <SelectValue placeholder={days === null ? "Loading…" : "No logs"} />
            </SelectTrigger>
            <SelectContent>
              {(days ?? []).map((d) => (
                <SelectItem key={d} value={d}>
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={manualRefresh} disabled={loading}>
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </header>

      <div className="grid shrink-0 grid-cols-2 gap-3 border-b border-border p-4 lg:grid-cols-4">
        <StatTile label="Records" value={String(events.length)} detail={day ?? undefined} />
        <StatTile label="Shown" value={String(shown.length)} detail="after filters" />
        <StatTile
          label="Errors"
          value={String(stats.errorCount)}
          detail={
            events.length > 0
              ? `${Math.round((stats.errorCount / events.length) * 100)}%`
              : undefined
          }
        />
        <StatTile
          label="Spans"
          value={String(stats.spanCount)}
          detail={stats.avgDurationMs !== null ? `avg ${stats.avgDurationMs}ms` : undefined}
        />
      </div>

      <Tabs
        orientation="vertical"
        value={tab}
        onValueChange={switchTab}
        className="min-h-0 flex-1 gap-0"
      >
        <TabsList
          variant="line"
          className="h-full w-44 shrink-0 items-stretch gap-1 rounded-none border-r border-border bg-card p-2"
        >
          <TabsTrigger value="overview" className="justify-start gap-2 px-2 py-1.5">
            <LayoutDashboard className="size-4" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="dashboard" className="justify-start gap-2 px-2 py-1.5">
            <BarChart3 className="size-4" />
            Dashboard
          </TabsTrigger>
          <TabsTrigger value="builds" className="justify-start gap-2 px-2 py-1.5">
            <GitCompare className="size-4" />
            Builds
          </TabsTrigger>
          <TabsTrigger value="attention" className="justify-start gap-2 px-2 py-1.5">
            <Gauge className="size-4" />
            Attention
          </TabsTrigger>
          <TabsTrigger value="keyboard" className="justify-start gap-2 px-2 py-1.5">
            <Keyboard className="size-4" />
            Keyboard
          </TabsTrigger>
          <TabsTrigger value="log" className="justify-start gap-2 px-2 py-1.5">
            <ScrollText className="size-4" />
            Log
          </TabsTrigger>
          <TabsTrigger value="insights" className="justify-start gap-2 px-2 py-1.5">
            <Lightbulb className="size-4" />
            Insights
          </TabsTrigger>
        </TabsList>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <TabsContent value="overview" className="p-4">
            <OverviewTab
              events={events}
              levelCounts={levelCounts}
              day={day}
              onOpenLog={() => switchTab("log")}
            />
          </TabsContent>

          <TabsContent value="dashboard" className="p-4">
            <DashboardTab
              summary={dashboard}
              loading={dashboardLoading}
              range={dashboardRange}
              group={dashboardGroup}
              onRange={setDashboardRange}
              onGroup={setDashboardGroup}
              onRefresh={() => void loadDashboard()}
              onOpenLog={openLogAt}
            />
          </TabsContent>

          <TabsContent value="builds" className="p-4">
            <BuildsTab
              snapshots={builds}
              loading={buildsLoading}
              onRefresh={() => void loadBuilds()}
            />
          </TabsContent>

          <TabsContent value="attention" className="p-4">
            <AttentionTab summary={attention} loading={attentionLoading} />
          </TabsContent>

          <TabsContent value="keyboard" className="p-4">
            <KeyboardTab score={keyboard} loading={keyboardLoading} />
          </TabsContent>

          <TabsContent value="log" className="p-4">
            <Card title="Log" note={`${shown.length} of ${events.length}`}>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <div className="relative w-64">
                  <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search target, name, fields…"
                    className="h-8 pl-8 text-sm"
                  />
                </div>
                <FilterSelect
                  value={level}
                  onValueChange={setLevel}
                  width="w-28"
                  options={[
                    { value: "all", label: "All levels" },
                    ...LEVELS.map((l) => ({ value: l, label: l })),
                  ]}
                />
                <FilterSelect
                  value={kind}
                  onValueChange={setKind}
                  width="w-28"
                  options={[
                    { value: "all", label: "All kinds" },
                    { value: "event", label: "Event" },
                    { value: "span", label: "Span" },
                  ]}
                />
                <FilterSelect
                  value={effectiveTarget}
                  onValueChange={setTarget}
                  width="w-40"
                  options={[
                    { value: "all", label: "All targets" },
                    ...targets.map((t) => ({ value: t, label: t })),
                  ]}
                />
              </div>

              {shown.length === 0 ? (
                <Empty inline>
                  {events.length === 0
                    ? day
                      ? "No telemetry recorded this day."
                      : "No telemetry logs found."
                    : "No records match."}
                </Empty>
              ) : (
                <>
                  <div className="-mx-1.5 flex flex-col">
                    {shown.slice(0, RENDER_LIMIT).map(({ e, summary }, i) => (
                      <TelemetryRow
                        key={`${e.ts}-${i}`}
                        record={e}
                        summary={summary}
                        onSelect={() => openRecord(e)}
                      />
                    ))}
                  </div>
                  {shown.length > RENDER_LIMIT && (
                    <p className="px-1.5 py-2 text-xs text-muted-foreground">
                      Showing the first {RENDER_LIMIT} of {shown.length} matches — narrow the search
                      or filters to see the rest.
                    </p>
                  )}
                </>
              )}
            </Card>
          </TabsContent>

          <TabsContent value="insights" className="p-4">
            <InsightsTab events={events} onSelect={openRecord} />
          </TabsContent>
        </div>
      </Tabs>

      <RecordDialog record={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

// ── Overview ────────────────────────────────────────────────────────────────

/** A single source (target or name) is this dominant before Overview calls it
 * out — the log being this lopsided is itself a signal something may be
 * over-logging, not just a UI-scale problem to page past. */
const DOMINANCE_THRESHOLD = 0.8;

function OverviewTab({
  events,
  levelCounts,
  day,
  onOpenLog,
}: {
  events: TelemetryRecord[];
  levelCounts: { key: string; count: number }[];
  day: string | null;
  onOpenLog: () => void;
}) {
  const byLevel = useMemo(() => {
    const counts = new Map(levelCounts.map((r) => [r.key, r.count]));
    return LEVELS.map((l) => ({ level: l, count: counts.get(l) ?? 0 })).filter((r) => r.count > 0);
  }, [levelCounts]);
  const byTarget = useMemo(
    () =>
      countBy(events, (e) => e.target)
        .toSorted((a, b) => b.count - a.count)
        .slice(0, 8),
    [events],
  );
  const recentErrors = useMemo(
    () => events.filter((e) => e.level === "ERROR").slice(0, 6),
    [events],
  );
  const dominant = byTarget[0];

  if (events.length === 0) {
    return (
      <Card title="No telemetry">
        <Empty inline>
          {day ? `No records for ${day}.` : "No telemetry logs found for this checkout yet."}
        </Empty>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {dominant && dominant.count / events.length >= DOMINANCE_THRESHOLD && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            <span className="font-mono">{dominant.key}</span> accounts for{" "}
            {Math.round((dominant.count / events.length) * 100)}% of today's records (
            {dominant.count} of {events.length}) — if that's more than you'd expect, something may
            be over-logging rather than this just being a busy day.
          </span>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="By level">
          <div className="flex flex-col gap-1.5">
            {byLevel.map((r) => (
              <BarRow
                key={r.level}
                label={r.level}
                count={r.count}
                max={maxCount(byLevel)}
                tone={LEVEL_TONE[r.level]}
              />
            ))}
          </div>
        </Card>

        <Card title="Busiest targets" note={`${byTarget.length}`}>
          <div className="flex flex-col gap-1.5">
            {byTarget.map((r) => (
              <BarRow key={r.key} label={r.key} count={r.count} max={maxCount(byTarget)} />
            ))}
          </div>
        </Card>
      </div>

      <Card
        title="Recent errors"
        note={recentErrors.length > 0 ? undefined : "none"}
        action={
          <Button variant="outline" size="sm" className="text-xs" onClick={onOpenLog}>
            Open log
          </Button>
        }
      >
        {recentErrors.length === 0 ? (
          <Empty inline>No errors today.</Empty>
        ) : (
          <div className="-mx-1 flex flex-col">
            {recentErrors.map((e, i) => (
              <div key={`${e.ts}-${i}`} className="flex items-center gap-2.5 px-1 py-1">
                <span className="font-mono text-xs text-foreground">{e.name}</span>
                <span className="font-mono text-[11px] text-muted-foreground/60">{e.target}</span>
                <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                  {timeOf(e.ts)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ── Insights ────────────────────────────────────────────────────────────────

function InsightsTab({
  events,
  onSelect,
}: {
  events: TelemetryRecord[];
  onSelect: (record: TelemetryRecord) => void;
}) {
  const slowestSpans = useMemo(
    () =>
      events
        .filter((e): e is TelemetryRecord & { durationMs: number } => e.durationMs !== null)
        .toSorted((a, b) => b.durationMs - a.durationMs)
        .slice(0, 10),
    [events],
  );
  const byName = useMemo(
    () =>
      countBy(events, (e) => e.name)
        .toSorted((a, b) => b.count - a.count)
        .slice(0, 10),
    [events],
  );

  if (events.length === 0) {
    return (
      <Card title="Insights">
        <Empty inline>No telemetry to analyze for this day.</Empty>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card title="Slowest spans" note={`${slowestSpans.length}`}>
        {slowestSpans.length === 0 ? (
          <Empty inline>No spans recorded.</Empty>
        ) : (
          <div className="-mx-1.5 flex flex-col">
            {slowestSpans.map((e, i) => (
              <button
                key={`${e.ts}-${i}`}
                type="button"
                onClick={() => onSelect(e)}
                className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left hover:bg-accent/50"
              >
                <span className="font-mono text-xs text-foreground">{e.name}</span>
                <span className="font-mono text-[11px] text-muted-foreground/60">{e.target}</span>
                <span className="ml-auto font-mono text-xs text-muted-foreground">
                  {e.durationMs}ms
                </span>
              </button>
            ))}
          </div>
        )}
      </Card>

      <Card title="Busiest names" note={`${byName.length}`}>
        <div className="flex flex-col gap-1.5">
          {byName.map((r) => (
            <BarRow key={r.key} label={r.key} count={r.count} max={maxCount(byName)} />
          ))}
        </div>
      </Card>
    </div>
  );
}

/** A generic filter dropdown — the level/kind/target selects differ only in
 * their option list and width. */
function FilterSelect<T extends string>({
  value,
  onValueChange,
  width,
  options,
}: {
  value: T;
  onValueChange: (v: T) => void;
  width: string;
  options: { value: T; label: string }[];
}) {
  return (
    <Select value={value} onValueChange={(v) => onValueChange(v as T)}>
      <SelectTrigger className={cn("h-8", width)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Everything the search box looks at, lowercased once per data change. */
function searchHaystack(record: TelemetryRecord): string {
  return [
    record.target,
    record.name,
    record.ttTask,
    record.ttBuildSha,
    JSON.stringify(record.fields),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** `HH:MM:SS` of an RFC 3339 timestamp, for a compact time column. */
function timeOf(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleTimeString([], { hour12: false });
}

/** A one-line summary of a record's extra fields, for the row's second line. */
function fieldsSummary(fields: Record<string, unknown>): string | null {
  const entries = Object.entries(fields);
  if (entries.length === 0) return null;
  return entries.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
}

function TelemetryRow({
  record,
  summary,
  onSelect,
}: {
  record: TelemetryRecord;
  summary: string | null;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full flex-col gap-0.5 rounded-md border-l-2 border-transparent px-3 py-2 text-left hover:bg-accent/50",
        record.level === "ERROR" && "border-l-red-500 bg-red-500/5",
      )}
    >
      <div className="flex w-full items-center gap-2.5">
        <span className="w-20 shrink-0 font-mono text-[11px] text-muted-foreground">
          {timeOf(record.ts)}
        </span>
        <span
          className={cn(
            "w-12 shrink-0 font-mono text-[10.5px] font-medium",
            LEVEL_TONE[record.level],
          )}
        >
          {record.level}
        </span>
        <span className="font-mono text-xs text-foreground">{record.name}</span>
        <span className="font-mono text-[11px] text-muted-foreground/60">{record.target}</span>
        <div className="ml-auto flex shrink-0 items-center gap-3 font-mono text-[11px] text-muted-foreground">
          {record.durationMs !== null && <span>{record.durationMs}ms</span>}
        </div>
      </div>
      {summary && (
        <span className="w-full truncate pl-[86px] font-mono text-[11px] text-muted-foreground/70">
          {summary}
        </span>
      )}
    </button>
  );
}

function RecordDialog({
  record,
  onClose,
}: {
  record: TelemetryRecord | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!record} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="pr-6 font-mono text-base">{record?.name}</DialogTitle>
          <DialogDescription>
            {record?.kind} · {record?.target}
            {record?.durationMs !== null && record?.durationMs !== undefined
              ? ` · ${record.durationMs}ms`
              : ""}
            {record ? ` · ${record.ts}` : ""}
          </DialogDescription>
        </DialogHeader>

        {record && (
          <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-2.5 font-mono text-xs whitespace-pre-wrap text-foreground">
            {prettyRaw(record.raw)}
          </pre>
        )}
      </DialogContent>
    </Dialog>
  );
}

function prettyRaw(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
