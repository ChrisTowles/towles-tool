import { graphemeClusters, isWideRun, type Run } from "@/lib/term-protocol";

/** Alpha washes, so they read on light and dark terminal themes. */
export const MATCH_FILL = "rgba(250, 204, 21, 0.3)";
export const CURRENT_MATCH_FILL = "rgba(249, 115, 22, 0.5)";
export const CURRENT_MATCH_STROKE = "rgba(249, 115, 22, 0.9)";

export const LINE_HEIGHT = 1.25;

/** The character at terminal column `x` in a row of runs, if any. */
export function charAt(runs: Run[], x: number): string | null {
  for (const run of runs) {
    if (x < run.x || x >= run.x + run.width) continue;
    const clusters = graphemeClusters(run.text);
    if (!isWideRun(run)) return clusters[x - run.x] ?? null;
    let cx = run.x;
    for (const cluster of clusters) {
      const w = (cluster.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
      if (x >= cx && x < cx + w) return cluster;
      cx += w;
    }
  }
  return null;
}
