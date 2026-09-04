import { useEffect, useRef } from "react";
import { Check, MessageCircleHeart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { dmsNeedingAttention, fmtAge, storeDmDismiss, useStoreSnapshot } from "@/lib/data";
import { useNow } from "@/lib/now";
import { openExternalUrl } from "@/lib/open-url";
import { isTauri } from "@/lib/tauri";
import { uiAction } from "@/lib/ui-action";
import { useWorkspace } from "@/lib/workspace";

/** Unanswered this long → the fill deepens and the age turns into a chip. */
const WARN_MS = 5 * 60_000;
/** Unanswered this long → the banner pulses and the OS taskbar flashes. */
const ALARM_MS = 10 * 60_000;

/** Full-width strip for a watched Slack DM (the `slack:dm` collector), in the
 * app-wide needs-you amber. Clears itself when you reply in Slack (the collector
 * sees your message as the newest) or on "Handled". */
export function DmBanner() {
  const { snapshot } = useStoreSnapshot();
  const { openTab } = useWorkspace();
  const now = useNow();
  // The message ts we already flashed the taskbar for — flash once per message.
  const flashedTs = useRef(0);

  const pending = dmsNeedingAttention(snapshot);
  const dm = pending[0];
  const age = dm ? now - dm.ts : 0;
  const alarm = !!dm && age >= ALARM_MS;
  const warn = !!dm && age >= WARN_MS;

  useEffect(() => {
    if (!alarm || !dm || flashedTs.current === dm.ts || !isTauri()) return;
    flashedTs.current = dm.ts;
    void (async () => {
      try {
        const { getCurrentWindow, UserAttentionType } = await import("@tauri-apps/api/window");
        await getCurrentWindow().requestUserAttention(UserAttentionType.Critical);
      } catch {
        // Best-effort: the in-app pulse still carries the escalation.
      }
    })();
  }, [alarm, dm]);

  if (!dm) return null;

  const reply = (via: string) => {
    uiAction("dm_banner.reply", "slack", via);
    openTab("slack");
  };

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-1 border-b border-l-4 border-l-amber-500",
        "bg-amber-500/10 py-1.5 pr-2 pl-2 text-sm",
        warn && "bg-amber-500/20",
        alarm && "bg-amber-500/35",
      )}
    >
      {/* The identity cluster is the click target; the actions are siblings, so
          nothing interactive nests inside a button. */}
      <button
        type="button"
        onClick={() => reply("banner")}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-amber-500/25 focus-visible:ring-2 focus-visible:ring-amber-500/60 focus-visible:outline-none"
      >
        {/* Only the glyph pulses at alarm: pulsing the strip fades the words
            you most need to read. */}
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-full bg-amber-500/30 text-amber-700 dark:text-amber-300",
            alarm && "animate-pulse bg-amber-500 text-amber-950 dark:text-amber-950",
          )}
        >
          <MessageCircleHeart className="size-4" />
        </span>
        <span className="shrink-0 font-semibold text-foreground">{dm.fromName}</span>
        <span className="min-w-0 truncate text-foreground/75">{dm.text}</span>
        <span
          className={cn(
            "shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[11px] text-foreground/60",
            warn && "bg-amber-500/30 font-medium text-amber-700 dark:text-amber-300",
            alarm && "bg-amber-500 text-amber-950",
          )}
        >
          {fmtAge(dm.ts, now)}
        </span>
        {pending.length > 1 && (
          <span className="shrink-0 font-mono text-[11px] text-foreground/60">
            +{pending.length - 1} more
          </span>
        )}
      </button>

      <Button
        size="xs"
        className="shrink-0 bg-amber-500 font-semibold text-amber-950 hover:bg-amber-400"
        onClick={() => reply("button")}
      >
        Reply
      </Button>
      {dm.url && (
        <Button
          variant="ghost"
          size="xs"
          className="shrink-0 text-foreground/70"
          onClick={() => {
            uiAction("dm_banner.open_slack", "slack");
            void openExternalUrl(dm.url!);
          }}
        >
          Open in Slack
        </Button>
      )}
      <Button
        variant="ghost"
        size="xs"
        className="shrink-0 text-foreground/70"
        onClick={() => {
          uiAction("dm_banner.dismiss", "slack");
          void storeDmDismiss(dm.channel, dm.ts);
        }}
      >
        <Check className="size-3.5" />
        Handled
      </Button>
    </div>
  );
}
