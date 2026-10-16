import { z } from "zod";
import { isTauri } from "@/lib/tauri";
import { toast } from "@/lib/toast";

// Rust closes a landed, idle task on its own; this only says so.

const AutoClosedSchema = z.object({ title: z.string(), folderDir: z.string() });

export function subscribeAutoClosed(): () => void {
  if (!isTauri()) return () => {};
  let unlisten: (() => void) | undefined;
  let cancelled = false;
  void (async () => {
    const { listen } = await import("@tauri-apps/api/event");
    const sub = await listen<unknown>("task://auto-closed", (event) => {
      const parsed = AutoClosedSchema.safeParse(event.payload);
      if (!parsed.success) {
        console.error("task://auto-closed: unexpected payload", parsed.error);
        return;
      }
      toast.success(`Closed “${parsed.data.title}”`, {
        description: "Its work landed, so the task closed as done.",
      });
    });
    if (cancelled) sub();
    else unlisten = sub;
  })();
  return () => {
    cancelled = true;
    unlisten?.();
  };
}
