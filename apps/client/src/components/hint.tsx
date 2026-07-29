/**
 * `Hint` — the app's one hover-explanation primitive.
 */
import type { ComponentProps, ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** The one way anything in the rail or the working-context header explains
 * itself on hover.
 *
 * There were three idioms on screen at once: the native `title` attribute, the
 * Radix tooltip `IconBtn` already used, and `HoverCard`. Native `title` is the
 * odd one out and not merely as a style — it is the OS's, so it appears after a
 * ~1s delay the styled ones don't have, in a different place, with different
 * type, and in the WebKitGTK webview it is unreliable besides. Two buttons
 * sitting next to each other in the same toolbar behaved differently, which is
 * exactly what made the header feel inconsistent. So: `Hint` (this) for a
 * sentence of text, `HoverCard` when the content is a real card with structure
 * or its own controls, and no third option.
 *
 * `label` is optional so a conditional hint (`humanTitle ? … : undefined`) can
 * stay conditional at the call site — with none, the child renders bare rather
 * than inside a tooltip that would open empty. */
export function Hint({
  label,
  side = "bottom",
  children,
}: {
  label?: string;
  side?: ComponentProps<typeof TooltipContent>["side"];
  children: ReactElement;
}) {
  if (!label) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}
