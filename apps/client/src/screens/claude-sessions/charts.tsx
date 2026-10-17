import { useEffect, useRef, useState } from "react";
// echarts is ~1MB, so it's dynamically imported at chart-mount time (see
// useEChart) rather than pulled into the initial bundle. The type-only import
// keeps `echarts.ECharts` available without emitting a runtime dependency.
import type * as echarts from "echarts";
import type { LedgerDay } from "@/lib/claude-sessions";
import { NEUTRAL, paletteAt } from "@/lib/colors";
import { fmtTokens, fmtUsd } from "@/lib/format";

/** Repos stacked individually in the day chart; the rest fold into "Other". */
const MAX_STACKED_REPOS = 4;

export const NO_SERIES_COLORS = new Map<string, string>();

/** A theme color as a concrete `rgba()` echarts can parse. The tokens are Kumo's
 * `light-dark(…)` over `oklch(…)`, which `getPropertyValue` returns unresolved
 * and echarts paints black — so resolve it on a probe, then rasterize one pixel. */
export function cssVar(name: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  probe.style.display = "none";
  document.body.append(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!ctx) return resolved;
  ctx.fillStyle = resolved;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}

/** A type-scale size from `index.css` (`--text-mini`), in px for echarts. */
export function cssPx(name: string): number {
  return Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
}

/** A font stack from `index.css` (`--font-sans`), so a canvas sets the app's face. */
function cssFont(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Bumps whenever `<html>`'s class actually flips (light/dark), so chart color
 * reads never race the theme-provider's own effect that toggles the class. */
function useDomThemeVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setVersion((v) => v + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return version;
}

/** Shared echarts lifecycle: init, first-layout resize, theme re-render. */
export function useEChart(render: (chart: echarts.ECharts) => void, deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  const themeVersion = useDomThemeVersion();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let chart: echarts.ECharts | undefined;
    let observer: ResizeObserver | undefined;
    let cancelled = false;
    const onResize = () => chart?.resize();
    // echarts is code-split; init once it lands, unless the effect already
    // cleaned up (fast tab switch / dep change) while the import was in flight.
    void import("echarts").then((echarts) => {
      if (cancelled || !ref.current) return;
      // A hidden or pre-layout mount is 0×0, and echarts.init() at 0×0 warns
      // and draws nothing — defer init to the ResizeObserver's first real
      // layout pass (screens stay mounted `hidden`, so this can be minutes).
      const initWhenSized = () => {
        if (chart || el.clientWidth === 0 || el.clientHeight === 0) return;
        chart = echarts.init(el);
        chart.setOption({ textStyle: { fontFamily: cssFont("--font-sans") } });
        render(chart);
      };
      initWhenSized();
      window.addEventListener("resize", onResize);
      observer = new ResizeObserver(() => {
        initWhenSized();
        chart?.resize();
      });
      observer.observe(el);
    });
    return () => {
      cancelled = true;
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
      chart?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps is caller-supplied (like useAsyncRefresh); render is a fresh closure re-read on each rebuild, not a trigger
  }, [...deps, themeVersion]);

  return ref;
}

/** Rank repos by window total and fold everything past the top N into "Other". */
function stackSeries(days: LedgerDay[]): { repos: string[]; rows: Map<string, number[]> } {
  const totals = new Map<string, number>();
  for (const day of days)
    for (const p of day.projects)
      totals.set(p.project, (totals.get(p.project) ?? 0) + p.totalTokens);
  const ranked = [...totals.entries()].toSorted((a, b) => b[1] - a[1]).map(([p]) => p);
  const top = ranked.slice(0, MAX_STACKED_REPOS);
  const hasOther = ranked.length > top.length;
  const repos = hasOther ? [...top, "Other"] : top;

  const rows = new Map<string, number[]>(repos.map((r) => [r, days.map(() => 0)]));
  days.forEach((day, i) => {
    for (const p of day.projects) {
      const key = top.includes(p.project) ? p.project : "Other";
      const row = rows.get(key);
      if (row) row[i] += p.totalTokens;
    }
  });
  return { repos, rows };
}

/** The subset of ECharts' axis-trigger tooltip param we read. */
type TooltipParam = {
  axisValue: string;
  dataIndex: number;
  marker: string;
  seriesName: string;
  value: number | null;
};

/** Stacked day×repo bars, capped with the day's estimated cost. Repos are
 * ranked by window total, so a repo's palette hue matches its row in the
 * "By repo" ranked chart; the "Other" fold stays neutral gray. */
