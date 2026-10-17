import { NEW_DIVIDER_ATTR } from "@/components/slack/use-pin-to-bottom";

/** A hairline with "New" above the first message that arrived while you were away. */
export function NewDivider() {
  const marker = { [NEW_DIVIDER_ATTR]: "" };
  return (
    <div
      role="separator"
      aria-label="New messages"
      className="flex items-center gap-2 py-1"
      {...marker}
    >
      <span className="h-px flex-1 bg-info/40" />
      <span className="font-mono text-mini font-medium text-info">New</span>
      <span className="h-px flex-1 bg-info/40" />
    </div>
  );
}
