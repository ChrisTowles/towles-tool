import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { withHint } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

/** A pill shown only while zen focus mode is on, so hidden chrome is never
 * mysterious. It must stay **bottom**-right: with the header hidden, each screen's
 * trailing action cluster slides to y=0, where this clipped badges and ate clicks. */
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
      title={`${withHint("Exit zen focus mode", "zen")} or Esc`}
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