export function DayStackChart({
  days,
  colors,
}: {
  days: LedgerDay[];
  colors: Map<string, string>;
}) {
  const ref = useEChart(
    (chart) => {
      const { repos, rows } = stackSeries(days);
      const foreground = cssVar("--foreground");
      const muted = cssVar("--muted-foreground");
      const border = cssVar("--border");
      const card = cssVar("--card");

      chart.setOption({
        // Extra headroom up top so the cost label above the tallest bar fits.
        grid: { left: 8, right: 8, top: 18, bottom: 44, containLabel: true },
        legend: {
          bottom: 0,
          // Only the repo series — the cost cap carries a label, not an identity.
          data: repos,
          textStyle: { color: muted, fontSize: cssPx("--text-mini") },
          itemWidth: 10,
          itemHeight: 10,
        },
        tooltip: {
          trigger: "axis",
          axisPointer: { type: "shadow" },
          backgroundColor: card,
          borderColor: border,
          textStyle: { color: foreground },
          formatter: (params: TooltipParam[]) => {
            const first = params[0];
            if (!first) return "";
            const lines = params
              .map(
                (p) =>
                  `<div>${p.marker} ${p.seriesName} <b>${(p.value ?? 0).toLocaleString()}</b> tokens</div>`,
              )
              .join("");
            const cost = days[first.dataIndex]?.costUsd ?? 0;
            return (
              `<div><b>${first.axisValue}</b></div>${lines}` +
              `<div style="margin-top:2px;opacity:.75">Est. cost <b>${fmtUsd(cost)}</b></div>`
            );
          },
        },
        xAxis: {
          type: "category",
          data: days.map((d) => d.date.slice(5)),
          axisLine: { lineStyle: { color: border } },
          axisTick: { show: false },
          axisLabel: { color: muted, fontSize: cssPx("--text-mini") },
        },
        yAxis: {
          type: "value",
          splitLine: { lineStyle: { color: border } },
          axisLabel: { color: muted, formatter: (v: number) => fmtTokens(v) },
        },
        series: [
          ...repos.map((repo) => ({
            name: repo,
            type: "bar",
            stack: "day",
            barMaxWidth: 26,
            data: rows.get(repo),
            itemStyle: {
              color: colors.get(repo) ?? NEUTRAL,
            },
          })),
          // Zero-height cap on the same stack: the only place a label sits at the
          // top of the whole stack rather than of whichever repo happens to be last.
          {
            name: "Est. cost",
            type: "bar",
            stack: "day",
            barMaxWidth: 26,
            silent: true,
            tooltip: { show: false },
            data: days.map(() => 0),
            label: {
              show: true,
              position: "top",
              color: muted,
              fontSize: cssPx("--text-mini"),
              formatter: (p: { dataIndex: number }) => fmtUsd(days[p.dataIndex]?.costUsd ?? 0),
            },
          },
        ],
      });
    },
    [days, colors],
  );

  if (days.length === 0)
    return <p className="text-sm text-muted-foreground">No sessions in this range.</p>;
  return <div ref={ref} style={{ height: 240 }} />;
}

/** Horizontal ranked bars, one palette hue per rank — sorted descending to
 * match the day-stack's ordering, so a repo keeps its hue across both charts;
 * each row labelled with tokens and estimated cost. */
export function RankedBarChart({
  bars,
  colors,
}: {
  bars: { label: string; totalTokens: number; costUsd: number }[];
  colors: Map<string, string>;
}) {
  const ref = useEChart(
    (chart) => {
      const foreground = cssVar("--foreground");
      const muted = cssVar("--muted-foreground");
      const border = cssVar("--border");
      const card = cssVar("--card");
      chart.setOption({
        // Right gutter holds the "tokens · cost" row label.
        grid: { left: 8, right: 88, top: 8, bottom: 8, containLabel: true },
        tooltip: {
          trigger: "item",
          backgroundColor: card,
          borderColor: border,
          textStyle: { color: foreground },
          formatter: (p: { marker: string; name: string; value: number; dataIndex: number }) =>
            `<div>${p.marker} <b>${p.name}</b></div>` +
            `<div>${p.value.toLocaleString()} tokens</div>` +
            `<div style="opacity:.75">Est. cost <b>${fmtUsd(bars[p.dataIndex]?.costUsd ?? 0)}</b></div>`,
        },
        xAxis: {
          type: "value",
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { lineStyle: { color: border } },
          axisLabel: { show: false },
        },
        yAxis: {
          type: "category",
          data: bars.map((b) => b.label),
          inverse: true,
          axisLine: { lineStyle: { color: border } },
          axisTick: { show: false },
          axisLabel: { color: foreground, width: 150, overflow: "truncate" },
        },
        series: [
          {
            type: "bar",
            data: bars.map((b, i) => ({
              value: b.totalTokens,
              itemStyle: {
                color: colors.get(b.label) ?? paletteAt(i),
                borderRadius: [0, 4, 4, 0],
              },
            })),
            barMaxWidth: 22,
            label: {
              show: true,
              position: "right",
              color: muted,
              formatter: (p: { value: number; dataIndex: number }) =>
                `${fmtTokens(p.value)} · ${fmtUsd(bars[p.dataIndex]?.costUsd ?? 0)}`,
            },
          },
        ],
      });
    },
    [bars, colors],
  );

  if (bars.length === 0)
    return <p className="text-sm text-muted-foreground">No sessions in this range.</p>;
  return <div ref={ref} style={{ height: Math.max(120, bars.length * 36) }} />;
}
