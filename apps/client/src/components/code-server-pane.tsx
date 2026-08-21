/** The Files pane's body: a real VS Code workbench (code-server) in an iframe, one per
 * checkout against the app's one server (docs/CODE-SERVER.md). Keyed on the URL alone — a
 * remount drops the workbench session and re-pays the several-second boot. */

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { FilesOpenRequest } from "@/components/files-pane";
import { codeServerOpen, codeServerReveal } from "@/lib/code-server";
import { errorMessage, NotInTauri } from "@/lib/errors";

type Phase =
  | { at: "starting" }
  | { at: "live"; url: string }
  | { at: "failed"; detail: string }
  | { at: "browser" };

export function CodeServerPane({
  dir,
  openRequest,
}: {
  dir: string;
  openRequest?: FilesOpenRequest;
}) {
  const [phase, setPhase] = useState<Phase>({ at: "starting" });
  const latestRequest = useRef(openRequest);
  latestRequest.current = openRequest;
  // The request the pane mounts with rides the workbench URL, so the file is open by the
  // time the workbench is. Every later one goes to the running workbench instead: a URL
  // change would be a reload.
  const servedByUrl = useRef<FilesOpenRequest | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    setPhase({ at: "starting" });
    const initial = latestRequest.current;
    servedByUrl.current = initial;
    void codeServerOpen(dir, initial?.path ?? null, initial?.line ?? null).then((r) => {
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

  const live = phase.at === "live";
  useEffect(() => {
    if (!live || !openRequest || openRequest === servedByUrl.current) return;
    void codeServerReveal(dir, openRequest.path, openRequest.line).then((r) => {
      if (r.isErr()) toast.error(`Couldn't open ${openRequest.path} — ${errorMessage(r.error)}`);
    });
  }, [dir, live, openRequest]);

  if (phase.at === "live") {
    return (
      // oxlint-disable-next-line react/iframe-missing-sandbox
      <iframe
        key={phase.url}
        src={phase.url}
        title="VS Code"
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
