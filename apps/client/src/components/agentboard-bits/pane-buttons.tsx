import { type ReactNode } from "react";
import { AppWindowIcon, EyeIcon, TreeStructureIcon } from "@phosphor-icons/react";
import { Hint } from "@/components/hint";
import { mouseAction } from "@/lib/shortcut-coach";
import { CHIP_CLASS } from "./diff-chips";

/** `mouseAction` is opt-in per chip: it must fire only for an exact shortcut
 * twin, or the habit score counts a keystroke the user never passed up. */
function PaneOpenButton({
  glyph,
  label,
  title,
  onOpen,
  shortcutTwin,
  labeled = false,
}: PaneOpenButtonProps & {
  glyph: ReactNode;
  label: string;
  title: string;
  /** Shortcut id this chip duplicates, when it has one. */
  shortcutTwin?: string;
}) {
  return (
    // A chip scoring a click as a passed-up keystroke has to name it.
    <Hint label={title} shortcut={shortcutTwin}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (shortcutTwin) mouseAction(shortcutTwin, "agentboard");
          onOpen();
        }}
        className={`${CHIP_CLASS} text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default`}
        aria-label={label}
      >
        {glyph}
        {labeled && <span>{label}</span>}
      </button>
    </Hint>
  );
}

/** `labeled` is the same width budget as [`DiffChipProps.labeled`]. */
type PaneOpenButtonProps = { onOpen: () => void; labeled?: boolean };

/** Opens the folder's file tree as a pane. `TreeStructure`, not `Files`:
 * two stacked pages is the near-universal *copy* glyph. */
export function FilesButton({ onOpen, labeled }: PaneOpenButtonProps) {
  return (
    <PaneOpenButton
      glyph={<TreeStructureIcon className="size-3" />}
      label="files"
      title="Browse every file in this checkout — @ any of them to Claude"
      onOpen={onOpen}
      labeled={labeled}
      shortcutTwin="ab-toggle-files"
    />
  );
}

/** `Eye`, not `AppWindow`: a window outline is one more generic rectangle next
 * to the file glyph. */
export function PreviewButton({ onOpen, labeled }: PaneOpenButtonProps) {
  return (
    <PaneOpenButton
      glyph={<EyeIcon className="size-3" />}
      label="preview"
      title="Preview this checkout's dev server — annotate the page and send it to the agent"
      onOpen={onOpen}
      labeled={labeled}
    />
  );
}

/** A real Chrome on the app-owned profile, so sign-ins persist across restarts.
 * Mounted only when `agentboard.browserPane` is on. */
export function BrowserButton({ onOpen, labeled }: PaneOpenButtonProps) {
  return (
    <PaneOpenButton
      glyph={<AppWindowIcon className="size-3" />}
      label="chrome"
      title="Open a real Chrome in this window — log in once, it sticks"
      onOpen={onOpen}
      labeled={labeled}
    />
  );
}
