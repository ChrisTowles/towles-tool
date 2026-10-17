import { useEffect, useState } from "react";
import { invoke, isTauri } from "@/lib/tauri";

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

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const stop = await listen<BuildBehind | null>("build-behind://changed", (event) => {
        setBehind(event.payload);
      });
      if (cancelled) return stop();
      unlisten = stop;
      const current = await invoke<BuildBehind | null>("build_behind");
      if (!cancelled) setBehind(current.unwrapOr(null));
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return behind;
}
