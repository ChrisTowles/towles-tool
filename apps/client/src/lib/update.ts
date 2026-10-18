import { Effect } from "effect";
import { useEffect, useState } from "react";
import { useTauriEvent } from "@/lib/run";
import { subscribeThen } from "@/lib/subscribe-then";
import { invoke, ipcOr, runIpc } from "@/lib/tauri";

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

  useEffect(
    () =>
      subscribeThen(
        {
          "update://available": (payload) => setUpdate(payload as UpdateInfo),
          "update://cleared": () => setUpdate(null),
        },
        Effect.promise(async () => {
          const found = await ipcOr(invoke<UpdateInfo | null>("update_pending"), null);
          if (found) setUpdate(found);
        }),
      ),
    [],
  );

  return update;
}

/** Download progress of the install in flight, as a 0–100 percentage, or `null` before the first chunk. */
export function useUpdateProgress(): number | null {
  const [percent, setPercent] = useState<number | null>(null);
  useTauriEvent<UpdateProgress>("update://progress", (payload) => {
    setPercent(
      payload.total ? Math.min(100, Math.round((payload.downloaded / payload.total) * 100)) : 0,
    );
  });
  return percent;
}

/** Download, install and relaunch. Resolves only on failure — success restarts the app. */
export function installUpdate() {
  return runIpc(invoke<void>("update_install"));
}

export function updateStatus() {
  return runIpc(invoke<UpdateStatus>("update_status"));
}

/** Check the saved channel now; the banner hears the result as events too. */
export function checkForUpdate() {
  return runIpc(invoke<UpdateInfo | null>("update_check_now"));
}

/** Reinstall the release the last install replaced. Resolves only on failure. */
export function rollbackUpdate() {
  return runIpc(invoke<void>("update_rollback"));
}

/** "0.3.0", or "main build abc1234" when the version can't tell builds apart. */
export function updateLabel(info: UpdateInfo): string {
  return info.build ? `main build ${info.build}` : info.version;
}
