import { useCallback, useState } from "react";
import { MessageCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { isAuthError, isScopeError, slackDmReact, slackDmSend, useSlackDm } from "@/lib/slack";
import { uiAction } from "@/lib/ui-action";
import { Composer } from "@/components/slack/composer";
import { MessageBubble } from "@/components/slack/message-bubble";
import { AppManifestDialog, FetchError, SetupGuide } from "@/components/slack/setup-guide";
import { ThreadPanel } from "@/components/slack/thread-panel";
import { usePinToBottom } from "@/components/slack/use-pin-to-bottom";

/** Messages — the chat panel for the one watched Slack DM. Ignores the
 * collector's `enabled` flag, so it works with the watcher off; the list is
 * top-level only, and a parent's replies live behind the thread panel. */
export function SlackScreen() {
  const { view, loading, error, revision, refresh } = useSlackDm();
  const [sending, setSending] = useState(false);
  const [openThread, setOpenThread] = useState<string | null>(null);

  const messages = view?.messages ?? [];
  const showThread = (view?.configured ?? true) && !(error && messages.length === 0);
  const { viewportRef, listRef, composerRef, repin } = usePinToBottom(showThread);

  const send = useCallback(
    async (text: string, threadTs?: string) => {
      uiAction(threadTs ? "slack.reply_in_thread" : "slack.send", "slack");
      // Sending is an explicit "I'm at the end of this thread".
      if (!threadTs) repin();
      setSending(true);
      const sent = await slackDmSend(text, threadTs);
      setSending(false);
      return sent.match({
        ok: () => {
          refresh();
          return true;
        },
        err: (e) => {
          toast.error(writeErrorMessage(e.message, "send"));
          return false;
        },
      });
    },
    [refresh, repin],
  );

  const toggleReaction = useCallback(
    (ts: string, name: string, add: boolean) => {
      uiAction(add ? "slack.react" : "slack.unreact", "slack");
      void slackDmReact(ts, name, add).then((done) =>
        done.match({
          ok: refresh,
          err: (e) => toast.error(writeErrorMessage(e.message, "react")),
        }),
      );
    },
    [refresh],
  );

  const watchName = view?.watchName?.trim() || "Slack DM";

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-2.5 border-b border-border bg-card px-4 py-2.5">
        <MessageCircle className="size-4 text-violet-500" />
        <span className="font-semibold text-foreground">{watchName}</span>
        {view?.configured && (
          <span className="font-mono text-[11px] text-muted-foreground/60">direct message</span>
        )}
        <div className="flex-1" />
        {view?.configured && <AppManifestDialog />}
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 px-2 text-muted-foreground"
          onClick={() => {
            uiAction("slack.refresh", "slack");
            refresh();
          }}
          disabled={loading}
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
          Refresh
        </Button>
      </header>

      {view && !view.configured ? (
        <SetupGuide />
      ) : error && messages.length === 0 ? (
        <FetchError error={error} onRetry={refresh} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <ScrollArea className="min-h-0 flex-1" viewportRef={viewportRef}>
              <div
                ref={listRef}
                className="mx-auto flex w-full max-w-2xl flex-col gap-1.5 px-4 py-4"
              >
                {messages.length === 0 && !loading && (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No messages yet. Say hello below.
                  </p>
                )}
                {messages.map((m, i) => (
                  <MessageBubble
                    key={m.tsRaw || `${m.ts}-${i}`}
                    message={m}
                    watchUserId={view?.watchUserId}
                    watchName={view?.watchName}
                    actions={{ onToggleReaction: toggleReaction, onOpenThread: setOpenThread }}
                  />
                ))}
              </div>
            </ScrollArea>

            <div ref={composerRef} className="shrink-0 border-t border-border bg-card px-4 py-3">
              <div className="mx-auto w-full max-w-2xl">
                <Composer
                  placeholder={`Message ${watchName}…`}
                  sending={sending}
                  onSend={(text) => send(text)}
                />
              </div>
            </div>
          </div>

          {openThread && (
            <ThreadPanel
              threadTs={openThread}
              watchName={watchName}
              watchUserId={view?.watchUserId}
              revision={revision}
              sending={sending}
              onClose={() => setOpenThread(null)}
              onReply={(text) => send(text, openThread)}
              onToggleReaction={toggleReaction}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Slack's raw error, mapped to the fix the user can act on. */
function writeErrorMessage(message: string, kind: "send" | "react"): string {
  if (isAuthError(message)) {
    return "Slack rejected that: your token is no longer valid. Re-issue it in Settings → Slack.";
  }
  if (isScopeError(message)) {
    const scope = kind === "send" ? "chat:write" : "reactions:write";
    return `Slack rejected that: re-authorize your token with the ${scope} scope, then try again.`;
  }
  return message;
}
