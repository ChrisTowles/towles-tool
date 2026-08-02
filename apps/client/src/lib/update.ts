import { useEffect, useState } from "react";
import { isTauri } from "@/lib/tauri";

/** Mirrors `tt_update::UpdateCheck` (crates/tt-update/src/lib.rs). */
export type UpdateCheck = {
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  updateAvailable: boolean;
};

/**
 * `update://available` fires only when a newer release exists, so the initial
 * state is just "no update known yet" — no loading/error state to model.
 */
export function useUpdateCheck(): UpdateCheck | null {
  const [update, setUpdate] = useState<UpdateCheck | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<UpdateCheck>("update://available", (event) => {
        setUpdate(event.payload);
      });
    })();
    return () => unlisten?.();
  }, []);

  return update;
}
