import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, Empty } from "@/components/store-bits";
import { cn } from "@/lib/utils";
import { errorMessage, NotInTauri } from "@/lib/errors";
import { uiAction } from "@/lib/ui-action";
import {
  fmtDuration,
  telemetryBuildCompare,
  type BuildDelta,
  type BuildKey,
  type BuildSnapshot,
} from "@/lib/telemetry";
import {
  fmtDelta,
  fmtValue,
  keyOf,
  loadBuildsPair,
  MIN_FOCUS_MS,
  MIN_SNAPSHOT_RECORDS,
  readOf,
  resolvePair,
  sameKey,
  saveBuildsPair,
  shortDay,
  shortSha,
  snapshotLabel,
  TELEMETRY_BUILDS_KEY,
  verdict,
  type BuildPair,
  type Verdict,
} from "@/lib/telemetry-builds";
import { ChipMenu, ChipSegments, ChipToggle } from "@/screens/telemetry/chips";

/** Builds — Braintrust's Experiments over `tt.build_sha`: a build × day is a
 * snapshot read against a baseline. Days differ, so the day always sits beside the
 * sha and raw / per-focused-hour are one click apart (`tt-telemetry/src/builds.rs`). */

const restoredPair = loadBuildsPair(localStorage.getItem(TELEMETRY_BUILDS_KEY));

type Normalize = "raw" | "hour";

const VERDICT_TONE: Record<Verdict, string> = {
  better: "text-green-600 dark:text-green-500",
  worse: "text-red-600 dark:text-red-400",
  same: "text-muted-foreground/60",
  neutral: "text-foreground",
  none: "text-muted-foreground/60",
};

