import { useEffect, useState } from "react";
import { toast } from "@/lib/toast";
import { Dialog, Input } from "@cloudflare/kumo";
import { journalLog, storeAddTask } from "@/lib/data";
import { NotInTauri, type IpcError } from "@/lib/errors";
import { formatLogLine, parseQuickLog } from "@/lib/quick-log-format";
import { useWorkspace } from "@/lib/workspace";
import { uiAction } from "@/lib/ui-action";

/** Surface a failed capture. Browser dev gets the "not wired" note rather than
 * an error, since nothing is actually broken there. */
function reportCaptureError(error: IpcError) {
  if (NotInTauri.is(error)) toast.info("not wired in browser");
  else toast.error(error.message);
}

/** ⌘J quick log: one line into today's journal note, or a Board todo with a
 * leading `/todo ` / `/t `. Opens on the `quicklog:open` window event so the
 * dialog can live anywhere without threading state through the workspace. */
export function QuickLog() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const { activeTab } = useWorkspace();

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("quicklog:open", onOpen);
    return () => window.removeEventListener("quicklog:open", onOpen);
  }, []);

  const parsed = parseQuickLog(text);
  const routesToTodo = parsed.kind === "todo";

  function submit() {
    if (!parsed.body) return;
    uiAction("quick_log.capture", activeTab, routesToTodo ? "todo" : "log");
    if (routesToTodo) {
      // Same add-task path the Board uses — a plain todo in the backlog column.
      void storeAddTask(parsed.body).then((added) =>
        added.match({
          ok: () => {
            toast.success("Added to Board");
          },
          err: reportCaptureError,
        }),
      );
    } else {
      // Reconstruct a timeline bullet — `- HH:MM [context] text` — stamped with the current
      // screen so scattered captures read back as a log. Matches `tt journal jot`'s format
      // so app and CLI entries interleave in the same daily note.
      const line = formatLogLine(parsed.body, { now: new Date(), context: activeTab });
      void journalLog(line).then((logged) =>
        logged.match({
          ok: () => {
            toast.success("Logged");
          },
          err: reportCaptureError,
        }),
      );
    }
    setText("");
    setOpen(false);
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog className="flex flex-col gap-4 p-6">
        <Dialog.Title className="text-lg font-semibold">Quick log</Dialog.Title>
        <Input
          autoFocus
          aria-label="Quick log"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="Log to today's note… (/todo for the Board)"
        />
        <p className="text-xs text-kumo-subtle">{routesToTodo ? "→ Board" : "→ today's note"}</p>
      </Dialog>
    </Dialog.Root>
  );
}
