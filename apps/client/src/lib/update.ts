import { useEffect, useState } from "react";
import { invoke, isTauri } from "@/lib/tauri";

/** Mirrors `update::UpdateInfo` (crates-tauri/tt-app/src/update.rs). */
export type UpdateInfo = {
  currentVersion: string;
  version: string;
};

/** Mirrors `update::UpdateProgress`; `total` is absent when the server sends no length. */
type UpdateProgress = {
  downloaded: number;
  total: number | null;
};

/**
 * The release a check found, or `null`. Only an installed bundle ever checks,
 * so a from-source build stays `null`. `update_pending` covers a check that
 * finished before this hook subscribed.
 */
export function useUpdateAvailable(): UpdateInfo | null {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<UpdateInfo>("update://available", (event) => {
        setUpdate(event.payload);
      });
      const pending = await invoke<UpdateInfo | null>("update_pending");
      const found = pending.unwrapOr(null);
      if (found) setUpdate(found);
    })();
    return () => unlisten?.();
  }, []);

  return update;
}

/** Download progress of the install in flight, as a 0–100 percentage, or `null` before the first chunk. */
export function useUpdateProgress(): number | null {
  const [percent, setPercent] = useState<number | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<UpdateProgress>("update://progress", ({ payload }) => {
        setPercent(
          payload.total ? Math.min(100, Math.round((payload.downloaded / payload.total) * 100)) : 0,
        );
      });
    })();
    return () => unlisten?.();
  }, []);

  return percent;
}

/** Download, install and relaunch. Resolves only on failure — success restarts the app. */
export function installUpdate() {
  return invoke<void>("update_install");
}
