import { Fragment, useEffect, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import {
  ArrowLeft,
  ArrowRight,
  AtSign,
  Code2,
  Columns2,
  Eye,
  Files,
  Maximize2,
  Minimize2,
  RefreshCw,
  Search,
  WrapText,
  X,
} from "lucide-react";
import { CodeViewer, isAnchored, type ViewerAnchor } from "@/components/code-viewer";
import { EditableToggle } from "@/components/editable-toggle";
import { ClaudeBadge, IconBtn, LspBadge, PanePlaceholder } from "@/components/agentboard-bits";
import { PaneChrome, PaneLens } from "@/components/pane-chrome";
import { FilePreview } from "@/components/file-preview";
import { Kbd } from "@/components/ui/kbd";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { CodeServerPane } from "@/components/code-server-pane";
import { useCodeServerEditor } from "@/lib/code-server";
import { ideMention, useIdeConnected } from "@/lib/ide";
import { useLspStatus } from "@/lib/lsp-status";
import {
  attachExplorer,
  openSidebarView,
  runMonacoCommand,
  setMonacoOpenHandler,
  setMonacoWorkspace,
  watchSidebarView,
  type SidebarView,
} from "@/lib/monaco";
import { EditorFontButtons } from "@/components/editor-font-buttons";
import { EditorTabBar } from "@/components/editor-tab-bar";
import {
  back,
  canGoBack,
  canGoForward,
  currentPath,
  forward,
  NO_HISTORY,
  openPath as visitPath,
  type FileHistory,
} from "@/lib/editor-history";
import {
  mruNext,
  nextAfterClose,
  NO_TABS,
  reopenTarget,
  tabsOnClose,
  tabsOnOpen,
  type PaneTabs,
} from "@/lib/editor-tabs";
import {
  flushEditorCheckoutPrefsSave,
  loadEditorCheckoutPrefs,
  scheduleEditorCheckoutPrefsSave,
} from "@/lib/editor-checkout-prefs";
import { mouseAction } from "@/lib/shortcut-coach";
import {
  initialViewMode,
  modeForPanels,
  panelsFor,
  type EditorViewMode,
} from "@/lib/editor-view-mode";
import { IS_MAC, matchesShortcut } from "@/lib/shortcuts";
import { hasRenderedView, previewKindFor } from "@/lib/preview-kind";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";
import type { FolderData } from "@/lib/agentboard";

/** VS Code's real Explorer beside a Monaco viewer, the checkout as workspace, with a tab bar
 * of open files above the editor. Opens editable; the header toggle locks a pane. An image or
 * video *replaces* the editor rather than splitting against it: Monaco cannot open one. */

/** Claude called openFile — focus this file (new nonce per request). */
export type FilesOpenRequest = { path: string; anchor: ViewerAnchor; nonce: number };

const MOD = IS_MAC ? "⌘" : "Ctrl";
const SHIFT = IS_MAC ? "⇧" : "Shift";
const ALT = IS_MAC ? "⌥" : "Alt";
const CTRL = IS_MAC ? "⌃" : "Ctrl";
const LEFT = IS_MAC ? "←" : "Left";
const RIGHT = IS_MAC ? "→" : "Right";

function chord(...caps: string[]): string {
  return caps.join(IS_MAC ? "" : "+");
}

const EDITOR_HINTS: { keys: string; what: string }[] = [
  { keys: chord(MOD, "P"), what: "jump to a file by name" },
  { keys: chord(MOD, "F"), what: "find in the open file" },
  { keys: chord(ALT, "Click"), what: "add another cursor" },
  { keys: chord(MOD, "D"), what: "select the next occurrence" },
  { keys: chord(MOD, SHIFT, "A"), what: "mention the selected lines" },
  { keys: chord(CTRL, "Tab"), what: "switch between open tabs" },
  { keys: chord(ALT, LEFT), what: "back to the file you came from" },
];

function EditorHints() {
  return (
    <dl className="hidden grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 text-xs @[22rem]/hints:grid">
      {EDITOR_HINTS.map(({ keys, what }) => (
        <Fragment key={keys}>
          <dt className="justify-self-end">
            <Kbd className="font-mono">{keys}</Kbd>
          </dt>
          <dd className="text-left text-muted-foreground">{what}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** Silent unless the bridge has something to say (a non-Rust checkout). */
function LspChip({ dir }: { dir: string }) {
  const { state, detail } = useLspStatus(dir);
  if (state === "off") return null;
  return <LspBadge state={state} detail={detail} />;
}

export function FilesPane({
  dir,
  connected,
  openRequest,
  onOpenFileChange,
  onSidebarViewChange,
}: {
  dir: string;
  connected: boolean;
  openRequest?: FilesOpenRequest;
  /** The header lives in `FolderFilesPane`, outside Monaco's subtree, so what's
   * open has to be reported up to it. */
  onOpenFileChange?: (open: { path: string; dirty: boolean } | null) => void;
  onSidebarViewChange?: (view: SidebarView | null) => void;
}) {
  const [history, setHistory] = useState<FileHistory>(NO_HISTORY);
  const open = currentPath(history);
  const openPath = (path: string) => setHistory((h) => visitPath(h, path));
  const [dirty, setDirty] = useState(false);
  // The tab set follows `open` (one sync point) rather than every open path.
  const [tabs, setTabs] = useState<PaneTabs>(NO_TABS);
  useEffect(() => {
    if (open) setTabs((t) => tabsOnOpen(t, open));
  }, [open]);
  // An effect, not a call in each setter: `open`/`dirty` move from four places
  // and one effect can't drift out of sync with them.
  useEffect(() => {
    onOpenFileChange?.(open ? { path: open, dirty } : null);
  }, [open, dirty, onOpenFileChange]);

  const [wordWrap, setWordWrap] = useState(true);
  // Per-pane rather than per-file: locking a pane holds for the sitting.
  const [editable, setEditable] = useState(true);
  const [viewMode, setViewMode] = useState<EditorViewMode>("code");
  // The sidebar part is a workbench singleton that switches view without asking
  // ("Find in Folder"), so follow it rather than tracking our own idea of it.
  const [sidebarView, setSidebarView] = useState<SidebarView | null>(null);
  useEffect(() => watchSidebarView(setSidebarView), []);
  useEffect(() => {
    onSidebarViewChange?.(sidebarView);
  }, [sidebarView, onSidebarViewChange]);
  const [fullscreen, setFullscreen] = useState(false);
  const explorerRef = useRef<HTMLDivElement>(null);
  const editorPanelRef = useRef<PanelImperativeHandle>(null);
  const previewPanelRef = useRef<PanelImperativeHandle>(null);
  // Set while the effect below drives the panels, so the `onResize` echo isn't
  // read back as a user drag — otherwise the two directions chase each other.
  const drivingPanelsRef = useRef(false);

  // A genuine dir *change* only: the openRequest below may have just created
  // this pane, and a mount-time reset would clobber it.
  const prevDirRef = useRef(dir);
  useEffect(() => {
    if (prevDirRef.current === dir) return;
    prevDirRef.current = dir;
    setHistory(NO_HISTORY);
    setTabs(NO_TABS);
    setDirty(false);
    setEditable(true);
  }, [dir]);

  useEffect(() => {
    if (openRequest) setHistory((h) => visitPath(h, openRequest.path));
  }, [openRequest]);

  // The lock and wrap only: a mount happens on every folder switch, so
  // restoring what was open would put a file on screen with no gesture behind
  // it. `prefsDir` gates saving, or a pane mid-load writes defaults over it.
  const [prefsDir, setPrefsDir] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    setPrefsDir(null);
    void loadEditorCheckoutPrefs(dir).then((prefs) => {
      if (stale) return;
      if (prefs) {
        setWordWrap(prefs.wordWrap);
        setEditable(prefs.editable);
      }
      setPrefsDir(dir);
    });
    return () => {
      stale = true;
      flushEditorCheckoutPrefsSave(dir);
    };
  }, [dir]);
  useEffect(() => {
    if (prefsDir !== dir) return;
    scheduleEditorCheckoutPrefsSave(dir, { v: 1, wordWrap, editable });
  }, [dir, prefsDir, wordWrap, editable]);

  // What a newly opened file starts in is `initialViewMode`'s call. Reset in
  // the render that opens it, not an effect: the panel-driving effect below
  // runs in that same commit and would flash the outgoing file's mode first.
  const openKey = `${openRequest?.nonce ?? ""}\0${open ?? ""}`;
  const [modeSetFor, setModeSetFor] = useState(openKey);
  if (modeSetFor !== openKey) {
    setModeSetFor(openKey);
    const anchored = openRequest?.path === open && isAnchored(openRequest.anchor);
    setViewMode(initialViewMode(open ? previewKindFor(open) : null, anchored));
  }

  // The fullscreen toggle lives in the header, which only renders while a file
  // is open — so closing the file must drop it, or the pane is stuck.
  useEffect(() => {
    if (!open) setFullscreen(false);
  }, [open]);

  const navigate = (direction: "back" | "forward") => {
    setHistory((h) => (direction === "back" ? back(h) : forward(h)));
    uiAction("files.navigate", "agentboard", direction);
  };

  const selectTab = (path: string) => {
    openPath(path);
    uiAction("files.tab_select", "agentboard");
  };
  const closeTab = (path: string, via: "key" | "mouse") => {
    const wasActive = open === path;
    const next = wasActive ? nextAfterClose(tabs, path) : null;
    setTabs((t) => tabsOnClose(t, path));
    // Closing the last tab must also empty the history, or `open` (derived
    // from it) would resurrect the file on the next render.
    if (wasActive) setHistory(next ? (h) => visitPath(h, next) : NO_HISTORY);
    if (via === "key") uiAction("shortcut.files-close-tab", "agentboard");
    else if (wasActive) mouseAction("files-close-tab", "agentboard");
    else uiAction("files.tab_close", "agentboard");
  };
  const reopenTab = () => {
    const target = reopenTarget(tabs);
    if (!target) return false;
    // `tabsOnOpen` (via the open sync) pulls it back off the closed stack.
    openPath(target);
    uiAction("shortcut.files-reopen-tab", "agentboard");
    return true;
  };

  const onPaneKeyDown = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      const direction = e.key === "ArrowLeft" ? "back" : e.key === "ArrowRight" ? "forward" : null;
      if (!direction) return;
      e.preventDefault();
      navigate(direction);
      return;
    }
    // Consumed here so the window-level `close-tab` (same chord, workspace
    // tabs) never sees a ⌘W meant for a file tab — hence the stopPropagation.
    if (open && matchesShortcut("files-close-tab", e.nativeEvent)) {
      e.preventDefault();
      e.stopPropagation();
      closeTab(open, "key");
      return;
    }
    if (matchesShortcut("files-reopen-tab", e.nativeEvent)) {
      if (reopenTab()) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    // Bare-Ctrl chords can't live in the registry (mac aliasing), so Ctrl+Tab
    // is matched by hand — the same spelling VS Code uses on both platforms.
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key === "Tab") {
      const next = mruNext(tabs, open);
      if (!next) return;
      e.preventDefault();
      e.stopPropagation();
      openPath(next);
      uiAction("files.tab_cycle", "agentboard");
    }
  };

  // Bubble phase plus `defaultPrevented` keep Escape from being stolen from Monaco, which
  // prevents the default whenever it consumes one. An open Radix dialog closes first, likewise.
  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      e.preventDefault();
      setFullscreen(false);
      uiAction("files.fullscreen", "agentboard", "escape");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullscreen]);

  const previewKind = open ? previewKindFor(open) : null;
  // Two shapes hide behind "not plain source": one splits against the editor,
  // the other replaces it — an image split would leave a permanently empty half.
  const splitKind = hasRenderedView(previewKind) ? previewKind : null;
  const mediaKind = previewKind !== null && !hasRenderedView(previewKind) ? previewKind : null;

  // Split sizes explicitly rather than leaning on `expand()`, which restores a
  // panel's *most recent* size — 0 for a preview never opened, so a sliver.
  useEffect(() => {
    if (!splitKind) return;
    const editor = editorPanelRef.current;
    const preview = previewPanelRef.current;
    if (!editor || !preview) return;
    const want = panelsFor(viewMode);
    drivingPanelsRef.current = true;
    if (want.editor && want.preview) {
      editor.expand();
      preview.expand();
      editor.resize("50%");
      preview.resize("50%");
    } else if (want.editor) {
      editor.expand();
      preview.collapse();
    } else {
      preview.expand();
      editor.collapse();
    }
    const settled = setTimeout(() => {
      drivingPanelsRef.current = false;
    }, 0);
    return () => clearTimeout(settled);
  }, [viewMode, splitKind]);

  // …and read the mode back off the panels when the *user* moves the handle,
  // so dragging one shut lights the matching toolbar button.
  const syncModeFromPanels = () => {
    if (drivingPanelsRef.current) return;
    const editor = editorPanelRef.current;
    const preview = previewPanelRef.current;
    if (!editor || !preview) return;
    setViewMode(modeForPanels(!editor.isCollapsed(), !preview.isCollapsed()));
  };

  // This pane is the VS Code workspace. Keyed on `open` too — panes stay mounted forever, so the
  // pane the user last opened a file in wins, stealing workspace, sidebar and open handler.
  useEffect(() => {
    let disposed = false;
    let detach: (() => void) | null = null;
    setMonacoWorkspace(dir).catch((e: unknown) => {
      console.error("[files] failed to set the VS Code workspace", e);
    });
    if (explorerRef.current) {
      attachExplorer(explorerRef.current)
        .then((d) => {
          if (disposed) d();
          else detach = d;
        })
        .catch((e: unknown) => {
          console.error("[files] failed to attach the Explorer", e);
        });
    }
    setMonacoOpenHandler((absolutePath) => {
      if (absolutePath.startsWith(`${dir}/`)) openPath(absolutePath.slice(dir.length + 1));
    });
    return () => {
      disposed = true;
      detach?.();
      setMonacoOpenHandler(null);
    };
  }, [dir, open]);

  // Whole-file only. A range mention is the viewer's own gesture: it needs the
  // live selection, which only the editor has.
  const mention = (path: string) => void ideMention(dir, path, null);

  return (
    <div
      onKeyDown={onPaneKeyDown}
      className={cn(
        "flex min-h-0 flex-1 overflow-hidden rounded-lg border",
        // Fullscreen leaves the pane in the React tree: portalling remounts
        // `CodeViewer`, losing the undo stack and scroll position.
        fullscreen && "fixed inset-0 z-50 rounded-none border-0 bg-background",
      )}
    >
      <div className="flex w-64 shrink-0 flex-col border-r bg-card">
        <div className="flex shrink-0 items-center gap-1.5 border-b bg-card px-2 py-1.5">
          <span className="flex shrink-0 items-center gap-0.5">
            {(
              [
                { view: "explorer", icon: Files, title: "Browse the file tree" },
                { view: "search", icon: Search, title: "Search this folder" },
              ] as const
            ).map(({ view, icon: Icon, title }) => (
              <IconBtn
                key={view}
                title={title}
                onClick={() => {
                  void openSidebarView(view);
                  uiAction("files.sidebar_view", "agentboard", view);
                }}
                className={sidebarView === view ? "text-violet-500" : undefined}
              >
                <Icon className="size-3.5" />
              </IconBtn>
            ))}
          </span>
          <span className="min-w-0 flex-1" />
          <LspChip dir={dir} />
          {sidebarView !== "search" && (
            <IconBtn
              title="refresh the explorer"
              onClick={() => void runMonacoCommand("workbench.files.action.refreshFilesExplorer")}
              className="hover:text-sky-500"
            >
              <RefreshCw className="size-3" />
            </IconBtn>
          )}
        </div>
        <div ref={explorerRef} className="min-h-0 flex-1 overflow-hidden" />
        <div className="shrink-0 border-t bg-card px-2 py-1 text-[10.5px] text-muted-foreground">
          <span className="font-mono text-violet-500">@</span> mentions the open file — select lines
          and {chord(MOD, SHIFT, "A")} to mention a range
          {connected ? "" : " — no session connected yet"}
          <span className="mt-0.5 block font-mono">
            {chord(MOD, "P")} files · {chord(MOD, "F")} find
          </span>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {tabs.order.length > 0 && (
          <EditorTabBar
            tabs={tabs.order}
            active={open}
            dirty={dirty}
            onSelect={selectTab}
            onClose={(path) => closeTab(path, "mouse")}
          />
        )}
        {open ? (
          <>
            {/* `PaneChrome`'s three-column row, so the lock lands in the same
             * place whichever pane you're in. */}
            <div className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 border-b bg-card px-3 py-1.5">
              <span className="flex min-w-0 items-center gap-2">
                <span className="flex shrink-0 items-center gap-0.5">
                  {(
                    [
                      {
                        direction: "back",
                        icon: ArrowLeft,
                        label: "Back",
                        can: canGoBack(history),
                      },
                      {
                        direction: "forward",
                        icon: ArrowRight,
                        label: "Forward",
                        can: canGoForward(history),
                      },
                    ] as const
                  ).map(({ direction, icon: Icon, label, can }) => (
                    <IconBtn
                      key={direction}
                      title={`${label} (${chord(ALT, direction === "back" ? LEFT : RIGHT)})`}
                      disabled={!can}
                      onClick={() => navigate(direction)}
                    >
                      <Icon className="size-3.5" />
                    </IconBtn>
                  ))}
                </span>
                <span className="min-w-0 truncate font-mono text-xs text-foreground" title={open}>
                  {open}
                </span>
                {dirty && (
                  <span
                    title={`Unsaved changes — autosaves after a pause; ${chord(MOD, "S")} saves now`}
                    className="size-1.5 shrink-0 rounded-full bg-amber-500"
                  />
                )}
              </span>
              {mediaKind === null && (
                <EditableToggle
                  editable={editable}
                  subject="this file"
                  onChange={(next) => {
                    setEditable(next);
                    uiAction("files.editable", "agentboard", next ? "on" : "off");
                  }}
                />
              )}
              {/* `min-w-max` so the toolbar's buttons can't spill leftward
               * over the centered toggle — see `PaneChrome`'s grid. */}
              <span className="flex min-w-max items-center justify-end gap-2">
                {mediaKind === null && (
                  <>
                    <EditorFontButtons />
                    <IconBtn
                      title={
                        wordWrap
                          ? "Wrapping long lines — click to scroll instead"
                          : "Scrolling long lines — click to wrap instead"
                      }
                      onClick={() => setWordWrap((w) => !w)}
                      className={wordWrap ? "text-violet-500" : undefined}
                    >
                      <WrapText className="size-3.5" />
                    </IconBtn>
                  </>
                )}
                {splitKind && (
                  <span className="flex shrink-0 items-center gap-0.5">
                    {(
                      [
                        { mode: "code", icon: Code2, title: "Code only" },
                        {
                          mode: "split",
                          icon: Columns2,
                          title: `Code and ${splitKind} side by side`,
                        },
                        { mode: "preview", icon: Eye, title: `Rendered ${splitKind} only` },
                      ] as const
                    ).map(({ mode, icon: Icon, title }) => (
                      <IconBtn
                        key={mode}
                        title={title}
                        onClick={() => {
                          setViewMode(mode);
                          uiAction("files.view_mode", "agentboard", mode);
                        }}
                        className={viewMode === mode ? "text-violet-500" : undefined}
                      >
                        <Icon className="size-3.5" />
                      </IconBtn>
                    ))}
                  </span>
                )}
                <IconBtn
                  title={fullscreen ? "Exit fullscreen (Escape)" : "Fill the window"}
                  onClick={() => {
                    setFullscreen((f) => !f);
                    uiAction("files.fullscreen", "agentboard", fullscreen ? "off" : "on");
                  }}
                  className={fullscreen ? "text-violet-500" : undefined}
                >
                  {fullscreen ? (
                    <Minimize2 className="size-3.5" />
                  ) : (
                    <Maximize2 className="size-3.5" />
                  )}
                </IconBtn>
                <button
                  type="button"
                  title={
                    connected
                      ? `Mention this whole file to the Claude session — select lines and press ${chord(MOD, SHIFT, "A")} to mention just those`
                      : "Run `claude` in this folder's terminal first"
                  }
                  onClick={() => mention(open)}
                  className={cn(
                    "flex shrink-0 items-center gap-0.5 rounded-sm px-1.5 py-0.5 font-mono text-[10.5px]",
                    connected ? "text-violet-500 hover:bg-accent" : "text-muted-foreground/50",
                  )}
                >
                  <AtSign className="size-3" /> send to claude
                </button>
              </span>
            </div>
            <div className="min-h-0 flex-1">
              {mediaKind ? (
                <FilePreview dir={dir} path={open} kind={mediaKind} />
              ) : splitKind ? (
                // Both panels stay mounted in all three modes — see
                // `lib/editor-view-mode.ts` for why collapsing beats unmounting.
                <ResizablePanelGroup orientation="horizontal">
                  <ResizablePanel
                    panelRef={editorPanelRef}
                    defaultSize="50%"
                    minSize="20%"
                    collapsible
                    collapsedSize="0%"
                    onResize={syncModeFromPanels}
                  >
                    <CodeViewer
                      dir={dir}
                      path={open}
                      wordWrap={wordWrap}
                      editable={editable}
                      connected={connected}
                      anchor={
                        openRequest && openRequest.path === open
                          ? { ...openRequest.anchor, nonce: openRequest.nonce }
                          : undefined
                      }
                      onDirtyChange={setDirty}
                    />
                  </ResizablePanel>
                  <ResizableHandle withHandle />
                  <ResizablePanel
                    panelRef={previewPanelRef}
                    defaultSize="50%"
                    minSize="20%"
                    collapsible
                    collapsedSize="0%"
                    onResize={syncModeFromPanels}
                  >
                    <FilePreview dir={dir} path={open} kind={splitKind} onOpenPath={openPath} />
                  </ResizablePanel>
                </ResizablePanelGroup>
              ) : (
                <CodeViewer
                  dir={dir}
                  path={open}
                  wordWrap={wordWrap}
                  editable={editable}
                  connected={connected}
                  anchor={
                    openRequest && openRequest.path === open
                      ? { ...openRequest.anchor, nonce: openRequest.nonce }
                      : undefined
                  }
                  onDirtyChange={setDirty}
                />
              )}
            </div>
          </>
        ) : (
          <div className="@container/hints flex h-full flex-col items-center justify-center gap-4 px-4 text-center">
            <p className="text-sm text-muted-foreground">
              Select a file — selections in the viewer stream to Claude
            </p>
            <EditorHints />
          </div>
        )}
      </div>
    </div>
  );
}

