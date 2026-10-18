import { Result } from "effect";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowClockwiseIcon, LightningIcon } from "@phosphor-icons/react";
import { toast } from "@/lib/toast";
import { Button, Tabs } from "@cloudflare/kumo";
import { Card, Empty, StatTile } from "@/components/store-bits";
import { cn } from "@/lib/utils";
import { errorMessage, NotInTauri } from "@/lib/errors";
import { keyboardScore, type KeyboardScore } from "@/lib/keyboard-score";
import {
  effectiveFilters,
  loadTelemetryFilters,
  nearestRange,
  saveTelemetryFilters,
  TELEMETRY_FILTERS_KEY,
  telemetryAttention,
  telemetryBuilds,
  telemetryAgents,
  telemetryDashboard,
  telemetryDays,
  telemetryEvents,
  telemetryRecords,
  telemetryRules,
  type AttentionSummary,
  type BuildSnapshot,
  type AgentsSummary,
  type DashboardGroupBy,
  type DashboardRange,
  type DashboardSummary,
  type Filter,
  type KindFilter,
  type LogPreset,
  type RangeDays,
  type RecordPage,
  type RuleScore,
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
import { AgentsTab, DEFAULT_AGENT_RANGE, type AgentRange } from "@/screens/telemetry/agents-tab";
import type { LogPoint } from "@/screens/telemetry/dashboard-charts";
import { KeyboardTab } from "@/screens/telemetry/keyboard-tab";
import { LogFilterBar } from "@/screens/telemetry/log-filter-bar";
import { DEFAULT_RULES_RANGE, RulesTab, type RulesRange } from "@/screens/telemetry/rules-tab";
import { QueryTab } from "@/screens/telemetry/query-tab";
import { useWorkspace } from "@/lib/workspace";
import { uiAction } from "@/lib/ui-action";
import { DayPicker } from "@/screens/telemetry/day-picker";
import { TELEMETRY_TABS } from "@/screens/telemetry/tab-strip";
import { InsightsTab } from "@/screens/telemetry/insights-tab";
import { OverviewTab, countBy } from "@/screens/telemetry/overview-tab";
import { RecordDialog, TelemetryRow, fieldsSummary } from "@/screens/telemetry/telemetry-row";

/** Telemetry — a viewer over `tt-telemetry`'s `events-<date>.jsonl`, re-read on
 * Refresh and on focus, never live-tailed. Overview/Attention/Insights hold the
 * picked day in memory (75,000+ records is normal); the Log tab asks Rust for
 * a filtered page over its own day range, since a fortnight is far more. */

/** Rendering a day's rows as plain DOM nodes is what froze the page before this
 * cap existed; narrowing the search/filters is the way to see past it. */
const RENDER_LIMIT = 300;

/** Each keystroke would otherwise re-read up to 14 files in Rust. */
const QUERY_DEBOUNCE_MS = 200;

// Read once at module load, so the Log tab reopens with the filters last left on
// it — the same restore-at-import pattern the workspace tabs use.
const restoredFilters = loadTelemetryFilters(localStorage.getItem(TELEMETRY_FILTERS_KEY));

export function TelemetryScreen() {
  const { activeTab, openSettingsTab } = useWorkspace();
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
  const [agents, setAgents] = useState<AgentsSummary | null>(null);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentsRange, setAgentsRange] = useState<AgentRange>(DEFAULT_AGENT_RANGE);
  const [builds, setBuilds] = useState<BuildSnapshot[] | null>(null);
  const [buildsLoading, setBuildsLoading] = useState(false);
  const [rules, setRules] = useState<RuleScore[] | null>(null);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [rulesRange, setRulesRange] = useState<RulesRange>(DEFAULT_RULES_RANGE);
  const [rulesOnlyFailing, setRulesOnlyFailing] = useState(false);

  useEffect(() => {
    saveTelemetryFilters({ kind, days: logDays, filters, query });
  }, [kind, logDays, filters, query]);

  useEffect(() => onSettingsChanged(() => void loadUserSettings().then(setSettings)), []);

  async function loadEvents(d: string) {
    setLoading(true);
    const r = await telemetryEvents(d);
    Result.match(r, {
      onSuccess: setEvents,
      onFailure: (e) => {
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
    Result.match(r, {
      onSuccess: setPage,
      onFailure: (e) => {
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
    Result.match(r, {
      onSuccess: setAttention,
      onFailure: (e) => {
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
    Result.match(r, {
      onSuccess: setKeyboard,
      onFailure: (e) => {
        setKeyboard(null);
        if (!NotInTauri.is(e)) toast.error(`Could not score shortcuts: ${errorMessage(e)}`);
      },
    });
    setKeyboardLoading(false);
  }

  /** Range-scoped like the keyboard score, so it ignores the day picker too. */
  async function loadAgents() {
    setAgentsLoading(true);
    const r = await telemetryAgents(agentsRange);
    Result.match(r, {
      onSuccess: setAgents,
      onFailure: (e) => {
        setAgents(null);
        if (!NotInTauri.is(e)) toast.error(`Could not summarize agents: ${errorMessage(e)}`);
      },
    });
    setAgentsLoading(false);
  }

  async function loadDashboard() {
    setDashboardLoading(true);
    const r = await telemetryDashboard(dashboardRange, dashboardGroup);
    Result.match(r, {
      onSuccess: setDashboard,
      onFailure: (e) => {
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
    Result.match(r, {
      onSuccess: setBuilds,
      onFailure: (e) => {
        setBuilds(null);
        if (!NotInTauri.is(e)) toast.error(`Could not list builds: ${errorMessage(e)}`);
      },
    });
    setBuildsLoading(false);
  }

  /** Range-scoped like the dashboard; the rules come from settings, so a save
   * there is picked up on the next load. */
  async function loadRules() {
    setRulesLoading(true);
    const r = await telemetryRules(rulesRange);
    Result.match(r, {
      onSuccess: setRules,
      onFailure: (e) => {
        setRules(null);
        if (!NotInTauri.is(e)) toast.error(`Could not score rules: ${errorMessage(e)}`);
      },
    });
    setRulesLoading(false);
  }

  /** Re-lists the available days and resolves the selected one if unset. */
  async function refreshDays() {
    const daysResult = await telemetryDays();
    Result.match(daysResult, {
      onSuccess: (d) => {
        setDays(d);
        setDay((current) => current ?? d[0] ?? null);
      },
      onFailure: (e) => {
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
    if (tab === "agents") void loadAgents();
    if (tab === "builds") void loadBuilds();
    if (tab === "rules") void loadRules();
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
    if (tab === "agents") void loadAgents();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadAgents is read fresh, not tracked
  }, [tab, agentsRange]);

  useEffect(() => {
    if (tab === "builds") void loadBuilds();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadBuilds is read fresh, not tracked
  }, [tab]);

  useEffect(() => {
    if (tab === "rules") void loadRules();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadRules is read fresh, not tracked
  }, [tab, rulesRange]);

  function manualRefresh() {
    uiAction("telemetry.refresh", "telemetry");
    void refreshDays();
    if (day) void loadEvents(day);
    if (day && tab === "attention") void loadAttention(day);
    if (tab === "keyboard") void loadKeyboard();
    if (tab === "dashboard") void loadDashboard();
    if (tab === "agents") void loadAgents();
    if (tab === "builds") void loadBuilds();
    if (tab === "rules") void loadRules();
  }

  /** A rule card becomes a Log view of its population — the `select` filters,
   * read from settings since the score carries only the id. */
  function openRule(score: RuleScore) {
    uiAction("telemetry.rule_opened", "telemetry", score.id);
    const rule = settings?.telemetryRules.find((r) => r.id === score.id);
    applyLogFilters({ days: rule?.days ?? 1, filters: rule?.select ?? [], query: "" });
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
          <LightningIcon className="size-5 text-muted-foreground" />
          Telemetry
        </h2>
        <div className="flex items-center gap-2">
          <DayPicker
            days={days}
            day={day}
            onDay={(v) => {
              setDay(v);
              uiAction("telemetry.day_change", "telemetry", v);
            }}
          />
          <Button
            variant="outline"
            size="sm"
            icon={<ArrowClockwiseIcon className={cn("size-3.5", loading && "animate-spin")} />}
            onClick={manualRefresh}
            disabled={loading}
          >
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
        variant="underline"
        value={tab}
        onValueChange={switchTab}
        className="shrink-0 border-b border-kumo-hairline bg-kumo-base px-2"
        tabs={TELEMETRY_TABS}
      />

      <div
        role="tabpanel"
        aria-label={tab[0].toUpperCase() + tab.slice(1)}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {tab === "overview" && (
          <div className="p-4">
            <OverviewTab
              events={events}
              levelCounts={levelCounts}
              day={day}
              onOpenLog={() => {
                uiAction("telemetry.log_opened", "telemetry", "errors");
                applyLogFilters({
                  days: 1,
                  filters: [{ field: "level", op: "eq", value: "ERROR" }],
                });
              }}
            />
          </div>
        )}

        {tab === "dashboard" && (
          <div className="p-4">
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
          </div>
        )}

        {tab === "agents" && (
          <div className="p-4">
            <AgentsTab
              summary={agents}
              loading={agentsLoading}
              range={agentsRange}
              onRange={setAgentsRange}
              onRefresh={() => void loadAgents()}
            />
          </div>
        )}

        {tab === "builds" && (
          <div className="p-4">
            <BuildsTab
              snapshots={builds}
              loading={buildsLoading}
              onRefresh={() => void loadBuilds()}
            />
          </div>
        )}

        {tab === "rules" && (
          <div className="p-4">
            <RulesTab
              scores={rules}
              loading={rulesLoading}
              range={rulesRange}
              onlyFailing={rulesOnlyFailing}
              onRange={setRulesRange}
              onOnlyFailing={setRulesOnlyFailing}
              onRefresh={() => void loadRules()}
              onOpenRule={openRule}
              onAddRule={() => openSettingsTab({ tab: "collectors", filter: "Telemetry rules" })}
            />
          </div>
        )}

        {tab === "attention" && (
          <div className="p-4">
            <AttentionTab summary={attention} loading={attentionLoading} />
          </div>
        )}

        {tab === "keyboard" && (
          <div className="p-4">
            <KeyboardTab score={keyboard} loading={keyboardLoading} />
          </div>
        )}

        {tab === "query" && (
          <div className="flex h-full min-h-0 flex-col p-4">
            <QueryTab />
          </div>
        )}

        {tab === "log" && (
          <div className="p-4">
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
          </div>
        )}

        {tab === "insights" && (
          <div className="p-4">
            <InsightsTab events={events} onSelect={openRecord} />
          </div>
        )}
      </div>

      <RecordDialog record={selected} onOpen={openRecord} onClose={() => setSelected(null)} />
    </div>
  );
}
