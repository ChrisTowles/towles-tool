import { useState } from "react";
import { Send, SmilePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { EmojiPicker } from "./emoji-picker";

/** The message composer. Enter sends, Shift+Enter breaks the line; the emoji
 * button inserts a `:shortcode:`, which is what Slack renders on receipt. */
export function Composer({
  placeholder,
  sending,
  onSend,
  compact,
}: {
  placeholder: string;
  sending: boolean;
  onSend: (text: string) => Promise<boolean>;
  compact?: boolean;
}) {
  const [draft, setDraft] = useState("");

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    if (await onSend(text)) setDraft("");
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="flex items-end gap-2">
      <div className="relative flex-1">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={1}
          className="max-h-40 min-h-9 resize-none pr-9"
        />
        <EmojiPicker
          align="end"
          onPick={(name) => setDraft((d) => `${d}${d && !d.endsWith(" ") ? " " : ""}:${name}: `)}
          trigger={
            <button
              type="button"
              title="Insert emoji"
              className="absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <SmilePlus className="size-4" />
            </button>
          }
        />
      </div>
      <Button
        size={compact ? "sm" : "lg"}
        className={cn("gap-1.5 bg-violet-600 text-white hover:bg-violet-600/90", compact && "h-9")}
        onClick={() => void send()}
        disabled={sending || draft.trim().length === 0}
      >
        <Send className="size-3.5" />
        {compact ? "Reply" : "Send"}
      </Button>
    </div>
  );
}
