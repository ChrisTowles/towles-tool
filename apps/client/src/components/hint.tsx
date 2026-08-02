import type { ComponentProps, ReactElement } from "react";
import { Kbd } from "@/components/ui/kbd";
import { shortcutHint } from "@/lib/shortcuts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** The one way anything explains itself on hover: `Hint` for a sentence,
 * `HoverCard` for a real card, no third option — native `title` lands late and
 * unreliably in the WebKitGTK webview. `label` optional: renders the child bare. */
export function Hint({
  label,
  shortcut,
  side = "bottom",
  children,
}: {
  label?: string;
  /** Registry id of the binding this control duplicates — renders as a keycap
   * badge after the label. */
  shortcut?: string;
  side?: ComponentProps<typeof TooltipContent>["side"];
  children: ReactElement;
}) {
  if (!label) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>
        {label}
        {shortcut && <ShortcutBadge id={shortcut} />}
      </TooltipContent>
    </Tooltip>
  );
}

/** The one way a tooltip names a binding: a keycap badge, never chord text
 * spliced into the sentence. `withHint` remains only for the places that can't
 * host an element — prose and the native `title` attribute. */
export function ShortcutBadge({ id }: { id: string }) {
  return <Kbd className="ml-1.5">{shortcutHint(id)}</Kbd>;
}
