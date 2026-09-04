import { useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EMOJI_GROUPS, QUICK_REACTIONS, emojiChar, searchEmoji } from "@/lib/emoji";
import { cn } from "@/lib/utils";

/** Emoji picker popover. `onPick` receives a bare Slack shortcode, which is what
 * `reactions.add` takes — the character never leaves this file. */
export function EmojiPicker({
  trigger,
  onPick,
  align = "start",
}: {
  trigger: ReactNode;
  onPick: (shortcode: string) => void;
  align?: "start" | "center" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  function pick(shortcode: string) {
    setOpen(false);
    setQuery("");
    onPick(shortcode);
  }

  const hits = searchEmoji(query);
  const groups = query.trim() ? [{ name: "Results", entries: hits }] : EMOJI_GROUPS;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align={align} className="w-72 p-0">
        <div className="border-b border-border p-2">
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search emoji…"
            className="h-8 text-xs"
          />
        </div>
        {!query.trim() && (
          <div className="flex gap-1 border-b border-border px-2 py-1.5">
            {QUICK_REACTIONS.map((name) => (
              <EmojiButton key={name} name={name} onPick={pick} />
            ))}
          </div>
        )}
        <ScrollArea className="h-56">
          <div className="p-2">
            {groups.map((group) => (
              <div key={group.name} className="mb-2 last:mb-0">
                <div className="px-1 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                  {group.name}
                </div>
                <div className="grid grid-cols-8 gap-0.5">
                  {group.entries.map(([name]) => (
                    <EmojiButton key={name} name={name} onPick={pick} />
                  ))}
                </div>
              </div>
            ))}
            {query.trim() && hits.length === 0 && (
              <p className="px-1 py-4 text-center text-xs text-muted-foreground">
                No emoji match “{query.trim()}”.
              </p>
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

function EmojiButton({ name, onPick }: { name: string; onPick: (name: string) => void }) {
  const char = emojiChar(name);
  if (!char) return null;
  return (
    <button
      type="button"
      title={`:${name}:`}
      onClick={() => onPick(name)}
      className={cn(
        "flex size-7 items-center justify-center rounded font-emoji text-base",
        "hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
      )}
    >
      {char}
    </button>
  );
}
