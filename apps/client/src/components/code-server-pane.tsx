/** The code-server editor pane (spike — docs/CODE-SERVER-SPIKE.md): a real VS
 * Code workbench in an iframe, where `files-pane` otherwise renders Monaco.
 * Keyed on the URL alone — a remount drops the workbench session and re-pays
 * the several-second boot. */

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { codeServerOpen } from "@/lib/code-server";
import { errorMessage, NotInTauri } from "@/lib/errors";

type Phase =
  | { at: "starting" }
  | { at: "live"; url: string }
  | { at: "failed"; detail: string }
  | { at: "browser" };

export function CodeServerPane({ dir }: { dir: string }) {
  const [phase, setPhase] = useState<Phase>({ at: "starting" });
  useEffect(() => {
    let alive = true;
    setPhase({ at: "starting" });
    void codeServerOpen(dir).then((r) => {
      if (!alive) return;
      setPhase(
        r.match<Phase>({
          ok: (info) => ({ at: "live", url: info.url }),
          err: (e) =>
            NotInTauri.is(e) ? { at: "browser" } : { at: "failed", detail: errorMessage(e) },
        }),
      );
    });
    return () => {
      alive = false;
    };
  }, [dir]);

  if (phase.at === "live") {
    return (
      // oxlint-disable-next-line react/iframe-missing-sandbox
      <iframe
        key={phase.url}
        src={phase.url}
        title="code-server"
        allow="clipboard-read; clipboard-write"
        className="h-full w-full border-0 bg-[#1f1f1f]"
      />
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
      {phase.at === "starting" ? (
        <>
          <Loader2 className="size-5 animate-spin text-muted-foreground/60" />
          <div className="text-xs text-muted-foreground">Starting code-server…</div>
        </>
      ) : phase.at === "browser" ? (
        <div className="text-xs text-muted-foreground">code-server needs the Tauri shell.</div>
      ) : (
        <>
          <AlertTriangle className="size-5 text-amber-500/80" />
          <div className="text-xs text-muted-foreground">{phase.detail}</div>
          <div className="text-[11px] text-muted-foreground/70">
            Install code-server, or point <span className="font-mono">TT_CODE_SERVER_BIN</span> at
            it.
          </div>
        </>
      )}
    </div>
  );
}
