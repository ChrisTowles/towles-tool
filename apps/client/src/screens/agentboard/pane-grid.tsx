import { TerminalSquare } from "lucide-react";
import { PanePlaceholder } from "@/components/agentboard-bits";
import { ColdCacheOverlay, PaneHeader } from "@/components/agentboard-pane";
import { AgentPane } from "@/components/agent-pane";
import { DiffPane } from "@/components/diff-pane";
import { FolderFilesPane, type FilesOpenRequest } from "@/components/files-pane";
import { PreviewPane } from "@/components/preview-pane";
import { TerminalView } from "@/components/terminal-view";
import {
  agentPaneDir,
  diffPaneDir,
  exitPaneSession,
  filesPaneDir,
  isDiffPane,
  isExitPane,
  isFilesPane,
  isPreviewPane,
  paneRects,
  previewPaneDir,
  type AgWindow,
  type FolderData,
  type SessionActions,
  type SessionData,
} from "@/lib/agentboard";
import type { ArtifactRequest } from "@/lib/preview-artifact";
import type { TermExit } from "@/lib/term-protocol";
import { cn } from "@/lib/utils";
import { paneStyle } from "./helpers";
import type { ColumnDrag } from "./use-column-drag";

/**
 * The pane area: one flat pool of mounted terminals *and chat panes* (never
 * remounted — a remount would respawn the shell, or in a chat's case kill the
 * `claude` process and throw the transcript away) plus the
 * diff/files/preview/tombstone panes, all absolutely positioned into the
 * active window's tiling.
 *
 * The active window's pane order assigns each a percent-rect; panes in other
 * windows stay hidden rather than unmounting, so scrollback survives switching
 * and regrouping. Diff/files/preview panes are *not* pooled deliberately —
 * they refetch from disk on mount and hold nothing that can't be rebuilt,
 * whereas a terminal and a chat each own a live process.
 */
