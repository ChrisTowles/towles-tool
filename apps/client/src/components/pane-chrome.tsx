import type { ReactNode } from "react";
import { AppWindow, Box, Files as FilesIcon, GitCompare, Globe } from "lucide-react";
import { cn } from "@/lib/utils";

/** One header row for every pane kind. **The lens leads, the subject follows, the
 * folder never appears** — a window is scoped to one checkout. Type is carried by
 * shape and words, never hue: violet and amber mean focused and needs-you. */
export function PaneChrome({
  lens,
  subject,
  subjectTitle,
  controls,
  center,
  actions,
}: {
  /** The lens chip, plus any marker the kind owns (a session's status `Dot`). */
  lens: ReactNode;
  /** What is unique to *this* pane: the baseline, the file, the URL, the label. */
  subject?: ReactNode;
  /** Hover text for a subject the row is likely to truncate (a long path). */
  subjectTitle?: string;
  /** Controls inline with the subject rather than in the trailing cluster. */
  controls?: ReactNode;
  /** One control given the middle of the row. Passing it switches the row to a
   * `1fr auto 1fr` grid so the target stays put as the subject's width changes;
   * the flex layout is kept for panes whose subject needs the whole row. */
  center?: ReactNode;
  /** Trailing icon buttons, right-aligned. */
  actions: ReactNode;
}) {
  const leading = (
    <>
      {lens}
      {subject != null && (
        <>
          <span className="h-3 w-px shrink-0 bg-border" aria-hidden="true" />
          {/* `flex-1` so the subject claims the row's leftover width. Without it
           * a `min-w-0 truncate` span beside `shrink-0` controls is the first
           * thing a narrow pane collapses, down to zero width. */}
          <span
            className="min-w-0 flex-1 truncate font-mono text-xs text-foreground"
            title={subjectTitle}
          >
            {subject}
          </span>
        </>
      )}
      {controls}
    </>
  );
  const row = "shrink-0 items-center gap-2 border-b bg-card px-2 py-1";
  if (center == null) {
    return (
      <div className={cn("flex", row)}>
        {leading}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</span>
      </div>
    );
  }
  return (
    <div className={cn("grid grid-cols-[1fr_auto_1fr]", row)}>
      {/* No `min-w-0` on the side columns, deliberately: it would let a column
       * shrink past its own chips, and since those are `shrink-0` they'd
       * spill *under* the centered slot — the same overlap absolute
       * positioning caused. Leaving `min-width: auto` makes a cramped row push
       * the center aside instead. A truncating subject still collapses, since
       * it carries `min-w-0` itself. */}
      <span className="flex min-w-max items-center gap-2">{leading}</span>
      <span className="flex items-center justify-center">{center}</span>
      {/* `min-w-max` for the same reason as above, from the other side: a
       * right column narrower than its buttons doesn't clip them, it spills
       * them *leftward* out of a `justify-end` cluster and back over the
       * center. Sized to max-content, the grid moves the center instead. */}
      <span className="flex min-w-max items-center justify-end gap-1.5">{actions}</span>
    </div>
  );
}

/** `agent` and `shell` keep the rail's `✦`/`❯` glyphs, so a session pane and
 * its rail row name themselves the same way. */
export type LensKind = "agent" | "shell" | "diff" | "files" | "web" | "browser" | "jarvis";

const LENSES: Record<LensKind, { label: string; glyph?: string; icon?: typeof GitCompare }> = {
  agent: { label: "claude", glyph: "✦" },
  shell: { label: "shell", glyph: "❯" },
  diff: { label: "diff", icon: GitCompare },
  files: { label: "files", icon: FilesIcon },
  web: { label: "web", icon: Globe },
  browser: { label: "chrome", icon: AppWindow },
  // The one pane that is not DOM at all: a compositor surface Bevy draws into.
  jarvis: { label: "jarvis", icon: Box },
};

/** The chip naming a pane's kind. The word carries it — an icon alone
 * measurably failed to distinguish two panes of one checkout. */
export function PaneLens({
  kind,
  label,
  title,
}: {
  kind: LensKind;
  /** Overrides the default word — shells pass their real one (`zsh`). */
  label?: string;
  title?: string;
}) {
  const lens = LENSES[kind];
  const Icon = lens.icon;
  return (
    <span
      title={title}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-px font-mono text-[10.5px]",
        kind === "agent" ? "text-violet-500" : "text-muted-foreground",
      )}
    >
      {lens.glyph ? (
        <span aria-hidden="true">{lens.glyph}</span>
      ) : (
        Icon && <Icon className="size-3" />
      )}
      {label ?? lens.label}
    </span>
  );
}
