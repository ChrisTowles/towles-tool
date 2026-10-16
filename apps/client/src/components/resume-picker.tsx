import { useEffect, useMemo, useRef, useState } from "react";
import { FolderIcon } from "@phosphor-icons/react";

import { Button, Checkbox, Dialog } from "@cloudflare/kumo";
import { ScrollArea } from "@/components/ui/scroll-area";
import { requestOpenSession, resumeCandidates } from "@/lib/agentboard/requests";
import { DEFAULT_AUTO_RESUME, loadUserSettings } from "@/lib/settings";
import { invoke } from "@/lib/tauri";
import { toast } from "@/lib/toast";
import { uiAction } from "@/lib/ui-action";
import type { ResumeCandidate } from "@/lib/agentboard/requests";
import { fmtAge } from "@/lib/data";
import { useWorkspace } from "@/lib/workspace";
import { cn } from "@/lib/utils";

/** Relaunches the Claude sessions from the previous run (`claude --resume`) —
 * all of them, unasked, unless `agentboard.autoResume` is off, when it asks which.
 * `tt_agentboard::resume` decides *whether* there is anything, so this mounts
 * unconditionally and stays invisible when there's nothing to offer. */
export function ResumePicker() {
  const [candidates, setCandidates] = useState<ResumeCandidate[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  const settled = useRef(false);
  const { openTab } = useWorkspace();

  useEffect(() => {
    void (async () => {
      const found = (await resumeCandidates()).unwrapOr([]);
      if (found.length === 0) return;
      const auto = (await loadUserSettings())?.agentboard?.autoResume ?? DEFAULT_AUTO_RESUME;
      if (auto) {
        settled.current = true;
        relaunch(found, openTab);
        uiAction("resume.auto", "agentboard", String(found.length));
        toast.info(
          found.length === 1
            ? "Resumed 1 Claude session"
            : `Resumed ${found.length} Claude sessions`,
        );
        return;
      }
      setCandidates(found);
      setChosen(new Set(found.map((c) => c.paneId)));
      setOpen(true);
    })();
  }, [openTab]);

  function toggle(paneId: string) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (!next.delete(paneId)) next.add(paneId);
      return next;
    });
  }

  // Whatever isn't relaunched now is gone: its shell died with the last run,
  // and a dead shell is not a row the rail keeps.
  // Once only, so a close event after Resume can't retire what was picked.
  function settle(picked: ReadonlySet<string>) {
    setOpen(false);
    if (settled.current) return;
    settled.current = true;
    for (const c of candidates) {
      if (!picked.has(c.paneId)) void invoke("ab_close_session", { id: c.paneId });
    }
  }

  function resume() {
    const picked = candidates.filter((c) => chosen.has(c.paneId));
    settle(chosen);
    uiAction("resume.picked", "agentboard", String(picked.length));
    relaunch(picked, openTab);
  }

  const now = Date.now();
  const byFolder = useMemo(() => {
    const m = new Map<string, ResumeCandidate[]>();
    for (const c of candidates) m.set(c.folderDir, [...(m.get(c.folderDir) ?? []), c]);
    return m;
  }, [candidates]);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? setOpen(true) : settle(new Set()))}>
      <Dialog size="lg" className="flex flex-col gap-4 p-6">
        <div className="flex flex-col gap-1.5">
          <Dialog.Title className="text-lg font-semibold">Resume your sessions?</Dialog.Title>
          <Dialog.Description className="text-sm text-kumo-subtle">
            These panes were running Claude when Towles Tool last closed — pick the ones to relaunch
            with <span className="font-mono text-xs">claude --resume</span>.
          </Dialog.Description>
        </div>

        <ScrollArea className="max-h-80 -mx-2 px-2">
          {[...byFolder].map(([dir, list]) => (
            <div key={dir} className="mb-3 last:mb-0">
              <div className="flex items-center gap-2 border-b border-kumo-hairline px-1 pb-1">
                <FolderIcon className="size-3.5 text-kumo-subtle" />
                <span className="truncate font-medium text-kumo-subtle text-caption">
                  {folderLabel(dir)}
                </span>
              </div>
              {list.map((c) => {
                const picked = chosen.has(c.paneId);
                return (
                  // A wrapping `<label>`, not `<button>`: the Checkbox renders
                  // a button and buttons can't nest. See apps/client/CLAUDE.md.
                  <label
                    key={c.paneId}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2.5 rounded-md py-2 pr-2 pl-3 text-left",
                      "hover:bg-kumo-tint",
                      picked && "bg-kumo-tint",
                    )}
                  >
                    <Checkbox
                      aria-label={c.title ?? c.paneName}
                      checked={picked}
                      onCheckedChange={() => toggle(c.paneId)}
                    />
                    <span className="w-4 text-center font-mono text-agent text-xs">✦</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-caption text-kumo-default">
                        {c.title ?? c.paneName}
                      </span>
                      <span className="block truncate font-mono text-mini text-kumo-subtle">
                        {c.paneName}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono text-mini text-kumo-subtle">
                      {fmtAge(c.lastActiveMs, now)}
                    </span>
                  </label>
                );
              })}
            </div>
          ))}
        </ScrollArea>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => settle(new Set())}>
            Don't resume
          </Button>
          <Button variant="primary" onClick={resume} disabled={chosen.size === 0}>
            {chosen.size === 1 ? "Resume 1 session" : `Resume ${chosen.size} sessions`}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}

function relaunch(picked: ResumeCandidate[], openTab: (id: "agentboard") => void) {
  if (picked.length === 0) return;
  // Agentboard owns the pane→PTY machinery, so hand off rather than
  // duplicating it. It may not be mounted yet at boot, which is exactly why
  // the open-session bridge stashes a queue (see `requestOpenSession`).
  openTab("agentboard");
  // Oldest first: Agentboard activates each folder as it restores it, so the
  // last one handed over is the one left on screen — that should be the
  // session you were most recently in.
  for (const c of picked.toReversed()) {
    requestOpenSession({
      folderDir: c.folderDir,
      sessionId: c.paneId,
      resumeId: c.claudeSessionId,
      label: c.title ?? c.paneName,
    });
  }
}

/** Last two path segments — enough to tell tasks of one repo apart. */
function folderLabel(dir: string): string {
  return dir.split("/").filter(Boolean).slice(-2).join("/");
}
