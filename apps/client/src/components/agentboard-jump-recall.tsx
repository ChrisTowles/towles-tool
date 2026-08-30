import { useEffect } from "react";
import { X } from "lucide-react";
import type { JumpRecall } from "@/lib/jump-recall";
import { cn } from "@/lib/utils";

/** Long enough to read a sentence, short enough to never become furniture. */
const DWELL_MS = 7000;

/** The reminder after a keyboard jump: which checkout you landed in and what
 * was happening here. Deliberately not an overlay — nothing behind it dims,
 * and only the dismiss button takes the pointer, so the terminal underneath
 * stays clickable while it shows. */
export function JumpRecallCard({
  recall,
  onDismiss,
}: {
  recall: JumpRecall;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onDismiss, DWELL_MS);
    return () => clearTimeout(t);
  }, [recall.nonce, onDismiss]);

  const facts = [recall.waiting, recall.work, recall.lastWorked].filter(Boolean);
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-30 flex justify-center px-3">
      <div
        key={recall.nonce}
        className={cn(
          "pointer-events-none flex max-w-md min-w-64 animate-in flex-col gap-1 rounded-lg border bg-card/95 px-3 py-2 shadow-lg backdrop-blur-sm duration-200 fade-in-0 slide-in-from-top-2",
          // Amber outranks the violet focus accent when the pane is one that
          // flagged you down — the same order the rail rows keep.
          recall.errored || recall.waiting ? "border-amber-500/70" : "border-violet-500/60",
        )}
      >
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            <span className="text-violet-500">✦</span> {recall.title}
          </span>
          <span className="truncate font-mono text-[10.5px] text-muted-foreground">
            {recall.repo}
          </span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={onDismiss}
            className="pointer-events-auto ml-auto shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </div>
        {recall.said && (
          <span className="line-clamp-2 text-xs leading-snug text-muted-foreground">
            {recall.said}
          </span>
        )}
        <div className="flex flex-wrap items-center gap-x-2 font-mono text-[10.5px] text-muted-foreground/80">
          <span className="truncate">{recall.branch}</span>
          {facts.map((fact) => (
            <span
              key={fact}
              className={cn(
                "before:mr-2 before:text-muted-foreground/40 before:content-['·']",
                fact === recall.waiting && "text-amber-500",
              )}
            >
              {fact}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
