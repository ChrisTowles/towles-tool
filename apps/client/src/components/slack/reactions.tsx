import { SmileyIcon } from "@phosphor-icons/react";
import { emojiChar } from "@/lib/emoji";
import { cn } from "@/lib/utils";
import type { DmReaction } from "@/lib/slack";
import { EmojiPicker } from "./emoji-picker";

/** The reaction row under a bubble. A chip I'm part of is toggled on and clicking
 * it removes mine; the trailing picker adds a new one. A shortcode outside the
 * bundled map (a custom workspace emoji) renders as its literal `:name:`. */
export function Reactions({
  reactions,
  onToggle,
  align,
}: {
  reactions: DmReaction[];
  onToggle: (name: string, add: boolean) => void;
  align: "start" | "end";
}) {
  if (reactions.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-1 px-1", align === "end" && "justify-end")}>
      {reactions.map((r) => (
        <Chip key={r.name} reaction={r} onToggle={onToggle} />
      ))}
      <EmojiPicker
        align={align}
        onPick={(name) => onToggle(name, true)}
        trigger={
          <button
            type="button"
            title="Add reaction"
            className="flex h-[22px] items-center rounded-full border border-border bg-card px-1.5 text-muted-foreground hover:bg-muted"
          >
            <SmileyIcon className="size-3" />
          </button>
        }
      />
    </div>
  );
}

function Chip({
  reaction,
  onToggle,
}: {
  reaction: DmReaction;
  onToggle: (name: string, add: boolean) => void;
}) {
  const char = emojiChar(reaction.name);
  return (
    <button
      type="button"
      title={`:${reaction.name}:`}
      onClick={() => onToggle(reaction.name, !reaction.mine)}
      className={cn(
        "flex h-[22px] items-center gap-1 rounded-full border px-1.5 text-mini tabular-nums transition-colors",
        reaction.mine
          ? "border-agent/50 bg-agent/15 text-agent"
          : "border-border bg-card text-muted-foreground hover:bg-muted",
      )}
    >
      <span className={cn(char ? "font-emoji text-caption leading-none" : "font-mono text-micro")}>
        {char ?? `:${reaction.name}:`}
      </span>
      <span>{reaction.count}</span>
    </button>
  );
}
