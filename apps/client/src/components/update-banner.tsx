import { useState } from "react";
import { SparkleIcon, XIcon } from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo";
import { toast } from "@/lib/toast";
import { uiAction } from "@/lib/ui-action";
import { useWorkspace } from "@/lib/workspace";
import { installUpdate, useUpdateAvailable, useUpdateProgress } from "@/lib/update";

/** Full-width strip offering a newer release. Dismiss is session-only — no
 * persisted "skip this version", so it returns on relaunch until installed. */
export function UpdateBanner() {
  const update = useUpdateAvailable();
  const progress = useUpdateProgress();
  const { activeTab } = useWorkspace();
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);

  if (!update || dismissed) return null;

  const install = async () => {
    setInstalling(true);
    const result = await installUpdate();
    setInstalling(false);
    if (result.isErr()) toast.error(`Couldn't install ${update.version} — ${result.error.message}`);
  };

  return (
    <div className="flex shrink-0 items-center gap-2.5 border-b border-l-2 border-l-info bg-info/5 px-3 py-1.5 text-xs">
      <SparkleIcon className="size-4 shrink-0 text-info" />
      <span className="text-kumo-default">
        Towles Tool <span className="font-medium">{update.version}</span> is available — you're on{" "}
        {update.currentVersion}
      </span>

      <div className="flex-1" />

      {installing ? (
        <span className="tabular-nums text-kumo-subtle">
          {progress === null || progress < 100 ? `Downloading ${progress ?? 0}%` : "Installing…"}
        </span>
      ) : (
        <>
          <span className="text-kumo-subtle">Restarting ends running terminals</span>
          <Button
            variant="outline"
            size="xs"
            className="border-info/40 text-info hover:text-info"
            onClick={() => void install()}
          >
            Update & restart
          </Button>
          <Button
            variant="ghost"
            size="xs"
            shape="square"
            className="text-kumo-subtle"
            aria-label="Dismiss"
            onClick={() => {
              uiAction("update_banner.dismiss", activeTab);
              setDismissed(true);
            }}
            icon={<XIcon className="size-3.5" />}
          />
        </>
      )}
    </div>
  );
}
