import {
  Box,
  CalendarClock,
  CircleSlash,
  Eye,
  EyeOff,
  FolderGit2,
  FolderPlus,
  FolderX,
  GitPullRequest,
  PanelLeftClose,
} from "lucide-react";
import { DismissButton } from "@/components/store-bits";
import { cn } from "@/lib/utils";
import { mouseAction } from "@/lib/shortcut-coach";
import { shortcutHint } from "@/lib/shortcuts";
import { uiAction } from "@/lib/ui-action";
import type { AttentionItem } from "./use-attention";

/**
 * The rail's fixed top: the "Repos" title row with its filter/cleanup
 * affordances, and the attention strip beneath it (failing/review PRs + the
 * next imminent meeting). Everything below this scrolls.
 */
export function RailHeader(props: {
  attention: AttentionItem[];
  missingRepoCount: number;
  dismissedPrCount: number;
  clearingDismissals: boolean;
  hideInactive: boolean;
  onSetHideInactive: (next: boolean) => void;
  showUnmanagedWorktrees: boolean;
  onSetShowUnmanagedWorktrees: (next: boolean) => void;
  jarvisPane: boolean;
  onSetJarvisPane: (next: boolean) => void;
  onOpenRepoManager: () => void;
  onCleanupMissing: () => void;
  onClearDismissals: () => void;
  onCollapseRail: () => void;
}) {
  const {
    attention,
    missingRepoCount,
    dismissedPrCount,
    clearingDismissals,
    hideInactive,
    onSetHideInactive,
    showUnmanagedWorktrees,
    onSetShowUnmanagedWorktrees,
    jarvisPane,
    onSetJarvisPane,
    onOpenRepoManager,
    onCleanupMissing,
    onClearDismissals,
    onCollapseRail,
  } = props;
  return (
    <>
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Repos
        </span>
        <span className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={onOpenRepoManager}
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-violet-500 hover:bg-accent/50"
            title="Manage tracked repos in Settings — track, reorder, icon and color"
          >
            <FolderPlus className="size-3.5" /> Manage repos
          </button>
          {missingRepoCount > 0 && (
            <button
              type="button"
              onClick={onCleanupMissing}
              aria-label={`Untrack ${missingRepoCount} missing repos`}
              className="rounded-md p-1 text-amber-500 hover:bg-accent/50 hover:text-amber-400"
              title={`Untrack ${missingRepoCount} repo${missingRepoCount === 1 ? "" : "s"} whose director${missingRepoCount === 1 ? "y is" : "ies are"} gone from disk`}
            >
              <FolderX className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              uiAction("agentboard.hide_inactive", "agentboard", hideInactive ? "off" : "on");
              onSetHideInactive(!hideInactive);
            }}
            aria-label={hideInactive ? "Show all repos" : "Hide inactive repos"}
            aria-pressed={hideInactive}
            className={cn(
              "rounded-md p-1 hover:bg-accent/50",
              hideInactive
                ? "text-violet-500 hover:text-violet-400"
                : "text-muted-foreground hover:text-foreground",
            )}
            title={
              hideInactive
                ? "Showing only repos with something going on — click to show all"
                : "Hide repos with nothing going on (no live session, no dirty tree, no unpushed commits)"
            }
          >
            {hideInactive ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => {
              uiAction(
                "agentboard.show_unmanaged_worktrees",
                "agentboard",
                showUnmanagedWorktrees ? "off" : "on",
              );
              onSetShowUnmanagedWorktrees(!showUnmanagedWorktrees);
            }}
            aria-label={
              showUnmanagedWorktrees
                ? "Show only worktrees you asked for"
                : "Show every git worktree, including ones you didn't ask for"
            }
            aria-pressed={showUnmanagedWorktrees}
            className={cn(
              "rounded-md p-1 hover:bg-accent/50",
              showUnmanagedWorktrees
                ? "text-violet-500 hover:text-violet-400"
                : "text-muted-foreground hover:text-foreground",
            )}
            title={
              showUnmanagedWorktrees
                ? "Showing every git worktree, including ones Claude Code made for its own agents — click to show only the tasks you asked for"
                : "Showing only the tasks you asked for — click to also show worktrees Claude Code made for its own agents, or ones added by hand"
            }
          >
            <FolderGit2 className="size-3.5" />
          </button>
          {/* Jarvis, the native Bevy surface: this toggles both the strip at
              the bottom of the rail and whether a checkout can tile one as a
              *pane* (`components/jarvis-pane.tsx`) — one switch for the whole
              proof-of-concept. Left off, no surface is ever created and no
              renderer runs; turned off after the fact, the surfaces are parked
              rather than freed, because a Bevy app can't be dropped in-process
              (`crates-tauri/tt-pane`). */}
          <button
            type="button"
            onClick={() => {
              uiAction("agentboard.jarvis_pane", "agentboard", jarvisPane ? "off" : "on");
              onSetJarvisPane(!jarvisPane);
            }}
            aria-label={jarvisPane ? "Hide the Jarvis pane" : "Show the Jarvis pane"}
            aria-pressed={jarvisPane}
            className={cn(
              "rounded-md p-1 hover:bg-accent/50",
              jarvisPane
                ? "text-violet-500 hover:text-violet-400"
                : "text-muted-foreground hover:text-foreground",
            )}
            title={
              jarvisPane
                ? "Jarvis (native Bevy surface) is on — rail strip plus a “jarvis” button on each checkout that tiles one as a pane. Click to turn it off"
                : "Turn on Jarvis, the native Bevy surface: a rail strip, and a “jarvis” pane you can tile beside a checkout's terminals (proof-of-concept; Linux/Wayland only)"
            }
          >
            <Box className="size-3.5" />
          </button>
          {dismissedPrCount > 0 && (
            <button
              type="button"
              onClick={onClearDismissals}
              disabled={clearingDismissals}
              aria-label="Clear all dismissed PRs"
              className="rounded-md p-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-60"
              title={`Bring back ${dismissedPrCount} dismissed PR${dismissedPrCount === 1 ? "" : "s"}`}
            >
              <CircleSlash className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              mouseAction("ab-toggle-rail", "agentboard");
              onCollapseRail();
            }}
            aria-label="Collapse the rail to icons"
            className="rounded-md p-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            title={`Collapse the rail to icons (${shortcutHint("ab-toggle-rail")})`}
          >
            <PanelLeftClose className="size-3.5" />
          </button>
        </span>
      </div>

      {attention.length > 0 && (
        <div className="flex flex-col gap-1 border-b p-2">
          {attention.map((a) => (
            <div
              key={a.key}
              className={cn(
                "group flex items-center gap-1 rounded-md border border-l-2 pr-1 hover:bg-accent/50",
                a.border,
              )}
            >
              <button
                type="button"
                onClick={a.onClick}
                className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
              >
                {a.kind === "pr" ? (
                  <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <CalendarClock className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{a.title}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{a.sub}</span>
                </span>
              </button>
              {a.onDismiss && <DismissButton label="Dismiss" onDismiss={a.onDismiss} />}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
