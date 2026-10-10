import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { FolderPlusIcon, GitBranchIcon } from "@phosphor-icons/react";
import { fmtMins } from "@/components/agentboard-bits";
import { WorkingContext } from "@/components/agentboard-working-context";
import { CockpitHeader } from "@/components/cockpit-header";
import { CockpitIssues } from "@/components/cockpit-issues";
import {
  CockpitRail,
  FOLDED_BY_DEFAULT,
  NextUpBanner,
  openQueueLink,
  QueueDetail,
  RailDrawer,
  rerankQueueItem,
  startQueueItem,
} from "@/components/cockpit-rail";
import { RailIconStrip, RollupChip } from "@/components/agentboard-rail";
import { RepoGroup } from "@/components/agentboard-repo-group";
import { NativePane } from "@/components/native-pane";
import { useNow, useNowInterval } from "@/lib/now";
import { BlockedDeleteDialog } from "@/components/task-blockers";
import type { FilesOpenRequest } from "@/components/files-pane";
import { Button } from "@cloudflare/kumo";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cleanupMissing, closeOnFalse } from "./cockpit/helpers";
import { useCollapseState } from "./cockpit/use-collapse-state";
import { useColumnDrag } from "./cockpit/use-column-drag";
import { useAttention } from "./cockpit/use-attention";
import { useRailIndex } from "./cockpit/use-rail-index";
import { useTaskCreation } from "./cockpit/use-task-creation";
import { useTauriEvent } from "./cockpit/use-tauri-event";
import { useWindowLayout } from "./cockpit/use-window-layout";
import { useWorktreeDelete } from "./cockpit/use-worktree-delete";
import { PaneGrid } from "./cockpit/pane-grid";
import { RailHeader } from "./cockpit/rail-header";
import { WindowStrip } from "./cockpit/window-strip";
import {
  DeleteWorktreeDialog,
  RemoveRepoDialog,
  SplitSessionDialog,
  StartClaudeDialog,
} from "./cockpit/dialogs";
import {
  claudeCommand,
  claudeResumeCommand,
  claudeTitleName,
  moveFocus,
  consumePendingAgentboardNav,
  consumePendingOpenSessions,
  cycleNotBusy,
  exitPaneId,
  filesPaneId,
  filesPaneTarget,
  folderBusy,
  folderRecreateBranch,
  folderRemovableTask,
  folderRemoving,
  isAgent,
  isCacheExpiring,
  browserPaneId,
  jarvisPaneId,
  liveSessions,
  nextOpenFileNonce,
  nextWindowId,
  paneCloseTarget,
  onAgentboardNavRequest,
  onOpenSessionRequest,
  abSetSessionPurpose,
  prForFolder,
  previewPaneId,
  sessionLabel,
  sleep,
  successorPane,
  taskForFolder,
  folderTask,
  termWriteRetry,
  useAgentboardState,
  useSetAgentOverlay,
  waitForFirstFrame,
  OVERLAY_STARTED,
  OVERLAY_STOPPED,
  type AgentboardNav,
  type FocusLevel,
  type FolderData,
  type ClaudeLaunchOptions,
  type PendingOpenSession,
  type RemoveTarget,
  type RepoData,
  type Selected,
  type SessionActions,
  type SessionData,
  type StartClaudeTarget,
} from "@/lib/agentboard";
import { errorMessage } from "@/lib/errors";
import { launchCommand, launchRegister, type LaunchConfigStatus } from "@/lib/launch";
import { buildJumpRecall, type JumpRecall } from "@/lib/jump-recall";
import type { PreviewRequest } from "@/lib/preview-artifact";
import { exitIsCrash, exitLabel, type TermExit } from "@/lib/term-protocol";
import { codeServerOpenClaudeSession } from "@/lib/code-server";
import { invoke } from "@/lib/tauri";
import type { OpenFileRequest } from "@/lib/ide";
import { shortcutHint, useModifierHeld, useShortcuts } from "@/lib/shortcuts";
import { isItemDismissed, useStoreSnapshot } from "@/lib/data";
import {
  cycleQueue,
  keyId,
  nextItem,
  nextUpArrival,
  onYouHead,
  primaryAction,
  railRows,
  rowForFolder,
  stepRow,
  useTaskQueue,
} from "@/lib/queue";
import type { Lane, QueueItem } from "@/lib/schemas/queue";
import { mouseAction } from "@/lib/shortcut-coach";
import { focusTargetStore, useFocusTarget } from "@/lib/focus-target";
import { railRowMotion } from "@/lib/rail-motion";
import { AnimatePresence, motion } from "motion/react";
import {
  useBrowserPane,
  useJarvisPane,
  useShowQuiet,
  useRailFilter,
  useShowUnmanagedWorktrees,
} from "@/lib/rail-prefs";
import { useWorkspace } from "@/lib/workspace";
import { repoParentDirs } from "@/lib/new-repo";
import { untrackRepo } from "@/lib/repo-actions";
import { uiAction } from "@/lib/ui-action";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/** A stub row's peek, toggled per repo. The event is emitted outside the
 * updater: a state updater must stay pure, or StrictMode double-counts it. */
function togglePeek(
  revealed: Set<string>,
  set: Dispatch<SetStateAction<Set<string>>>,
  event: "agentboard.idle_peek" | "agentboard.unmanaged_peek",
) {
  return (repoKey: string) => {
    uiAction(event, "cockpit", revealed.has(repoKey) ? "hide" : "show");
    set((keys) => {
      const next = new Set(keys);
      if (!next.delete(repoKey)) next.add(repoKey);
      return next;
    });
  };
}

/** Release the shell's claim on the keyboard when focus moves off its pane. */
function blurTerminal() {
  const el = document.activeElement;
  if (el instanceof HTMLElement && el.closest("[data-term-host]")) el.blur();
}

/** Someone is typing in a shell — the one thing Next up must never interrupt. */
function terminalFocused(): boolean {
  const el = document.activeElement;
  return (
    document.hasFocus() && el instanceof HTMLElement && el.closest("[data-term-host]") !== null
  );
}

const CHECKOUTS_OPEN_KEY = "tt-cockpit-checkouts-open";

/** Cockpit — the agent board, driven by the queue. The rail is everything
 * waiting on you (Next up, then the lanes); picking a row puts that item's
 * terminals and panes beside it. Agent status is reported, never re-rendered. */
