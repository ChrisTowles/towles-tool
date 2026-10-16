import type { Dispatch, RefObject, SetStateAction } from "react";
import { cycleNotBusy } from "@/lib/agentboard/session";
import type { AgWindow, FolderData, RepoData, Selected, SessionData } from "@/lib/agentboard/types";
import { moveFocus, type FocusLevel } from "@/lib/agentboard/windows";
import { buildJumpRecall, type JumpRecall } from "@/lib/jump-recall";
import { advanceTarget, cycleQueue, nextItem, stepRow } from "@/lib/queue";
import { railCollapseAll, railExpandAll } from "@/lib/rail-collapse";
import { railMove, type RailNode } from "@/lib/rail-nodes";
import type { QueueItem } from "@/lib/schemas/queue";
import { toast } from "@/lib/toast";
import { uiAction } from "@/lib/ui-action";
import { blurTerminal } from "./focus-dom";
import type { RailSnapshot } from "./selection-actions";

type Direction = "up" | "down" | "left" | "right";

/** Where the cursor and focus ring can go from here: the jump chords, the
 * arrow walk over rail, window strip and panes, and the queue's row steps.
 * Rebuilt every render like the closures it replaces. */
export function railNavigation(a: {
  tree: boolean;
  now: number;
  selected: Selected;
  activeFolderDir: string | null;
  activeFolder: FolderData | undefined;
  activeWin: AgWindow | undefined;
  windowsForFolder: AgWindow[];
  sessionById: Map<string, SessionData>;
  folderOf: Map<string, FolderData>;
  cwds: RefObject<Record<string, string>>;
  railRef: RefObject<RailSnapshot>;
  shownRepos: RepoData[];
  railQueue: RailSnapshot["railQueue"];
  railTree: RailNode[];
  cursorKey: string | null;
  cursorNode: RailNode | null;
  collapsed: Record<string, boolean>;
  rows: QueueItem[];
  ringId: string | null;
  hotkeyTargets: { sessionId: string; folderDir: string }[];
  focusLevel: FocusLevel;
  focusedPaneId: string | null;
  jumpNonce: RefObject<number>;
  applyCollapse: (changes: { key: string; collapsed: boolean }[]) => void;
  selectSession: (folderDir: string, sessionId: string) => void;
  selectFolder: (folderDir: string) => void;
  focusWindow: (windowId: string) => void;
  setJumpRecall: Dispatch<SetStateAction<JumpRecall | null>>;
  setRailCursor: Dispatch<SetStateAction<RailNode | null>>;
  setFocusLevel: Dispatch<SetStateAction<FocusLevel>>;
  setFocusedPaneId: Dispatch<SetStateAction<string | null>>;
  setFocusTerminalRequest: Dispatch<SetStateAction<{ id: string; nonce: number } | null>>;
}) {
  // ab-jump-*: board-wide, wrapping, through `selectSession` so a jump behaves
  // exactly like clicking the session.
  function jumpTo(target: SessionData | null, nothing: string) {
    if (!target) {
      toast(nothing);
      return;
    }
    const folder = a.folderOf.get(target.id);
    if (!folder) return;
    a.selectSession(folder.dir, target.id);
    // A keyboard jump is the one arrival with no click to remember it by.
    a.jumpNonce.current += 1;
    a.setJumpRecall(buildJumpRecall(a.shownRepos, folder, target, a.now, a.jumpNonce.current));
  }

  // Walks the task queue's sessions: answer one, press next, and the most
  // urgent remaining agent is where you land.
  function jumpToNeedsYou(direction: "next" | "prev") {
    const id = cycleQueue(a.railQueue, a.selected?.sessionId ?? null, direction);
    jumpTo(id ? (a.sessionById.get(id) ?? null) : null, "Queue's empty — nothing needs you.");
  }

  // After a prompt to `fromSessionId`: the next agent waiting on you, landed on
  // as a keyboard jump is (recall card included) with its terminal focused.
  function advanceFrom(fromSessionId: string): boolean {
    const target = advanceTarget(a.railRef.current.shownQueue, fromSessionId);
    const session = target?.sessionId ? a.sessionById.get(target.sessionId) : undefined;
    if (!session) return false;
    jumpTo(session, "");
    a.setFocusTerminalRequest((r) => ({ id: session.id, nonce: (r?.nonce ?? 0) + 1 }));
    return true;
  }

  /** Open a queue row in place: its session, else its checkout.
   * `hint` is for a row you opened; an automatic open says nothing. */
  function selectQueueItem(item: QueueItem, hint = true) {
    if (item.sessionId) a.selectSession(item.folderDir, item.sessionId);
    else a.selectFolder(item.folderDir);
    if (hint && item.reason === "land") toast.info("Run /done in the task's terminal to land it.");
  }

  function pickQueueItem(item: QueueItem) {
    uiAction("queue.open", "agentboard", item.reason ?? item.lane);
    selectQueueItem(item);
  }

  function openNextUp() {
    const target = nextItem(a.railRef.current.shownQueue);
    if (target) selectQueueItem(target);
    else toast.info("Queue's empty — nothing needs you.");
  }

  // Declines when the digit addresses nothing, so an unused number keeps
  // whatever the platform does with the chord rather than silently eating it.
  function jumpToHotkey(n: number): boolean {
    if (a.tree) {
      const session = a.hotkeyTargets[n - 1];
      if (!session) return false;
      a.selectSession(session.folderDir, session.sessionId);
      return true;
    }
    const target = a.rows[n - 1];
    if (!target) return false;
    selectQueueItem(target);
    return true;
  }

  function moveQueueCursor(step: 1 | -1): boolean {
    const target = stepRow(a.rows, a.ringId, step);
    if (!target) return false;
    selectQueueItem(target);
    return true;
  }

  function jumpToNotBusy() {
    jumpTo(
      cycleNotBusy(a.shownRepos, a.selected?.sessionId ?? null, "next"),
      "Nothing idle right now.",
    );
  }

  // ab-focus-terminal (Enter): real DOM focus, so the next keystroke lands in
  // the shell instead of nowhere.
  function focusActiveTerminal(): boolean {
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      if (active.tagName === "BUTTON" || active.tagName === "A") return false;
      if (active.closest('[role="dialog"], [role="alertdialog"]')) return false;
    }
    const { activeFolderDir, activeFolder, selected } = a;
    if (!activeFolderDir || !activeFolder) return false;
    const sessionPaneId = a.activeWin?.panes.find((id) => a.sessionById.has(id));
    const targetId =
      (a.tree ? (a.cursorNode?.sessionId ?? undefined) : undefined) ??
      (selected?.folderDir === activeFolderDir ? selected.sessionId : undefined) ??
      sessionPaneId ??
      activeFolder.sessions[0]?.id;
    if (!targetId) return false;
    a.selectSession(activeFolderDir, targetId);
    a.setFocusLevel("pane");
    a.setFocusTerminalRequest((r) => ({ id: targetId, nonce: (r?.nonce ?? 0) + 1 }));
    return true;
  }

  // Keyboard reality, not just the violet ring: a session pane takes DOM focus,
  // a view pane takes the ring and the previous shell loses the keyboard.
  function focusPane(paneId: string) {
    if (a.sessionById.has(paneId)) {
      const dir = a.folderOf.get(paneId)?.dir ?? a.cwds.current[paneId];
      if (!dir) return;
      a.selectSession(dir, paneId);
      a.setFocusTerminalRequest((r) => ({ id: paneId, nonce: (r?.nonce ?? 0) + 1 }));
    } else {
      a.setFocusedPaneId(paneId);
      blurTerminal();
    }
    // After selectSession, which claims rail level — the batch resolves to pane.
    a.setFocusLevel("pane");
  }

  // Walking off the rail's right edge is the pane grid's business.
  function leaveRailRight(): boolean {
    if (a.windowsForFolder.length > 1) {
      a.setFocusLevel("window");
      a.setFocusedPaneId(null);
      blurTerminal();
      return true;
    }
    const first = a.activeWin?.panes[0];
    if (first === undefined) return false;
    focusPane(first);
    return true;
  }

  // Declining when nothing changes leaves the chord to the platform.
  function collapseWholeRail(collapse: boolean): boolean {
    const changes = collapse
      ? railCollapseAll(a.shownRepos, a.collapsed)
      : railExpandAll(a.shownRepos, a.collapsed);
    if (changes.length === 0) return false;
    a.applyCollapse(changes);
    return true;
  }

  // The tree cursor lands: a session row selects its session, a checkout row (a
  // solo repo's header included) makes that checkout the working context, and a
  // multi-checkout repo header speaks for no one checkout, so it only rings.
  function landOnRow(key: string) {
    const node = a.railTree.find((n) => n.key === key);
    if (!node) return;
    if (node.sessionId !== null && node.dir !== null) {
      a.selectSession(node.dir, node.sessionId);
      return;
    }
    if (node.dir !== null) {
      a.selectFolder(node.dir);
      return;
    }
    a.setRailCursor(node);
    a.setFocusLevel("rail");
  }

  function moveTreeCursor(direction: Direction): boolean {
    const move = railMove({
      nodes: a.railTree,
      cursor: a.cursorKey,
      direction,
      collapsed: a.collapsed,
    });
    if (!move) return false;
    if (move.kind === "collapse") {
      a.applyCollapse([{ key: move.key, collapsed: move.collapsed }]);
      return true;
    }
    if (move.kind === "exit") return leaveRailRight();
    landOnRow(move.key);
    return true;
  }

  // One cursor over rail, window strip and panes. In the rail it walks the
  // queue's rows or Agent Board's tree; past it, `moveFocus` owns the transitions.
  function focusByArrow(direction: Direction): boolean {
    if (a.focusLevel === "rail" && a.tree) return moveTreeCursor(direction);
    if (a.focusLevel === "rail") {
      if (direction === "up") return moveQueueCursor(-1);
      if (direction === "down") return moveQueueCursor(1);
      return direction === "right" ? leaveRailRight() : false;
    }
    const move = moveFocus({
      level: a.focusLevel,
      direction,
      panes: a.activeWin?.panes ?? [],
      focusedPaneId: a.focusedPaneId,
      windows: a.windowsForFolder.map((w) => w.id),
      activeWindowId: a.activeWin?.id ?? null,
    });
    if (!move) return false;
    switch (move.kind) {
      case "level":
        a.setFocusLevel(move.level);
        a.setFocusedPaneId(null);
        blurTerminal();
        break;
      case "pane":
        focusPane(move.id);
        break;
      case "window":
        a.focusWindow(move.id);
        break;
    }
    return true;
  }

  return {
    jumpToNeedsYou,
    advanceFrom,
    jumpToNotBusy,
    jumpToHotkey,
    selectQueueItem,
    pickQueueItem,
    openNextUp,
    moveQueueCursor,
    focusActiveTerminal,
    collapseWholeRail,
    focusByArrow,
  };
}