/** A folder's file tree as a *pane* in the Agentboard tiling — `DiffPane`'s sibling. Claude's
 * openFile requests arrive as `openRequest`, the screen opening the pane first if none existed. */
export function FolderFilesPane({
  folder,
  focused,
  onClose,
  openRequest,
}: {
  /** The checkout this pane browses; undefined when it left the rail. */
  folder: FolderData | undefined;
  focused: boolean;
  onClose: () => void;
  openRequest?: FilesOpenRequest;
}) {
  const ideConnected = useIdeConnected(folder?.dir);
  // The spike's swap: same pane, same chrome, a whole other editor inside.
  const [codeServer] = useCodeServerEditor();
  const [openFile, setOpenFile] = useState<{ path: string; dirty: boolean } | null>(null);
  const [sidebarView, setSidebarView] = useState<SidebarView | null>(null);
  if (!folder) return <PanePlaceholder label="folder gone" focused={focused} onRemove={onClose} />;
  return (
    <div
      className={cn(
        "flex h-full flex-col overflow-hidden rounded-lg border bg-card",
        focused && "border-violet-500/60",
      )}
    >
      <PaneChrome
        lens={<PaneLens kind="files" />}
        subject={
          codeServer ? (
            <span className="text-muted-foreground">code-server</span>
          ) : openFile ? (
            <>
              {openFile.path}
              {openFile.dirty && <span className="text-amber-500"> •</span>}
            </>
          ) : (
            <span className="text-muted-foreground">{sidebarView ?? "explorer"}</span>
          )
        }
        subjectTitle={openFile?.path}
        controls={ideConnected ? <ClaudeBadge /> : undefined}
        actions={
          <IconBtn
            title="close pane (files stay a click away on the folder)"
            shortcut={focused ? "ab-close-pane" : undefined}
            onClick={onClose}
            className="hover:text-sky-500"
          >
            <X className="size-3" />
          </IconBtn>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col p-2">
        {codeServer ? (
          <CodeServerPane dir={folder.dir} />
        ) : (
          <FilesPane
            dir={folder.dir}
            connected={ideConnected}
            openRequest={openRequest}
            onOpenFileChange={setOpenFile}
            onSidebarViewChange={setSidebarView}
          />
        )}
      </div>
    </div>
  );
}
