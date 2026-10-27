import { AgentboardStandby, Centered } from "@/components/agentboard-standby";
import { ColdCacheOverlay, PaneHeader } from "@/components/agentboard-pane";
import { JumpRecallCard } from "@/components/agentboard-jump-recall";
import { BrowserPane } from "@/components/browser-pane";
import { FolderFilesPane, type FilesOpenRequest } from "@/components/files-pane";
import { PreviewPane } from "@/components/preview-pane";
import { TerminalView } from "@/components/terminal-view";
import type { SessionActions } from "@/lib/agentboard/actions";
import { ownerRepoFromOrigin } from "@/lib/agentboard/folder";
import { paneRects } from "@/lib/agentboard/layout";
import {
  filesPaneDir,
  isFilesPane,
  isPreviewPane,
  previewPaneDir,
  browserPaneDir,
  isBrowserPane,
} from "@/lib/agentboard/pane-ids";
import type { AgWindow, FolderData, RepoData, SessionData } from "@/lib/agentboard/types";
import type { JumpRecall } from "@/lib/jump-recall";
import type { PreviewRequest } from "@/lib/preview-artifact";
import type { TermExit } from "@/lib/term-protocol";
import { cn } from "@/lib/utils";
import { paneStyle } from "./helpers";
import type { ColumnDrag } from "./use-column-drag";

/** The pane area: one flat pool of mounted terminals (never remounted — a remount would respawn
 * the shell) plus the files/preview/browser/tombstone panes, all absolutely positioned into
 * the active window's tiling. */
