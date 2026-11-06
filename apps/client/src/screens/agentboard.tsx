import { useAtomEffect, useAtomValue } from "@/lib/atoms/react";
import { storeSnapshotAtom } from "@/lib/store-snapshot";
import { useMemo } from "react";
import { WorkingContext } from "@/components/agentboard-working-context";
import { QueueRail } from "@/components/queue-rail";
import { RailIconStrip } from "@/components/agentboard-rail";
import { nowAtom } from "@/lib/now";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { useScrollEdges } from "@/components/scroll-edge-shades";
import { cleanupMissing } from "./agentboard/helpers";
import { useColumnDrag } from "./agentboard/use-column-drag";
import { useAttention } from "./agentboard/use-attention";
import { useTaskCreation } from "./agentboard/use-task-creation";
import { useTauriEvent } from "@/lib/run";
import { useWorktreeDelete } from "./agentboard/use-worktree-delete";
import { useCacheExpiryToast } from "./agentboard/use-cache-expiry-toast";
import { useBoardRequests } from "./agentboard/use-board-requests";
import { useSessionSpawn } from "./agentboard/use-session-spawn";
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
import { sessionActions } from "./agentboard/session-actions";
import { sessionLifecycle } from "./agentboard/session-lifecycle";
import { WindowStrip } from "./agentboard/window-strip";
import {
  folderRecreateBranch,
  folderRemoving,
  prForFolder,
  taskForFolder,
  folderTask,
  isHomeRepo,
} from "@/lib/agentboard/folder";
import { claudeTitleName, sessionLabel } from "@/lib/agentboard/session";
import { useStableFn, useStableFns } from "@/lib/use-stable-fn";
import { setAgentOverlay, agentboardAtom } from "@/lib/agentboard/state";
import type { FolderData, RepoData, SessionData } from "@/lib/agentboard/types";
import { dropSessionlessWindows, paneCloseTarget } from "@/lib/agentboard/windows";
import { shortcutHint, useModifierHeld, useShortcuts } from "@/lib/shortcuts";

import { nextUpArrival, onYouHead, taskQueueAtom } from "@/lib/queue";
import type { Lane } from "@/lib/schemas/queue";
import { focusTargetAtom, useFocusTarget } from "@/lib/focus-target";
import {
  useBrowserPane,
  useShowQuiet,
  useRailFilter,
  useShowUnmanagedWorktrees,
} from "@/lib/rail-prefs";
import {
  activeTabAtom,
  openSettingsTab,
  openTab,
  railViewAtom,
  setRailView,
} from "@/lib/workspace";
import { repoParentDirs } from "@/lib/new-repo";
import { uiAction } from "@/lib/ui-action";
import { toast } from "@/lib/toast";
import { read, write } from "@/lib/atoms/registry";
import {
  activeFolderDirRef,
  boardField,
  cwdsRef,
  jumpNonce,
  expectedKills,
  foldedLanesAtom,
  lastTaskRepoAtom,
  selectedIdRef,
  setActiveFolderDir,
  setConfirmRemove,
  setFocusedPaneId,
  setFocusLevel,
  setFocusTerminalRequest,
  setFoldedLanes,
  setIdleRevealed,
  setJumpRecall,
  setOpen,
  setQuery,
  setRailCursor,
  setRailTaskBase,
  setRailTaskRepoKey,
  setRenaming,
  setRepoFilter,
  setSelected,
  setSnoozeId,
  setSplitOpen,
  setTermAttention,
  setTitles,
  setUnmanagedRevealed,
} from "@/lib/board/atoms";
import {
  addPaneToActive,
  applyCollapse,
  RAIL_COLLAPSE_KEY,
  removePane,
  toggleCollapsed,
  toggleRail,
  updateWins,
} from "@/lib/board/commands";
import {
  activeFolderAtom,
  activeRepoAtom,
  activeWinAtom,
  archiveSplitAtom,
  collapsedAtom,
  cursorNodeAtom,
  hotkeyTargetsAtom,
  idleDirsAtom,
  lookupsAtom,
  onYouHeadIdAtom,
  queueRowsAtom,
  quietSplitAtom,
  railQueueAtom,
  railRef,
  railTreeAtom,
  ringItemAtom,
  shownQueueAtom,
  shownReposAtom,
  splitCandidatesAtom,
  unmanagedDirsAtom,
  visibleReposAtom,
  windowsForFolderAtom,
  winsAtom,
} from "@/lib/board/derive";
import { SELECTION } from "@/lib/board/selection";

