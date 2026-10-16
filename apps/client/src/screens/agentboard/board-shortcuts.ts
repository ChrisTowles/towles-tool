import { rerankQueueItem } from "@/components/queue-rail";
import { folderBusy } from "@/lib/agentboard/folder";
import { folderRemovableTask } from "@/lib/agentboard/landing";
import { isAgent } from "@/lib/agentboard/session";
import type { AgWindow, FolderData, Selected, SessionData } from "@/lib/agentboard/types";
import { openNoteDialog } from "@/lib/inbox";
import type { QueueItem } from "@/lib/schemas/queue";
import type { RailView } from "@/lib/screens";
import type { WorktreeDelete } from "./use-worktree-delete";

type Chord = () => boolean | void;

/** Everything the keyboard map reads: the render's state and the handlers it
 * dispatches to. */
export type BoardShortcutContext = {
  tree: boolean;
  activeFolderDir: string | null;
  activeFolder: FolderData | undefined;
  activeWin: AgWindow | undefined;
  selected: Selected;
  sessionById: Map<string, SessionData>;
  ringItem: QueueItem | undefined;
  shownQueueItems: readonly QueueItem[];
  worktreeDelete: Pick<
    WorktreeDelete,
    "blockedDelete" | "forceDeleteBlocked" | "confirmDeleteWt" | "confirmDeleteWorktree"
  >;
  newSession: (folderDir: string) => Promise<void>;
  openRailNewTask: () => void;
  requestDeleteWorktree: (dir: string, label: string) => void;
  closeFocusedPane: () => void;
  openFiles: (dir: string) => void;
  toggleRail: () => void;
  setRailView: (view: RailView) => void;
  jumpToNeedsYou: (direction: "next" | "prev") => void;
  jumpToNotBusy: () => void;
  jumpToHotkey: (n: number) => boolean;
  focusByArrow: (direction: "up" | "down" | "left" | "right") => boolean;
  collapseWholeRail: (collapse: boolean) => boolean;
  moveQueueCursor: (step: 1 | -1) => boolean;
  setSnoozeId: (folderDir: string) => void;
  focusActiveTerminal: () => boolean;
  splitIntoWindow: () => void;
};

/** Agent Board's chord → handler map. A handler returning `false` declines the
 * chord to the platform. */
export function boardShortcuts(c: BoardShortcutContext): Record<string, Chord> {
  const { activeFolder, activeFolderDir, ringItem, worktreeDelete } = c;
  const rerank = (direction: "up" | "down" | "top") => () => {
    if (ringItem) void rerankQueueItem(c.shownQueueItems, ringItem, direction);
  };
  return {
    "ab-new-session": () => {
      if (activeFolderDir) void c.newSession(activeFolderDir);
    },
    "ab-new-task": () => c.openRailNewTask(),
    "ab-remove-task": () => {
      // `requestDeleteWorktree` always confirms before touching anything.
      if (!activeFolder || !folderRemovableTask(activeFolder)) return;
      if (folderBusy(activeFolder)) return;
      c.requestDeleteWorktree(activeFolder.dir, activeFolder.name);
    },
    // One chord for the whole delete flow: it confirms the first dialog, and
    // then the blocked dialog's destructive button if the guards refuse.
    "ab-confirm-close-worktree": () => {
      if (worktreeDelete.blockedDelete) {
        worktreeDelete.forceDeleteBlocked();
        return;
      }
      if (!worktreeDelete.confirmDeleteWt) return false;
      worktreeDelete.confirmDeleteWorktree();
    },
    "ab-close-pane": c.closeFocusedPane,
    "ab-toggle-files": () => {
      if (activeFolderDir) c.openFiles(activeFolderDir);
    },
    "ab-toggle-rail": c.toggleRail,
    "ab-rail-view": () => c.setRailView(c.tree ? "queue" : "tree"),
    "ab-jump-next": () => c.jumpToNeedsYou("next"),
    "ab-jump-prev": () => c.jumpToNeedsYou("prev"),
    "ab-jump-idle": c.jumpToNotBusy,
    ...Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [
        `ab-jump-session-${i + 1}`,
        () => c.jumpToHotkey(i + 1),
      ]),
    ),
    "ab-focus-up": () => c.focusByArrow("up"),
    "ab-focus-down": () => c.focusByArrow("down"),
    "ab-focus-up-bracket": () => c.focusByArrow("up"),
    "ab-focus-down-bracket": () => c.focusByArrow("down"),
    "ab-focus-left": () => c.focusByArrow("left"),
    "ab-focus-right": () => c.focusByArrow("right"),
    // Each rail's own chords, and only while it's up: Alt+Shift+↑ is the
    // queue's rank-top and the tree's collapse-all.
    ...(c.tree
      ? {
          "ab-collapse-all": () => c.collapseWholeRail(true),
          "ab-expand-all": () => c.collapseWholeRail(false),
        }
      : {
          "queue-down": () => c.moveQueueCursor(1),
          "queue-up": () => c.moveQueueCursor(-1),
          "queue-snooze": () => {
            if (!ringItem?.reason || ringItem.snoozed) return false;
            c.setSnoozeId(ringItem.folderDir);
          },
          // Before rank-up: a shift-less spec also matches Alt+Shift+↑, and the
          // first matching handler wins.
          "queue-rank-top": rerank("top"),
          "queue-rank-up": rerank("up"),
          "queue-rank-down": rerank("down"),
        }),
    "ab-focus-terminal": c.focusActiveTerminal,
    "ab-split-session": c.splitIntoWindow,
    "ab-note-agent": () => {
      const id =
        (c.selected?.folderDir === activeFolderDir ? c.selected?.sessionId : undefined) ??
        c.activeWin?.panes.find((p) => c.sessionById.has(p));
      const s = id ? c.sessionById.get(id) : undefined;
      if (!s || !isAgent(s)) return false;
      openNoteDialog({ sessionId: s.id, label: s.name });
    },
    "ab-new-terminal-right": () => {
      if (activeFolderDir) void c.newSession(activeFolderDir);
    },
  };
}
