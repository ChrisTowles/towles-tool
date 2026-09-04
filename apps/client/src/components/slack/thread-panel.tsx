import { useCallback, useEffect, useState } from "react";
import { MessagesSquare, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { errorMessage } from "@/lib/errors";
import { slackDmThread, type DmMessage } from "@/lib/slack";
import { Composer } from "./composer";
import { MessageBubble, type BubbleActions } from "./message-bubble";
import { usePinToBottom } from "./use-pin-to-bottom";

/** One thread beside the conversation, with a composer that posts back into the
 * same `thread_ts`. Refetches on every `revision` bump — the screen ticks it on
 * each store snapshot, so a reply arriving over the socket lands here too. */
export function ThreadPanel({
  threadTs,
  watchName,
  watchUserId,
  revision,
  sending,
  onClose,
  onReply,
  onToggleReaction,
}: {
  threadTs: string;
  watchName: string;
  watchUserId?: string;
  revision: number;
  sending: boolean;
  onClose: () => void;
  onReply: (text: string) => Promise<boolean>;
  onToggleReaction: BubbleActions["onToggleReaction"];
}) {
  const [messages, setMessages] = useState<DmMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { viewportRef, listRef, composerRef, repin } = usePinToBottom(error === null);

  const load = useCallback(async () => {
    const loaded = await slackDmThread(threadTs);
    loaded.match({
      ok: (next) => {
        setMessages(next);
        setError(null);
      },
      err: (e) => setError(errorMessage(e)),
    });
    setLoading(false);
  }, [threadTs]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load, revision]);

  const replies = Math.max(messages.length - 1, 0);

  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-border bg-background">
      <header className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2.5">
        <MessagesSquare className="size-4 text-violet-500" />
        <span className="text-sm font-semibold text-foreground">Thread</span>
        <span className="font-mono text-[11px] text-muted-foreground/60">
          {replies} {replies === 1 ? "reply" : "replies"}
        </span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="size-7 p-0 text-muted-foreground"
          onClick={onClose}
          aria-label="Close thread"
        >
          <X className="size-4" />
        </Button>
      </header>

      {error ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="max-w-full text-center text-[13px] break-words text-muted-foreground">
            {error}
          </p>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1" viewportRef={viewportRef}>
          <div ref={listRef} className="flex flex-col gap-1.5 px-3 py-3">
            {loading && messages.length === 0 && (
              <p className="py-6 text-center text-xs text-muted-foreground">Loading thread…</p>
            )}
            {messages.map((m, i) => (
              <div key={m.tsRaw || i}>
                <MessageBubble
                  message={m}
                  watchUserId={watchUserId}
                  watchName={watchName}
                  actions={{ onToggleReaction }}
                />
                {i === 0 && replies > 0 && (
                  <div className="my-2 flex items-center gap-2">
                    <div className="h-px flex-1 bg-border" />
                    <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
                      {replies} {replies === 1 ? "reply" : "replies"}
                    </span>
                    <div className="h-px flex-1 bg-border" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </ScrollArea>
      )}

      <div ref={composerRef} className="shrink-0 border-t border-border bg-card px-3 py-2.5">
        <Composer
          compact
          placeholder={`Reply to ${watchName}…`}
          sending={sending}
          onSend={(text) => {
            repin();
            return onReply(text);
          }}
        />
      </div>
    </aside>
  );
}
