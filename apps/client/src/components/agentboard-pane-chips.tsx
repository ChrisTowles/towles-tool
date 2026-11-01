// The checkout-line chips that aren't a PTY session. A view pane is a *view
// of* the folder, so it carries no status and closes without asking.
import { useState } from "react";
import { AppWindowIcon, EyeIcon, TreeStructureIcon } from "@phosphor-icons/react";
import { Hint } from "@/components/hint";
import { IconBtn } from "@/components/agentboard-bits/primitives";
import { cn } from "@/lib/utils";
import { isFilesPane, isBrowserPane, isPreviewPane } from "@/lib/agentboard/pane-ids";

/** The pane kinds that are a *view of* the folder rather than something
 * running in it — each still gets a chip, so what's open in a folder is
 * answerable from the rail alone. */
export type ViewPaneKind = "files" | "preview" | "browser";

export function viewPaneKind(paneId: string): ViewPaneKind | null {
  if (isFilesPane(paneId)) return "files";
  if (isPreviewPane(paneId)) return "preview";
  if (isBrowserPane(paneId)) return "browser";
  return null;
}

const VIEW_PANE_META: Record<
  ViewPaneKind,
  { Icon: typeof TreeStructureIcon; label: string; title: string }
> = {
  files: { Icon: TreeStructureIcon, label: "files", title: "This checkout's file tree and editor" },
  preview: { Icon: EyeIcon, label: "preview", title: "This checkout's live dev server" },
  browser: {
    Icon: AppWindowIcon,
    label: "chrome",
    title: "A real Chrome with persistent sign-ins",
  },
};

/** Quieter than a session chip: nothing running, so no status. Click focuses,
 * ✕ closes. */
export function ViewPaneChip({
  kind,
  active,
  onSelect,
  onClose,
}: {
  kind: ViewPaneKind;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const { Icon, label, title } = VIEW_PANE_META[kind];
  const [hovered, setHovered] = useState(false);
  return (
    <Hint label={title} side="bottom">
      <div
        role="button"
        tabIndex={0}
        aria-current={active || undefined}
        aria-label={title}
        onClick={onSelect}
        onKeyDown={(e) => e.key === "Enter" && onSelect()}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={cn(
          "relative flex h-6 cursor-pointer items-center gap-1.5 rounded-sm px-1.5",
          (hovered || active) && "bg-kumo-tint",
        )}
      >
        <Icon className="size-3.5 shrink-0 text-kumo-subtle" />
        <span className="font-mono text-mini text-kumo-subtle">{label}</span>
        {hovered && (
          <span className="absolute inset-y-0 right-0 z-10 flex items-center rounded-r-sm bg-kumo-tint pl-1">
            <IconBtn
              ghost
              title={`close ${label} pane`}
              onClick={onClose}
              className="size-5 hover:text-danger"
            >
              ✕
            </IconBtn>
          </span>
        )}
      </div>
    </Hint>
  );
}
