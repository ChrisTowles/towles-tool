import { type ComponentProps, type ReactNode } from "react";
import { XIcon } from "@phosphor-icons/react";
import { Button, Tooltip } from "@cloudflare/kumo";
import { ShortcutBadge } from "@/components/hint";
import { mouseAction } from "@/lib/shortcut-coach";
import { shortcutAria, shortcutHint } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

/** Shared atoms for the Agentboard rail rows, folder headers, pane chrome and
 * working-context band, so each surface composes the same pieces. */

/** `title` is a Kumo tooltip, not a native one, which a WebKitGTK webview
 * renders unreliably; it doubles as the `aria-label`. */
export function IconBtn({
  title,
  shortcut,
  onClick,
  className,
  ghost = false,
  children,
  ...props
}: {
  title: string;
  /** Registry id of the binding this duplicates. The click scores itself as a
   * passed-up keystroke, so a caller passing this must not also `mouseAction`. */
  shortcut?: string;
  onClick: () => void;
  className?: string;
  ghost?: boolean;
  children: ReactNode;
} & Omit<ComponentProps<"button">, "onClick" | "title" | "children">) {
  return (
    <Tooltip
      side="bottom"
      content={
        <>
          {title}
          {shortcut && <ShortcutBadge id={shortcut} />}
        </>
      }
      render={
        <Button
          variant={ghost ? "ghost" : "outline"}
          size="xs"
          shape="square"
          aria-label={title}
          aria-keyshortcuts={shortcut ? shortcutAria(shortcut) : undefined}
          onClick={(e) => {
            e.stopPropagation();
            // Every `IconBtn` is an agentboard atom, so that is the scoring screen.
            if (shortcut) mouseAction(shortcut, "agentboard");
            onClick();
          }}
          className={cn("font-mono text-xs text-kumo-subtle", className)}
          {...props}
        >
          {children}
        </Button>
      }
    />
  );
}

/** ✦ for an agent session, ❯ for a plain shell. */
export function Glyph({ agent }: { agent: boolean }) {
  return (
    <span
      className={cn(
        "w-4 shrink-0 text-center font-mono text-xs",
        agent ? "text-agent" : "text-kumo-subtle",
      )}
    >
      {agent ? "✦" : "❯"}
    </span>
  );
}

/** The jump number a row answers to while the chord is held. Takes {@link Glyph}'s
 * own 16px column rather than adding one, so revealing the numbers across the
 * rail never reflows a single row. */
export function HotkeyBadge({ n }: { n: number }) {
  return (
    <span
      aria-label={`jump key ${n}`}
      className="w-4 shrink-0 rounded-[3px] border border-agent/60 bg-agent/10 text-center font-mono text-micro leading-4 text-agent"
    >
      {n}
    </span>
  );
}

/** A gone folder, or a crashed shell (`detail` + `tone="alert"`). Removal is the
 * only affordance on purpose — restarting is the rail's job. */
export function PanePlaceholder({
  label,
  focused = false,
  onRemove,
}: {
  label: string;
  /** See the focus-ring rule at `screens/agentboard.tsx`'s `focusedPaneId`. */
  focused?: boolean;
  onRemove: () => void;
}) {
  return (
    <div
      className={cn(
        "flex h-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-kumo-subtle",
        focused && "border-agent/60",
      )}
    >
      <span className="text-sm">{label}</span>
      <button
        type="button"
        onClick={() => {
          // Only the focused tile is the chord's twin — see `PaneHeader`'s `focused`.
          if (focused) mouseAction("ab-close-pane", "agentboard");
          onRemove();
        }}
        className="flex items-center gap-1 font-mono text-xs hover:text-info"
      >
        <XIcon className="size-3" /> close pane {focused && shortcutHint("ab-close-pane")}
      </button>
    </div>
  );
}