/** Agent Board — one screen, two rails over the same checkouts. The queue rail
 * is their tasks (Next up, then the lanes), worked one at a time; the tree rail
 * is every repo → checkout → session, walked by place. Either way,
 * picking a row puts its terminals and panes beside it, and the panes, shells
 * and selection are the same ones. Agent status is reported, never re-rendered. */
// Board commands with no render inputs: module scope, one identity for ever.
const onTitle = (id: string, title: string) =>
  setTitles((m) => (m[id] === title ? m : { ...m, [id]: title }));

const openRepoManager = () => {
  uiAction("repo.manage_opened", "agentboard");
  openSettingsTab({ tab: "agentboard" });
};

function toggleLane(lane: Lane) {
  uiAction("queue.lane_toggle", "agentboard", lane);
  setFoldedLanes((cur) => toggled(cur, lane));
}

export function AgentBoardScreen() {
  const state = useAtomValue(agentboardAtom);
  const { snapshot } = useAtomValue(storeSnapshotAtom);
  const activeTab = useAtomValue(activeTabAtom);
  const railView = useAtomValue(railViewAtom);
  const tree = railView === "tree";
  const onScreen = activeTab === "agentboard";
  // Deep-link focus: a "needs you" popover row scrolls its PR or repo into view here.
  const focusRef = useFocusTarget<HTMLDivElement>("agentboard");
  const now = useAtomValue(nowAtom);
  const repos = state.repos;
  const queueLive = useAtomValue(taskQueueAtom).live;
  const railEdges = useScrollEdges();

  // The UI record, field by field: each read wakes this screen only when that
  // field changes. Writes go through board/atoms' setters and board/commands.
  const selected = useAtomValue(boardField("selected"));
  const jumpRecall = useAtomValue(boardField("jumpRecall"));
  const focusedPaneId = useAtomValue(boardField("focusedPaneId"));
  const focusLevel = useAtomValue(boardField("focusLevel"));
  const repoFilter = useAtomValue(boardField("repoFilter"));
  const foldedLanes = useAtomValue(foldedLanesAtom);
  const snoozeId = useAtomValue(boardField("snoozeId"));
  const focusTerminalRequest = useAtomValue(boardField("focusTerminalRequest"));
  const activeFolderDir = useAtomValue(boardField("activeFolderDir"));
  const splitOpen = useAtomValue(boardField("splitOpen"));
  const confirmRemove = useAtomValue(boardField("confirmRemove"));
  const open = useAtomValue(boardField("open"));
  const idleRevealed = useAtomValue(boardField("idleRevealed"));
  const unmanagedRevealed = useAtomValue(boardField("unmanagedRevealed"));
  const query = useAtomValue(boardField("query"));
  const renaming = useAtomValue(boardField("renaming"));
  const titles = useAtomValue(boardField("titles"));
  const termAttention = useAtomValue(boardField("termAttention"));
  const railTaskRepoKey = useAtomValue(boardField("railTaskRepoKey"));
  const railTaskBase = useAtomValue(boardField("railTaskBase"));

  const collapsed = useAtomValue(collapsedAtom);
  const railCollapsed = !!collapsed[RAIL_COLLAPSE_KEY];
  // Filtered-out folders demote to a per-repo "N idle" stub, never hidden.
  const { filter, recentHours, setFilter, setRecentHours } = useRailFilter();
  // Whether worktrees `tt task` didn't create get rail folders at all.
  const [showUnmanagedWorktrees, setShowUnmanagedWorktrees] = useShowUnmanagedWorktrees();
  const [browserPane] = useBrowserPane();
  // Quiet is a persisted view mode: its switch is in the rail header, so the
  // hiding is never something you can't find your way back out of.
  const [showQuiet, setShowQuiet] = useShowQuiet();

  const { active: unarchivedRepos, archived: archivedRepos } = useAtomValue(archiveSplitAtom);
  const { shown: railRepos, quietDirs, quietCount } = useAtomValue(quietSplitAtom);
  const shownRepos = useAtomValue(shownReposAtom);
  const queryHidden = railRepos.length - shownRepos.length;
  const idleDirs = useAtomValue(idleDirsAtom);
  const unmanagedDirs = useAtomValue(unmanagedDirsAtom);
  const visibleRepos = useAtomValue(visibleReposAtom);
  const {
    missingRepoCount,
    folderOf,
    sessionById,
    folderByDir,
    repoOf: repoByFolder,
  } = useAtomValue(lookupsAtom);
  const activeFolder = useAtomValue(activeFolderAtom);
  const activeRepo = useAtomValue(activeRepoAtom);
  const railQueue = useAtomValue(railQueueAtom);
  const shownQueue = useAtomValue(shownQueueAtom);
  const wins = useAtomValue(winsAtom);
  const rows = useAtomValue(queueRowsAtom);
  const railTree = useAtomValue(railTreeAtom);
  const cursorNode = useAtomValue(cursorNodeAtom);
  const cursorKey = cursorNode?.key ?? null;
  const hotkeyTargets = useAtomValue(hotkeyTargetsAtom);
  const ringItem = useAtomValue(ringItemAtom);
  const ringId = ringItem?.folderDir ?? null;
  const windowsForFolder = useAtomValue(windowsForFolderAtom);
  const activeWin = useAtomValue(activeWinAtom);
  const splitCandidates = useAtomValue(splitCandidatesAtom);

  const setOverlay = setAgentOverlay;
  const toggleIdleRevealed = (repoKey: string) => {
    uiAction("agentboard.idle_peek", "agentboard", idleRevealed.has(repoKey) ? "hide" : "show");
    setIdleRevealed((keys) => toggled(keys, repoKey));
  };
  const toggleUnmanagedRevealed = (repoKey: string) => {
    uiAction(
      "agentboard.unmanaged_peek",
      "agentboard",
      unmanagedRevealed.has(repoKey) ? "hide" : "show",
    );
    setUnmanagedRevealed((keys) => toggled(keys, repoKey));
  };

  // Hold-to-reveal jump keys: the badges paint on the rows the numbering is
  // computed from, so what you press is what you read. The collapsed strip has
  // no rows to badge, so it offers no numbers. Keyed by session on the tree, by
  // checkout on the queue.
  const hotkeysHeld = useModifierHeld("ab-jump-session-1");
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

  useCacheExpiryToast(repos, now);

  const { ackFolder, selectFolder, mountSession, selectSession } = SELECTION;

  const parentDirs = useMemo(
    () => repoParentDirs(repos.filter((r) => !isHomeRepo(r)).map((r) => r.dir)),
    [repos],
  );

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
  const { requestDeleteWorktree, discardWorktree, blockedByDir } = worktreeDelete;

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
  const { openFiles, openPreview, openBrowser } = viewPanes;

  // A BEL or OSC 9/777 — Claude Code's "needs your input".
  useTauriEvent<{ termId: string; kind: string; body?: string }>(
    "terminal://notify",
    ({ termId, kind, body }) => {
      // The session the user is looking at doesn't need a badge.
      if (termId === selectedIdRef.current && document.hasFocus()) return;
      setTermAttention((m) => (m[termId] ? m : { ...m, [termId]: true }));
      if (kind === "notify" && body) toast(body);
    },
  );

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
    cwds: cwdsRef,
    collapsed,
    selectSession,
    setOverlay,
    applyCollapse,
    setFocusLevel,
    setFocusTerminalRequest,
    updateWins,
  });
  const { newSession, newRootShell, launchClaudeIn } = spawn;

  // Opening a checkout lands on a shell, never a leftover files tile: windows
  // with no session go, and with none left its first session is mounted, else
  // a fresh shell started. Reads the atoms at call time, so the mount-only nav
  // handler sees what is on screen now.
  const newSessionLatest = useStableFn(newSession);
  function openFolder(folderDir: string) {
    selectFolder(folderDir);
    const cur = read(winsAtom);
    if (!cur) return;
    const kept = dropSessionlessWindows(cur, folderDir);
    if (kept !== cur) updateWins([folderDir], (w) => dropSessionlessWindows(w, folderDir));
    if (kept.windows.some((w) => w.folderDir === folderDir)) return;
    const first = read(lookupsAtom).folderByDir.get(folderDir)?.sessions[0];
    if (first) selectSession(folderDir, first.id);
    else void newSessionLatest(folderDir, false, false);
  }

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

  // Fixed identity, so the memoised session rows are not re-rendered by it.
  const actions = useStableFns(
    sessionActions({
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
    }),
  );

  const stableSelect = useStableFn(selectSession);
  const stableRenameCommit = useStableFn(lifecycle.commitRename);

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
    cwds: cwdsRef,
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
    selectFolder: openFolder,
    focusWindow: actions.focusWindow,
    setJumpRecall,
    setRailCursor,
    setFocusLevel,
    setFocusedPaneId,
    setFocusTerminalRequest,
  });
  useAdvanceAfterSubmit(nav.advanceFrom, sessionById);

  // The head of On you changed: open it only where nothing would be
  // interrupted. Never moves DOM focus, and never announces itself. The tree
  // is walked by place: the queue's pull is the queue's business.
  useAtomEffect(onYouHeadIdAtom, (id) => {
    if (id == null || read(railViewAtom) === "tree") return;
    const head = onYouHead(read(railQueueAtom));
    const verdict = nextUpArrival(undefined, head, {
      terminalFocused: terminalFocused(),
      selectedId: read(boardField("activeFolderDir")),
    });
    if (head && verdict === "open") nav.selectQueueItem(head, false);
  });
  // A deep link to a PR lands on its checkout's row, which a folded lane would hide.
  useAtomEffect(focusTargetAtom, (t) => {
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
  });

  const taskCreation = useTaskCreation({
    mountSession,
    selectSession,
    launchClaudeIn,
    selectedRef: selectedIdRef,
    activeFolderDirRef,
    railCollapsed,
    toggleRail,
  });

  // The rail's new-task form, for one repo: a queue chip or a tree `+` picks it,
  // the shortcut takes the default. Opening again closes it. A fork sets the base.
  function openRailNewTask(repoKey?: string) {
    if (railCollapsed) toggleRail();
    setRailTaskBase(undefined);
    if (railTaskRepoKey !== null && repoKey === undefined) {
      setRailTaskRepoKey(null);
      return;
    }
    const picked = repoKey
      ? repos.find((r) => r.key === repoKey)
      : defaultTaskRepo(repos, activeRepo?.key, read(lastTaskRepoAtom));
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
    selectFolder: openFolder,
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
    openFolder,
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
        write(lastTaskRepoAtom, repo.key);
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
      onOpenRepoManager={openRepoManager}
      onCleanupMissing={() => void cleanupMissing()}
      onClearDismissals={() => void attention.clearDismissals()}
      onCollapseRail={toggleRail}
      parentDirs={parentDirs}
    />
  );
  const checkoutTree = (
    <CheckoutTree
      repos={unarchivedRepos}
      archivedRepos={archivedRepos}
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
        onSelectFolder: openFolder,
        onSelect: stableSelect,
        onNewSession: newSession,
        onRemoveRepo: requestRemoveRepo,
        onDeleteWorktree: requestDeleteWorktree,
        onDiscardWorktree: discardWorktree,
        deleteBlockers: blockedByDir,
        settingUpDirs: taskCreation.settingUpDirs,
        onRenameCommit: stableRenameCommit,
        onOpenFiles: openFiles,
        onOpenPreview: openPreview,
        // Undefined while `agentboard.browserPane` is off:
        // no entry point rather than a disabled pane.
        onOpenBrowser: browserPane ? openBrowser : undefined,
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
            onSelectFolder={openFolder}
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
                  scales it with the window instead, so a comfortable 640px rail
                  ends up a few hundred pixels narrower on a smaller window —
                  below the width a row is laid out for, which is where its
                  right-edge content starts disappearing past the rail's
                  clipping edge. minSize is that width: indent + chevron/icon +
                  a readable title + the four trailing icon buttons. */}
              <ResizablePanel
                defaultSize="640px"
                minSize="300px"
                maxSize="880px"
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
                  cwds={cwdsRef}
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
                  onSelectFolder={openFolder}
                  jumpRecall={jumpRecall}
                  onDismissJumpRecall={() => setJumpRecall(null)}
                  termAttention={termAttention}
                  filesOpenRequests={viewPanes.filesOpenRequests}
                  previewRequests={viewPanes.previewRequests}
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
