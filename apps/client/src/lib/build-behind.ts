import { useEffect, useState } from "react";
import { Effect } from "effect";
import { subscribeThen } from "@/lib/subscribe-then";
import { invoke } from "@/lib/tauri";

/** Mirrors `build_behind::BuildBehind` (crates-tauri/tt-app/src/build_behind.rs).
 * Absent unless this is a from-source build and `origin/main` is ahead of it. */
export type BuildBehind = {
  commits: number;
  /** Short sha this app was built from. */
  build: string;
};

export function behindLabel(behind: BuildBehind): string {
  return `main +${behind.commits} · rebuild`;
}

export function behindTooltip(behind: BuildBehind): string {
  const n = behind.commits;
  return `Built from ${behind.build}; origin/main has ${n} newer ${n === 1 ? "commit" : "commits"}. Rebuild with bun start.`;
}

/** `build_behind` covers a recompute that finished before this hook subscribed. */
export function useBuildBehind(): BuildBehind | null {
  const [behind, setBehind] = useState<BuildBehind | null>(null);

  useEffect(
    () =>
      subscribeThen(
        { "build-behind://changed": (payload) => setBehind(payload as BuildBehind | null) },
        invoke<BuildBehind | null>("build_behind").pipe(
          Effect.tap((current) => Effect.sync(() => setBehind(current))),
          Effect.ignore,
        ),
      ),
    [],
  );

  return behind;
}
