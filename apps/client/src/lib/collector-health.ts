import type { CollectRun } from "./data";

/**
 * Always-on collector health, derived purely from the store's run bookkeeping
 * (`snapshot.runs`). The status bar renders one small dot per known collector
 * from this; keeping the classification here (not in the component) makes the
 * threshold behaviour unit-testable with an injected `now`.
 */

/** The four collector keys the app knows about (mirrors `tt-collect`). */
export type CollectorKey = "prs" | "issues" | "claude:calendar" | "slack:dm";

/**
 * - `fresh` — last run succeeded and is within the stale window.
 * - `stale` — last run succeeded but is older than the stale window.
 * - `failing` — last run errored (auth expired, network, …).
 * - `never-ran` — no run recorded yet.
 */
export type CollectorState = "fresh" | "stale" | "failing" | "never-ran";

export const KNOWN_COLLECTORS: readonly CollectorKey[] = [
  "prs",
  "issues",
  "claude:calendar",
  "slack:dm",
];

/**
 * Dot tint per collector state — **the** mapping, shared by the status bar and
 * the day bar. Green when fresh, red when failing, amber for stale data, and a
 * muted grey for "nothing collected yet". Carries the `dark:` pairs the styling
 * convention requires.
 *
 * The two surfaces used to keep private copies that disagreed: `never-ran` was
 * a muted grey in the status bar and amber in the day bar, so the same collector
 * read as "nothing yet" in one and "something's wrong" in the other, in the same
 * window at the same time. **Grey is the kept behavior**, because the status bar
 * paints a dot for every {@link KNOWN_COLLECTORS} entry — including
 * `claude:calendar` and `slack:dm`, both off unless the user turns them on — so
 * amber there is a permanent false alarm about collectors nobody asked to run.
 * The day bar only ever shows {@link ALWAYS_ON_COLLECTORS}, where `never-ran`
 * lasts only until the first tick lands, and its own docstring already says a
 * deliberately-disabled collector must not read as a problem.
 */
export const COLLECTOR_STATE_DOT: Record<CollectorState, string> = {
  fresh: "bg-green-500/70 dark:bg-green-400/70",
  stale: "bg-amber-500/80 dark:bg-amber-400/80",
  failing: "bg-red-500 dark:bg-red-400",
  "never-ran": "bg-muted-foreground/30 dark:bg-muted-foreground/30",
};

/** Short human label per collector state, for freshness tooltips. */
export const COLLECTOR_STATE_LABEL: Record<CollectorState, string> = {
  fresh: "up to date",
  stale: "stale",
  failing: "failing",
  "never-ran": "never ran",
};

/** Human labels for tooltips (the raw keys are terse). */
export const COLLECTOR_LABELS: Record<CollectorKey, string> = {
  prs: "Pull requests",
  issues: "Issues",
  "claude:calendar": "Calendar",
  "slack:dm": "Slack DM",
};

/**
 * Age (ms) past a *successful* run after which a collector reads as stale.
 * Tuned per collector cadence — PRs/Slack refresh in seconds so they go stale
 * quickly, issues/calendar run on the minute scale — and overridable per call.
 */
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

/**
 * Classify a single collector's latest run. `staleMs` is the boundary: a run
 * exactly `staleMs` old (or older) is `stale`, anything younger is `fresh`.
 */
export function classifyRun(
  run: CollectRun | undefined,
  now: number,
  staleMs: number,
): CollectorState {
  if (!run) return "never-ran";
  if (!run.ok) return "failing";
  return now - run.ranAt < staleMs ? "fresh" : "stale";
}

/**
 * Health for every known collector, newest-run-wins from `runs`. Order follows
 * {@link KNOWN_COLLECTORS} so the dot cluster is stable across renders.
 */
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

/**
 * The collectors the Cockpit "Refreshed …" readout reflects — exactly the ones
 * `storeCollectNow` kicks off (calendar is excluded there, since it spends claude
 * tokens per tick).
 */
export const REFRESH_COLLECTORS: readonly CollectorKey[] = ["prs", "issues"];

/**
 * Collectors that run unattended on every tick, so their freshness is the honest
 * signal for the day-bar dot. Calendar is excluded (off by default — it spends
 * claude tokens per tick), so its perpetual `never-ran` must not drag the dot
 * amber over a collector the user deliberately disabled.
 */
export const ALWAYS_ON_COLLECTORS: readonly CollectorKey[] = ["prs", "issues"];

/**
 * Severity order for {@link worstCollectorState}: a `failing` collector is the
 * loudest, then a `never-ran` one (no data at all), then `stale` (old data);
 * `fresh` is the quiet baseline. Ranking `never-ran` above `stale` is about
 * which one {@link worstCollectorState} surfaces, not about tint — see
 * {@link COLLECTOR_STATE_DOT}, where `never-ran` is grey and `stale` amber.
 */
const STATE_SEVERITY: Record<CollectorState, number> = {
  fresh: 0,
  stale: 1,
  "never-ran": 2,
  failing: 3,
};

/**
 * The worst state across the given health entries (by {@link STATE_SEVERITY}).
 * An empty list is `fresh` — nothing is wrong when there's nothing to judge.
 */
export function worstCollectorState(healths: CollectorHealth[]): CollectorState {
  return healths.reduce<CollectorState>(
    (worst, h) => (STATE_SEVERITY[h.state] > STATE_SEVERITY[worst] ? h.state : worst),
    "fresh",
  );
}

/**
 * Health for just the {@link ALWAYS_ON_COLLECTORS}, in their declared order —
 * what the day-bar dot colours from and lists in its tooltip.
 */
export function alwaysOnHealth(
  runs: CollectRun[],
  now: number,
  staleMs: Partial<Record<CollectorKey, number>> = {},
): CollectorHealth[] {
  const all = collectorHealth(runs, now, staleMs);
  return ALWAYS_ON_COLLECTORS.map((key) => all.find((h) => h.key === key)!);
}

/**
 * When the Cockpit's PR/issue data was last refreshed: the newest *successful*
 * run timestamp (epoch ms) across {@link REFRESH_COLLECTORS}, or `undefined` when
 * neither has a successful latest run yet. Derived from {@link collectorHealth}
 * so it shares the newest-run-wins bookkeeping — a collector whose latest run
 * errored contributes nothing (the readout then reports the other collector, or
 * "not refreshed yet"). The caller turns this into an age with an injected `now`
 * (via `fmtAge`), so nothing here reads the clock.
 */
export function dataRefreshedAt(runs: CollectRun[], now: number): number | undefined {
  let newest: number | undefined;
  for (const h of collectorHealth(runs, now)) {
    if (!REFRESH_COLLECTORS.includes(h.key)) continue;
    if (h.run?.ok) newest = newest === undefined ? h.run.ranAt : Math.max(newest, h.run.ranAt);
  }
  return newest;
}