export function BuildsTab({
  snapshots,
  loading,
  onRefresh,
}: {
  snapshots: BuildSnapshot[] | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const [chosen, setChosen] = useState<BuildPair | null>(restoredPair);
  const [normalize, setNormalize] = useState<Normalize>("raw");
  const [diffOnly, setDiffOnly] = useState(false);
  const [deltas, setDeltas] = useState<BuildDelta[] | null>(null);
  const [comparing, setComparing] = useState(false);

  // Memoized so the default pair is one object across renders; the compare
  // effect keys on it.
  const pair = useMemo(() => resolvePair(chosen, snapshots ?? []), [chosen, snapshots]);

  useEffect(() => {
    if (pair) saveBuildsPair(pair);
  }, [pair]);

  useEffect(() => {
    if (!pair) {
      setDeltas(null);
      return;
    }
    let stale = false;
    setComparing(true);
    void telemetryBuildCompare(pair.base, pair.other).then((r) => {
      if (stale) return;
      r.match({
        ok: setDeltas,
        err: (e) => {
          setDeltas(null);
          if (!NotInTauri.is(e)) toast.error(`Could not compare builds: ${errorMessage(e)}`);
        },
      });
      setComparing(false);
    });
    return () => {
      stale = true;
    };
  }, [pair]);

  function choose(which: "base" | "other", key: BuildKey) {
    if (!pair) return;
    uiAction(
      which === "base" ? "telemetry.builds_baseline" : "telemetry.builds_candidate",
      "telemetry",
      shortSha(key.sha),
    );
    setChosen({ ...pair, [which]: key });
  }

  /** A row click makes it the candidate; clicking the baseline swaps the two. */
  function pick(snapshot: BuildSnapshot) {
    if (!pair) return;
    const key = keyOf(snapshot);
    if (sameKey(key, pair.base)) {
      uiAction("telemetry.builds_candidate", "telemetry", "swap");
      setChosen({ base: pair.other, other: pair.base });
    } else {
      choose("other", key);
    }
  }

  const items = (which: "base" | "other") =>
    (snapshots ?? []).map((s) => ({
      key: `${s.sha}@${s.day}`,
      label: `${snapshotLabel(s)} · ${s.recordCount.toLocaleString()}`,
      onSelect: () => choose(which, keyOf(s)),
    }));

  const normalized = normalize === "hour";
  const lowFocus = pair
    ? [pair.base, pair.other]
        .map((k) => snapshots?.find((s) => sameKey(s, k)))
        .filter((s): s is BuildSnapshot => !!s && s.measures.focusedMs < MIN_FOCUS_MS)
    : [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <ChipMenu
          ariaLabel="Baseline build"
          label={pair ? `Baseline: ${snapshotLabel(pair.base)}` : "Baseline: —"}
          active={false}
          items={items("base")}
        />
        <ChipMenu
          ariaLabel="Candidate build"
          label={pair ? `vs ${snapshotLabel(pair.other)}` : "vs —"}
          active={false}
          items={items("other")}
        />
        <ChipSegments
          label="Normalize:"
          value={normalize}
          options={[
            { value: "raw", label: "raw" },
            { value: "hour", label: "per focused hour" },
          ]}
          onChange={(v) => {
            uiAction("telemetry.builds_normalize", "telemetry", v);
            setNormalize(v);
          }}
        />
        <ChipToggle
          label="Diff"
          pressed={diffOnly}
          onPressedChange={(on) => {
            uiAction("telemetry.builds_diff", "telemetry", on ? "on" : "off");
            setDiffOnly(on);
          }}
        />
        <Button
          variant="outline"
          size="xs"
          className="ml-auto"
          onClick={() => {
            uiAction("telemetry.builds_refresh", "telemetry");
            onRefresh();
          }}
          disabled={loading}
        >
          <RefreshCw className={cn("size-3", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {!snapshots || snapshots.length === 0 ? (
        <Card title="Builds">
          <Empty inline>{loading ? "Reading the fortnight…" : "No builds recorded yet."}</Empty>
        </Card>
      ) : (
        <div className="grid grid-cols-[280px_minmax(0,1fr)] gap-3">
          <SnapshotList snapshots={snapshots} pair={pair} onPick={pick} />
          <Card
            title="Comparison"
            note={pair ? `${shortSha(pair.base.sha)} → ${shortSha(pair.other.sha)}` : undefined}
          >
            {!pair ? (
              <Empty inline>Two builds are needed to compare.</Empty>
            ) : !deltas ? (
              <Empty inline>{comparing ? "Comparing…" : "No comparison available."}</Empty>
            ) : (
              <>
                <DeltaTable deltas={deltas} normalized={normalized} diffOnly={diffOnly} />
                {normalized && lowFocus.length > 0 && (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Per-hour figures withheld where focused time is under 10 minutes:{" "}
                    {lowFocus
                      .map((s) => `${snapshotLabel(s)} (${fmtDuration(s.measures.focusedMs)})`)
                      .join(", ")}
                    .
                  </p>
                )}
              </>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

function SnapshotList({
  snapshots,
  pair,
  onPick,
}: {
  snapshots: BuildSnapshot[];
  pair: BuildPair | null;
  onPick: (snapshot: BuildSnapshot) => void;
}) {
  const max = Math.max(1, ...snapshots.map((s) => s.recordCount));
  return (
    <Card title="Snapshots" note={`${snapshots.length}`}>
      <div className="-mx-1.5 flex flex-col">
        {snapshots.map((s) => {
          const isBase = !!pair && sameKey(s, pair.base);
          const isOther = !!pair && sameKey(s, pair.other);
          const thin = s.recordCount < MIN_SNAPSHOT_RECORDS;
          return (
            <button
              key={`${s.sha}@${s.day}`}
              type="button"
              aria-current={isOther ? "true" : undefined}
              onClick={() => onPick(s)}
              title={`${s.sha} · ${s.day}`}
              className={cn(
                "flex w-full flex-col gap-1 rounded-md border-l-2 border-transparent px-2 py-1.5 text-left hover:bg-accent/50",
                isBase && "border-l-violet-500",
                isOther && "bg-accent/50",
              )}
            >
              <div className="flex w-full items-center gap-2 font-mono text-xs">
                <span className={cn(thin ? "text-muted-foreground" : "text-foreground")}>
                  {shortSha(s.sha)}
                </span>
                <span className="text-muted-foreground">{shortDay(s.day)}</span>
                {isBase && <span className="text-violet-700 dark:text-violet-300">baseline</span>}
                {isOther && <span className="text-muted-foreground">candidate</span>}
                <span className="ml-auto text-[11px] text-muted-foreground [font-variant-numeric:tabular-nums]">
                  {s.recordCount.toLocaleString()}
                </span>
              </div>
              <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-violet-500/60"
                  style={{ width: `${Math.max(1, (s.recordCount / max) * 100)}%` }}
                />
              </div>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function DeltaTable({
  deltas,
  normalized,
  diffOnly,
}: {
  deltas: BuildDelta[];
  normalized: boolean;
  diffOnly: boolean;
}) {
  const rows = deltas.map((d) => {
    const shown = normalized && d.perHour ? d.perHour : d;
    const perHour = normalized && d.perHour !== null;
    return { d, shown, perHour, tone: verdict(shown.delta, d.direction) };
  });
  const visible = diffOnly ? rows.filter((r) => r.shown.delta !== 0) : rows;
  if (visible.length === 0) {
    return <Empty inline>Nothing changed between these builds.</Empty>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs [font-variant-numeric:tabular-nums]">
        <thead>
          <tr className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
            <th className="pb-1.5 text-left font-medium">Measure</th>
            <th className="pb-1.5 text-right font-medium">baseline</th>
            <th className="pb-1.5 text-right font-medium">candidate</th>
            <th className="pb-1.5 text-right font-medium">Δ</th>
            <th className="pb-1.5 pl-4 text-left font-medium">read</th>
          </tr>
        </thead>
        <tbody>
          {visible.map(({ d, shown, perHour, tone }) => (
            <tr key={d.measure} className="border-t border-border/60">
              <td className="py-1.5 pr-3 text-foreground">{d.label}</td>
              <td className="py-1.5 text-right font-mono text-muted-foreground">
                {fmtValue(shown.base, d.unit, perHour)}
              </td>
              <td className="py-1.5 text-right font-mono text-foreground">
                {fmtValue(shown.other, d.unit, perHour)}
              </td>
              <td className={cn("py-1.5 text-right font-mono", VERDICT_TONE[tone])}>
                {fmtDelta(shown.delta, d.unit, perHour)}
              </td>
              <td className="py-1.5 pl-4 text-muted-foreground">{readOf(d, normalized)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
