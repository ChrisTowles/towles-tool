import { useAtomValue } from "@/lib/atoms/react";
import { CheckIcon, InfoIcon, WarningIcon } from "@phosphor-icons/react";
import { freshHudNoteAtom } from "@/lib/rail-hud";
import { shortcutHint } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

const LEGEND: [id: string, label: string][] = [
  ["ab-new-session", "new session"],
  ["ab-toggle-files", "files"],
  ["ab-remove-task", "delete"],
  ["ab-new-task", "new task"],
];

const TONE_TEXT = { ok: "text-ok", warn: "text-warn", danger: "text-danger" } as const;

/** The rail's status line: what the control under the pointer does, else what
 * the last action did, else the keys. One fixed place, so it never covers the
 * next target the way a tooltip does. */
export function RailHud({
  hovered,
}: {
  /** The text under the pointer or focus, and when it got there. */
  hovered: { text: string; at: number } | null;
}) {
  const fresh = useAtomValue(freshHudNoteAtom);
  // A note newer than the hover wins: the control under a still pointer may
  // be the one the action just removed.
  const hover = hovered && !(fresh && fresh.at > hovered.at) ? hovered.text : null;
  return (
    <div
      aria-live="polite"
      className="flex h-7 shrink-0 items-center gap-2 overflow-hidden border-t border-kumo-hairline px-3 font-mono text-mini whitespace-nowrap text-kumo-subtle"
    >
      {hover ? (
        <>
          <InfoIcon className="size-3 shrink-0" />
          <span className="truncate text-kumo-default">{hover}</span>
        </>
      ) : fresh ? (
        <>
          {fresh.tone === "ok" ? (
            <CheckIcon className="size-3 shrink-0 text-ok" />
          ) : (
            <WarningIcon className={cn("size-3 shrink-0", TONE_TEXT[fresh.tone])} />
          )}
          <span className={cn("truncate", TONE_TEXT[fresh.tone])}>{fresh.text}</span>
        </>
      ) : (
        LEGEND.map(([id, label]) => (
          <span key={id} className="shrink-0">
            <span className="text-kumo-default">{shortcutHint(id)}</span> {label}
          </span>
        ))
      )}
    </div>
  );
}
