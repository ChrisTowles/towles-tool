import { useEffect, useState } from "react";
import { invoke, isTauri } from "@/lib/tauri";

/** Mirrors `update::UpdateInfo` (crates-tauri/tt-app/src/update.rs). */
export type UpdateInfo = {
  currentVersion: string;
  version: string;
  /** Short commit of a main-channel build; main builds share a version. */
  build: string | null;
};

export type UpdateChannel = "stable" | "main";

/** Mirrors `update::UpdateStatus`. */
export type UpdateStatus = {
  installed: boolean;
  currentVersion: string;
  build: string;
  channel: UpdateChannel;
  rollbackTo: string | null;
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
      const unlistenFound = await listen<UpdateInfo>("update://available", (event) => {
        setUpdate(event.payload);
      });
      const unlistenCleared = await listen("update://cleared", () => setUpdate(null));
      unlisten = () => {
        unlistenFound();
        unlistenCleared();
      };
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

export function updateStatus() {
  return invoke<UpdateStatus>("update_status");
}

/** Check the saved channel now; the banner hears the result as events too. */
export function checkForUpdate() {
  return invoke<UpdateInfo | null>("update_check_now");
}

/** Reinstall the release the last install replaced. Resolves only on failure. */
export function rollbackUpdate() {
  return invoke<void>("update_rollback");
}

/** "0.3.0", or "main build abc1234" when the version can't tell builds apart. */
export function updateLabel(info: UpdateInfo): string {
  return info.build ? `main build ${info.build}` : info.version;
}
