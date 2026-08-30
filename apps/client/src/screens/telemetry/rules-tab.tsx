import { Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, Empty } from "@/components/store-bits";
import { ChipMenu, ChipToggle } from "@/screens/telemetry/chips";
import { cn } from "@/lib/utils";
import { uiAction } from "@/lib/ui-action";
import type { RuleScore } from "@/lib/telemetry";
import {
  fmtRuleValue,
  ruleDetail,
  ruleState,
  shortDay,
  sparklineMax,
  type RuleState,
} from "@/lib/telemetry-rules";

/** Rules — Braintrust's scorers, counting outcomes instead of asking a model.
 * One card per enabled rule, scored in `crates/tt-telemetry/src/rules.rs`; the
 * rules themselves are settings. */

export type RulesRange = 7 | 14;

const RANGES: { value: RulesRange; label: string }[] = [
  { value: 7, label: "Past 7 days" },
  { value: 14, label: "Past 14 days" },
];

export const DEFAULT_RULES_RANGE: RulesRange = 14;

const VALUE_TONE: Record<RuleState, string> = {
  failing: "text-red-600 dark:text-red-400",
  near: "text-amber-600 dark:text-amber-400",
  passing: "text-emerald-600 dark:text-emerald-500",
  empty: "text-muted-foreground/60",
};

const LINE_TONE: Record<RuleState, string> = {
  failing: "stroke-red-600 dark:stroke-red-400",
  near: "stroke-amber-600 dark:stroke-amber-400",
  passing: "stroke-emerald-600 dark:stroke-emerald-500",
  empty: "stroke-muted-foreground/60",
};

export function RulesTab({
  scores,
  loading,
  range,
  onlyFailing,
  onRange,
  onOnlyFailing,
  onRefresh,
  onOpenRule,
  onAddRule,
}: {
  scores: RuleScore[] | null;
  loading: boolean;
  range: RulesRange;
  onlyFailing: boolean;
  onRange: (range: RulesRange) => void;
  onOnlyFailing: (on: boolean) => void;
  onRefresh: () => void;
  onOpenRule: (score: RuleScore) => void;
  onAddRule: () => void;
}) {
  const shown = (scores ?? []).filter((s) => !onlyFailing || s.failing);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <ChipMenu
          ariaLabel="Rules range"
          label={RANGES.find((r) => r.value === range)?.label ?? `Past ${range} days`}
          active={range !== DEFAULT_RULES_RANGE}
          items={RANGES.map((r) => ({
            key: String(r.value),
            label: r.label,
            onSelect: () => {
              uiAction("telemetry.rules_range", "telemetry", `${r.value}d`);
              onRange(r.value);
            },
          }))}
        />
        <ChipToggle
          label="Only failing"
          pressed={onlyFailing}
          onPressedChange={(on) => {
            uiAction("telemetry.rules_only_failing", "telemetry", on ? "on" : "off");
            onOnlyFailing(on);
          }}
        />
        <Button
          variant="outline"
          size="xs"
          className="ml-auto"
          onClick={() => {
            uiAction("telemetry.rules_refresh", "telemetry");
            onRefresh();
          }}
          disabled={loading}
        >
          <RefreshCw className={cn("size-3", loading && "animate-spin")} />
          Refresh
        </Button>
        <Button
          variant="outline"
          size="xs"
          onClick={() => {
            uiAction("telemetry.rules_add", "telemetry");
            onAddRule();
          }}
        >
          <Plus className="size-3" />
          Rule
        </Button>
      </div>

      {!scores || scores.length === 0 ? (
        <Card title="Rules">
          <Empty inline>
            {loading
              ? "Scoring the range…"
              : "No rules enabled — add one here or in Settings → Collectors."}
          </Empty>
        </Card>
      ) : shown.length === 0 ? (
        <Card title="Rules" note={`${scores.length}`}>
          <Empty inline>Nothing is failing.</Empty>
        </Card>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3">
          {shown.map((s) => (
            <RuleCard key={s.id} score={s} onOpen={() => onOpenRule(s)} />
          ))}
        </div>
      )}
    </div>
  );
}

function RuleCard({ score, onOpen }: { score: RuleScore; onOpen: () => void }) {
  const state = ruleState(score);
  return (
    <button
      type="button"
      onClick={onOpen}
      title="Open these records in the Log"
      className="flex flex-col gap-1 rounded-lg border border-border bg-card p-3.5 text-left hover:bg-accent/40"
    >
      <span className="text-sm font-medium text-foreground">{score.label}</span>
      <span
        className={cn(
          "font-mono text-3xl font-semibold leading-none [font-variant-numeric:tabular-nums]",
          VALUE_TONE[state],
        )}
      >
        {fmtRuleValue(score.kind, score.today)}
      </span>
      <span className="font-mono text-[11px] text-muted-foreground [font-variant-numeric:tabular-nums]">
        {ruleDetail(score)}
      </span>
      <Sparkline score={score} state={state} />
    </button>
  );
}

const VIEW_W = 220;
const VIEW_H = 36;
const PAD = 3;

/** A line through the day scores with the threshold dashed across; a day with
 * no population breaks the line rather than pulling it to zero. */
function Sparkline({ score, state }: { score: RuleScore; state: RuleState }) {
  const { series } = score;
  const max = sparklineMax(score);
  const step = (VIEW_W - PAD * 2) / Math.max(1, series.length - 1);
  const xOf = (i: number) => PAD + step * i;
  const yOf = (v: number) => PAD + (VIEW_H - PAD * 2) * (1 - Math.min(v, max) / max);
  const thresholdY = yOf(score.threshold);

  let d = "";
  let previous = false;
  const dots: { x: number; y: number; day: string; value: string }[] = [];
  series.forEach((p, i) => {
    if (p.score === null) {
      previous = false;
      return;
    }
    const x = xOf(i);
    const y = yOf(p.score);
    d += `${previous ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    previous = true;
    dots.push({ x, y, day: p.day, value: fmtRuleValue(score.kind, p.score) });
  });
  const last = dots.at(-1);

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      className="mt-1.5 h-9 w-full"
      role="img"
      aria-label={`${score.label}, daily score over ${series.length} days`}
    >
      <line
        x1={PAD}
        x2={VIEW_W - PAD}
        y1={thresholdY}
        y2={thresholdY}
        strokeDasharray="3 3"
        strokeWidth={1}
        className="stroke-muted-foreground/50"
      />
      <path d={d} fill="none" strokeWidth={1.5} className={LINE_TONE[state]} />
      {last && (
        <circle
          cx={last.x}
          cy={last.y}
          r={2.5}
          strokeWidth={1.5}
          className={cn("fill-card", LINE_TONE[state])}
        />
      )}
      {dots.map((p) => (
        <circle key={p.day} cx={p.x} cy={p.y} r={5} className="fill-transparent">
          <title>{`${shortDay(p.day)} · ${p.value}`}</title>
        </circle>
      ))}
    </svg>
  );
}
