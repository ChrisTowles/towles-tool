// The note box: words for an agent, read at its next step instead of typed into its
// terminal. Mounted once at the root; a session row's menu or Mod+Shift+M opens it.
import { useEffect, useState } from "react";
import { Button, Dialog, InputArea } from "@cloudflare/kumo";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react";
import { errorMessage } from "@/lib/errors";
import {
  NOT_LISTENING_HINT,
  closeNoteDialog,
  inboxSend,
  isListening,
  useInbox,
  useNoteDialog,
} from "@/lib/inbox";
import { toast } from "@/lib/toast";
import { uiAction } from "@/lib/ui-action";

export function NoteDialog() {
  const target = useNoteDialog();
  const inbox = useInbox();
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  useEffect(() => setBody(""), [target?.sessionId]);
  const listening = target ? isListening(inbox, target.sessionId) : false;

  async function send() {
    if (!target || !body.trim()) return;
    setSending(true);
    const sent = await inboxSend(target.sessionId, body, [], false);
    setSending(false);
    uiAction("agentboard.note.send", "agentboard", sent.isOk() ? "ok" : "err");
    sent.match({
      ok: () => {
        toast.success(`Note queued for ${target.label}`);
        closeNoteDialog();
      },
      err: (e) => toast.error(`Note not sent: ${errorMessage(e)}`),
    });
  }

  return (
    <Dialog.Root open={target != null} onOpenChange={(open) => !open && closeNoteDialog()}>
      <Dialog size="base" className="flex flex-col gap-3 p-5">
        <Dialog.Title className="flex items-center gap-2 text-base font-semibold">
          <EnvelopeSimpleIcon className="size-4" />
          Note to {target?.label}
        </Dialog.Title>
        <Dialog.Description className="text-sm text-kumo-subtle">
          {listening
            ? "Read at the agent's next step if it is working, or sent as your prompt if it is idle."
            : NOT_LISTENING_HINT}
        </Dialog.Description>
        <InputArea
          aria-label="Note"
          autoFocus
          value={body}
          disabled={!listening}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
          }}
          placeholder="Also handle the empty state…"
          rows={3}
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={closeNoteDialog}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!listening || sending || !body.trim()}
            onClick={() => void send()}
          >
            {sending ? "Sending…" : "Send"}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
