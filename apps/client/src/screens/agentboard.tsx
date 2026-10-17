import { useEffect, useMemo, useRef, useState } from "react";
import { WorkingContext } from "@/components/agentboard-working-context";
import { QueueRail, FOLDED_BY_DEFAULT } from "@/components/queue-rail";
import { RailIconStrip } from "@/components/agentboard-rail";
import { useNow, useNowInterval } from "@/lib/now";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { useScrollEdges } from "@/components/scroll-edge-shades";
import { cleanupMissing } from "./agentboard/helpers";
import { useCollapseState } from "./agentboard/use-collapse-state";
import { useColumnDrag } from "./agentboard/use-column-drag";
import { useAttention } from "./agentboard/use-attention";
import { useRailIndex } from "./agentboard/use-rail-index";
import { useTaskCreation } from "./agentboard/use-task-creation";
import { useTauriEvent } from "./agentboard/use-tauri-event";
import { useWindowLayout } from "./agentboard/use-window-layout";
import { useWorktreeDelete } from "./agentboard/use-worktree-delete";
import { useCacheExpiryToast } from "./agentboard/use-cache-expiry-toast";
import { usePeekReveal } from "./agentboard/use-peek-reveal";
import { useBoardRequests } from "./agentboard/use-board-requests";
import { useSessionSpawn, type FocusTerminalRequest } from "./agentboard/use-session-spawn";
import { useViewPanes } from "./agentboard/use-view-panes";
import { boardShortcuts } from "./agentboard/board-shortcuts";
import { BoardDialogs } from "./agentboard/board-dialogs";
import { CheckoutTree } from "./agentboard/checkout-tree";
import { terminalFocused } from "./agentboard/focus-dom";
import { toggled } from "./agentboard/helpers";
import { PaneGrid } from "./agentboard/pane-grid";
import { RailHeader } from "./agentboard/rail-header";
import { railNavigation } from "./agentboard/rail-navigation";
import { useAdvanceAfterSubmit } from "./agentboard/use-advance-after-submit";
import { LandQueueDialog } from "./agentboard/land-dialog";
import { useQueueActions } from "./agentboard/queue-actions";
import { defaultTaskRepo, RailNewTask } from "./agentboard/rail-new-task";
import { RailPanel } from "./agentboard/rail-panel";
import { selectionActions, type RailSnapshot } from "./agentboard/selection-actions";
import { sessionActions } from "./agentboard/session-actions";
import { sessionLifecycle } from "./agentboard/session-lifecycle";
import { WindowStrip } from "./agentboard/window-strip";
import type { RemoveTarget } from "@/lib/agentboard/actions";
import {
  folderRecreateBranch,
  folderRemoving,
  prForFolder,
  taskForFolder,
  folderTask,
  isFolderUnmanaged,
  isHomeRepo,
} from "@/lib/agentboard/folder";
import { claudeTitleName, sessionLabel } from "@/lib/agentboard/session";
import { useAgentboardState, useSetAgentOverlay } from "@/lib/agentboard/state";
import type { FolderData, RepoData, Selected, SessionData } from "@/lib/agentboard/types";
import { paneCloseTarget, type FocusLevel } from "@/lib/agentboard/windows";
import type { JumpRecall } from "@/lib/jump-recall";
import { shortcutHint, useModifierHeld, useShortcuts } from "@/lib/shortcuts";
import { useStoreSnapshot } from "@/lib/data";
import {
  filterQueue,
  nextUpArrival,
  onYouHead,
  parseFoldedLanes,
  railRows,
  rowForFolder,
  useTaskQueue,
} from "@/lib/queue";
import type { Lane } from "@/lib/schemas/queue";
import { focusTargetStore, useFocusTarget } from "@/lib/focus-target";
import { railHotkeyTargets } from "@/lib/rail-hotkeys";
import { railNodes, resolveCursor, type RailNode } from "@/lib/rail-nodes";
import {
  useBrowserPane,
  useJarvisPane,
  useShowQuiet,
  useRailFilter,
  useShowUnmanagedWorktrees,
} from "@/lib/rail-prefs";
import { useWorkspace } from "@/lib/workspace";
import { repoParentDirs } from "@/lib/new-repo";
import { uiAction } from "@/lib/ui-action";
import { toast } from "@/lib/toast";

