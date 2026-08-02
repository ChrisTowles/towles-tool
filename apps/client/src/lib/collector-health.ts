import type { CollectRun } from "./data";

export type CollectorKey = "prs" | "issues" | "claude:calendar" | "slack:dm";

export type CollectorState = "fresh" | "stale" | "failing" | "never-ran";

export const KNOWN_COLLECTORS: readonly CollectorKey[] = [
  "prs",
  "issues",
  "claude:calendar",
  "slack:dm",
];

/** **The** state→tint mapping, shared by the status bar and the app header, which
 * must not diverge. `never-ran` is grey, not amber: the status bar dots every
 * {@link KNOWN_COLLECTORS} entry, and two of them are off unless asked for. */
export const COLLECTOR_STATE_DOT: Record<CollectorState, string> = {
  fresh: "bg-green-500/70 dark:bg-green-400/70",
  stale: "bg-amber-500/80 dark:bg-amber-400/80",
  failing: "bg-red-500 dark:bg-red-400",
  "never-ran": "bg-muted-foreground/30 dark:bg-muted-foreground/30",
};

export const COLLECTOR_STATE_LABEL: Record<CollectorState, string> = {
  fresh: "up to date",
  stale: "stale",
  failing: "failing",
  "never-ran": "never ran",
};

export const COLLECTOR_LABELS: Record<CollectorKey, string> = {
  prs: "Pull requests",
  issues: "Issues",
  "claude:calendar": "Calendar",
  "slack:dm": "Slack DM",
};

/** Age (ms) past a *successful* run after which a collector reads as stale. */
export const DEFAULT_STALE_MS: Record<CollectorKey, number> = {
  prs: 20 * 60_000,
  issues: 30 * 60_000,
  "claude:calendar": 60 * 60_000,
  "slack:dm": 5 * 60_000,
};

export type CollectorHealth = {
  key: CollectorKey;
  label: string;
  state: CollectorState;
  run: CollectRun | undefined;
};

/** `staleMs` is inclusive: a run exactly that old is already `stale`. */
export function classifyRun(
  run: CollectRun | undefined,
  now: number,
  staleMs: number,
): CollectorState {
  if (!run) return "never-ran";
  if (!run.ok) return "failing";
  return now - run.ranAt < staleMs ? "fresh" : "stale";
}

/** Newest-run-wins, in {@link KNOWN_COLLECTORS} order so the dot cluster is stable. */
export function collectorHealth(
  runs: CollectRun[],
  now: number,
  staleMs: Partial<Record<CollectorKey, number>> = {},
): CollectorHealth[] {
  const latest = new Map<string, CollectRun>();
  for (const run of runs) {
    const prev = latest.get(run.collector);
    if (!prev || run.ranAt > prev.ranAt) latest.set(run.collector, run);
  }
  return KNOWN_COLLECTORS.map((key) => {
    const run = latest.get(key);
    const threshold = staleMs[key] ?? DEFAULT_STALE_MS[key];
    return { key, label: COLLECTOR_LABELS[key], state: classifyRun(run, now, threshold), run };
  });
}

/** Exactly what `storeCollectNow` kicks off; calendar spends claude tokens a tick. */
export const REFRESH_COLLECTORS: readonly CollectorKey[] = ["prs", "issues"];

/** What the header's freshness dot may judge: collectors that run unattended every
 * tick. A deliberately-disabled one's perpetual `never-ran` must not drag it. */
export const ALWAYS_ON_COLLECTORS: readonly CollectorKey[] = ["prs", "issues"];

/** Ranking `never-ran` over `stale` is about which state {@link worstCollectorState}
 * surfaces, not tint — {@link COLLECTOR_STATE_DOT} paints it the quieter of the two. */
const STATE_SEVERITY: Record<CollectorState, number> = {
  fresh: 0,
  stale: 1,
  "never-ran": 2,
  failing: 3,
};

export function worstCollectorState(healths: CollectorHealth[]): CollectorState {
  return healths.reduce<CollectorState>(
    (worst, h) => (STATE_SEVERITY[h.state] > STATE_SEVERITY[worst] ? h.state : worst),
    "fresh",
  );
}

export function alwaysOnHealth(
  runs: CollectRun[],
  now: number,
  staleMs: Partial<Record<CollectorKey, number>> = {},
): CollectorHealth[] {
  const all = collectorHealth(runs, now, staleMs);
  return ALWAYS_ON_COLLECTORS.map((key) => all.find((h) => h.key === key)!);
}

/** Newest *successful* run (epoch ms) across {@link REFRESH_COLLECTORS} — a
 * collector whose latest run errored contributes nothing. `now` is injected. */
export function dataRefreshedAt(runs: CollectRun[], now: number): number | undefined {
  let newest: number | undefined;
  for (const h of collectorHealth(runs, now)) {
    if (!REFRESH_COLLECTORS.includes(h.key)) continue;
    if (h.run?.ok) newest = newest === undefined ? h.run.ranAt : Math.max(newest, h.run.ranAt);
  }
  return newest;
}
