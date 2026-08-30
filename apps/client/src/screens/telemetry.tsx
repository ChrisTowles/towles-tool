import { useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  CircleAlert,
  Database,
  Gauge,
  GitCompare,
  Keyboard,
  LayoutDashboard,
  Lightbulb,
  RefreshCw,
  ScrollText,
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
  effectiveFilters,
  LEVELS,
  loadTelemetryFilters,
  nearestRange,
  saveTelemetryFilters,
  TELEMETRY_FILTERS_KEY,
  telemetryAttention,
  telemetryBuilds,
  telemetryDashboard,
  telemetryDays,
  telemetryEvents,
  telemetryRecords,
  telemetryTrace,
  type AttentionSummary,
  type BuildSnapshot,
  type DashboardGroupBy,
  type DashboardRange,
  type DashboardSummary,
  type Filter,
  type KindFilter,
  type LogPreset,
  type RangeDays,
  type RecordPage,
  type TelemetryRecord,
} from "@/lib/telemetry";
import {
  loadUserSettings,
  nextSavedViewId,
  onSettingsChanged,
  saveUserSettings,
  type SavedView,
  type UserSettings,
} from "@/lib/settings";
import { AttentionTab } from "@/screens/telemetry/attention-tab";
import { BuildsTab } from "@/screens/telemetry/builds-tab";
import { DEFAULT_GROUP, DEFAULT_RANGE, DashboardTab } from "@/screens/telemetry/dashboard-tab";
import type { LogPoint } from "@/screens/telemetry/dashboard-charts";
import { KeyboardTab } from "@/screens/telemetry/keyboard-tab";
import { LogFilterBar } from "@/screens/telemetry/log-filter-bar";
import { TraceTree } from "@/screens/telemetry/trace-tree";
import { QueryTab } from "@/screens/telemetry/query-tab";
import { useWorkspace } from "@/lib/workspace";
import { uiAction } from "@/lib/ui-action";

/** Telemetry — a viewer over `tt-telemetry`'s `events-<date>.jsonl`, re-read on
 * Refresh and on focus, never live-tailed. Overview/Attention/Insights hold the
 * picked day in memory (75,000+ records is normal); the Log tab asks Rust for
 * a filtered page over its own day range, since a fortnight is far more. */

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