export function CockpitScreen() {
  const state = useAgentboardState();
  const { snapshot, live: storeLive } = useStoreSnapshot();
  const { openTab, activeTab, openSettingsTab } = useWorkspace();
  // Deep-link focus: a "needs you" popover row scrolls its PR or repo into view here.
  const focusRef = useFocusTarget<HTMLDivElement>("cockpit");
  const now = useNow();
  const repos = state.repos;

  const [selected, setSelected] = useState<Selected>(null);
  const [jumpRecall, setJumpRecall] = useState<JumpRecall | null>(null);
  // A ref, not previous state: `selectSession` clears the card in the same batch that sets it.
  const jumpNonce = useRef(0);
  // The tile that last claimed a click — the sole driver of the violet ring.
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null);
  const [focusLevel, setFocusLevel] = useState<FocusLevel>("rail");
  const { queue, live: queueLive } = useTaskQueue();
  // The picked row. A row with a checkout also drives `activeFolderDir`; one
  // without (a backlog task, a PR, a CI failure) shows its detail instead.
  const [selKey, setSelKey] = useState<string | null>(null);
  const [foldedLanes, setFoldedLanes] = useState<Set<Lane>>(() => new Set(FOLDED_BY_DEFAULT));
  // Next up changed while you were busy: the key it was announced for.
  const [announced, setAnnounced] = useState<string | null>(null);
  // The row whose snooze menu is open — `z` opens it from the keyboard.
  const [snoozeKey, setSnoozeKey] = useState<string | null>(null);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [checkoutsOpen, setCheckoutsOpen] = useState(
    () => localStorage.getItem(CHECKOUTS_OPEN_KEY) === "1",
  );
  // The nonce lets a re-request of the *same* session still fire.
  const [focusTerminalRequest, setFocusTerminalRequest] = useState<{
    id: string;
    nonce: number;
  } | null>(null);
  const [activeFolderDir, setActiveFolderDir] = useState<string | null>(null);
  // Shown only with more than one candidate; a single one is added directly.
  const [splitOpen, setSplitOpen] = useState(false);
  // Pending remove awaiting confirmation because it would kill live sessions.
  const [confirmRemove, setConfirmRemove] = useState<RemoveTarget | null>(null);
  const [startClaudeTarget, setStartClaudeTarget] = useState<StartClaudeTarget | null>(null);
  const [startClaudePrompt, setStartClaudePrompt] = useState("");
  // Session ids whose PTY is mounted (kept alive for scrollback), + their cwd.
  const [open, setOpen] = useState<string[]>([]);
  const cwds = useRef<Record<string, string>>({});
  // Only *crashes* land here — a clean logout takes its pane with it.
  const [exitLabels, setExitLabels] = useState<Record<string, string>>({});
  const expectedKills = useRef<Set<string>>(new Set());
  const { collapsed, toggleCollapsed, railCollapsed, toggleRail } = useCollapseState(state);
  // Filtered-out folders demote to a per-repo "N idle" stub, never hidden.
  const { filter, recentHours, setFilter, setRecentHours } = useRailFilter();
  // Whether worktrees `tt task` didn't create get rail folders at all.
  const [showUnmanagedWorktrees, setShowUnmanagedWorktrees] = useShowUnmanagedWorktrees();
  const [jarvisPane, setJarvisPane] = useJarvisPane();
  const [browserPane] = useBrowserPane();
  const nativeVisible = activeTab === "cockpit";
  // The idle stub's peek is view state — it belongs to one glance at one repo.
  // Quiet is a persisted view mode instead: its switch is in the rail header,
  // so the hiding is never something you can't find your way back out of.
  const [idleRevealed, setIdleRevealed] = useState<Set<string>>(new Set());
  const [unmanagedRevealed, setUnmanagedRevealed] = useState<Set<string>>(new Set());
  const [showQuiet, setShowQuiet] = useShowQuiet();
  // Never persisted: a rail that opened already narrowed to yesterday's search
  // is a rail with repos missing and no memory of why.
  const [query, setQuery] = useState("");
  const toggleIdleRevealed = togglePeek(idleRevealed, setIdleRevealed, "agentboard.idle_peek");
  const toggleUnmanagedRevealed = togglePeek(
    unmanagedRevealed,
    setUnmanagedRevealed,
    "agentboard.unmanaged_peek",
  );
  const [renaming, setRenaming] = useState<string | null>(null);
  // Live PTY titles (Claude emits `✳ <title>`), preferred over the backend label.
  const [titles, setTitles] = useState<Record<string, string>>({});
  const onTitle = (id: string, title: string) =>
    setTitles((m) => (m[id] === title ? m : { ...m, [id]: title }));
  // Raised by BEL / OSC 9 since the user last looked at the session.
  const [termAttention, setTermAttention] = useState<Record<string, true>>({});
  const setOverlay = useSetAgentOverlay();

  const {
    railRepos,
    shownRepos,
    queryHidden,
    quietDirs,
    quietCount,
    idleDirs,
    unmanagedDirs,
    visibleRepos,
    missingRepoCount,
    folderOf,
    folderNameByDir,
    sessionById,
    folderByDir,
    activeFolder,
    activeRepo,
  } = useRailIndex({
    repos,
    filter,
    recentHours,
    idleRevealed,
    unmanagedRevealed,
    showQuiet,
    query,
    activeFolderDir,
    now,
  });

  const { wins, updateWins, addPaneToActive, removePane, replacePaneInPlace, removeSessionPane } =
    useWindowLayout({
      state,
      repos,
      open,
      cwds,
    });

  // Hold-to-reveal jump keys: the badges paint on the rows the numbering is
  // computed from, so what you press is what you read. The targets are kept
  // even while nothing is held — the handlers address them without a repaint.
  const hotkeysHeld = useModifierHeld("ab-jump-session-1");
  const rows = useMemo(() => railRows(queue, foldedLanes), [queue, foldedLanes]);
  const selItem = selKey === null ? undefined : queue.items.find((i) => keyId(i.key) === selKey);
  // A row with no checkout is its own view; otherwise the ring follows the
  // checkout on screen, however it got there.
  const detailItem = selItem && !selItem.folderDir ? selItem : undefined;
  const ringItem = detailItem ?? rowForFolder(queue, activeFolderDir);
  const ringKey = ringItem ? keyId(ringItem.key) : null;
  const head = nextItem(queue);
  // The collapsed strip has no rows to badge, so it offers no numbers.
  const railHotkeys = useMemo(
    () =>
      hotkeysHeld && !railCollapsed
        ? new Map(rows.slice(0, 9).map((r, i) => [keyId(r.key), i + 1]))
        : undefined,
    [hotkeysHeld, railCollapsed, rows],
  );
  const openIssues = useMemo(
    () => snapshot.issues.filter((i) => !isItemDismissed(i)),
    [snapshot.issues],
  );

  // Read live by the terminal://notify listener, which must not re-subscribe.
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    selectedRef.current = selected?.sessionId ?? null;
  });
  // Lets an async task-create ask, on resolve, whether the user has moved on.
  const activeFolderDirRef = useRef<string | null>(null);
  useEffect(() => {
    activeFolderDirRef.current = activeFolderDir;
  });
  // Same, for the rail: the mount-only nav-request handler's closure would only
  // ever see the empty first-render snapshot.
  const railRef = useRef({ repos, folderNameByDir, queue });
  useEffect(() => {
    railRef.current = { repos, folderNameByDir, queue };
  });

  // One-shot "prompt cache about to expire" toast per session per cache generation.
  const cacheWarned = useRef(new Set<string>());
  useEffect(() => {
    for (const repo of state.repos)
      for (const folder of repo.folders)
        for (const s of folder.sessions) {
          const d = s.agentState?.details;
          if (!s.live || !isAgent(s) || !d?.cacheExpiresAt) continue;
          if (!isCacheExpiring(d, now)) continue;
          const key = `${s.id}:${d.cacheExpiresAt}`;
          if (cacheWarned.current.has(key)) continue;
          cacheWarned.current.add(key);
          toast(
            `◔ ${folder.name} / ${s.name} — prompt cache expires in ~${fmtMins(d.cacheExpiresAt - now)}. Any message re-warms it; a cold resume re-reads everything at full price.`,
          );
        }
  }, [state.repos, now]);

  const parentDirs = useMemo(() => repoParentDirs(state.repos.map((r) => r.dir)), [state.repos]);

  const openRepoManager = () => {
    uiAction("repo.manage_opened", "cockpit");
    openSettingsTab({ tab: "agentboard" });
  };

  const attention = useAttention({ snapshot, now, openTab });

  const worktreeDelete = useWorktreeDelete({
    repos,
    tasks: snapshot.tasks,
    expectedKills,
    onSessionRemoved: (id) => {
      setOpen((prev) => prev.filter((x) => x !== id));
      setSelected((cur) => (cur?.sessionId === id ? null : cur));
      removeSessionPane(id);
    },
  });
  const { requestDeleteWorktree } = worktreeDelete;

  // The live Claude title while the shell runs, else the backend-derived name.
  const labelFor = (s: SessionData) =>
    (s.live ? claudeTitleName(titles[s.id]) : null) ?? sessionLabel(s);

  // View panes go beside the live terminals — never a modal.
  function placeViewPane(dir: string, paneId: string) {
    setActiveFolderDir(dir);
    addPaneToActive(dir, paneId);
    setFocusedPaneId(paneId);
    setFocusLevel("pane");
  }

  const openFiles = (dir: string) => placeViewPane(dir, filesPaneId(dir));
  const openPreview = (dir: string) => placeViewPane(dir, previewPaneId(dir));

  // Same, for the folder's Chrome pane — a real browser whose sign-ins stick.
  function openBrowser(dir: string) {
    uiAction("agentboard.open_browser_pane", "cockpit");
    setActiveFolderDir(dir);
    addPaneToActive(dir, browserPaneId(dir));
    setFocusedPaneId(browserPaneId(dir));
  }

  const [previewRequests, setPreviewRequests] = useState<Record<string, PreviewRequest>>({});
  function showPreviewFile(req: {
    folderDir: string | null;
    path: string;
    title: string;
    nonce: number;
  }) {
    // A file in no tracked folder lands on whatever's on screen, else the first.
    const dir =
      req.folderDir ?? activeFolderDirRef.current ?? railRef.current.repos[0]?.folders[0]?.dir;
    if (!dir) {
      toast.error(`Couldn't show ${req.title} — no checkouts are open on the rail`);
      return;
    }
    setPreviewRequests((prev) => ({
      ...prev,
      [dir]: { path: req.path, title: req.title, nonce: req.nonce },
    }));
    // Ack where the file landed, not what the payload named.
    ackFolder(dir);
    openPreview(dir);
  }

  // The MCP `file_open` tool / `tt open`. Shares `showPreviewFile`'s fallback
  // folder; a file outside it still opens in that folder's workbench, which is
  // not confined to the tree it has open.
  function openFileFromRequest(req: {
    folderDir: string | null;
    path: string;
    isDir: boolean;
    line: number | null;
    nonce: number;
  }) {
    const dir =
      req.folderDir ?? activeFolderDirRef.current ?? railRef.current.repos[0]?.folders[0]?.dir;
    if (!dir) {
      toast.error(`Couldn't open ${req.path} — no checkouts are open on the rail`);
      return;
    }
    // A directory: the tree is already rooted there, nothing to select.
    if (!req.isDir) {
      const target = filesPaneTarget(dir, req.path);
      if (target == null) {
        toast.error(`Couldn't open ${req.path} — it names no file this app can reach`);
        return;
      }
      setFilesOpenRequests((prev) => ({
        ...prev,
        [dir]: { path: target, line: req.line, nonce: req.nonce },
      }));
    }
    focusFiles(dir);
  }

  function focusFiles(dir: string) {
    setActiveFolderDir(dir);
    ackFolder(dir);
    openFiles(dir);
  }

  // The extension resumes from the transcripts filed under its workspace folder,
  // so the session's cwd has to *be* a checkout on the rail, not sit inside one.
  async function openClaudeSessionInEditor(dir: string, sessionId: string) {
    if (!railRef.current.folderNameByDir.has(dir)) {
      toast.error(`Couldn't open the session in the editor — ${dir} isn't a checkout on the rail`);
      return;
    }
    focusFiles(dir);
    const opened = await codeServerOpenClaudeSession(dir, sessionId);
    if (opened.isErr()) {
      toast.error(`Couldn't open the session in the editor — ${opened.error.message}`);
    }
  }

  // Same, for the native pane — a window rectangle rendered by Bevy, not DOM.
  function openJarvis(dir: string) {
    uiAction("agentboard.open_jarvis_pane", "cockpit");
    placeViewPane(dir, jarvisPaneId(dir));
  }

  // Claude's openFile tool → that folder's files pane, focused on the file.
  const [filesOpenRequests, setFilesOpenRequests] = useState<Record<string, FilesOpenRequest>>({});
  useTauriEvent<OpenFileRequest>("ide://open-file", (p) => {
    const dir = p.dir;
    if (!folderByDir.has(dir)) return;
    const target = filesPaneTarget(dir, p.filePath);
    if (target == null) return;
    setFilesOpenRequests((prev) => ({
      ...prev,
      [dir]: { path: target, line: null, nonce: nextOpenFileNonce() },
    }));
    openFiles(dir);
  });

  // A terminal file link takes the same files-pane route, wherever on disk it
  // points. The backend resolves first (`term_resolve_path`) because a relative
  // link is only folder-relative until the pane's shell `cd`s elsewhere, and
  // because it is what expands a `~`. Only a link that resolves to nothing at
  // all falls through to the external editor.
  async function openTerminalPath(dir: string, termId: string, path: string, line: number | null) {
    uiAction("terminal.link_open_file", "cockpit");
    const resolved = (
      await invoke<string | null>("term_resolve_path", { path, cwd: dir, termId })
    ).unwrapOr(null);
    const target = filesPaneTarget(dir, resolved ?? path);
    if (target == null) {
      void invoke("term_open_path", { path, cwd: dir, line, termId });
      return;
    }
    setFilesOpenRequests((prev) => ({
      ...prev,
      [dir]: { path: target, line, nonce: nextOpenFileNonce() },
    }));
    openFiles(dir);
  }

  // A BEL or OSC 9/777 — Claude Code's "needs your input".
  useTauriEvent<{ termId: string; kind: string; body?: string }>(
    "terminal://notify",
    ({ termId, kind, body }) => {
      // The session the user is looking at doesn't need a badge.
      if (termId === selectedRef.current && document.hasFocus()) return;
      setTermAttention((m) => (m[termId] ? m : { ...m, [termId]: true }));
      if (kind === "notify" && body) toast(body);
    },
  );

  const windowsForFolder = useMemo(
    () => wins?.windows.filter((w) => w.folderDir === activeFolderDir) ?? [],
    [wins, activeFolderDir],
  );
  const activeWin =
    windowsForFolder.find(
      (w) => w.id === (activeFolderDir && wins?.activeWindows[activeFolderDir]),
    ) ?? windowsForFolder[0];

  // What ab-split-session (⌘⇧S) has to choose from: sessions not in *any* window.
  const splitCandidates = useMemo(() => {
    if (!activeFolder) return [];
    const openIds = new Set(windowsForFolder.flatMap((w) => w.panes));
    return activeFolder.sessions.filter((s) => !openIds.has(s.id));
  }, [activeFolder, windowsForFolder]);

  function splitIntoWindow() {
    if (!activeFolderDir) {
      toast("Select a folder first.");
      return;
    }
    if (splitCandidates.length === 0) {
      toast("No unopened sessions in this folder to add.");
      return;
    }
    if (splitCandidates.length === 1) {
      selectSession(activeFolderDir, splitCandidates[0].id);
      return;
    }
    setSplitOpen(true);
  }

  // A window can't exist without panes, so "+ window" spawns a session too.
  async function newWindow(folderDir: string) {
    const added = await invoke<SessionData>("ab_add_session", { dir: folderDir, name: null });
    if (added.isErr()) return;
    const sessionId = added.value.id;
    const id = nextWindowId();
    updateWins([folderDir], (cur) => {
      const count = cur.windows.filter((w) => w.folderDir === folderDir).length;
      return {
        windows: [
          ...cur.windows,
          { id, name: `window ${count + 1}`, folderDir, panes: [sessionId] },
        ],
        activeWindows: { ...cur.activeWindows, [folderDir]: id },
      };
    });
    // Mount + focus the session; `placePane` sees it already hosted here.
    selectSession(folderDir, sessionId);
  }

  const columns = useColumnDrag(updateWins);

  /** A shell exited on its own. */
  function handleExit(sessionId: string, exit: TermExit) {
    setOpen((prev) => prev.filter((id) => id !== sessionId));
    const expected = expectedKills.current.delete(sessionId);
    if (expected || !exitIsCrash(exit.code, exit.signal)) {
      closePane(sessionId);
      return;
    }
    const label = exitLabel(exit.code, exit.signal);
    const s = sessionById.get(sessionId);
    toast.error(`${s ? labelFor(s) : "shell"} ${label}`);
    setExitLabels((m) => ({ ...m, [sessionId]: label }));
    // The tile keeps its place; only its occupant changes.
    setFocusedPaneId((cur) => (cur === sessionId ? exitPaneId(sessionId) : cur));
    replacePaneInPlace(sessionId, exitPaneId(sessionId));
  }

  // Reaching a checkout any way at all hands the ring to its queue row, and
  // drops a detail view that would otherwise cover its panes.
  function setCursorFor(folderDir: string) {
    const row = rowForFolder(railRef.current.queue, folderDir);
    setSelKey(row ? keyId(row.key) : null);
  }

  function selectFolder(folderDir: string) {
    setCursorFor(folderDir);
    setActiveFolderDir(folderDir);
    setSelected((cur) => (cur && cur.folderDir !== folderDir ? null : cur));
    setFocusLevel("rail");
    ackFolder(folderDir);
  }

  // For sessions created in the background: leaves `selected`/`activeFolderDir`.
  function mountSession(folderDir: string, sessionId: string) {
    cwds.current[sessionId] = folderDir;
    setOpen((prev) => (prev.includes(sessionId) ? prev : [...prev, sessionId]));
    addPaneToActive(folderDir, sessionId);
  }

  function selectSession(folderDir: string, sessionId: string) {
    setJumpRecall(null);
    setCursorFor(folderDir);
    mountSession(folderDir, sessionId);
    setSelected({ folderDir, sessionId });
    setFocusedPaneId(sessionId);
    // Rail-level selection by default; focusPane overrides to pane in the same batch.
    setFocusLevel("rail");
    setActiveFolderDir(folderDir);
    setTermAttention((m) => {
      if (!m[sessionId]) return m;
      const { [sessionId]: _, ...rest } = m;
      return rest;
    });
    ackFolder(folderDir);
  }

  /** Run `fn` against a session's PTY, guaranteeing its shell exists first. */
  async function withLiveSession(
    sessionId: string,
    fn: () => Promise<unknown>,
    folderDir?: string,
  ) {
    const dir = folderDir ?? folderOf.get(sessionId)?.dir ?? cwds.current[sessionId];
    if (!dir) return;
    selectSession(dir, sessionId);
    await waitForFirstFrame(sessionId);
    await fn();
  }

  // Looking at the rail entry clears its agents' `unseen` pulse.
  function ackFolder(folderDir: string) {
    // Through the ref: its mount-only caller sees only the first-render map.
    const name = railRef.current.folderNameByDir.get(folderDir);
    if (name) void invoke("ab_mark_seen", { name });
  }

  // ab-jump-*: board-wide, wrapping, through `selectSession` so a jump behaves
  // exactly like clicking the session.
  function jumpTo(target: SessionData | null, nothing: string) {
    if (!target) {
      toast(nothing);
      return;
    }
    const folder = folderOf.get(target.id);
    if (!folder) return;
    selectSession(folder.dir, target.id);
    // A keyboard jump is the one arrival with no click to remember it by.
    jumpNonce.current += 1;
    setJumpRecall(buildJumpRecall(shownRepos, folder, target, now, jumpNonce.current));
  }

  // Walks the task queue's sessions: answer one, press next, and the most
  // urgent remaining agent is where you land.
  function jumpToNeedsYou(direction: "next" | "prev") {
    const id = cycleQueue(queue, selected?.sessionId ?? null, direction);
    jumpTo(id ? (sessionById.get(id) ?? null) : null, "Queue's empty — nothing needs you.");
  }

  /** Open a queue row in place: its session, its checkout, or its detail. */
  function selectQueueItem(item: QueueItem) {
    const key = keyId(item.key);
    setAnnounced(null);
    if (item.folderDir) {
      if (item.sessionId) selectSession(item.folderDir, item.sessionId);
      else selectFolder(item.folderDir);
    } else {
      setFocusLevel("rail");
      blurTerminal();
    }
    // After the select, whose own ring sync would name the checkout's row.
    setSelKey(key);
    if (item.reason === "land") toast.info("Run /done in the task's terminal to land it.");
  }

  function pickQueueItem(item: QueueItem) {
    uiAction("queue.open", "cockpit", item.reason ?? item.lane);
    selectQueueItem(item);
  }

  function openNextUp() {
    const target = nextItem(railRef.current.queue);
    if (target) selectQueueItem(target);
    else toast.info("Queue's empty — nothing needs you.");
  }

  // Declines when the digit addresses nothing, so an unused number keeps
  // whatever the platform does with the chord rather than silently eating it.
  function jumpToHotkey(n: number): boolean {
    const target = rows[n - 1];
    if (!target) return false;
    selectQueueItem(target);
    return true;
  }

  function moveQueueCursor(step: 1 | -1): boolean {
    const target = stepRow(rows, ringKey, step);
    if (!target) return false;
    selectQueueItem(target);
    return true;
  }

  function toggleLane(lane: Lane) {
    uiAction("queue.lane_toggle", "cockpit", lane);
    setFoldedLanes((cur) => {
      const next = new Set(cur);
      if (!next.delete(lane)) next.add(lane);
      return next;
    });
  }

  function toggleCheckouts(show = !checkoutsOpen) {
    uiAction("cockpit.checkouts_toggle", "cockpit", show ? "open" : "close");
    setCheckoutsOpen(show);
    localStorage.setItem(CHECKOUTS_OPEN_KEY, show ? "1" : "0");
  }

  // The head of On you changed: open it where nothing would be interrupted,
  // else say so above the panes. Never moves DOM focus.
  const onYou = onYouHead(queue);
  const onYouKey = onYou ? keyId(onYou.key) : null;
  const lastOnYouKey = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!queueLive) return;
    const verdict = nextUpArrival(lastOnYouKey.current, onYou, {
      terminalFocused: terminalFocused(),
      selectedKey: ringKey,
      selectedOnYou: ringItem?.lane === "on_you",
    });
    lastOnYouKey.current = onYouKey;
    if (!onYou) return;
    if (verdict === "open") selectQueueItem(onYou);
    else if (verdict === "announce") setAnnounced(onYouKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires on a new head only; the rest is read at that moment
  }, [onYouKey, queueLive]);
  const announcedItem =
    announced !== null && announced === onYouKey && announced !== ringKey ? onYou : undefined;

  // A deep link to a checkout's repo row: that row lives in the Checkouts drawer.
  useEffect(
    () =>
      focusTargetStore.subscribe(() => {
        const t = focusTargetStore.get();
        if (t?.screen === "cockpit" && t.kind === "repo") setCheckoutsOpen(true);
      }),
    [],
  );

  function jumpToNotBusy() {
    jumpTo(
      cycleNotBusy(shownRepos, selected?.sessionId ?? null, "next"),
      "Nothing idle right now.",
    );
  }

  // ab-focus-terminal (Enter): real DOM focus, so the next keystroke lands in
  // the shell instead of nowhere. A row with no checkout acts instead.
  function focusActiveTerminal(): boolean {
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      if (active.tagName === "BUTTON" || active.tagName === "A") return false;
      if (active.closest('[role="dialog"], [role="alertdialog"]')) return false;
    }
    if (detailItem) {
      const action = primaryAction(detailItem);
      if (action === "start") void startQueueItem(detailItem);
      else if (action === "open-link") openQueueLink(detailItem);
      return true;
    }
    if (!activeFolderDir || !activeFolder) return false;
    const sessionPaneId = activeWin?.panes.find((id) => sessionById.has(id));
    const targetId =
      (selected?.folderDir === activeFolderDir ? selected.sessionId : undefined) ??
      sessionPaneId ??
      activeFolder.sessions[0]?.id;
    if (!targetId) return false;
    selectSession(activeFolderDir, targetId);
    setFocusLevel("pane");
    setFocusTerminalRequest((r) => ({ id: targetId, nonce: (r?.nonce ?? 0) + 1 }));
    return true;
  }

  // Keyboard reality, not just the violet ring: a session pane takes DOM focus,
  // a view pane takes the ring and the previous shell loses the keyboard.
  function focusPane(paneId: string) {
    if (sessionById.has(paneId)) {
      const dir = folderOf.get(paneId)?.dir ?? cwds.current[paneId];
      if (!dir) return;
      selectSession(dir, paneId);
      setFocusTerminalRequest((r) => ({ id: paneId, nonce: (r?.nonce ?? 0) + 1 }));
    } else {
      setFocusedPaneId(paneId);
      blurTerminal();
    }
    // After selectSession, which claims rail level — the batch resolves to pane.
    setFocusLevel("pane");
  }

  // Walking off the rail's right edge is the pane grid's business.
  function leaveRailRight(): boolean {
    if (windowsForFolder.length > 1) {
      setFocusLevel("window");
      setFocusedPaneId(null);
      blurTerminal();
      return true;
    }
    const first = activeWin?.panes[0];
    if (first === undefined) return false;
    focusPane(first);
    return true;
  }

  // One cursor over rail, window strip and panes. In the rail it walks the
  // queue's rows; past it, `moveFocus` owns the transitions.
  function focusByArrow(direction: "up" | "down" | "left" | "right"): boolean {
    if (focusLevel === "rail") {
      if (direction === "up") return moveQueueCursor(-1);
      if (direction === "down") return moveQueueCursor(1);
      return direction === "right" && !detailItem ? leaveRailRight() : false;
    }
    const move = moveFocus({
      level: focusLevel,
      direction,
      panes: activeWin?.panes ?? [],
      focusedPaneId,
      windows: windowsForFolder.map((w) => w.id),
      activeWindowId: activeWin?.id ?? null,
    });
    if (!move) return false;
    switch (move.kind) {
      case "level":
        setFocusLevel(move.level);
        setFocusedPaneId(null);
        blurTerminal();
        break;
      case "pane":
        focusPane(move.id);
        break;
      case "window":
        actions.focusWindow(move.id);
        break;
    }
    return true;
  }

  const taskCreation = useTaskCreation({
    mountSession,
    selectSession,
    launchClaudeIn,
    selectedRef,
    activeFolderDirRef,
    railCollapsed,
    toggleRail,
  });

  // The setup badge is `m:ss` against a clock that otherwise ticks every 15s,
  // so it would read 0:00 throughout. Bounded by the install itself.
  useNowInterval(taskCreation.settingUpDirs.size > 0 ? 1000 : undefined);

  // The form renders in the Checkouts drawer, so the rail and drawer open first.
  function newTaskForActiveRepo() {
    if (!activeRepo) return;
    if (railCollapsed) toggleRail();
    if (!checkoutsOpen) toggleCheckouts(true);
    taskCreation.toggleTaskForm({
      name: activeRepo.name,
      dir: activeRepo.folders[0].dir,
      key: activeRepo.key,
    });
  }

  // A `no worktree` row's way back: the ordinary create path with the existing
  // `taskId`, so the row keeps its place, issues and PRs instead of becoming a
  // second card — and no Claude, since this repairs rather than restarts.
  function recreateWorktree(repo: RepoData, folder: FolderData) {
    const branch = folderRecreateBranch(folder);
    const task = folderTask(folder);
    if (!branch || !task) return;
    uiAction("agentboard.recreate_worktree", "cockpit");
    void taskCreation.createTask(
      { name: repo.name, dir: folder.repoRoot, key: repo.key, originUrl: repo.originUrl },
      {
        goal: "",
        title: branch,
        branch,
        // The branch already exists, so `git worktree add` checks it out.
        base: "",
        options: {},
        imagePaths: [],
        issues: [],
        // So the rebuilt checkout lands where the record says it is.
        dir: folder.dir,
        worktree: true,
        launchClaude: false,
        pr: null,
        taskId: task.id,
      },
    );
  }

  async function newSession(folderDir: string, launchClaude = false) {
    const added = await invoke<SessionData>("ab_add_session", { dir: folderDir, name: null });
    if (added.isErr()) return;
    const rec = added.value;
    selectSession(folderDir, rec.id);
    if (launchClaude) {
      setStartClaudeTarget({ folderDir, sessionId: rec.id, sessionName: rec.name, restart: false });
    }
  }

  async function launchClaudeIn(
    target: StartClaudeTarget,
    prompt: string,
    options?: ClaudeLaunchOptions,
    /** What the toast shows when it should differ from what's typed into the PTY. */
    label?: string,
  ) {
    const { folderDir, sessionId, sessionName, restart } = target;
    const shown = label ?? prompt;
    setOverlay(sessionId, OVERLAY_STARTED);
    const verb = restart ? "starting over — fresh Claude session" : "starting Claude";
    toast(shown ? `✦ ${verb} in ${sessionName}: ${shown}` : `✦ ${verb} in ${sessionName}`);
    await withLiveSession(
      sessionId,
      async () => {
        if (restart) {
          await termWriteRetry(sessionId, "\x03");
          await sleep(150);
          await termWriteRetry(sessionId, "\x04");
          await sleep(300);
        }
        await termWriteRetry(sessionId, claudeCommand(prompt, options));
      },
      folderDir,
    );
  }

  // A `.claude/launch.json` config in a fresh session, over the same PTY-typing
  // path (no backend spawn). The config→session mapping is what lets the popover
  // offer "focus" instead of a second launch while the pane lives.
  async function launchDevServer(folderDir: string, cfg: LaunchConfigStatus) {
    const added = await invoke<SessionData>("ab_add_session", {
      dir: folderDir,
      name: `dev: ${cfg.name}`,
    });
    if (added.isErr()) {
      toast(errorMessage(added.error));
      return;
    }
    const rec = added.value;
    const command = launchCommand(cfg);
    toast(`▶ ${command} — in ${rec.name}`);
    void abSetSessionPurpose(rec.id, command);
    await withLiveSession(
      rec.id,
      async () => {
        const wrote = await termWriteRetry(rec.id, `${command}\r`);
        if (wrote.isErr()) {
          toast(`could not start ${cfg.name}: ${errorMessage(wrote.error)}`);
          return;
        }
        void launchRegister(folderDir, cfg.name, rec.id, cfg.port ?? null, command);
      },
      folderDir,
    );
  }

  // Dismiss the start-Claude dialog and launch with whatever's typed — blank is
  // a valid answer, it just skips the initial prompt + purpose.
  function commitStartClaude() {
    const target = startClaudeTarget;
    if (!target) return;
    setStartClaudeTarget(null);
    const prompt = startClaudePrompt.trim();
    setStartClaudePrompt("");
    // The typed prompt is why this session exists; blank leaves it unlabeled.
    if (prompt) void abSetSessionPurpose(target.sessionId, prompt);
    void launchClaudeIn(target, prompt);
  }

  // Claude Sessions' "Open in Agentboard" handoff — `lib/agentboard.ts`'s
  // pending-open-session bridge says why this can't be a plain function call.
  useEffect(() => {
    let cancelled = false;
    let tail = Promise.resolve();

    const handle = (req: PendingOpenSession) => {
      tail = tail.then(async () => {
        if (cancelled) return;
        toast(`✦ resuming ${req.label} — claude --resume ${req.resumeId.slice(0, 8)}`);
        await withLiveSession(
          req.sessionId,
          () => termWriteRetry(req.sessionId, claudeResumeCommand(req.resumeId)),
          req.folderDir,
        );
      });
    };
    for (const req of consumePendingOpenSessions()) handle(req);
    const off = onOpenSessionRequest(handle);
    return () => {
      cancelled = true;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only subscription; handle closes over the values it needs and must not re-subscribe
  }, []);

  // Command-palette "jump to repo/session" handoff (`requestAgentboardNav`).
  useEffect(() => {
    const handle = (req: AgentboardNav) => {
      if (req.kind === "session") {
        selectSession(req.folderDir, req.sessionId);
      } else if (req.kind === "reopen-task") {
        setActiveFolderDir(req.repoDir);
        ackFolder(req.repoDir);
        taskCreation.openReopenForm(
          { name: req.repoName, dir: req.repoDir, key: req.repoKey, originUrl: req.originUrl },
          req.taskId,
          req.goal,
        );
      } else if (req.kind === "start-task") {
        // The MCP `task_start` tool.
        setActiveFolderDir(req.repoDir);
        ackFolder(req.repoDir);
        void taskCreation.createTask(
          { name: req.repoName, dir: req.repoDir, key: req.repoKey, originUrl: req.originUrl },
          {
            goal: req.goal,
            title: req.goal,
            branch: req.branch,
            base: req.base ?? "",
            options: {},
            imagePaths: [],
            issues: [],
            // Unknown here — `createTask` derives it from the branch.
            dir: null,
            worktree: true,
            launchClaude: true,
            pr: null,
            taskId: req.taskId,
          },
        );
      } else if (req.kind === "open-claude-session") {
        void openClaudeSessionInEditor(req.folderDir, req.sessionId);
      } else if (req.kind === "open-file") {
        openFileFromRequest(req);
      } else if (req.kind === "show-file") {
        // The MCP `preview_file` tool — the agent has something to *show*.
        showPreviewFile(req);
      } else if (req.kind === "queue-next") {
        openNextUp();
      } else {
        setActiveFolderDir(req.folderDir);
        ackFolder(req.folderDir);
      }
    };
    const pending = consumePendingAgentboardNav();
    if (pending) handle(pending);
    return onAgentboardNavRequest(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only subscription; handle closes over current values and must not re-subscribe
  }, []);

  // Kill live sessions first — killing a PTY is client-mediated — then drop the
  // checkout(s) from the watched list.
  async function performRemove(target: RemoveTarget) {
    // Closed here rather than in `untrackRepo` because `closeSession` also clears
    // this screen's local pane state; the seam is handed an empty id list.
    for (const id of target.sessionIds) await closeSession(id);
    for (const dir of target.dirs) await untrackRepo(dir, target.label, [], "cockpit");
  }

  function requestRemoveRepo(dirs: string[], label: string) {
    const folders = repos.flatMap((r) => r.folders).filter((f) => dirs.includes(f.dir));
    const sessionIds = folders.flatMap((f) => liveSessions(f).map((s) => s.id));
    const target: RemoveTarget = { label, dirs, sessionIds };
    if (sessionIds.length === 0) {
      void performRemove(target);
      return;
    }
    setConfirmRemove(target);
  }

  // Closing the focused pane hands focus to its neighbor (and `selected` moves
  // too, for a live one), so a repeated ab-close-pane chord keeps eating panes.
  // Closing an unfocused pane moves nothing.
  function shiftFocusFrom(...closedIds: string[]) {
    const lost = closedIds.some((id) => id === focusedPaneId || id === selected?.sessionId);
    if (!lost) return;
    const next = wins
      ? (closedIds.map((id) => successorPane(wins, id)).find((n) => n !== null) ?? null)
      : null;
    if (next === null) {
      setFocusedPaneId(null);
      return;
    }
    const dir = wins?.windows.find((w) => w.panes.includes(next))?.folderDir;
    if (dir && sessionById.has(next)) selectSession(dir, next);
    else setFocusedPaneId(next);
  }

  async function closeSession(sessionId: string) {
    await invoke("ab_close_session", { id: sessionId });
    // Both ids: a crashed session's tile holds its tombstone, not the session id itself.
    shiftFocusFrom(sessionId, exitPaneId(sessionId));
    setOpen((prev) => prev.filter((id) => id !== sessionId));
    setSelected((cur) => (cur?.sessionId === sessionId ? null : cur));
    removeSessionPane(sessionId);
  }

  /** A view pane's ✕ / close shortcut: focus hand-off, then the layout drop. */
  function closePane(paneId: string) {
    shiftFocusFrom(paneId);
    removePane(paneId);
  }

  /** ab-close-pane (⌘⇧W) and the strip's Close: the focused tile goes, whichever
   * kind it is. `paneCloseTarget` decides. */
  function closeFocusedPane() {
    const target = paneCloseTarget(focusedPaneId, activeWin?.panes ?? []);
    if (!target) return;
    if (target.kind === "session") void closeSession(target.sessionId);
    else closePane(target.paneId);
  }

  async function commitRename(sessionId: string, name: string) {
    setRenaming(null);
    const trimmed = name.trim();
    if (trimmed) await invoke("ab_rename_session", { id: sessionId, name: trimmed });
  }

  const actions: SessionActions = {
    start: (folderDir, s) => {
      // Selecting mounts the TerminalView, whose effect spawns the PTY.
      selectSession(folderDir, s.id);
    },
    startClaude: (folderDir, s) => {
      selectSession(folderDir, s.id);
      setStartClaudeTarget({ folderDir, sessionId: s.id, sessionName: s.name, restart: false });
    },
    stopClaude: (s) => {
      setOverlay(s.id, OVERLAY_STOPPED);
      toast(`■ interrupting Claude — ${s.name}'s shell stays alive`);
      void withLiveSession(s.id, async () => {
        await termWriteRetry(s.id, "\x03"); // interrupt the current turn
        await sleep(150);
        await termWriteRetry(s.id, "\x04"); // Ctrl-D at the empty prompt exits Claude
      });
    },
    compactClaude: (s) => {
      setOverlay(s.id, OVERLAY_STARTED);
      toast(`⤿ compacting ${s.name} — summarize & drop stale turns`);
      void withLiveSession(s.id, () => termWriteRetry(s.id, "/compact\r"));
    },
    restartClaude: (folderDir, s) => {
      selectSession(folderDir, s.id);
      setStartClaudeTarget({ folderDir, sessionId: s.id, sessionName: s.name, restart: true });
    },
    close: (sessionId) => void closeSession(sessionId),
    renameStart: setRenaming,
    launchDevServer: (folderDir, cfg) => void launchDevServer(folderDir, cfg),
    focusSession: selectSession,
    focusWindow: (windowId) => {
      const win = wins?.windows.find((w) => w.id === windowId);
      if (!win) return;
      selectFolder(win.folderDir);
      setFocusLevel("window");
      updateWins([win.folderDir], (w) => ({
        ...w,
        activeWindows: { ...w.activeWindows, [win.folderDir]: windowId },
      }));
    },
  };

  useShortcuts(
    useMemo(
      () => ({
        "ab-new-session": () => {
          if (activeFolderDir) void newSession(activeFolderDir);
        },
        "ab-new-task": newTaskForActiveRepo,
        "ab-remove-task": () => {
          // `requestDeleteWorktree` always confirms before touching anything.
          if (!activeFolder || !folderRemovableTask(activeFolder)) return;
          if (folderBusy(activeFolder)) return;
          requestDeleteWorktree(activeFolder.dir, activeFolder.name);
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
        "ab-close-pane": closeFocusedPane,
        "ab-toggle-files": () => {
          if (activeFolderDir) openFiles(activeFolderDir);
        },
        "ab-toggle-rail": toggleRail,
        "ab-jump-next": () => jumpToNeedsYou("next"),
        "ab-jump-prev": () => jumpToNeedsYou("prev"),
        "ab-jump-idle": jumpToNotBusy,
        ...Object.fromEntries(
          Array.from({ length: 9 }, (_, i) => [
            `ab-jump-session-${i + 1}`,
            () => jumpToHotkey(i + 1),
          ]),
        ),
        "ab-focus-up": () => focusByArrow("up"),
        "ab-focus-down": () => focusByArrow("down"),
        "ab-focus-up-bracket": () => focusByArrow("up"),
        "ab-focus-down-bracket": () => focusByArrow("down"),
        "ab-focus-left": () => focusByArrow("left"),
        "ab-focus-right": () => focusByArrow("right"),
        "queue-down": () => moveQueueCursor(1),
        "queue-up": () => moveQueueCursor(-1),
        "queue-start": () => {
          if (detailItem?.key.kind !== "task" || primaryAction(detailItem) !== "start")
            return false;
          void startQueueItem(detailItem);
        },
        "queue-snooze": () => {
          if (ringItem?.key.kind !== "task" || !ringItem.reason) return false;
          setSnoozeKey(keyId(ringItem.key));
        },
        // Before rank-up: a shift-less spec also matches Alt+Shift+↑, and the
        // first matching handler wins.
        "queue-rank-top": () => {
          if (ringItem) void rerankQueueItem(queue.items, ringItem, "top");
        },
        "queue-rank-up": () => {
          if (ringItem) void rerankQueueItem(queue.items, ringItem, "up");
        },
        "queue-rank-down": () => {
          if (ringItem) void rerankQueueItem(queue.items, ringItem, "down");
        },
        "ab-focus-terminal": focusActiveTerminal,
        "ab-split-session": splitIntoWindow,
        "ab-new-terminal-right": () => {
          if (activeFolderDir) void newSession(activeFolderDir);
        },
      }),
      // eslint-disable-next-line react-hooks/exhaustive-deps -- handlers are stable within a render; only the state they close over (listed) should rebuild the map
      [
        activeFolderDir,
        collapsed,
        queue,
        rows,
        ringKey,
        ringItem,
        detailItem,
        selected,
        focusedPaneId,
        focusLevel,
        windowsForFolder,
        wins,
        shownRepos,
        folderOf,
        splitCandidates,
        activeRepo,
        activeFolder,
        activeWin,
        sessionById,
        railCollapsed,
        worktreeDelete.confirmDeleteWt,
        worktreeDelete.deleteWtTask,
        worktreeDelete.deleteWtOutcome,
        worktreeDelete.blockedDelete,
        worktreeDelete.deleteBusy,
      ],
    ),
    "cockpit",
    activeTab === "cockpit",
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CockpitHeader snapshot={snapshot} live={storeLive} now={now} />
      <div className="flex min-h-0 flex-1">
        {/* Rail collapsed to icons: fixed-width strip outside the panel group.
            The group itself is NOT keyed on the collapse — remounting it would
            remount the terminal pool below and respawn every shell. The rail
            panel + handle just unmount; the main panel keeps its identity. */}
        {railCollapsed && (
          <RailIconStrip
            repos={visibleRepos}
            activeFolderDir={activeFolderDir}
            attentionCount={attention.items.length}
            onSelectFolder={selectFolder}
            onExpand={toggleRail}
            expandHint={shortcutHint("ab-toggle-rail")}
          />
        )}
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          {/* Rail: rollup tally + header + attention strip + Repo → Folder → Session tree. */}
          {!railCollapsed && (
            <>
              {/* The rail is a sidebar, so it keeps the width it was dragged to
                  when the *window* resizes (`preserve-pixel-size`) — the pane
                  area absorbs the change. The default, preserve-relative-size,
                  scales it with the window instead, so a comfortable 520px rail
                  ends up a few hundred pixels narrower on a smaller window —
                  below the width a row is laid out for, which is where its
                  right-edge content starts disappearing past the rail's
                  clipping edge. minSize is that width: indent + chevron/icon +
                  a readable title + the four trailing icon buttons. */}
              <ResizablePanel
                defaultSize="520px"
                minSize="300px"
                maxSize="760px"
                groupResizeBehavior="preserve-pixel-size"
              >
                <div className="flex h-full flex-col border-r">
                  <RollupChip
                    repos={railRepos}
                    compactPct={state.compactRecommendPercent}
                    now={now}
                  />
                  {/* min-h-0 is load-bearing: without it this flex child grows past the
                      rail's height and rows below the fold become unreachable. */}
                  <ScrollArea className="min-h-0 flex-1">
                    <div ref={focusRef}>
                      <CockpitRail
                        queue={queue}
                        live={queueLive}
                        now={now}
                        head={head}
                        selectedKey={ringKey}
                        folded={foldedLanes}
                        hotkeys={railHotkeys}
                        snoozeKey={snoozeKey}
                        onSnoozeKeyChange={setSnoozeKey}
                        onToggleLane={toggleLane}
                        onSelect={pickQueueItem}
                        onOpenHead={() => {
                          mouseAction("queue-next", "cockpit");
                          openNextUp();
                        }}
                      >
                        <RailDrawer
                          title="Issues"
                          count={openIssues.length}
                          open={issuesOpen}
                          onToggle={() => {
                            uiAction(
                              "cockpit.issues_toggle",
                              "cockpit",
                              issuesOpen ? "close" : "open",
                            );
                            setIssuesOpen(!issuesOpen);
                          }}
                        >
                          <CockpitIssues issues={openIssues} repos={repos} now={now} />
                        </RailDrawer>
                        {/* Every tracked checkout, task or not: where a main
                            checkout's shell, repo management and the new-task
                            form live. */}
                        <RailDrawer
                          title="Checkouts"
                          count={repos.length}
                          open={checkoutsOpen}
                          onToggle={() => toggleCheckouts()}
                        >
                          <RailHeader
                            attention={attention.items}
                            missingRepoCount={missingRepoCount}
                            agentScanOk={state.agentScanOk !== false}
                            dismissedPrCount={attention.dismissedPrCount}
                            clearingDismissals={attention.clearingDismissals}
                            filter={filter}
                            recentHours={recentHours}
                            onSetFilter={setFilter}
                            onSetRecentHours={setRecentHours}
                            quietCount={quietCount}
                            showQuiet={showQuiet}
                            onSetShowQuiet={setShowQuiet}
                            query={query}
                            onSetQuery={setQuery}
                            queryHidden={queryHidden}
                            showUnmanagedWorktrees={showUnmanagedWorktrees}
                            onSetShowUnmanagedWorktrees={setShowUnmanagedWorktrees}
                            jarvisPane={jarvisPane}
                            onSetJarvisPane={setJarvisPane}
                            onOpenRepoManager={openRepoManager}
                            onCleanupMissing={() => void cleanupMissing()}
                            onClearDismissals={() => void attention.clearDismissals()}
                            onCollapseRail={toggleRail}
                            parentDirs={parentDirs}
                          />
                          <div className="flex flex-col">
                            {repos.length === 0 && (
                              <div className="flex flex-col items-center gap-3 px-3 py-10 text-center">
                                <GitBranchIcon className="size-8 text-muted-foreground" />
                                <p className="text-sm text-muted-foreground">
                                  No repos on the rail yet.
                                </p>
                                <div className="flex items-center gap-2">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={openRepoManager}
                                    icon={<FolderPlusIcon className="size-3.5" />}
                                  >
                                    Manage repos
                                  </Button>
                                </div>
                              </div>
                            )}
                            {/* An empty tree under a query is the search's answer,
                              not an empty rail — say which, and offer the way out. */}
                            {repos.length > 0 && shownRepos.length === 0 && (
                              <div className="flex flex-col items-center gap-3 px-3 py-10 text-center">
                                <p className="text-sm text-muted-foreground">
                                  No repo or branch matches{" "}
                                  <span className="font-mono text-foreground">{query}</span>.
                                </p>
                                <Button size="sm" variant="outline" onClick={() => setQuery("")}>
                                  Clear filter
                                </Button>
                                {quietCount > 0 && !showQuiet && (
                                  <p className="text-xs text-muted-foreground/70">
                                    {quietCount} quiet checkout{quietCount === 1 ? " is" : "s are"}{" "}
                                    hidden — the ▤ button above searches them too once shown.
                                  </p>
                                )}
                              </div>
                            )}
                            {/* initial={false} so the rail drawing itself on launch
                              isn't mistaken for repos arriving — only genuine
                              track/untrack animates. */}
                            <AnimatePresence initial={false}>
                              {shownRepos.map((repo) => (
                                <motion.div key={repo.key} {...railRowMotion}>
                                  <RepoGroup
                                    repo={repo}
                                    idleDirs={idleDirs.get(repo.key)}
                                    idleRevealed={idleRevealed.has(repo.key)}
                                    onToggleIdle={() => toggleIdleRevealed(repo.key)}
                                    unmanagedDirs={unmanagedDirs.get(repo.key)}
                                    unmanagedRevealed={unmanagedRevealed.has(repo.key)}
                                    onToggleUnmanaged={() => toggleUnmanagedRevealed(repo.key)}
                                    quietDirs={quietDirs.get(repo.key)}
                                    now={now}
                                    compactPct={state.compactRecommendPercent}
                                    prs={snapshot.prs}
                                    tasks={snapshot.tasks}
                                    selectedSessionId={selected?.sessionId ?? null}
                                    activePaneId={focusedPaneId}
                                    activeFolderDir={activeFolderDir}
                                    collapsed={collapsed}
                                    renaming={renaming}
                                    titles={titles}
                                    wins={wins}
                                    actions={actions}
                                    onToggle={toggleCollapsed}
                                    onSelectFolder={selectFolder}
                                    onSelect={selectSession}
                                    onNewSession={newSession}
                                    onNewTask={taskCreation.toggleTaskForm}
                                    onRemoveRepo={requestRemoveRepo}
                                    onDeleteWorktree={requestDeleteWorktree}
                                    onRecreateWorktree={(folder) => recreateWorktree(repo, folder)}
                                    settingUpDirs={taskCreation.settingUpDirs}
                                    onRenameCommit={commitRename}
                                    onOpenFiles={openFiles}
                                    onOpenPreview={openPreview}
                                    // Undefined while `agentboard.jarvisPane` is off:
                                    // no entry point rather than a disabled pane.
                                    onOpenBrowser={browserPane ? openBrowser : undefined}
                                    onOpenJarvis={jarvisPane ? openJarvis : undefined}
                                    onClosePane={closePane}
                                    taskFormOpen={taskCreation.openTaskForms.has(repo.key)}
                                    taskFormInitialGoal={
                                      taskCreation.reopenTasks.get(repo.key)?.goal
                                    }
                                    onCancelTaskForm={() => taskCreation.closeTaskForm(repo.key)}
                                    onSubmitTaskForm={(input) => {
                                      const reopening = taskCreation.reopenTasks.get(repo.key);
                                      taskCreation.closeTaskForm(repo.key);
                                      void taskCreation.createTask(
                                        {
                                          name: repo.name,
                                          dir: repo.folders[0].dir,
                                          key: repo.key,
                                          originUrl: repo.originUrl,
                                        },
                                        {
                                          ...input,
                                          taskId: reopening?.taskId,
                                          reopen: reopening !== undefined,
                                        },
                                      );
                                    }}
                                  />
                                </motion.div>
                              ))}
                            </AnimatePresence>
                          </div>
                        </RailDrawer>
                      </CockpitRail>
                    </div>
                  </ScrollArea>

                  {/* Jarvis: the lower quarter of the rail is a native Bevy
                      surface, not DOM (see `components/native-pane.tsx`).
                      `shrink-0` + `basis-1/4` rather than `h-1/4` so the
                      ScrollArea above yields the space instead of both fighting
                      over `flex-1`.

                      Hidden whenever this screen is not the active tab: the
                      surface sits *above* the webview, so it would otherwise
                      cover whatever screen the user switched to — screens stay
                      mounted here rather than unmounting.

                      Off (the default) means *not rendered*, which is what
                      hands the quarter back to the ScrollArea — and, on a
                      checkout that never turns it on, what keeps a surface from
                      being created at all. It does not reclaim one already
                      shown: retiring parks the renderer rather than dropping it
                      (`crates-tauri/tt-pane`). Toggle: the rail header's cube
                      button. */}
                  {jarvisPane && (
                    <NativePane
                      paneId="jarvis"
                      visible={nativeVisible}
                      className="shrink-0 basis-1/4 border-t"
                    />
                  )}
                </div>
              </ResizablePanel>
              <ResizableHandle />
            </>
          )}

          {/* Main area: window strip + the active window's panes tiled side-by-side.
              Scoped to `activeFolderDir` — a window may only ever hold panes from
              the one folder it belongs to, so switching folders switches the
              whole strip, not just which panes happen to show. */}
          {/* The floor the rail's `preserve-pixel-size` yields to: a narrowing
              window takes its pixels out of the pane area, and without a
              minimum here it would take *all* of them and leave the panes at
              zero width. */}
          <ResizablePanel key="main" minSize="320px">
            <div className="flex h-full min-w-0 flex-col">
              {announcedItem && (
                <NextUpBanner
                  item={announcedItem}
                  onOpen={() => {
                    mouseAction("queue-next", "cockpit");
                    selectQueueItem(announcedItem);
                  }}
                  onDismiss={() => {
                    uiAction("queue.announce_dismiss", "cockpit");
                    setAnnounced(null);
                  }}
                />
              )}
              {detailItem && <QueueDetail item={detailItem} now={now} />}
              {!detailItem && activeFolder && activeRepo && (
                <WorkingContext
                  repo={activeRepo}
                  folder={activeFolder}
                  pr={prForFolder(snapshot.prs, activeRepo.originUrl, activeFolder.branch)}
                  task={taskForFolder(snapshot.tasks, activeFolder.dir)}
                  deleting={folderRemoving(activeFolder)}
                  actions={actions}
                  onOpenFiles={openFiles}
                  onOpenPreview={openPreview}
                  onOpenBrowser={browserPane ? openBrowser : undefined}
                  onOpenJarvis={jarvisPane ? openJarvis : undefined}
                  onNewSession={newSession}
                  onNewTask={newTaskForActiveRepo}
                  onRemoveRepo={requestRemoveRepo}
                  onDeleteWorktree={requestDeleteWorktree}
                />
              )}
              {!detailItem && wins && activeFolderDir && (
                <WindowStrip
                  windows={windowsForFolder}
                  activeWinId={activeWin?.id}
                  keyboardFocused={focusLevel === "window"}
                  hasFocusedPane={paneCloseTarget(focusedPaneId, activeWin?.panes ?? []) !== null}
                  updateWins={updateWins}
                  onFocusWindow={actions.focusWindow}
                  onNewWindow={() => void newWindow(activeFolderDir)}
                  onNewSession={() => void newSession(activeFolderDir)}
                  onClosePane={closeFocusedPane}
                />
              )}

              {/* Hidden, never unmounted, behind a detail view: the pool holds live shells. */}
              <div className={cn("flex min-h-0 flex-1 flex-col", detailItem && "hidden")}>
                <PaneGrid
                  open={open}
                  // The standby board lists checkouts: quiet ones stay off it.
                  repos={railRepos}
                  cwds={cwds}
                  activeWin={activeWin}
                  activeFolderDir={activeFolderDir}
                  sessionById={sessionById}
                  folderOf={folderOf}
                  folderByDir={folderByDir}
                  now={now}
                  actions={actions}
                  focusedPaneId={focusedPaneId}
                  onFocusPane={(id) => {
                    setFocusedPaneId(id);
                    setFocusLevel("pane");
                  }}
                  onSelectFolder={selectFolder}
                  jumpRecall={jumpRecall}
                  onDismissJumpRecall={() => setJumpRecall(null)}
                  termAttention={termAttention}
                  exitLabels={exitLabels}
                  filesOpenRequests={filesOpenRequests}
                  previewRequests={previewRequests}
                  nativeVisible={nativeVisible && !detailItem}
                  labelFor={labelFor}
                  focusTerminalRequest={focusTerminalRequest}
                  onSelectSession={(dir, id) => {
                    selectSession(dir, id);
                    setFocusLevel("pane");
                  }}
                  onExit={handleExit}
                  onTitle={onTitle}
                  onOpenTerminalPath={openTerminalPath}
                  onRemovePane={closePane}
                  columns={columns}
                />
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      <SplitSessionDialog
        open={splitOpen}
        onOpenChange={setSplitOpen}
        folderName={activeFolder?.name}
        candidates={splitCandidates}
        onPick={(sessionId) => {
          setSplitOpen(false);
          if (activeFolderDir) selectSession(activeFolderDir, sessionId);
        }}
      />

      <RemoveRepoDialog
        target={confirmRemove}
        onOpenChange={closeOnFalse(() => setConfirmRemove(null))}
        onConfirm={() => {
          if (confirmRemove) void performRemove(confirmRemove);
          setConfirmRemove(null);
        }}
      />

      <DeleteWorktreeDialog
        target={worktreeDelete.confirmDeleteWt}
        task={worktreeDelete.deleteWtTask}
        outcome={worktreeDelete.deleteWtOutcome}
        force={worktreeDelete.deleteWtForce}
        onOpenChange={closeOnFalse(worktreeDelete.clearConfirm)}
        onSwapOutcome={worktreeDelete.swapOutcome}
        onForceChange={worktreeDelete.setDeleteWtForce}
        onConfirm={worktreeDelete.confirmDeleteWorktree}
      />

      {/* The guards refused — shared shell, see `BlockedDeleteDialog`. */}
      <BlockedDeleteDialog
        open={worktreeDelete.blockedDelete != null}
        // Escape/cancel abandons the flow — except once the removal is running,
        // when "keep" can no longer be honored: the dialog stays up, buttons
        // locked, until the removal resolves and closes it honestly.
        onOpenChange={closeOnFalse(() => {
          if (!worktreeDelete.blockedRemovalInFlight)
            worktreeDelete.endDeleteFlow(worktreeDelete.blockedDeleteDir);
        })}
        name={worktreeDelete.blockedDelete?.name}
        description="The worktree is still on disk. Clear what’s below and it’ll delete cleanly, or delete anyway."
        cancelLabel="Keep the worktree"
        blockers={worktreeDelete.blockedDelete?.blockers ?? []}
        messages={worktreeDelete.blockedDelete?.messages ?? []}
        busy={worktreeDelete.deleteBusy}
        cancelDisabled={worktreeDelete.blockedRemovalInFlight}
        stoppingPort={worktreeDelete.stoppingPort}
        onStopPort={(port) => {
          const blocked = worktreeDelete.blockedDelete;
          if (blocked) void worktreeDelete.stopPortAndRetry(blocked, port);
        }}
        forceHint={shortcutHint("ab-confirm-close-worktree")}
        onForce={worktreeDelete.forceDeleteBlocked}
      />

      <StartClaudeDialog
        target={startClaudeTarget}
        prompt={startClaudePrompt}
        onPromptChange={setStartClaudePrompt}
        onCommit={commitStartClaude}
        onOpenChange={closeOnFalse(commitStartClaude)}
      />
    </div>
  );
}
