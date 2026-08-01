import { PanePlaceholder } from "@/components/agentboard-bits";
import { AgentboardStandby, Centered } from "@/components/agentboard-standby";
import { ColdCacheOverlay, PaneHeader } from "@/components/agentboard-pane";
import { DiffPane } from "@/components/diff-pane";
import { FolderFilesPane, type FilesOpenRequest } from "@/components/files-pane";
import { JarvisPane } from "@/components/jarvis-pane";
import { PreviewPane } from "@/components/preview-pane";
import { TerminalView } from "@/components/terminal-view";
import {
  diffPaneDir,
  exitPaneSession,
  filesPaneDir,
  isDiffPane,
  isExitPane,
  isFilesPane,
  isJarvisPane,
  isPreviewPane,
  jarvisPaneDir,
  paneRects,
  previewPaneDir,
  type AgWindow,
  type FolderData,
  type RepoData,
  type SessionActions,
  type SessionData,
} from "@/lib/agentboard";
import type { PreviewRequest } from "@/lib/preview-artifact";
import type { TermExit } from "@/lib/term-protocol";
import { cn } from "@/lib/utils";
import { paneStyle } from "./helpers";
import type { ColumnDrag } from "./use-column-drag";

/** The pane area: one flat pool of mounted terminals (never remounted — a remount would respawn
 * the shell) plus the diff/files/preview/jarvis/tombstone panes, all absolutely positioned into
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
  /** Files an agent asked to show, by folder dir — see the MCP
   * `preview_file` tool (`lib/preview-artifact.ts`). */
  previewRequests: Record<string, PreviewRequest>;
  /** False when something must appear over the pane area — this screen isn't the active tab. */
  nativeVisible: boolean;
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
  onRemovePane: (paneId: string) => void;
  onSelectFolder: (dir: string) => void;
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
    now,
    actions,
    focusedPaneId,
    onFocusPane,
    termAttention,
    exitLabels,
    filesOpenRequests,
    previewRequests,
    nativeVisible,
    labelFor,
    focusTerminalRequest,
    onSelectSession,
    onExit,
    onTitle,
    onOpenTerminalPath,
    onRemovePane,
    onSelectFolder,
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
                // Amber (needs-you) wins the border over violet (focus) when both apply — see
                // the folder-rail-ui skill's "Two accent hues" rule; class order here matters
                // because `cn` (tailwind-merge) keeps only the last conflicting border-color
                // utility.
                focusedPaneId === id && "border-violet-500/60",
                termAttention[id] && "border-amber-500/70",
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
                  // Only folder-owned terminals can route links into a files
                  // pane; others keep the external-editor default.
                  onOpenPath={
                    termDir
                      ? (path, line) => void onOpenTerminalPath(termDir, id, path, line)
                      : undefined
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
            file={previewRequests[dir]}
            onClose={() => onRemovePane(id)}
          />,
        );
      })}
      {/* Jarvis panes: a rectangle of the window handed to Bevy as a real
          compositor surface. Rendered conditionally like the other view panes,
          which is affordable because unmounting one *retires* it rather than
          destroying it — the host parks the renderer and revives it if the
          pane comes back (`crates-tauri/tt-pane`). `visible` is threaded down
          because the surface composites *above* the webview: no DOM ancestor
          can hide it. */}
      {panes
        .filter(isJarvisPane)
        .map((id) =>
          paneBox(
            id,
            <JarvisPane
              folder={folderByDir.get(jarvisPaneDir(id) ?? "")}
              focused={focusedPaneId === id}
              visible={nativeVisible}
              onClose={() => onRemovePane(id)}
            />,
          ),
        )}
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
      {/* Nothing tiled. With a folder chosen that is a narrow, literal state and
          gets a sentence; with none, it is the screen you launch into, and
          `AgentboardStandby` answers "where do I go next" instead of deferring
          to the rail. */}
      {panes.length === 0 &&
        (activeFolderDir ? (
          <Centered>
            <p className="text-sm text-muted-foreground">
              No panes open here — click a session in the rail, or{" "}
              <span className="font-mono">+ session</span> above.
            </p>
          </Centered>
        ) : (
          <AgentboardStandby repos={repos} now={now} onSelectFolder={onSelectFolder} />
        ))}
    </div>
  );
}