/** Each keystroke would otherwise re-read up to 14 files in Rust. */
const QUERY_DEBOUNCE_MS = 200;

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
  const [kind, setKind] = useState<KindFilter>(restoredFilters.kind);
  const [logDays, setLogDays] = useState<RangeDays>(restoredFilters.days);
  const [filters, setFilters] = useState<Filter[]>(restoredFilters.filters);
  const [page, setPage] = useState<RecordPage | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
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
    saveTelemetryFilters({ kind, days: logDays, filters, query });
  }, [kind, logDays, filters, query]);

  useEffect(() => onSettingsChanged(() => void loadUserSettings().then(setSettings)), []);

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

  // Only the latest request may land: a slow 14-day read must not overwrite
  // the 1-day page the user switched to while it ran.
  const logRequest = useRef(0);
  async function loadLog() {
    const id = ++logRequest.current;
    setPageLoading(true);
    const r = await telemetryRecords(logDays, effectiveFilters(kind, filters), query, RENDER_LIMIT);
    if (id !== logRequest.current) return;
    r.match({
      ok: setPage,
      err: (e) => {
        setPage(null);
        if (!NotInTauri.is(e)) toast.error(`Could not read telemetry: ${errorMessage(e)}`);
      },
    });
    setPageLoading(false);
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
    if (tab === "log") void loadLog();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only on focus/mount; refreshDays/loadEvents/day are read fresh, not tracked (a changed day reloads via the effect below)
  }, [activeTab]);

  // Structural changes reload at once; typing is debounced.
  useEffect(() => {
    if (tab !== "log") return;
    const handle = setTimeout(() => void loadLog(), QUERY_DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadLog reads these fresh; its identity is not a trigger
  }, [tab, kind, logDays, filters, query]);

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

  /** A chart point becomes a Log view: the series as a structured filter on the
   * field the dashboard is grouped by, and the day picker moved when the log has it. */
  function openLogAt(point: LogPoint) {
    const field = {
      executable: "process.executable.name",
      task: "ttTask",
      working_directory: "process.working_directory",
    }[dashboardGroup];
    applyLogFilters({
      days: 1,
      filters: point.executable ? [{ field, op: "eq", value: point.executable }] : [],
      query: "",
    });
    if (days?.includes(point.day)) setDay(point.day);
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

  function addFilter(f: Filter) {
    uiAction("telemetry.filter_added", "telemetry", `${f.field} ${f.op}`);
    setFilters((current) => [...current, f]);
    setActiveViewId(null);
  }

  function removeFilter(index: number) {
    const f = filters[index];
    if (f) uiAction("telemetry.filter_removed", "telemetry", `${f.field} ${f.op}`);
    setFilters((current) => current.filter((_, i) => i !== index));
    setActiveViewId(null);
  }

  function setRange(range: RangeDays) {
    uiAction("telemetry.range_set", "telemetry", String(range));
    setLogDays(range);
    setActiveViewId(null);
  }

  /** Pre-fills the Log tab and switches to it — the seam a sibling tab uses
   * to say "show me these rows". */
  function applyLogFilters(preset: LogPreset) {
    setFilters(preset.filters);
    setLogDays(nearestRange(preset.days));
    setQuery(preset.query ?? "");
    setKind("all");
    setActiveViewId(null);
    switchTab("log");
  }

  function selectView(view: SavedView) {
    uiAction("telemetry.view_selected", "telemetry", view.id);
    applyLogFilters({ days: view.days, filters: view.filters, query: view.query });
    setActiveViewId(view.id);
  }

  async function saveViews(next: SavedView[]) {
    if (!settings) return;
    const updated = { ...settings, savedViews: next };
    setSettings(updated);
    if (!(await saveUserSettings(updated))) toast.error("Could not save the view.");
  }

  function saveView(label: string) {
    if (!settings) return;
    const id = nextSavedViewId(settings.savedViews, label);
    uiAction("telemetry.view_saved", "telemetry", id);
    void saveViews([
      ...settings.savedViews,
      { id, label, filters: effectiveFilters(kind, filters), days: logDays, query },
    ]);
    setActiveViewId(id);
  }

  function deleteView(id: string) {
    if (!settings) return;
    uiAction("telemetry.view_deleted", "telemetry", id);
    void saveViews(settings.savedViews.filter((v) => v.id !== id));
    if (activeViewId === id) setActiveViewId(null);
  }

  // One pass, shared by the stat strip and Overview's "By level" breakdown.
  const levelCounts = useMemo(() => countBy(events, (e) => e.level), [events]);

  // Summaries per page load, not per render: `Object.entries` for every row.
  const shown = useMemo(
    () => (page?.records ?? []).map((e) => ({ e, summary: fieldsSummary(e.fields) })),
    [page],
  );

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
        <StatTile
          label="Log matches"
          value={page ? String(page.total) : "–"}
          detail={`past ${logDays} ${logDays === 1 ? "day" : "days"}, after filters`}
        />
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
          <TabsTrigger value="query" className="justify-start gap-2 px-2 py-1.5">
            <Database className="size-4" />
            Query
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
              onOpenLog={() =>
                applyLogFilters({
                  days: 1,
                  filters: [{ field: "level", op: "eq", value: "ERROR" }],
                })
              }
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

          <TabsContent value="query" className="flex h-full min-h-0 flex-col p-4">
            <QueryTab />
          </TabsContent>

          <TabsContent value="log" className="p-4">
            <Card
              title="Log"
              note={
                page
                  ? `${page.total} ${page.total === 1 ? "row" : "rows"}${pageLoading ? " · reading…" : ""}`
                  : pageLoading
                    ? "reading…"
                    : undefined
              }
            >
              <LogFilterBar
                kind={kind}
                onKind={(k) => {
                  uiAction("telemetry.filter_added", "telemetry", `kind ${k}`);
                  setKind(k);
                  setActiveViewId(null);
                }}
                days={logDays}
                onDays={setRange}
                filters={filters}
                onAddFilter={addFilter}
                onRemoveFilter={removeFilter}
                query={query}
                onQuery={setQuery}
                views={settings?.savedViews ?? []}
                activeViewId={activeViewId}
                onSelectView={selectView}
                onSaveView={saveView}
                onDeleteView={deleteView}
              />

              {shown.length === 0 ? (
                <Empty inline>
                  {page === null
                    ? pageLoading
                      ? "Reading the log…"
                      : "No telemetry logs found."
                    : "No records match."}
                </Empty>
              ) : (
                <>
                  <div className="-mx-1.5 flex flex-col">
                    {shown.map(({ e, summary }, i) => (
                      <TelemetryRow
                        key={`${e.ts}-${i}`}
                        record={e}
                        summary={summary}
                        showDay={logDays > 1}
                        onSelect={() => openRecord(e)}
                      />
                    ))}
                  </div>
                  {page && page.total > shown.length && (
                    <p className="px-1.5 py-2 text-xs text-muted-foreground">
                      Showing the newest {shown.length} of {page.total} matches — narrow the search
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

      <RecordDialog record={selected} onOpen={openRecord} onClose={() => setSelected(null)} />
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
  showDay,
  onSelect,
}: {
  record: TelemetryRecord;
  summary: string | null;
  /** A multi-day range needs the date; a single day would only repeat it. */
  showDay: boolean;
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
        <span
          className={cn(
            "shrink-0 font-mono text-[11px] text-muted-foreground",
            showDay ? "w-36" : "w-20",
          )}
        >
          {showDay && <span className="text-muted-foreground/60">{record.ts.slice(5, 10)} </span>}
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
        <span
          className={cn(
            "w-full truncate font-mono text-[11px] text-muted-foreground/70",
            showDay ? "pl-[150px]" : "pl-[86px]",
          )}
        >
          {summary}
        </span>
      )}
    </button>
  );
}

function RecordDialog({
  record,
  onOpen,
  onClose,
}: {
  record: TelemetryRecord | null;
  onOpen: (record: TelemetryRecord) => void;
  onClose: () => void;
}) {
  const [children, setChildren] = useState<TelemetryRecord[] | null>(null);

  // Children are fetched, not derived: with a multi-day range the page holds
  // a few hundred rows, and the siblings live in the day file.
  useEffect(() => {
    setChildren(null);
    if (!record || record.durationMs === null) return;
    let live = true;
    void telemetryTrace(record.ts, record.ts.slice(0, 10)).then((r) => {
      if (live) setChildren(r.unwrapOr([]));
    });
    return () => {
      live = false;
    };
  }, [record]);

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

        {record && children && children.length > 0 && (
          <TraceTree parent={record} descendants={children} onOpen={onOpen} />
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