const LAST_TASK_REPO_KEY = "tt-agentboard-last-task-repo";

/** Agent Board — one screen, two rails over the same checkouts. The queue rail
 * is their tasks (Next up, then the lanes), worked one at a time; the tree rail
 * is every repo → checkout → session, walked by place. Either way,
 * picking a row puts its terminals and panes beside it, and the panes, shells
 * and selection are the same ones. Agent status is reported, never re-rendered. */
const FOLDED_LANES_KEY = "tt-queue-folded-lanes";

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function AgentBoardScreen() {
  const state = useAgentboardState();
  const { snapshot } = useStoreSnapshot();
  const { openTab, activeTab, openSettingsTab, railView, setRailView } = useWorkspace();
  const tree = railView === "tree";
  const onScreen = activeTab === "agentboard";
  // Deep-link focus: a "needs you" popover row scrolls its PR or repo into view here.
  const focusRef = useFocusTarget<HTMLDivElement>("agentboard");
  const now = useNow();
  const repos = state.repos;
  const repoByFolder = useMemo(
    () => new Map(repos.flatMap((r) => r.folders.map((f) => [f.dir, r] as const))),
    [repos],
  );

  const [selected, setSelected] = useState<Selected>(null);
  const [jumpRecall, setJumpRecall] = useState<JumpRecall | null>(null);
  // A ref, not previous state: `selectSession` clears the card in the same batch that sets it.
  const jumpNonce = useRef(0);
  // The tile that last claimed a click — the sole driver of the violet ring.
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null);
  const [focusLevel, setFocusLevel] = useState<FocusLevel>("rail");
  // Agent Board's cursor: one row of `railTree`, kept as the node so a row that
  // disappears can hand the cursor to whatever now stands for it.
  const [railCursor, setRailCursor] = useState<RailNode | null>(null);
  const { queue, live: queueLive } = useTaskQueue();
  // Never persisted, like the tree's search: a queue that opens narrowed to
  // yesterday's repos is a queue with work missing and no memory of why.
  const [repoFilter, setRepoFilter] = useState<ReadonlySet<string>>(() => new Set());
  const railEdges = useScrollEdges();
  const [foldedLanes, setFoldedLanes] = useState<Set<Lane>>(
    () => parseFoldedLanes(readStored(FOLDED_LANES_KEY)) ?? new Set(FOLDED_BY_DEFAULT),
  );
  useEffect(() => {
    try {
      localStorage.setItem(FOLDED_LANES_KEY, JSON.stringify([...foldedLanes]));
    } catch {
      // Unremembered folds just reopen at the default next launch.
    }
  }, [foldedLanes]);
  // The checkout whose snooze menu is open — `z` opens it from the keyboard.
  const [snoozeId, setSnoozeId] = useState<string | null>(null);
  // The nonce lets a re-request of the *same* session still fire.
  const [focusTerminalRequest, setFocusTerminalRequest] = useState<FocusTerminalRequest | null>(
    null,
  );
  const [activeFolderDir, setActiveFolderDir] = useState<string | null>(null);
  // Shown only with more than one candidate; a single one is added directly.
  const [splitOpen, setSplitOpen] = useState(false);
  // Pending remove awaiting confirmation because it would kill live sessions.
  const [confirmRemove, setConfirmRemove] = useState<RemoveTarget | null>(null);
  // Session ids whose PTY is mounted (kept alive for scrollback), + their cwd.
  const [open, setOpen] = useState<string[]>([]);
  const cwds = useRef<Record<string, string>>({});
  const expectedKills = useRef<Set<string>>(new Set());
  const { collapsed, toggleCollapsed, applyCollapse, railCollapsed, toggleRail } = useCollapseState(
    state,
    "agentboard",
  );
  // Filtered-out folders demote to a per-repo "N idle" stub, never hidden.
  const { filter, recentHours, setFilter, setRecentHours } = useRailFilter();
  // Whether worktrees `tt task` didn't create get rail folders at all.
  const [showUnmanagedWorktrees, setShowUnmanagedWorktrees] = useShowUnmanagedWorktrees();
  const [jarvisPane, setJarvisPane] = useJarvisPane();
  const [browserPane] = useBrowserPane();
  const nativeVisible = onScreen;
  // The idle stub's peek is view state — it belongs to one glance at one repo.
  // Quiet is a persisted view mode instead: its switch is in the rail header,
  // so the hiding is never something you can't find your way back out of.
  const { idleRevealed, unmanagedRevealed, toggleIdleRevealed, toggleUnmanagedRevealed } =
    usePeekReveal();
  const [showQuiet, setShowQuiet] = useShowQuiet();
  // Never persisted: a rail that opened already narrowed to yesterday's search
  // is a rail with repos missing and no memory of why.
  const [query, setQuery] = useState("");
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

  // The queue is the tree's checkouts in another order: what the tree leaves out
  // — quiet ones, and unmanaged worktrees nothing is running in — it does too.
  const railQueue = useMemo(() => {
    const onRail = new Set(
      railRepos.flatMap((r) =>
        r.folders
          .filter((f) => !isFolderUnmanaged(f) || f.dir === activeFolderDir)
          .map((f) => f.dir),
      ),
    );
    return filterQueue(
      queue,
      (dir) => onRail.has(dir),
      new Set(),
      () => undefined,
    );
  }, [queue, railRepos, activeFolderDir]);
  const shownQueue = useMemo(
    () =>
      filterQueue(
        railQueue,
        () => true,
        repoFilter,
        (dir) => repoByFolder.get(dir)?.key,
      ),
    [railQueue, repoFilter, repoByFolder],
  );

  const { wins, updateWins, addPaneToActive, removePane } = useWindowLayout({
    state,
    repos,
    open,
    cwds,
  });

  // Hold-to-reveal jump keys: the badges paint on the rows the numbering is
  // computed from, so what you press is what you read. The targets are kept
  // even while nothing is held — the handlers address them without a repaint.
  const hotkeysHeld = useModifierHeld("ab-jump-session-1");
  const rows = useMemo(() => railRows(shownQueue, foldedLanes), [shownQueue, foldedLanes]);
  const railVis = useMemo(
    () => ({
      repos: shownRepos,
      idleDirs,
      idleRevealed,
      unmanagedDirs,
      unmanagedRevealed,
      collapsed,
      wins,
    }),
    [shownRepos, idleDirs, idleRevealed, unmanagedDirs, unmanagedRevealed, collapsed, wins],
  );
  const railTree = useMemo(() => railNodes(railVis), [railVis]);
  const cursorNode = useMemo(() => resolveCursor(railTree, railCursor), [railTree, railCursor]);
  const cursorKey = cursorNode?.key ?? null;
  const hotkeyTargets = useMemo(() => railHotkeyTargets(railVis), [railVis]);
  // Every row is a checkout, so the ring follows the one on screen, however it got there.
  const ringItem = rowForFolder(shownQueue, activeFolderDir);
  const ringId = ringItem?.folderDir ?? null;
  // The collapsed strip has no rows to badge, so it offers no numbers. Keyed by
  // session on the tree, by checkout on the queue.
  const showHotkeys = hotkeysHeld && !railCollapsed;
  const treeHotkeys = useMemo(
    () =>
      showHotkeys && tree ? new Map(hotkeyTargets.map((t, i) => [t.sessionId, i + 1])) : undefined,
    [showHotkeys, tree, hotkeyTargets],
  );
  const queueHotkeys = useMemo(
    () =>
      showHotkeys && !tree
        ? new Map(rows.slice(0, 9).map((r, i) => [r.folderDir, i + 1]))
        : undefined,
    [showHotkeys, tree, rows],
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
  const railRef = useRef<RailSnapshot>({ repos, folderNameByDir, railQueue, shownQueue, railTree });
  useEffect(() => {
    railRef.current = { repos, folderNameByDir, railQueue, shownQueue, railTree };
  });

  useCacheExpiryToast(repos, now);

  const { ackFolder, selectFolder, mountSession, selectSession } = selectionActions({
    railRef,
    cwds,
    addPaneToActive,
    setOpen,
    setSelected,
    setJumpRecall,
    setRailCursor,
    setActiveFolderDir,
    setFocusedPaneId,
    setFocusLevel,
    setTermAttention,
  });

  const parentDirs = useMemo(
    () => repoParentDirs(repos.filter((r) => !isHomeRepo(r)).map((r) => r.dir)),
    [repos],
  );

  const openRepoManager = () => {
    uiAction("repo.manage_opened", "agentboard");
    openSettingsTab({ tab: "agentboard" });
  };

  const attention = useAttention({ snapshot, now, openTab });

  const worktreeDelete = useWorktreeDelete({
    repos,
    prs: snapshot.prs,
    tasks: snapshot.tasks,
    expectedKills,
    onSessionRemoved: (id) => {
      setOpen((prev) => prev.filter((x) => x !== id));
      setSelected((cur) => (cur?.sessionId === id ? null : cur));
      removePane(id);
    },
  });
  const { requestDeleteWorktree } = worktreeDelete;

  // The live Claude title while the shell runs, else the backend-derived name.
  const labelFor = (s: SessionData) =>
    (s.live ? claudeTitleName(titles[s.id]) : null) ?? sessionLabel(s);

  const viewPanes = useViewPanes({
    folderByDir,
    railRef,
    activeFolderDirRef,
    setActiveFolderDir,
    setFocusedPaneId,
    setFocusLevel,
    addPaneToActive,
    ackFolder,
  });
  const { openFiles, openPreview, openBrowser, openJarvis } = viewPanes;

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

  const columns = useColumnDrag(updateWins);

  const spawn = useSessionSpawn({
    folderOf,
    cwds,
    collapsed,
    selectSession,
    setOverlay,
    applyCollapse,
    setFocusLevel,
    setFocusTerminalRequest,
    updateWins,
  });
  const { newSession, newRootShell, launchClaudeIn } = spawn;

  const lifecycle = sessionLifecycle({
    repos,
    wins,
    focusedPaneId,
    selected,
    activePanes: activeWin?.panes ?? [],
    sessionById,
    expectedKills,
    labelFor,
    selectSession,
    removePane,
    setFocusedPaneId,
    setOpen,
    setSelected,
    setConfirmRemove,
    setRenaming,
  });
  const { closeSession, closePane, closeFocusedPane, requestRemoveRepo } = lifecycle;

  const actions = sessionActions({
    wins,
    setOverlay,
    selectSession,
    selectFolder,
    setStartClaudeTarget: spawn.setStartClaudeTarget,
    setRenaming,
    setFocusLevel,
    withLiveSession: (sessionId, fn) => spawn.withLiveSession(sessionId, fn),
    closeSession,
    launchDevServer: spawn.launchDevServer,
    updateWins,
  });

  const nav = railNavigation({
    tree,
    now,
    selected,
    activeFolderDir,
    activeFolder,
    activeWin,
    windowsForFolder,
    sessionById,
    folderOf,
    cwds,
    railRef,
    shownRepos,
    railQueue,
    railTree,
    cursorKey,
    cursorNode,
    collapsed,
    rows,
    ringId,
    hotkeyTargets,
    focusLevel,
    focusedPaneId,
    jumpNonce,
    applyCollapse,
    selectSession,
    selectFolder,
    focusWindow: actions.focusWindow,
    setJumpRecall,
    setRailCursor,
    setFocusLevel,
    setFocusedPaneId,
    setFocusTerminalRequest,
  });
  useAdvanceAfterSubmit(nav.advanceFrom, sessionById);

  function toggleLane(lane: Lane) {
    uiAction("queue.lane_toggle", "agentboard", lane);
    setFoldedLanes((cur) => toggled(cur, lane));
  }

  // The head of On you changed: open it only where nothing would be
  // interrupted. Never moves DOM focus, and never announces itself.
  const onYou = onYouHead(railQueue);
  const onYouId = onYou?.folderDir ?? null;
  const lastOnYouId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!queueLive) return;
    const verdict = nextUpArrival(lastOnYouId.current, onYou, {
      terminalFocused: terminalFocused(),
      selectedId: activeFolderDir,
    });
    lastOnYouId.current = onYouId;
    // The tree is walked by place: the queue's pull is the queue's business.
    if (!onYou || tree) return;
    if (verdict === "open") nav.selectQueueItem(onYou, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires on a new head only; the rest is read at that moment
  }, [onYouId, queueLive]);
  // A deep link to a PR lands on its checkout's row, which a folded lane would hide.
  useEffect(
    () =>
      focusTargetStore.subscribe(() => {
        const t = focusTargetStore.get();
        if (t?.screen !== "agentboard") return;
        // A PR is a queue row; a repo is a tree row.
        if (t.kind === "repo") return setRailView("tree");
        if (t.kind !== "pr") return;
        setRailView("queue");
        const row = railRef.current.railQueue.items.find(
          (i) => i.pr && `${i.pr.repo}#${i.pr.number}` === t.id,
        );
        // A filter that hides the row gives way to it.
        if (row && !railRef.current.shownQueue.items.includes(row)) setRepoFilter(new Set());
        if (row)
          setFoldedLanes((cur) => {
            if (!cur.has(row.lane)) return cur;
            const next = new Set(cur);
            next.delete(row.lane);
            return next;
          });
      }),
    [setRailView],
  );

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

  // The rail's new-task form, for one repo: a queue chip or a tree `+` picks it,
  // the shortcut takes the default. Opening again closes it.
  const [railTaskRepoKey, setRailTaskRepoKey] = useState<string | null>(null);
  // Set only by a fork, and cleared with the form.
  const [railTaskBase, setRailTaskBase] = useState<string | undefined>(undefined);

  function openRailNewTask(repoKey?: string) {
    if (railCollapsed) toggleRail();
    setRailTaskBase(undefined);
    if (railTaskRepoKey !== null && repoKey === undefined) {
      setRailTaskRepoKey(null);
      return;
    }
    const picked = repoKey
      ? repos.find((r) => r.key === repoKey)
      : defaultTaskRepo(repos, activeRepo?.key, localStorage.getItem(LAST_TASK_REPO_KEY));
    if (!picked) return;
    setRailTaskRepoKey(picked.key);
  }

  // A `no worktree` row's way back: the ordinary create path with the existing
  // `taskId`, so the row keeps its place, issues and PRs instead of becoming a
  // second card — and no Claude, since this repairs rather than restarts.
  function recreateWorktree(repo: RepoData, folder: FolderData) {
    const branch = folderRecreateBranch(folder);
    const task = folderTask(folder);
    if (!branch || !task) return;
    uiAction("agentboard.recreate_worktree", "agentboard");
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
        templateSetup: "",
        taskId: task.id,
      },
    );
  }

  const queueActions = useQueueActions({
    shownQueueItems: shownQueue.items,
    sessionById,
    tasks: snapshot.tasks,
    repoByFolder,
    openBrowser: browserPane ? openBrowser : undefined,
    selectFolder,
    actions,
    setStartClaudePrompt: spawn.setStartClaudePrompt,
    openFork: (repoKey, base) => {
      if (railCollapsed) toggleRail();
      setRailTaskRepoKey(repoKey);
      setRailTaskBase(base);
    },
  });

  useBoardRequests({
    selectSession,
    withLiveSession: spawn.withLiveSession,
    setActiveFolderDir,
    ackFolder,
    taskCreation,
    viewPanes,
    openNextUp: nav.openNextUp,
  });

  useShortcuts(
    useMemo(
      () =>
        boardShortcuts({
          tree,
          activeFolderDir,
          activeFolder,
          activeWin,
          selected,
          sessionById,
          ringItem,
          shownQueueItems: shownQueue.items,
          worktreeDelete,
          newSession,
          openRailNewTask: () => openRailNewTask(),
          requestDeleteWorktree,
          closeFocusedPane,
          openFiles,
          toggleRail,
          setRailView,
          jumpToNeedsYou: nav.jumpToNeedsYou,
          jumpToNotBusy: nav.jumpToNotBusy,
          jumpToHotkey: nav.jumpToHotkey,
          focusByArrow: nav.focusByArrow,
          collapseWholeRail: nav.collapseWholeRail,
          moveQueueCursor: nav.moveQueueCursor,
          setSnoozeId,
          queueActions: queueActions.actions,
          folderByDir,
          focusActiveTerminal: nav.focusActiveTerminal,
          splitIntoWindow,
        }),
      // eslint-disable-next-line react-hooks/exhaustive-deps -- handlers are stable within a render; only the state they close over (listed) should rebuild the map
      [
        tree,
        activeFolderDir,
        collapsed,
        shownQueue,
        rows,
        railTree,
        cursorKey,
        cursorNode,
        hotkeyTargets,
        ringId,
        ringItem,
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
        folderByDir,
        snapshot.tasks,
        browserPane,
      ],
    ),
    "agentboard",
    onScreen,
  );

  // Both rails open the new-task form under their header; the header and the
  // tree are Agent Board's alone.
  const railTaskRepo = repos.find((r) => r.key === railTaskRepoKey);
  const newTaskForm = railTaskRepo && (
    <RailNewTask
      repo={railTaskRepo}
      base={railTaskBase}
      onCancel={() => {
        setRailTaskRepoKey(null);
        setRailTaskBase(undefined);
      }}
      onSubmit={(repo, input) => {
        localStorage.setItem(LAST_TASK_REPO_KEY, repo.key);
        setRailTaskRepoKey(null);
        setRailTaskBase(undefined);
        void taskCreation.createTask(
          {
            name: repo.name,
            dir: repo.folders[0].dir,
            key: repo.key,
            originUrl: repo.originUrl,
          },
          input,
        );
      }}
    />
  );
  const railHeader = (
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
  );
  const checkoutTree = (
    <CheckoutTree
      repos={repos}
      shownRepos={shownRepos}
      query={query}
      onClearQuery={() => setQuery("")}
      quietCount={quietCount}
      showQuiet={showQuiet}
      onOpenRepoManager={openRepoManager}
      idleDirs={idleDirs}
      idleRevealed={idleRevealed}
      onToggleIdle={toggleIdleRevealed}
      unmanagedDirs={unmanagedDirs}
      unmanagedRevealed={unmanagedRevealed}
      onToggleUnmanaged={toggleUnmanagedRevealed}
      quietDirs={quietDirs}
      taskCreation={taskCreation}
      onNewRootShell={(repo) => void newRootShell(repo)}
      onNewTask={(target) => openRailNewTask(target.key)}
      onRecreateWorktree={recreateWorktree}
      shared={{
        now,
        compactPct: state.compactRecommendPercent,
        prs: snapshot.prs,
        tasks: snapshot.tasks,
        selectedSessionId: selected?.sessionId ?? null,
        activePaneId: focusedPaneId,
        activeFolderDir,
        cursorKey: tree ? cursorKey : null,
        hotkeys: treeHotkeys,
        collapsed,
        renaming,
        titles,
        wins,
        actions,
        onToggle: toggleCollapsed,
        onSelectFolder: selectFolder,
        onSelect: selectSession,
        onNewSession: newSession,
        onRemoveRepo: requestRemoveRepo,
        onDeleteWorktree: requestDeleteWorktree,
        settingUpDirs: taskCreation.settingUpDirs,
        onRenameCommit: lifecycle.commitRename,
        onOpenFiles: openFiles,
        onOpenPreview: openPreview,
        // Undefined while `agentboard.jarvisPane` is off:
        // no entry point rather than a disabled pane.
        onOpenBrowser: browserPane ? openBrowser : undefined,
        onOpenJarvis: jarvisPane ? openJarvis : undefined,
        onClosePane: closePane,
      }}
    />
  );
  const queueBody = (
    <QueueRail
      queue={shownQueue}
      allItems={railQueue.items}
      repoFilter={repoFilter}
      onRepoFilterChange={setRepoFilter}
      repoByFolder={repoByFolder}
      folderByDir={folderByDir}
      prs={snapshot.prs}
      tasks={snapshot.tasks}
      onOpenFiles={openFiles}
      live={queueLive}
      now={now}
      selectedId={ringId}
      folded={foldedLanes}
      hotkeys={queueHotkeys}
      snoozeId={snoozeId}
      onSnoozeIdChange={setSnoozeId}
      onToggleLane={toggleLane}
      onSelect={nav.pickQueueItem}
      repos={repos}
      newTaskRepoKey={railTaskRepoKey}
      onPickRepo={(repo) => {
        const closing = railTaskRepoKey === repo.key;
        uiAction("agentboard.new_task_chip", "agentboard", closing ? "close" : "open");
        setRailTaskRepoKey(closing ? null : repo.key);
        setRailTaskBase(undefined);
      }}
      newTaskForm={newTaskForm}
      queueActions={queueActions.actions}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
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
          {/* Rail: the Tree/Queue switch, rollup tally, then the task queue or the
              Repo → Folder → Session tree. Only its contents swap: the panel
              keeps its identity, so the panes beside it never remount. */}
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
                <RailPanel
                  view={railView}
                  onViewChange={setRailView}
                  repos={railRepos}
                  compactPct={state.compactRecommendPercent}
                  now={now}
                  header={tree && railHeader}
                  body={
                    tree ? (
                      <>
                        {newTaskForm}
                        {checkoutTree}
                      </>
                    ) : (
                      queueBody
                    )
                  }
                  scrollRef={railEdges.ref}
                  edges={railEdges}
                  focusRef={focusRef}
                  jarvisPane={jarvisPane}
                  nativeVisible={nativeVisible}
                />
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
              {activeFolder && activeRepo && (
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
                  onNewTask={() => openRailNewTask(activeRepo.key)}
                  onRemoveRepo={requestRemoveRepo}
                  onDeleteWorktree={requestDeleteWorktree}
                />
              )}
              {wins && activeFolderDir && (
                <WindowStrip
                  windows={windowsForFolder}
                  activeWinId={activeWin?.id}
                  keyboardFocused={focusLevel === "window"}
                  hasFocusedPane={paneCloseTarget(focusedPaneId, activeWin?.panes ?? []) !== null}
                  updateWins={updateWins}
                  onFocusWindow={actions.focusWindow}
                  onNewWindow={() => void spawn.newWindow(activeFolderDir)}
                  onNewSession={() => void newSession(activeFolderDir)}
                  onClosePane={closeFocusedPane}
                />
              )}

              <div className="flex min-h-0 flex-1 flex-col">
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
                  repoByFolder={repoByFolder}
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
                  filesOpenRequests={viewPanes.filesOpenRequests}
                  previewRequests={viewPanes.previewRequests}
                  nativeVisible={nativeVisible}
                  labelFor={labelFor}
                  focusTerminalRequest={focusTerminalRequest}
                  onSelectSession={(dir, id) => {
                    selectSession(dir, id);
                    setFocusLevel("pane");
                  }}
                  onExit={lifecycle.handleExit}
                  onTitle={onTitle}
                  onOpenTerminalPath={viewPanes.openTerminalPath}
                  onRevealTerminalPath={viewPanes.revealTerminalPath}
                  onRemovePane={closePane}
                  columns={columns}
                />
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      <BoardDialogs
        split={{
          open: splitOpen,
          onOpenChange: setSplitOpen,
          folder: activeFolder,
          candidates: splitCandidates,
          onPick: (sessionId) => {
            setSplitOpen(false);
            if (activeFolderDir) selectSession(activeFolderDir, sessionId);
          },
        }}
        remove={{
          target: confirmRemove,
          onCancel: () => setConfirmRemove(null),
          onConfirm: (target) => void lifecycle.performRemove(target),
        }}
        worktreeDelete={worktreeDelete}
        startClaude={{
          target: spawn.startClaudeTarget,
          prompt: spawn.startClaudePrompt,
          onPromptChange: spawn.setStartClaudePrompt,
          onCommit: spawn.commitStartClaude,
          onCancel: () => {
            spawn.setStartClaudeTarget(null);
            spawn.setStartClaudePrompt("");
          },
        }}
      />
      <LandQueueDialog
        rows={queueActions.landRows}
        busy={queueActions.landBusy}
        onOpenChange={(isOpen) => {
          if (!isOpen && !queueActions.landBusy) queueActions.setLandRows(null);
        }}
        onConfirm={() => void queueActions.confirmLand()}
      />
    </div>
  );
}