export function PaneGrid(props: {
  /** Session ids whose PTY is mounted, in mount order. */
  open: string[];
  /** Every chat pane open in *any* window, not just the active one — they stay
   * mounted (and hidden) for the same reason terminals do: the session is a
   * live process plus a transcript, and both used to die on a folder switch. */
  chatPanes: string[];
  /** Fallback cwd per session, for terminals whose folder isn't resolvable. */
  cwds: React.RefObject<Record<string, string>>;
  activeWin: AgWindow | undefined;
  activeFolderDir: string | null;
  sessionById: Map<string, SessionData>;
  folderOf: Map<string, FolderData>;
  folderByDir: Map<string, FolderData>;
  now: number;
  actions: SessionActions;
  /** Which tile last claimed the click — the sole driver of the violet ring. */
  focusedPaneId: string | null;
  onFocusPane: (paneId: string) => void;
  /** Sessions whose program raised attention (BEL / OSC 9) since last looked at. */
  termAttention: Record<string, true>;
  /** How a *crashed* session's shell died, by session id (tombstone detail). */
  exitLabels: Record<string, string>;
  filesOpenRequests: Record<string, FilesOpenRequest>;
  /** Artifacts an agent asked to show, by folder dir — see the MCP
   * `preview_show` tool (`lib/preview-artifact.ts`). */
  artifactRequests: Record<string, ArtifactRequest>;
  /** The label to lead a session's pane with — live Claude title or backend name. */
  labelFor: (s: SessionData) => string;
  /** Terminal focus request: the session to focus, and a nonce so re-requesting
   * the same one still re-fires. */
  focusTerminalRequest: { id: string; nonce: number } | null;
  onSelectSession: (folderDir: string, sessionId: string) => void;
  onExit: (sessionId: string, exit: TermExit) => void;
  onTitle: (id: string, title: string) => void;
  onOpenTerminalPath: (dir: string, path: string, line: number | null) => void;
  onRemovePane: (paneId: string) => void;
  columns: ColumnDrag;
}) {
  const {
    open,
    chatPanes,
    cwds,
    activeWin,
    activeFolderDir,
    sessionById,
    folderOf,
    folderByDir,
    now,
    actions,
    focusedPaneId,
    onFocusPane,
    termAttention,
    exitLabels,
    filesOpenRequests,
    artifactRequests,
    labelFor,
    focusTerminalRequest,
    onSelectSession,
    onExit,
    onTitle,
    onOpenTerminalPath,
    onRemovePane,
    columns,
  } = props;
  const { paneAreaRef, colDrag, startColDrag, resetCols } = columns;

  const panes: string[] = activeWin?.panes ?? [];
  const liveCols =
    colDrag && activeWin && colDrag.winId === activeWin.id ? colDrag.cols : activeWin?.cols;
  const rects = paneRects(panes.length, liveCols);
  const rectFor = (id: string) => {
    const i = panes.indexOf(id);
    return i < 0 ? undefined : rects[i];
  };

  /** Every non-terminal pane kind shares this shell: absolutely positioned into
   * its rect, claiming focus on click. */
  const paneBox = (id: string, children: React.ReactNode) => {
    const r = rectFor(id);
    return (
      <div
        key={id}
        style={r ? paneStyle(r) : undefined}
        className="absolute p-1.5"
        onClick={() => onFocusPane(id)}
      >
        {children}
      </div>
    );
  };

  return (
    <div ref={paneAreaRef} className="relative min-h-0 flex-1 overflow-hidden p-2">
      {open.map((id) => {
        const r = rectFor(id);
        const s = sessionById.get(id);
        const termDir = folderOf.get(id)?.dir;
        return (
          <div key={id} hidden={!r} style={r ? paneStyle(r) : undefined} className="absolute p-1.5">
            <div
              onClick={() => onSelectSession(folderOf.get(id)?.dir ?? cwds.current[id] ?? "", id)}
              className={cn(
                "flex h-full flex-col overflow-hidden rounded-lg border bg-card",
                // Amber (needs-you) wins the border over violet (focus) when
                // both apply — see the folder-rail-ui skill's "Two accent hues"
                // rule; class order here matters because `cn` (tailwind-merge)
                // keeps only the last conflicting border-color utility.
                focusedPaneId === id && "border-violet-500/60",
                termAttention[id] && "border-amber-500/70",
              )}
            >
              {s && <PaneHeader session={s} label={labelFor(s)} now={now} actions={actions} />}
              {/* data-term-host marks terminal territory for the shortcut
                  guard — keys typed here belong to the shell (Ctrl+D is EOF,
                  not "new session"). */}
              <div className="relative min-h-0 flex-1" data-term-host>
                <TerminalView
                  termId={id}
                  cwd={termDir ?? cwds.current[id]}
                  onExit={(exit) => onExit(id, exit)}
                  onTitle={onTitle}
                  // Only folder-owned terminals can route links into a files
                  // pane; others keep the external-editor default.
                  onOpenPath={
                    termDir ? (path, line) => onOpenTerminalPath(termDir, path, line) : undefined
                  }
                  focusRequest={
                    focusTerminalRequest?.id === id ? focusTerminalRequest.nonce : undefined
                  }
                />
                {s && (
                  <ColdCacheOverlay
                    session={s}
                    now={now}
                    onCompact={() => actions.compactClaude(s)}
                  />
                )}
              </div>
            </div>
          </div>
        );
      })}
      {/* Diff panes: a folder's patch tiled beside its terminals. */}
      {panes
        .filter(isDiffPane)
        .map((id) =>
          paneBox(
            id,
            <DiffPane
              folder={folderByDir.get(diffPaneDir(id) ?? "")}
              focused={focusedPaneId === id}
              onClose={() => onRemovePane(id)}
            />,
          ),
        )}
      {/* Files panes: a folder's full tree tiled beside its terminals. */}
      {panes.filter(isFilesPane).map((id) => {
        const dir = filesPaneDir(id) ?? "";
        return paneBox(
          id,
          <FolderFilesPane
            folder={folderByDir.get(dir)}
            focused={focusedPaneId === id}
            openRequest={filesOpenRequests[dir]}
            onClose={() => onRemovePane(id)}
          />,
        );
      })}
      {/* Preview panes: a folder's live dev server tiled beside its terminals,
          with draw-on-page feedback. */}
      {panes.filter(isPreviewPane).map((id) => {
        const dir = previewPaneDir(id) ?? "";
        return paneBox(
          id,
          <PreviewPane
            folder={folderByDir.get(dir)}
            focused={focusedPaneId === id}
            artifact={artifactRequests[dir]}
            onClose={() => onRemovePane(id)}
          />,
        );
      })}
      {/* Chat panes: a Claude Code session in this folder rendered as
          structured turns rather than PTY scrollback. Sits beside the folder's
          terminals — comprehension coming back, where they are precision going
          in. Pooled like the terminals above (hidden, not unmounted, when it
          isn't in the active window) because the session behind it is a live
          process and a conversation. */}
      {chatPanes.map((id) => {
        const r = rectFor(id);
        return (
          <div key={id} hidden={!r} style={r ? paneStyle(r) : undefined} className="absolute p-1.5">
            <div className="h-full" onClick={() => onFocusPane(id)}>
              <AgentPane
                folder={folderByDir.get(agentPaneDir(id) ?? "")}
                focused={focusedPaneId === id}
                onClose={() => onRemovePane(id)}
              />
            </div>
          </div>
        );
      })}
      {/* Tombstones: a shell that died on its own, holding the task it died in.
          The pane id says which kind this is, so this pass can't overlap the
          terminal pass above — a session is either its own id or its `~exit:`
          one, never both. Dismissal is the only affordance; reopening from the
          rail reclaims the task. */}
      {panes.filter(isExitPane).map((id) => {
        const sessionId = exitPaneSession(id) ?? "";
        const s = sessionById.get(sessionId);
        return paneBox(
          id,
          <PanePlaceholder
            label={s ? labelFor(s) : "shell"}
            detail={exitLabels[sessionId]}
            tone="alert"
            focused={focusedPaneId === id}
            onRemove={() => onRemovePane(id)}
          />,
        );
      })}
      {/* Column dividers: drag to resize (snaps to thirds and fifths),
          double-click for equal columns. Row layout (≤3) has one per boundary;
          the ≥4 grid shares one column boundary across rows. */}
      {activeWin &&
        panes.length >= 2 &&
        (panes.length <= 3 ? rects.slice(1).map((r) => r.left) : [rects[1].left]).map((x, i) => (
          <div
            key={`divider-${i}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="resize panes"
            title="Drag to resize (snaps to thirds and fifths) — double-click for equal columns"
            onPointerDown={(e) => startColDrag(e, activeWin, i)}
            onDoubleClick={() => resetCols(activeWin)}
            className="absolute top-0 z-10 h-full w-2 -translate-x-1/2 cursor-col-resize transition-colors hover:bg-violet-500/40 active:bg-violet-500/60"
            style={{ left: `${x}%` }}
          />
        ))}
      {panes.length === 0 && (
        <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
          <TerminalSquare className="size-10" />
          <p className="text-sm">
            {activeFolderDir
              ? "No open panes — click a session in the rail, or use ✦ chat above for a Claude session rendered as structured turns."
              : "Select a folder in the rail to see its sessions."}
          </p>
        </div>
      )}
    </div>
  );
}
