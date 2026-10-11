import { z } from "zod";
import { requestAgentboardNav, type RepoData } from "@/lib/agentboard";
import { folderForSession } from "@/lib/preview-artifact";
import { isTauri } from "@/lib/tauri";
import { toast, toastManager } from "@/lib/toast";
import { uiAction } from "@/lib/ui-action";

// Delivery for the MCP `summon` tool: a toast that stays up exactly as long as
// the chime does. Rust owns when it ends — typing into the caller's terminal.

const SummonPayloadSchema = z.object({
  id: z.number(),
  session: z.string().nullish(),
  reason: z.string().nullish(),
  active: z.boolean(),
});

export function subscribeSummon(reposNow: () => RepoData[], onRouted: () => void): () => void {
  if (!isTauri()) return () => {};
  const toasts = new Map<number, string>();
  let unlisten: (() => void) | undefined;
  let cancelled = false;
  void (async () => {
    const { listen } = await import("@tauri-apps/api/event");
    const sub = await listen<unknown>("summon://changed", (event) => {
      const parsed = SummonPayloadSchema.safeParse(event.payload);
      if (!parsed.success) {
        console.error("summon://changed: unexpected payload", parsed.error);
        return;
      }
      const { id, session, reason, active } = parsed.data;
      if (!active) {
        const toastId = toasts.get(id);
        toasts.delete(id);
        if (toastId) toastManager.close(toastId);
        return;
      }
      const folder = folderForSession(reposNow(), session);
      const toastId = toast.info(folder ? `${folder.name} needs you` : "An agent needs you", {
        description: reason ?? undefined,
        timeout: 0,
        action:
          folder && session
            ? {
                label: "Go",
                onClick: () => {
                  uiAction("summon.go", "agentboard");
                  requestAgentboardNav({
                    kind: "session",
                    folderDir: folder.dir,
                    sessionId: session,
                  });
                  onRouted();
                },
              }
            : undefined,
      });
      toasts.set(id, toastId);
    });
    if (cancelled) sub();
    else unlisten = sub;
  })();
  return () => {
    cancelled = true;
    unlisten?.();
  };
}
