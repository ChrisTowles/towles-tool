import { Schema } from "effect";
import { requestAgentboardNav } from "@/lib/agentboard/requests";
import type { RepoData } from "@/lib/agentboard/types";
import { folderForSession } from "@/lib/preview-artifact";
import { subscribe } from "@/lib/run";
import { toast, toastManager } from "@/lib/toast";
import { uiAction } from "@/lib/ui-action";

// Delivery for the MCP `summon` tool: a toast that stays up exactly as long as
// the chime does. Rust owns when it ends — typing into the caller's terminal.

const SummonPayloadSchema = Schema.Struct({
  id: Schema.Number,
  session: Schema.optional(Schema.NullOr(Schema.String)),
  reason: Schema.optional(Schema.NullOr(Schema.String)),
  active: Schema.Boolean,
});

export function subscribeSummon(reposNow: () => RepoData[], onRouted: () => void): () => void {
  const toasts = new Map<number, string>();
  return subscribe(
    "summon://changed",
    ({ id, session, reason, active }) => {
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
        actions:
          folder && session
            ? [
                {
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
                },
              ]
            : undefined,
      });
      toasts.set(id, toastId);
    },
    SummonPayloadSchema,
  );
}
