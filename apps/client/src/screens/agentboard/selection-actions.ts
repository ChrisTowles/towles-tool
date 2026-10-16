import type { Dispatch, RefObject, SetStateAction } from "react";
import type { RepoData, Selected } from "@/lib/agentboard/types";
import type { FocusLevel } from "@/lib/agentboard/windows";
import type { JumpRecall } from "@/lib/jump-recall";
import type { filterQueue } from "@/lib/queue";
import type { RailNode } from "@/lib/rail-nodes";
import { invoke } from "@/lib/tauri";

/** What handlers that outlive a render (mount-only subscriptions, async
 * continuations) read the rail through; kept current by the screen every render. */
export type RailSnapshot = {
  repos: RepoData[];
  folderNameByDir: Map<string, string>;
  railQueue: ReturnType<typeof filterQueue>;
  shownQueue: ReturnType<typeof filterQueue>;
  railTree: RailNode[];
};

/** The state setters selection moves, which `selectSession` and its siblings
 * write together so one click lands as one batch. */
export type SelectionSetters = {
  setOpen: Dispatch<SetStateAction<string[]>>;
  setSelected: Dispatch<SetStateAction<Selected>>;
  setJumpRecall: Dispatch<SetStateAction<JumpRecall | null>>;
  setRailCursor: Dispatch<SetStateAction<RailNode | null>>;
  setActiveFolderDir: Dispatch<SetStateAction<string | null>>;
  setFocusedPaneId: Dispatch<SetStateAction<string | null>>;
  setFocusLevel: Dispatch<SetStateAction<FocusLevel>>;
  setTermAttention: Dispatch<SetStateAction<Record<string, true>>>;
};

/** The ways Agent Board arrives at a checkout or session. Rebuilt every render
 * like any closure, so each call sees the render it was handed out in. */
export function selectionActions(
  a: SelectionSetters & {
    railRef: RefObject<RailSnapshot>;
    cwds: RefObject<Record<string, string>>;
    addPaneToActive: (folderDir: string, paneId: string) => void;
  },
) {
  const { railRef, cwds, addPaneToActive } = a;

  // Looking at the rail entry clears its agents' `unseen` pulse.
  function ackFolder(folderDir: string) {
    // Through the ref: its mount-only caller sees only the first-render map.
    const name = railRef.current.folderNameByDir.get(folderDir);
    if (name) void invoke("ab_mark_seen", { name });
  }

  // Reaching a checkout any way at all hands Agent Board's cursor to it, its
  // session's row when there is one; the queue's ring follows `activeFolderDir`.
  function setCursorFor(folderDir: string, sessionId?: string) {
    const nodes = railRef.current.railTree;
    const node =
      (sessionId === undefined ? undefined : nodes.find((n) => n.sessionId === sessionId)) ??
      nodes.find((n) => n.kind !== "session" && n.dir === folderDir);
    if (node) a.setRailCursor(node);
  }

  function selectFolder(folderDir: string) {
    setCursorFor(folderDir);
    a.setActiveFolderDir(folderDir);
    a.setSelected((cur) => (cur && cur.folderDir !== folderDir ? null : cur));
    a.setFocusLevel("rail");
    ackFolder(folderDir);
  }

  // For sessions created in the background: leaves `selected`/`activeFolderDir`.
  function mountSession(folderDir: string, sessionId: string) {
    cwds.current[sessionId] = folderDir;
    a.setOpen((prev) => (prev.includes(sessionId) ? prev : [...prev, sessionId]));
    addPaneToActive(folderDir, sessionId);
  }

  function selectSession(folderDir: string, sessionId: string) {
    a.setJumpRecall(null);
    setCursorFor(folderDir, sessionId);
    mountSession(folderDir, sessionId);
    a.setSelected({ folderDir, sessionId });
    a.setFocusedPaneId(sessionId);
    // Rail-level selection by default; focusPane overrides to pane in the same batch.
    a.setFocusLevel("rail");
    a.setActiveFolderDir(folderDir);
    a.setTermAttention((m) => withoutKey(m, sessionId));
    ackFolder(folderDir);
  }

  return { ackFolder, setCursorFor, selectFolder, mountSession, selectSession };
}

/** `m` unless it holds `key`, in which case a copy without it. */
export function withoutKey<T>(m: Record<string, T>, key: string): Record<string, T> {
  if (!m[key]) return m;
  const { [key]: _, ...rest } = m;
  return rest;
}