export function PaneGrid(props: {
  /** Session ids whose PTY is mounted, in mount order. */
  open: string[];
  /** The whole rail, for the nothing-selected standby board. */
  repos: RepoData[];
  /** Fallback cwd per session, for terminals whose folder isn't resolvable. */
  cwds: React.RefObject<Record<string, string>>;
  activeWin: AgWindow | undefined;
  activeFolderDir: string | null;
  sessionById: Map<string, SessionData>;
  folderOf: Map<string, FolderData>;
  folderByDir: Map<string, FolderData>;
  /** Every folder's repo, quiet ones included, for its GitHub `owner/name`. */
  repoByFolder: Map<string, RepoData>;
  now: number;
  actions: SessionActions;
  /** Which tile last claimed the click — the sole driver of the violet ring. */
  focusedPaneId: string | null;
  onFocusPane: (paneId: string) => void;
  /** Sessions whose program raised attention (BEL / OSC 9) since last looked at. */
  termAttention: Record<string, true>;
  filesOpenRequests: Record<string, FilesOpenRequest>;
  /** Files an agent asked to show, by folder dir — see the MCP
   * `preview_file` tool (`lib/preview-artifact.ts`). */
  previewRequests: Record<string, PreviewRequest>;
  /** The label to lead a session's pane with — live Claude title or backend name. */
  labelFor: (s: SessionData) => string;
  /** Terminal focus request: the session to focus, and a nonce so re-requesting
   * the same one still re-fires. */
  focusTerminalRequest: { id: string; nonce: number } | null;
  onSelectSession: (folderDir: string, sessionId: string) => void;
  onExit: (sessionId: string, exit: TermExit) => void;
  onTitle: (id: string, title: string) => void;
  onOpenTerminalPath: (
    dir: string,
    termId: string,
    path: string,
    line: number | null,
  ) => Promise<void>;
  onRevealTerminalPath: (dir: string, termId: string, path: string) => Promise<void>;
  onRemovePane: (paneId: string) => void;
  onSelectFolder: (dir: string) => void;
  /** Set by a keyboard jump only; null once dismissed or aged out. */
  jumpRecall: JumpRecall | null;
  onDismissJumpRecall: () => void;
  columns: ColumnDrag;
}) {
  const {
    open,
    repos,
    cwds,
    activeWin,
    activeFolderDir,
    sessionById,
    folderOf,
    folderByDir,
    repoByFolder,
    now,
    actions,
    focusedPaneId,
    onFocusPane,
    termAttention,
    filesOpenRequests,
    previewRequests,
    labelFor,
    focusTerminalRequest,
    onSelectSession,
    onExit,
    onTitle,
    onOpenTerminalPath,
    onRevealTerminalPath,
    onRemovePane,
    onSelectFolder,
    jumpRecall,
    onDismissJumpRecall,
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

  /** Every non-terminal pane kind shares this shell, and claims focus on the way *down*:
   * Chrome's canvas captures the pointer for CDP and Monaco eats mousedown, so a bubbling
   * handler leaves those panes unfocusable by the very act of using them. */
  const paneBox = (id: string, children: React.ReactNode) => {
    const r = rectFor(id);
    return (
      <div
        key={id}
        style={r ? paneStyle(r) : undefined}
        className="absolute p-1.5"
        onPointerDownCapture={() => onFocusPane(id)}
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
                // Amber (needs-you) beats violet (focus) — the visual-design
                // rule; order matters, tailwind-merge keeps the last border-color.
                focusedPaneId === id && "border-agent/60",
                termAttention[id] && "border-warn/70",
                // Same trade as the rail row: amber keeps the border, so focus
                // becomes a ring rather than disappearing under it.
                focusedPaneId === id && termAttention[id] && "ring-1 ring-inset ring-agent/70",
              )}
            >
              {s && (
                <PaneHeader
                  session={s}
                  label={labelFor(s)}
                  now={now}
                  actions={actions}
                  focused={focusedPaneId === id}
                />
              )}
              {/* data-term-host marks terminal territory for the shortcut
                  guard — keys typed here belong to the shell (Ctrl+D is EOF,
                  not "new session"). */}
              <div className="relative min-h-0 flex-1" data-term-host>
                <TerminalView
                  termId={id}
                  cwd={termDir ?? cwds.current[id]}
                  onExit={(exit) => onExit(id, exit)}
                  onTitle={onTitle}
                  // Only folder-owned terminals have a workbench to route a
                  // link into; a folderless one keeps the external editor.
                  onOpenPath={
                    termDir
                      ? (path, line) => void onOpenTerminalPath(termDir, id, path, line)
                      : undefined
                  }
                  onRevealPath={
                    termDir ? (path) => void onRevealTerminalPath(termDir, id, path) : undefined
                  }
                  ghRepo={
                    termDir ? ownerRepoFromOrigin(repoByFolder.get(termDir)?.originUrl) : undefined
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
                {jumpRecall?.sessionId === id && (
                  <JumpRecallCard
                    key={jumpRecall.nonce}
                    recall={jumpRecall}
                    onDismiss={onDismissJumpRecall}
                  />
                )}
              </div>
            </div>
          </div>
        );
      })}
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
            file={previewRequests[dir]}
            onClose={() => onRemovePane(id)}
          />,
        );
      })}
      {/* Chrome panes: a real headless Chrome streamed onto a canvas — the
          process lives in the Rust BrowserHost, so conditional rendering is
          safe: unmount closes the pane's tab, sign-ins persist in the
          profile. */}
      {panes.filter(isBrowserPane).map((id) => {
        const dir = browserPaneDir(id) ?? "";
        return paneBox(
          id,
          <BrowserPane
            folder={folderByDir.get(dir)}
            focused={focusedPaneId === id}
            onClose={() => onRemovePane(id)}
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
            className="absolute top-0 z-10 h-full w-2 -translate-x-1/2 cursor-col-resize transition-colors hover:bg-agent/40 active:bg-agent/60"
            style={{ left: `${x}%` }}
          />
        ))}
      {/* Nothing tiled. With a folder chosen that is a narrow, literal state and
          gets a sentence; with none, it is the screen you launch into, and
          `AgentboardStandby` answers "where do I go next" instead of deferring
          to the rail. */}
      {panes.length === 0 &&
        (activeFolderDir ? (
          <Centered>
            <p className="text-sm text-muted-foreground">
              No panes open here — open a session from Agent Board, or{" "}
              <span className="font-mono">+ session</span> above.
            </p>
          </Centered>
        ) : (
          <AgentboardStandby repos={repos} now={now} onSelectFolder={onSelectFolder} />
        ))}
    </div>
  );
}
