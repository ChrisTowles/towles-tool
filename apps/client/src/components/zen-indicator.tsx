import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { shortcutHint } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

/**
 * A tiny, unobtrusive pill shown only while zen focus mode is on, so the
 * hidden-chrome state is never mysterious. It stays out of the way: invisible
 * until the pointer moves near the bottom of the window, then fades out again a
 * couple seconds later. Folder-rail styled (muted, bordered, low-contrast).
 *
 * It sits **bottom**-right, over the strip the hidden status bar owned, and not
 * top-right where it used to: every screen's trailing action cluster lives in
 * the content's top-right corner (the Agentboard pane header's badges + kebab,
 * the DM banner's actions, the terminal's overlay controls), and with the app
 * header hidden that cluster slides up to y=0 — directly under this pill, which
 * clipped the badges into unreadable half-words and swallowed clicks on the
 * buttons. Nothing interactive is anchored bottom-right; toasts and the IDE
 * selection chip pass through there, but both are transient like this pill.
 */
export function ZenIndicator({ onExit }: { onExit: () => void }) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    let hideTimer: ReturnType<typeof setTimeout>;
    const arm = () => {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => setVisible(false), 2000);
    };
    const onMove = (e: MouseEvent) => {
      // Only wake near the bottom strip the hidden status bar used to occupy.
      if (e.clientY >= window.innerHeight - 64) {
        setVisible(true);
        arm();
      }
    };
    arm();
    window.addEventListener("mousemove", onMove);
    return () => {
      clearTimeout(hideTimer);
      window.removeEventListener("mousemove", onMove);
    };
  }, []);

  return (
    <button
      type="button"
      onClick={onExit}
      title={`Exit zen focus mode (${shortcutHint("zen")} or Esc)`}
      className={cn(
        "fixed bottom-3 right-3 z-50 flex items-center gap-1.5 rounded-full border bg-background/80 px-2.5 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur transition-opacity duration-500 hover:text-foreground",
        visible ? "opacity-80" : "pointer-events-none opacity-0",
      )}
    >
      <Sparkles className="size-3" />
      Zen
    </button>
  );
}
