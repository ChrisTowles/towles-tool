import { ArrowBendUpLeftIcon, SmileyIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { fmtClock } from "@/lib/data";
import type { DmMessage } from "@/lib/slack";
import { MrkdwnText } from "@/components/mrkdwn-text";
import { Attachments } from "./attachments";
import { EmojiPicker } from "./emoji-picker";
import { Reactions } from "./reactions";

export type BubbleActions = {
  onToggleReaction: (ts: string, name: string, add: boolean) => void;
  /** Absent inside a thread, where every message is already in one. */
  onOpenThread?: (threadTs: string) => void;
};

/** One chat bubble: mine (violet, right) vs. theirs (card, left). Text renders
 * from Slack mrkdwn; hover reveals react/reply-in-thread, and a parent with
 * replies grows a footer that opens the thread. */
export function MessageBubble({
  message,
  watchUserId,
  watchName,
  actions,
}: {
  message: DmMessage;
  watchUserId?: string;
  watchName?: string;
  actions: BubbleActions;
}) {
  const mine = message.fromMe;
  const hasText = message.text.trim().length > 0;
  const threadTs = message.threadTs || message.tsRaw;
  const align = mine ? "end" : "start";

  return (
    <div className={cn("group/msg flex flex-col gap-0.5", mine ? "items-end" : "items-start")}>
      <div className={cn("flex max-w-[85%] items-center gap-1", mine && "flex-row-reverse")}>
        <div
          className={cn(
            "min-w-0 rounded-lg border px-3 py-1.5 text-sm whitespace-pre-wrap",
            mine
              ? "border-agent/30 bg-agent/15 text-foreground"
              : "border-border bg-card text-foreground",
          )}
        >
          {hasText && (
            <MrkdwnText text={message.text} watchUserId={watchUserId} watchName={watchName} />
          )}
          {message.files.length > 0 && <Attachments files={message.files} hasText={hasText} />}
        </div>
        <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
          <EmojiPicker
            align={align}
            onPick={(name) => actions.onToggleReaction(message.tsRaw, name, true)}
            trigger={
              <button type="button" title="Add reaction" className={HOVER_ACTION}>
                <SmileyIcon className="size-3.5" />
              </button>
            }
          />
          {actions.onOpenThread && (
            <button
              type="button"
              title="Reply in thread"
              onClick={() => actions.onOpenThread?.(threadTs)}
              className={HOVER_ACTION}
            >
              <ArrowBendUpLeftIcon className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      <Reactions
        reactions={message.reactions}
        align={align}
        onToggle={(name, add) => actions.onToggleReaction(message.tsRaw, name, add)}
      />

      {message.replyCount > 0 && actions.onOpenThread && (
        <button
          type="button"
          onClick={() => actions.onOpenThread?.(threadTs)}
          className="flex items-center gap-1.5 rounded px-1 py-0.5 text-mini font-medium text-agent hover:bg-agent/10"
        >
          <ArrowBendUpLeftIcon className="size-3" />
          {message.replyCount} {message.replyCount === 1 ? "reply" : "replies"}
          {message.latestReplyTs > 0 && (
            <span className="font-mono text-mini font-normal text-muted-foreground/70">
              last {fmtClock(message.latestReplyTs)}
            </span>
          )}
        </button>
      )}

      <span className="px-1 font-mono text-mini text-muted-foreground/60">
        {fmtClock(message.ts)}
      </span>
    </div>
  );
}

const HOVER_ACTION =
  "flex size-6 items-center justify-center rounded border border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground";
