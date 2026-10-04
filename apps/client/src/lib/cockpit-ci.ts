/**
 * Pure decisions behind the Cockpit's CI-health chips: which tint a run earns,
 * one chip per workflow, and red first.
 */
import type { CiRun } from "@/lib/data";
import type { ChecksTone } from "@/lib/pr-tone";

export type CiTone = ChecksTone;

/** Anything not yet `completed` is in flight. Of the verdicts, only `success` is
 * green and only a real failure is red; cancelled, skipped, neutral, stale and
 * action_required are muted — nobody needs to act on them from here. */
export function ciTone(run: Pick<CiRun, "status" | "conclusion">): CiTone {
  if (run.status !== "completed") return "running";
  switch (run.conclusion) {
    case "success":
      return "passing";
    case "failure":
    case "timed_out":
    case "startup_failure":
      return "failed";
    default:
      return "plain";
  }
}

const TONE_RANK: Record<CiTone, number> = { failed: 0, running: 1, passing: 2, plain: 3 };

/** One run per `(repo, workflow)`, newest `updatedMs` winning. The store already
 * holds one row per key; this keeps a duplicate from ever painting two chips. */
export function latestPerWorkflow(runs: readonly CiRun[]): CiRun[] {
  const latest = new Map<string, CiRun>();
  for (const run of runs) {
    const key = `${run.repo}\n${run.workflow}`;
    const prev = latest.get(key);
    if (!prev || run.updatedMs > prev.updatedMs) latest.set(key, run);
  }
  return [...latest.values()];
}

/** Red first, then in flight, green, muted; ties by repo then workflow. */
export function orderCiRuns(runs: readonly CiRun[]): CiRun[] {
  return latestPerWorkflow(runs).toSorted(
    (a, b) =>
      TONE_RANK[ciTone(a)] - TONE_RANK[ciTone(b)] ||
      a.repo.localeCompare(b.repo) ||
      a.workflow.localeCompare(b.workflow),
  );
}

/** Groups an {@link orderCiRuns} list by repo in first-appearance order, so the
 * repo with a red workflow leads and each group keeps red first. */
export function groupCiRunsByRepo(ordered: readonly CiRun[]): [string, CiRun[]][] {
  const groups = new Map<string, CiRun[]>();
  for (const run of ordered) {
    const group = groups.get(run.repo);
    if (group) group.push(run);
    else groups.set(run.repo, [run]);
  }
  return [...groups.entries()];
}

/** Why the panel is empty: no shell, nothing collected, or a repo chip with no
 * CI rows — never "nothing collected" while other repos have chips. */
export function ciEmptyCopy(live: boolean, collected: number, repo: string | null): string {
  if (!live) return "Not connected yet.";
  if (collected === 0) return "No default-branch workflow runs collected yet.";
  return repo === null ? "No workflow runs." : `No workflow runs for ${repo}.`;
}

/** Hover text: `Nightly · completed · failure · schedule · 2981502e`. */
export function ciRunTitle(run: CiRun): string {
  const parts = [run.workflow, run.status];
  if (run.conclusion) parts.push(run.conclusion);
  if (run.event) parts.push(run.event);
  if (run.headSha) parts.push(run.headSha.slice(0, 8));
  return parts.join(" · ");
}
