import { useEffect, useState } from "react";
import { Button } from "@cloudflare/kumo";
import { toast } from "@/lib/toast";
import { errorMessage, NotInTauri } from "@/lib/errors";
import { telemetryPrune, telemetryStorage, type TelemetryStorage } from "@/lib/telemetry";
import { uiAction } from "@/lib/ui-action";
import { SettingRow, type Flush } from "./common";

function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The event log's footprint, and a prune that applies the saved retention now
 * instead of at the next day's rollover. */
export function TelemetryStorageRow({ flush }: { flush: Flush }) {
  const [storage, setStorage] = useState<TelemetryStorage | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void telemetryStorage().then((r) => r.isOk() && setStorage(r.value));
  }, []);

  const prune = async () => {
    setBusy(true);
    uiAction("settings.telemetry_prune", "settings");
    await flush();
    const r = await telemetryPrune();
    setBusy(false);
    if (r.isErr()) {
      if (!NotInTauri.is(r.error)) toast.error(errorMessage(r.error));
      return;
    }
    const removed = (storage?.files ?? r.value.files) - r.value.files;
    setStorage(r.value);
    toast.success(removed > 0 ? `Deleted ${removed} old log files` : "Nothing past retention");
  };

  return (
    <SettingRow
      label="On disk"
      description={
        storage
          ? storage.files === 0
            ? "No event-log files yet."
            : `${storage.files} daily files, ${fmtBytes(storage.bytes)}, since ${storage.oldest}.`
          : "The event log lives in this checkout's data directory."
      }
    >
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void prune()}>
        {busy ? "Pruning…" : "Prune now"}
      </Button>
    </SettingRow>
  );
}
