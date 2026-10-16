// The home directory's header, pinned atop the tree. `~` is no repo, so the row
// carries none of a checkout's git block or repo menu — only identity, the
// session rollup and the two things you do in a directory: open a session or
// its files.
import { HouseIcon, PlusIcon } from "@phosphor-icons/react";
import { NeedsBadge } from "@/components/agentboard-bits/badges";
import { FilesButton } from "@/components/agentboard-bits/pane-buttons";
import { IconBtn } from "@/components/agentboard-bits/primitives";
import { Chevron, CollapsedLive } from "@/components/agentboard-bits/status-dots";
import { Hint } from "@/components/hint";
import { repoAccentStyles, type RepoIdentity } from "@/lib/repo-identity";
import { cn } from "@/lib/utils";
import type { FolderData } from "@/lib/agentboard/types";

export function HomeHeader({
  identity,
  folder,
  needs,
  collapsed,
  active,
  cursor,
  onToggle,
  onNewSession,
  onOpenFiles,
}: {
  identity: RepoIdentity;
  folder: FolderData;
  needs: number;
  collapsed: boolean;
  active: boolean;
  cursor: boolean;
  onToggle: () => void;
  onNewSession: () => void;
  onOpenFiles: () => void;
}) {
  const accent = repoAccentStyles(identity);
  return (
    <div
      style={needs === 0 ? accent.headerStyle : undefined}
      className={cn(
        "group sticky top-0 z-10 flex items-center gap-2 border-b border-l-[3px] border-border border-l-transparent py-1.5 pr-3 pl-3 hover:bg-accent",
        accent.headerStyle && needs === 0 ? "bg-(--repo-wash)" : "bg-card",
        active && "border-l-agent",
        cursor && "ring-1 ring-inset ring-agent",
      )}
    >
      <Hint label={folder.dir} side="right">
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-2">
          <Chevron collapsed={collapsed} />
          <HouseIcon className="size-3.5 shrink-0" style={accent.iconStyle} />
          <span className="shrink-0 font-mono text-sm text-muted-foreground/60">~</span>
          <span style={accent.iconStyle} className="truncate text-sm font-semibold">
            Home
          </span>
        </button>
      </Hint>
      {collapsed && <CollapsedLive sessions={folder.sessions} />}
      {needs > 0 && <NeedsBadge n={needs} />}
      <div className="flex shrink-0 items-center gap-1 pl-1">
        <span className="pointer-events-none flex w-0 items-center gap-1 overflow-hidden opacity-0 transition-opacity focus-within:pointer-events-auto focus-within:w-auto focus-within:opacity-100 group-hover:pointer-events-auto group-hover:w-auto group-hover:opacity-100">
          <FilesButton onOpen={onOpenFiles} />
        </span>
        <IconBtn
          ghost
          title="New session in ~"
          shortcut="ab-new-session"
          onClick={onNewSession}
          className="hover:text-agent"
        >
          <PlusIcon className="size-3.5" />
        </IconBtn>
      </div>
    </div>
  );
}
