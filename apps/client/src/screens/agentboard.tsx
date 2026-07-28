import { useEffect, useMemo, useRef, useState } from "react";
import { FolderGit2, FolderPlus } from "lucide-react";
import { fmtMins } from "@/components/agentboard-bits";
import { WorkingContext } from "@/components/agentboard-working-context";
import { RailIconStrip, RollupChip } from "@/components/agentboard-rail";
import { RepoGroup } from "@/components/agentboard-repo-group";
import { NativePane } from "@/components/native-pane";
import { useNow, useNowInterval } from "@/lib/now";
import { BlockedDeleteDialog } from "@/components/task-blockers";
import type { FilesOpenRequest } from "@/components/files-pane";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cleanupMissing, closeOnFalse } from "./agentboard/helpers";
import { useCollapseState } from "./agentboard/use-collapse-state";
import { useColumnDrag } from "./agentboard/use-column-drag";
import { useAttention } from "./agentboard/use-attention";
import { useRailIndex } from "./agentboard/use-rail-index";
import { useTaskCreation } from "./agentboard/use-task-creation";
import { useTauriEvent } from "./agentboard/use-tauri-event";
import { useWindowLayout } from "./agentboard/use-window-layout";
import { useWorktreeDelete } from "./agentboard/use-worktree-delete";
import { PaneGrid } from "./agentboard/pane-grid";
import { RailHeader } from "./agentboard/rail-header";
import { WindowStrip } from "./agentboard/window-strip";
import {
  DeleteWorktreeDialog,
  RemoveRepoDialog,
  SplitSessionDialog,
  StartClaudeDialog,
} from "./agentboard/dialogs";
import {
  claudeCommand,
  claudeResumeCommand,
  claudeTitleName,
  collapseTargetKeys,
  consumePendingAgentboardNav,
  consumePendingOpenSessions,
  cycleNeedsYou,
  cycleSession,
  diffPaneId,
  exitPaneId,
  filesPaneId,
  filesPanePathFor,
  folderRemovableTask,
  isAgent,
  isCacheExpiring,
  jarvisPaneId,
  liveSessions,
  nextOpenFileNonce,
  nextWindowId,
  onAgentboardNavRequest,
  onOpenSessionRequest,
  abSetSessionPurpose,
  prForFolder,
  previewPaneId,
  sessionLabel,
  sleep,
  taskForFolder,
  termWriteRetry,
  useAgentboardState,
  waitForFirstFrame,
  type AgentboardNav,
  type AgentStatus,
  type ClaudeLaunchOptions,
  type Overlay,
  type PendingOpenSession,
  type RemoveTarget,
  type Selected,
  type SessionActions,
  type SessionData,
  type StartClaudeTarget,
} from "@/lib/agentboard";
import { errorMessage } from "@/lib/errors";
import { launchCommand, launchRegister, type LaunchConfigStatus } from "@/lib/launch";
import type { ArtifactRequest } from "@/lib/preview-artifact";
import { exitIsCrash, exitLabel, type TermExit } from "@/lib/term-protocol";
import { invoke } from "@/lib/tauri";
import type { OpenFileRequest } from "@/lib/ide";
import { shortcutHint, useShortcuts } from "@/lib/shortcuts";
import { useStoreSnapshot } from "@/lib/data";
import { useFocusTarget } from "@/lib/focus-target";
import { railRowMotion } from "@/lib/rail-motion";
import { AnimatePresence, motion } from "motion/react";
import { useHideInactiveRepos, useJarvisPane, useShowUnmanagedWorktrees } from "@/lib/rail-prefs";
import { useWorkspace } from "@/lib/workspace";
import { untrackRepo } from "@/lib/repo-actions";
import { uiAction } from "@/lib/ui-action";
import { toast } from "sonner";

/**
 * Agentboard — the Folder Rail. Left: rollup tally + needs-you strip + the
 * repos → folders (checkouts) → *panes* tree — every PTY session plus whatever
 * else the folder has open (its diff, files, preview), so what is open in
 * a checkout is answerable from the rail and not just from the pane area. Right: in-app *windows*,
 * scoped to whichever folder is active (clicking a folder header or a
 * session row focuses it) — each a named tiling of that folder's session
 * panes (side-by-side up to 3, then a 2-col grid), switched via the window
 * strip. A window never holds panes from more than one folder. Clicking a
 * rail session opens it as a pane in its own folder's active window; the
 * colored square on a row is its window's group tag. A session IS a PTY;
 * "agent" (✦) is a badge on a session where Claude is detected running —
 * status is reported, never re-rendered (the real TUI is the PTY). All
 * opened terminals live in one flat mounted pool (hidden unless in the active
 * folder's active window) so scrollback survives switching and regrouping; the
 * diff/files/preview panes are rebuilt on mount instead, owning no process. A
 * folder's diff, its file tree and its live preview each open as their own pane
 * in the same tiling (never a modal), so you review while the agents keep
 * working. Layout persists via
 * debounced `ab_save_windows`. Shortcuts come from the registry in
 * lib/shortcuts.tsx (⌘D new session, ⌘⇧W close session, ⌘⇧G diff pane,
 * ⌘⇧N/⌘⇧P jump to the next/previous session that needs you — `cycleNeedsYou`
 * in lib/agentboard.ts, board-wide, wraps around — ⌘⇧S add another session
 * as a pane in the active window, skipping straight to it when there's only
 * one candidate and opening a picker otherwise), active only while this tab
 * is shown.
 *
 * This file is the screen's wiring: local session/selection state, the
 * lifecycle actions that write to PTYs, and the layout. The self-contained
 * pieces live beside it in `screens/agentboard/` — the window layout
 * (`use-window-layout`), the worktree-delete flow (`use-worktree-delete`),
 * task creation (`use-task-creation`), the rail's derived lookups
 * (`use-rail-index`), the attention strip (`use-attention`), and the three
 * render surfaces (`rail-header`, `window-strip`, `pane-grid`).
 */
export function AgentboardScreen() {
  const state = useAgentboardState();
  const { snapshot } = useStoreSnapshot();
  const { openTab, activeTab, openSettingsTab } = useWorkspace();
  // Deep-link focus: a "needs you" popover row scrolls its repo into view here.
  const focusRef = useFocusTarget<HTMLDivElement>("agentboard");
  // The shared 15s clock, where this screen used to own a 30s ticker. It is the
  // app's largest tree and it stays mounted across screen switches, so that is
  // a real doubling of its idle re-render rate — accepted deliberately: the
  // values it feeds are minute-resolution session ages and the cache-expiry
  // check below, and one app-wide interval beats a second timer firing
  // out of phase with every other countdown on screen.
  const now = useNow();
  const repos = state.repos;

  const [selected, setSelected] = useState<Selected>(null);
  // Which pane tile (session, diff, files, or tombstone) last claimed the
  // click — the sole driver of the violet focus ring below. Deliberately
  // separate from `selected`: `selected` targets the session the toolbar's
  // Close/⌘D/⌘W and cache-badge actions act on, while this is purely "which
  // tile is visually active" and every pane kind can claim it, not just
  // sessions.
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null);
  // ab-focus-terminal (Enter): which session's terminal to imperatively give
  // DOM focus, and a nonce so re-requesting the *same* session (e.g. Enter
  // pressed twice) still re-fires the effect that focuses it. Read by the
  // `<TerminalView>` instance whose id matches, via its `focusRequest` prop.
  const [focusTerminalRequest, setFocusTerminalRequest] = useState<{
    id: string;
    nonce: number;
  } | null>(null);
  // The folder whose windows the main area shows — set by clicking a folder
  // header or a session row. Null until the user picks a folder.
  const [activeFolderDir, setActiveFolderDir] = useState<string | null>(null);
  // ab-split-session picker: only shown when the active folder has more than
  // one session not already in the active window (a single candidate is
  // added directly — see `splitIntoWindow`).
  const [splitOpen, setSplitOpen] = useState(false);
  // Pending remove awaiting confirmation because it would kill live sessions.
  const [confirmRemove, setConfirmRemove] = useState<RemoveTarget | null>(null);
  // Session awaiting the "what are you working toward?" prompt before Claude
  // actually launches — see `commitStartClaude`.
  const [startClaudeTarget, setStartClaudeTarget] = useState<StartClaudeTarget | null>(null);
  const [startClaudePrompt, setStartClaudePrompt] = useState("");
  // Session ids whose PTY is mounted (kept alive for scrollback), + their cwd.
  const [open, setOpen] = useState<string[]>([]);
  const cwds = useRef<Record<string, string>>({});
  // How a *crashed* session's shell died ("exited · Killed"), by session id.
  // Only crashes land here — a clean logout takes its pane with it (see
  // `handleExit`). Entries are never invalidated: what's on screen is decided
  // by the render filter (a tombstone needs a pane that still exists and no
  // live terminal over the top), so a stale entry for a dismissed or reopened
  // session is inert, and there's no invalidation scheme to keep correct.
  const [exitLabels, setExitLabels] = useState<Record<string, string>>({});
  // Sessions whose shell we're killing on purpose. `task_delete` kills a
  // folder's PTYs in Rust *before* the frontend unmounts their panes, so those
  // deaths arrive as signal exits at a still-listening TerminalView — which is
  // a crash by every test `handleExit` can apply, except that we asked for it.
  // Ids land here just before the kill and are consumed by the exit they
  // predict. (The `term_kill` on TerminalView unmount needs no entry: cleanup
  // unlistens first, so that exit is never delivered.)
  const expectedKills = useRef<Set<string>>(new Set());
  // Folder-rail collapse/expand state (issue #52) — hydrated once and then
  // this local copy is the live truth; see useCollapseState.
  const { collapsed, toggleCollapsed, setCollapsedTo, railCollapsed, toggleRail } =
    useCollapseState(state);
  // "Hide inactive" rail filter: demote quiet folders behind a per-repo "N
  // quiet" stub row, so a big rail shrinks to what's actually going on without
  // anything silently disappearing. A view filter, not a rail-structure change.
  // Persisted via `agentboard.hideInactiveRepos` in the shared settings file —
  // a whole-app preference, not rail-row UI state, so it doesn't belong in the
  // `collapsed` map the way `railCollapsed` does.
  const [hideInactive, setHideInactive] = useHideInactiveRepos();
  // Whether auto-discovered worktrees that `tt task` didn't create (a bare
  // `claude --worktree`, a hand-added one) get rail folders at all. Unlike
  // `hideInactive` this isn't a view filter over `repos` — the backend decides
  // which checkouts to discover, so the toggle round-trips through Rust and
  // the rail repopulates from the next `agentboard://state`.
  const [showUnmanagedWorktrees, setShowUnmanagedWorktrees] = useShowUnmanagedWorktrees();
  // Whether the native Bevy surfaces exist at all — the rail strip below, and
  // the per-checkout `jarvis` pane's entry point. Off is the default, and left
  // off nothing is ever created; see the render site below.
  const [jarvisPane, setJarvisPane] = useJarvisPane();
  // Whether a native surface may be on screen right now. Every `NativePane` on
  // this screen takes this one value: they composite *above* the webview, so a
  // screen switch has to hide them explicitly (screens stay mounted here), and
  // two surfaces disagreeing about it means one of them covers the next screen.
  const nativeVisible = activeTab === "agentboard";
  // Per-repo "show me the quiet ones anyway" toggle (the stub row).
  const [quietRevealed, setQuietRevealed] = useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  // Live PTY window titles keyed by session id (Claude emits `✳ <title>`);
  // preferred over the backend label for sessions whose terminal is open.
  const [titles, setTitles] = useState<Record<string, string>>({});
  const onTitle = (id: string, title: string) =>
    setTitles((m) => (m[id] === title ? m : { ...m, [id]: title }));
  // Sessions whose program raised attention (BEL / OSC 9 notification —
  // Claude Code asking for input) since the user last looked at them.
  // Set by the terminal://notify listener below, cleared on select.
  const [termAttention, setTermAttention] = useState<Record<string, true>>({});
  // Optimistic lifecycle overlays (sessionId → forced status until ts). The
  // 2s watcher scan re-renders with ground truth; overlays just cover the gap.
  const [overlays, setOverlays] = useState<Record<string, Overlay>>({});
  const setOverlay = (id: string, status: AgentStatus) =>
    setOverlays((m) => ({ ...m, [id]: { status, until: Date.now() + 2_500 } }));

  const {
    quietDirs,
    visibleRepos,
    missingRepoCount,
    folderOf,
    folderNameByDir,
    sessionById,
    folderByDir,
    activeFolder,
    activeRepo,
  } = useRailIndex({ repos, hideInactive, quietRevealed, activeFolderDir, now });

  const { wins, updateWins, addPaneToActive, removePane, replacePaneInPlace, removeSessionPane } =
    useWindowLayout({
      state,
      repos,
      open,
      cwds,
    });

  // Read live by the terminal://notify listener without re-subscribing on
  // selection changes.
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    selectedRef.current = selected?.sessionId ?? null;
  });
  // Live copy of the active folder, read the same way — lets an async
  // task-create decide, when it finally resolves, whether the user is still
  // where they were when they submitted.
  const activeFolderDirRef = useRef<string | null>(null);
  useEffect(() => {
    activeFolderDirRef.current = activeFolderDir;
  });
  // The rail as it stands *now*, for the same reason: the nav-request handler
  // below is a mount-only subscription, so reading `repos`/`folderNameByDir`
  // out of its closure would only ever see the empty first-render snapshot
  // (the backend hasn't broadcast yet at mount).
  const railRef = useRef({ repos, folderNameByDir });
  useEffect(() => {
    railRef.current = { repos, folderNameByDir };
  });

  // One-shot "prompt cache about to expire" toast per session per cache
  // generation. `cacheExpiresAt` moves forward on every request Claude makes,
  // so keying on `sessionId:cacheExpiresAt` naturally re-arms the toast after
  // the session is nudged — while the shared `useNow` tick can't re-fire the
  // same warning. The set is tiny (one entry per warning ever shown this mount),
  // so it's never pruned.
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

  // Repo management lives on one surface (Settings → Agentboard → Repos); the
  // rail just links to it.
  const openRepoManager = () => {
    uiAction("repo.manage_opened", "agentboard");
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
  const { deletingDirs, requestDeleteWorktree } = worktreeDelete;

  // Ctrl+Shift+Left/Right collapse/expand (complements ab-focus-up/down's
  // Ctrl+Shift+Up/Down session nav — same modifier family, so it's also safe
  // to steal from a focused terminal, unlike plain arrow keys which the shell
  // needs for cursor movement). One level per press, mirroring the rail's own
  // repo-header/folder-header nesting (`collapseTargetKeys`). Right expands
  // the outer (repo) level first if it's the thing hiding the folder, then
  // the folder itself; Left is the mirror, collapsing the folder before
  // walking up to the repo.
  function collapseByArrow(direction: "left" | "right") {
    if (!activeRepo || !activeFolder) return;
    const { own, parent } = collapseTargetKeys(activeRepo, activeFolder.dir);
    if (direction === "right") {
      if (parent && collapsed[parent]) {
        setCollapsedTo(parent, false);
        return;
      }
      setCollapsedTo(own, false);
      return;
    }
    if (!collapsed[own]) {
      setCollapsedTo(own, true);
    } else if (parent) {
      setCollapsedTo(parent, true);
    }
  }

  // The label to lead a session row/tab with: the live Claude terminal title
  // when the shell is actually running, else the backend-derived task/shell
  // name. Gating on `s.live` keeps a stopped shell from showing the `✳ <goal>`
  // title its dead PTY last emitted (the `titles` map is never cleared), which
  // otherwise reads as a running Claude while the status says "not started".
  const labelFor = (s: SessionData) =>
    (s.live ? claudeTitleName(titles[s.id]) : null) ?? sessionLabel(s);

  // Open a folder's diff as a pane in its focused window (beside the live
  // terminals — never a modal). Re-opening focuses the window it's already in.
  // Every `open*` here claims the focus ring as well, so the rail row for the
  // pane it opened (or re-focused) reads as the active one — the rail lists
  // panes now, and a row you just clicked has to look like it.
  function openDiff(dir: string) {
    setActiveFolderDir(dir);
    addPaneToActive(dir, diffPaneId(dir));
    setFocusedPaneId(diffPaneId(dir));
  }

  // Same, for the folder's full file tree.
  function openFiles(dir: string) {
    setActiveFolderDir(dir);
    addPaneToActive(dir, filesPaneId(dir));
    setFocusedPaneId(filesPaneId(dir));
  }

  // Same, for the folder's live dev-server preview (embedded browser + draw-on-
  // page feedback to this task's own session).
  function openPreview(dir: string) {
    setActiveFolderDir(dir);
    addPaneToActive(dir, previewPaneId(dir));
    setFocusedPaneId(previewPaneId(dir));
  }

  // Claude called the preview_show tool → open (or focus) that folder's
  // preview pane and render the artifact it wrote. Routed here for the same
  // reason as `ide://open-file` above: only this level can *create* the pane
  // when none is open, which is the normal case (nobody keeps a preview pane
  // open on the off chance an agent has something to show).
  const [artifactRequests, setArtifactRequests] = useState<Record<string, ArtifactRequest>>({});
  function showArtifact(req: {
    folderDir: string | null;
    path: string;
    title: string;
    nonce: number;
  }) {
    // Where to put an artifact that belongs to no tracked folder: whatever
    // folder is on screen, else the first one in the rail. The MCP server is
    // one per machine, so the sessions calling this are frequently in
    // checkouts *this* app doesn't track — and a page shown in a
    // slightly-wrong pane beats a page not shown at all. The rail being
    // completely empty is the only case with nowhere to go.
    const dir =
      req.folderDir ?? activeFolderDirRef.current ?? railRef.current.repos[0]?.folders[0]?.dir;
    if (!dir) {
      toast.error(`Couldn't show ${req.title} — no checkouts are open on the rail`);
      return;
    }
    setArtifactRequests((prev) => ({
      ...prev,
      [dir]: { path: req.path, title: req.title, nonce: req.nonce },
    }));
    // Ack the folder the artifact actually landed in, not the one the payload
    // named — a fallback show still puts the user in front of that folder.
    ackFolder(dir);
    openPreview(dir);
  }

  // Same, for this folder's native pane — a rectangle of the window rendered
  // by Bevy rather than DOM (`components/jarvis-pane.tsx`). Gated on the same
  // `agentboard.jarvisPane` setting as the rail's surface: while this is a
  // proof-of-concept, off means no Bevy anywhere, so the affordance that opens
  // one only exists when it's on.
  function openJarvis(dir: string) {
    uiAction("agentboard.open_jarvis_pane", "agentboard");
    setActiveFolderDir(dir);
    addPaneToActive(dir, jarvisPaneId(dir));
    setFocusedPaneId(jarvisPaneId(dir));
  }

  // Claude called the openFile tool → open (or focus) that folder's files
  // pane and focus the file. Routed here rather than inside the pane so the
  // request can *create* the pane when none is open yet.
  const [filesOpenRequests, setFilesOpenRequests] = useState<Record<string, FilesOpenRequest>>({});
  useTauriEvent<OpenFileRequest>("ide://open-file", (p) => {
    const dir = p.dir;
    if (!folderByDir.has(dir)) return;
    const path = p.filePath.startsWith(`${dir}/`) ? p.filePath.slice(dir.length + 1) : p.filePath;
    setFilesOpenRequests((prev) => ({
      ...prev,
      [dir]: {
        path,
        anchor: {
          startText: p.startText,
          endText: p.endText,
          selectToEndOfLine: p.selectToEndOfLine,
        },
        nonce: nextOpenFileNonce(),
      },
    }));
    openFiles(dir);
  });

  // A file link clicked in a folder's terminal → the same files-pane route as
  // Claude's openFile, landing on the `:line` when the link carried one. Links
  // pointing outside the checkout keep the old behavior (external editor via
  // `term_open_path` — the files pane can only browse the checkout).
  function openTerminalPath(dir: string, path: string, line: number | null) {
    uiAction("terminal.link_open_file", "agentboard");
    const rel = filesPanePathFor(dir, path);
    if (rel == null) {
      void invoke("term_open_path", { path, cwd: dir, line });
      return;
    }
    setFilesOpenRequests((prev) => ({
      ...prev,
      [dir]: { path: rel, anchor: { line }, nonce: nextOpenFileNonce() },
    }));
    openFiles(dir);
  }

  // Live status for a worktree deletion in progress — the Rust side emits
  // these from inside `ops::remove_task`, keyed by dir the same way
  // `deletingDirs` is.
  useTauriEvent<{ dir: string; label: string }>("task://delete_progress", (p) =>
    worktreeDelete.setDeletePhase(p.dir, p.label),
  );

  // Attention signals from terminals: a BEL or a desktop notification
  // (OSC 9/777 — Claude Code's "needs your input"). The session badges
  // amber until selected; a notification body also toasts, since the pane
  // raising it is usually not the one on screen.
  useTauriEvent<{ termId: string; kind: string; body?: string }>(
    "terminal://notify",
    ({ termId, kind, body }) => {
      // The session the user is looking at doesn't need a badge.
      if (termId === selectedRef.current && document.hasFocus()) return;
      setTermAttention((m) => (m[termId] ? m : { ...m, [termId]: true }));
      if (kind === "notify" && body) toast(body);
    },
  );

  // Windows belonging to the active folder, and whichever of those is focused.
  const windowsForFolder = useMemo(
    () => wins?.windows.filter((w) => w.folderDir === activeFolderDir) ?? [],
    [wins, activeFolderDir],
  );
  const activeWin =
    windowsForFolder.find(
      (w) => w.id === (activeFolderDir && wins?.activeWindows[activeFolderDir]),
    ) ?? windowsForFolder[0];

  // The active folder's sessions not currently a pane in *any* of its
  // windows — what ab-split-session (⌘⇧S) has to choose from. Deliberately
  // folder-wide, not just the active window: `selectSession` (via
  // `placePane`) never moves a pane that already has a window, it just
  // switches focus to wherever it lives — so a session parked in another
  // window isn't a real candidate, it'd just yank focus away from the
  // window you're trying to add *to*.
  const splitCandidates = useMemo(() => {
    if (!activeFolder) return [];
    const openIds = new Set(windowsForFolder.flatMap((w) => w.panes));
    return activeFolder.sessions.filter((s) => !openIds.has(s.id));
  }, [activeFolder, windowsForFolder]);

  // ab-split-session: add one of the active folder's not-yet-opened sessions
  // as a pane in its active window. One candidate adds directly (mirrors
  // clicking it); more than one opens a picker, since a single keypress
  // can't disambiguate.
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

  // "+ window": a window can't exist without panes, so minting one means
  // giving it content — spawn a fresh session and open the new window around
  // it in one move.
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

  // Column resize (drag the divider between side-by-side panes) — see
  // useColumnDrag; the release commits to the window's `cols` via updateWins.
  const columns = useColumnDrag(updateWins);

  /** A shell exited on its own. Either way its terminal unmounts (the PTY is
   * gone); how it died decides whether the pane goes with it.
   *
   * A clean logout is expected — you typed `exit`, and the pane disappearing
   * *is* the feedback; the window retiles around the loss. A crash is the
   * opposite: nothing would otherwise tell you it happened, so the pane stays
   * as a tombstone reporting how it died, until you dismiss it or reopen the
   * session over the top. A toast fires alongside, since the pane only speaks
   * to whoever is looking at that folder's window. No auto-restart. */
  function handleExit(sessionId: string, exit: TermExit) {
    setOpen((prev) => prev.filter((id) => id !== sessionId));
    const expected = expectedKills.current.delete(sessionId);
    if (expected || !exitIsCrash(exit.code, exit.signal)) {
      removePane(sessionId);
      return;
    }
    const label = exitLabel(exit.code, exit.signal);
    const s = sessionById.get(sessionId);
    toast.error(`${s ? labelFor(s) : "shell"} ${label}`);
    setExitLabels((m) => ({ ...m, [sessionId]: label }));
    // The task keeps its place in the tiling; only its occupant changes.
    replacePaneInPlace(sessionId, exitPaneId(sessionId));
  }

  // Switch the main area to a folder without selecting one of its sessions
  // (clicking a folder header). Drops any selection from a *different*
  // folder so the cache bar / ⌘D / ⌘W / Close button never act on a session
  // that's no longer the one shown — a session selected in the folder you're
  // switching to stays selected.
  function selectFolder(folderDir: string) {
    setActiveFolderDir(folderDir);
    setSelected((cur) => (cur && cur.folderDir !== folderDir ? null : cur));
    ackFolder(folderDir);
  }

  // Spawn a session's PTY and place its pane in its own folder's window,
  // without touching `selected`/`activeFolderDir` — for sessions created in
  // the background (e.g. a new task) that shouldn't steal focus from
  // whatever the user is currently looking at.
  function mountSession(folderDir: string, sessionId: string) {
    cwds.current[sessionId] = folderDir;
    setOpen((prev) => (prev.includes(sessionId) ? prev : [...prev, sessionId]));
    addPaneToActive(folderDir, sessionId);
  }

  function selectSession(folderDir: string, sessionId: string) {
    mountSession(folderDir, sessionId);
    setSelected({ folderDir, sessionId });
    setFocusedPaneId(sessionId);
    setActiveFolderDir(folderDir);
    // Looking at it acknowledges it — drop the attention badge.
    setTermAttention((m) => {
      if (!m[sessionId]) return m;
      const { [sessionId]: _, ...rest } = m;
      return rest;
    });
    ackFolder(folderDir);
  }

  /**
   * Run `fn` against a session's PTY, guaranteeing its shell exists first.
   *
   * A pane spawns its shell only once rendered, and only the active folder's
   * active window renders — so "write to session X" really means "make X
   * visible, wait for its shell, then write". Every PTY-writing path goes
   * through here: open-coding the three steps is how stop/compact came to
   * silently no-op for any folder that wasn't the active one.
   *
   * `folderDir` is only needed when the session isn't on the board yet (the
   * crash-resume handoff at boot); otherwise it's resolved from state, so
   * callers don't have to carry it.
   */
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

  // The user is now looking at this folder's rail entry — clear its agents'
  // `unseen` flags (`sessionCatchesEye`'s pulse) via the backend tracker.
  function ackFolder(folderDir: string) {
    // Read through the ref: the nav-request handler that also calls this is a
    // mount-only subscription, where the rendered `folderNameByDir` is still
    // the empty first-render map.
    const name = railRef.current.folderNameByDir.get(folderDir);
    if (name) void invoke("ab_mark_seen", { name });
  }

  // ab-jump-next/ab-jump-prev (see lib/shortcuts.tsx): board-wide, wraps
  // around, reuses `selectSession` — the same "mount + focus + ack" path a
  // rail click uses — so a jump behaves exactly like clicking the session.
  function jumpToNeedsYou(direction: "next" | "prev") {
    const target = cycleNeedsYou(repos, selected?.sessionId ?? null, direction);
    if (!target) {
      toast("Nothing needs you right now.");
      return;
    }
    const folderDir = folderOf.get(target.id)?.dir;
    if (!folderDir) return;
    selectSession(folderDir, target.id);
  }

  // ab-focus-up/ab-focus-down (see lib/shortcuts.tsx): plain up/down through
  // the whole task list in rail order, wrapping around — unlike jumpToNeedsYou
  // this doesn't filter to sessions needing attention.
  function focusSession(direction: "next" | "prev") {
    const target = cycleSession(repos, selected?.sessionId ?? null, direction);
    if (!target) return;
    const folderDir = folderOf.get(target.id)?.dir;
    if (!folderDir) return;
    selectSession(folderDir, target.id);
  }

  // ab-focus-terminal (Enter, see lib/shortcuts.tsx): jump into the focused
  // folder's first session and give it real DOM focus, so the next keystroke
  // lands in the shell instead of nowhere. "First" mirrors ab-split-session's
  // notion of the active window: whichever of its panes is a live session
  // (never a diff/files pane), falling back to the folder's first session at
  // all when no window is open yet — `selectSession` mounts it either way.
  //
  // Returns `false` (never actually focuses anything) whenever some other
  // element already owns Enter — a focused button, link, or anything inside
  // a Radix dialog — so `useShortcuts` lets the browser's native Enter
  // handling (activating that element) through instead of eating it. This is
  // deliberately narrower than `isEditableTarget`'s guard, which only knows
  // about inputs/terminals, not buttons — see the registry comment.
  function focusActiveTerminal(): boolean {
    if (!activeFolderDir || !activeFolder) return false;
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      if (active.tagName === "BUTTON" || active.tagName === "A") return false;
      if (active.closest('[role="dialog"], [role="alertdialog"]')) return false;
    }
    const sessionPaneId = activeWin?.panes.find((id) => sessionById.has(id));
    const targetId = sessionPaneId ?? activeFolder.sessions[0]?.id;
    if (!targetId) return false;
    selectSession(activeFolderDir, targetId);
    setFocusTerminalRequest((r) => ({ id: targetId, nonce: (r?.nonce ?? 0) + 1 }));
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

  // Live steps for a creation in flight — `task://delete_progress`'s twin,
  // sitting here rather than beside it because each goes below the hook it
  // feeds.
  useTauriEvent<{ root: string; branch: string; label: string }>("task://create_progress", (p) =>
    taskCreation.setCreatePhase(p.root, p.branch, p.label),
  );

  // The pending row's age and the setup badge are both `m:ss` against a clock
  // that otherwise ticks every 15s — a create finishes inside two ticks, so
  // the number would read 0:00 throughout. Bounded by the create itself.
  useNowInterval(
    taskCreation.pendingTasks.length > 0 || taskCreation.settingUpDirs.size > 0 ? 1000 : undefined,
  );

  // ab-new-task + the working-context band's "New task" button both open the
  // form for the focused folder's repo — expand a collapsed rail first since
  // the form itself renders there, same as the rail's own new-task buttons.
  function newTaskForActiveRepo() {
    if (!activeRepo) return;
    if (railCollapsed) toggleRail();
    taskCreation.toggleTaskForm({
      name: activeRepo.name,
      dir: activeRepo.folders[0].dir,
      key: activeRepo.key,
    });
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

  // Actually launch Claude in `target`'s session, folding in whatever prompt
  // the user entered (or none) — see `commitStartClaude`, which reads the
  // dialog state and calls this.
  async function launchClaudeIn(
    target: StartClaudeTarget,
    prompt: string,
    options?: ClaudeLaunchOptions,
    /** What the toast shows, when that should differ from what's actually
     * typed into the PTY — the new-task flow appends attached-image paths to
     * `prompt` that would only be noise here. Defaults to `prompt` for every
     * other caller. Setting the session's rail purpose is the caller's job,
     * not this function's: a session's purpose is why it exists, which is
     * equally true of the tasks this never launches anything into. */
    label?: string,
  ) {
    const { folderDir, sessionId, sessionName, restart } = target;
    const shown = label ?? prompt;
    setOverlay(sessionId, "busy");
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

  // Start a `.claude/launch.json` dev-server config in a fresh session named
  // after it — the same PTY-typing path `launchClaudeIn` uses (no backend
  // spawn), then register the config→session mapping so the popover offers
  // "focus" instead of a second launch while the pane lives.
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

  // Dismiss the start-Claude dialog (Enter, Escape, or click-outside all land
  // here via `onOpenChange`/`onKeyDown`) and launch with whatever's typed —
  // blank is a valid answer, it just skips the initial prompt + purpose.
  function commitStartClaude() {
    const target = startClaudeTarget;
    if (!target) return;
    setStartClaudeTarget(null);
    const prompt = startClaudePrompt.trim();
    setStartClaudePrompt("");
    // The typed prompt is why this session exists — blank just leaves it
    // unlabeled, same as before.
    if (prompt) void abSetSessionPurpose(target.sessionId, prompt);
    void launchClaudeIn(target, prompt);
  }

  // Claude Sessions' "Open in Agentboard" handoff (see `lib/agentboard.ts`'s
  // pending-open-session bridge doc comment for why this can't be a plain
  // function call).
  //
  // Requests run **one at a time** via a promise tail: `withLiveSession` makes
  // each request's folder active to mount its pane, and only one folder can be
  // active at a time — so overlapping them would leave every folder but the
  // last with a pane that never started.
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

  // Command-palette "jump to repo/session" handoff (see `requestAgentboardNav`
  // in lib/agentboard.ts). Read-only reveal: focus the folder, and for a
  // session request select its pane too — no PTY writes, unlike the resume
  // handoff above.
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
        // The MCP `task_start` tool. Unlike `reopen-task` this opens no form and
        // waits for no submit — the caller already chose every field, so it goes
        // straight down the same `createTask` path a submit would, binding the
        // existing `taskId` instead of minting a new board row.
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
            worktree: true,
            launchClaude: true,
            taskId: req.taskId,
          },
        );
      } else if (req.kind === "show-artifact") {
        // The MCP `preview_show` tool — the agent has something to *show*.
        // `showArtifact` resolves the folder (the payload's may be null) and
        // acks whichever one it landed in.
        showArtifact(req);
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

  // Actually remove: kill any live sessions first (killing a PTY is
  // client-mediated — see `closeSession`/`TerminalView`'s unmount effect),
  // then drop the checkout(s) from the watched list. Removes by `dir`, never
  // by resolved session name — a multi-checkout repo removes several dirs in
  // one batch, and `ab_remove_repo`'s name resolution shifts as each removal
  // changes the collision-disambiguated names of whatever's left.
  async function performRemove(target: RemoveTarget) {
    // Closed here rather than by `untrackRepo` because `closeSession` also
    // clears this screen's local pane state (open list, selection, the pane
    // itself) — so the seam is handed an empty id list and owns only the
    // untrack, its `Result` check, and the `ui.action` event.
    for (const id of target.sessionIds) await closeSession(id);
    for (const dir of target.dirs) await untrackRepo(dir, target.label, [], "agentboard");
  }

  // Remove a repo (or, for a multi-checkout repo, all its checkouts) from
  // the rail. Immediate when nothing's running; confirms first (see the
  // AlertDialog below) when any of its sessions are live, since confirming
  // kills them.
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

  async function closeSession(sessionId: string) {
    await invoke("ab_close_session", { id: sessionId });
    setOpen((prev) => prev.filter((id) => id !== sessionId));
    setSelected((cur) => (cur?.sessionId === sessionId ? null : cur));
    removeSessionPane(sessionId);
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
      setOverlay(s.id, "interrupted");
      toast(`■ interrupting Claude — ${s.name}'s shell stays alive`);
      void withLiveSession(s.id, async () => {
        await termWriteRetry(s.id, "\x03"); // interrupt the current turn
        await sleep(150);
        await termWriteRetry(s.id, "\x04"); // Ctrl-D at the empty prompt exits Claude
      });
    },
    compactClaude: (s) => {
      setOverlay(s.id, "busy");
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
      updateWins([win.folderDir], (w) => ({
        ...w,
        activeWindows: { ...w.activeWindows, [win.folderDir]: windowId },
      }));
    },
  };

  // Agentboard-scoped shortcuts (see lib/shortcuts.tsx for the registry).
  // Gated on the tab being active: this screen stays mounted while hidden, so
  // without the gate ⌘D would spawn sessions from the Cockpit. Close-session
  // is ⌘⇧W (not ⌘W) — killing a shell deserves a deliberate chord.
  useShortcuts(
    useMemo(
      () => ({
        "ab-new-session": () => {
          if (activeFolderDir) void newSession(activeFolderDir);
        },
        "ab-new-task": newTaskForActiveRepo,
        "ab-remove-task": () => {
          // `requestDeleteWorktree` always confirms before touching anything;
          // the in-flight check mirrors the rail row dimming itself while a
          // removal runs.
          if (!activeFolder || !folderRemovableTask(activeFolder)) return;
          if (deletingDirs.has(activeFolder.dir)) return;
          requestDeleteWorktree(activeFolder.dir, activeFolder.name);
        },
        // One chord for the whole delete flow: it confirms the first dialog,
        // and — when the guards refuse and the blocked dialog takes its place
        // — presses that dialog's destructive button. Blocked wins the tie
        // because only one of the two is ever open. With neither open the
        // handler declines (`false`), leaving the keystroke to the browser
        // rather than eating it.
        "ab-confirm-close-worktree": () => {
          if (worktreeDelete.blockedDelete) {
            worktreeDelete.forceDeleteBlocked();
            return;
          }
          if (!worktreeDelete.confirmDeleteWt) return false;
          worktreeDelete.confirmDeleteWorktree();
        },
        "ab-close-session": () => {
          if (selected) void closeSession(selected.sessionId);
        },
        "ab-toggle-diff": () => {
          if (activeFolderDir) openDiff(activeFolderDir);
        },
        "ab-toggle-files": () => {
          if (activeFolderDir) openFiles(activeFolderDir);
        },
        "ab-toggle-rail": toggleRail,
        "ab-jump-next": () => jumpToNeedsYou("next"),
        "ab-jump-prev": () => jumpToNeedsYou("prev"),
        "ab-focus-up": () => focusSession("prev"),
        "ab-focus-down": () => focusSession("next"),
        "ab-focus-up-bracket": () => focusSession("prev"),
        "ab-focus-down-bracket": () => focusSession("next"),
        "ab-collapse-left": () => collapseByArrow("left"),
        "ab-collapse-right": () => collapseByArrow("right"),
        "ab-focus-terminal": focusActiveTerminal,
        "ab-split-session": splitIntoWindow,
        "ab-new-terminal-right": () => {
          if (activeFolderDir) void newSession(activeFolderDir);
        },
      }),
      // newSession/closeSession/openDiff/openFiles/jumpToNeedsYou/splitIntoWindow are
      // stable within a render pass; the state they close over is what matters.
      // eslint-disable-next-line react-hooks/exhaustive-deps -- handlers are stable within a render; only the state they close over (listed) should rebuild the map
      [
        activeFolderDir,
        deletingDirs,
        selected,
        wins,
        repos,
        folderOf,
        splitCandidates,
        activeRepo,
        activeFolder,
        activeWin,
        sessionById,
        collapsed,
        railCollapsed,
        worktreeDelete.confirmDeleteWt,
        worktreeDelete.deleteWtTask,
        worktreeDelete.deleteWtOutcome,
        worktreeDelete.blockedDelete,
        worktreeDelete.deleteBusy,
      ],
    ),
    "agentboard",
    activeTab === "agentboard",
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
                  <RollupChip state={state} now={now} />
                  <RailHeader
                    attention={attention.items}
                    missingRepoCount={missingRepoCount}
                    dismissedPrCount={attention.dismissedPrCount}
                    clearingDismissals={attention.clearingDismissals}
                    hideInactive={hideInactive}
                    onSetHideInactive={setHideInactive}
                    showUnmanagedWorktrees={showUnmanagedWorktrees}
                    onSetShowUnmanagedWorktrees={setShowUnmanagedWorktrees}
                    jarvisPane={jarvisPane}
                    onSetJarvisPane={setJarvisPane}
                    onOpenRepoManager={openRepoManager}
                    onCleanupMissing={() => void cleanupMissing()}
                    onClearDismissals={() => void attention.clearDismissals()}
                    onCollapseRail={toggleRail}
                  />

                  {/* min-h-0 is load-bearing: without it this flex child grows past the
                      rail's height and folders below the fold become unreachable. */}
                  <ScrollArea className="min-h-0 flex-1">
                    <div ref={focusRef} className="flex flex-col">
                      {repos.length === 0 && (
                        <div className="flex flex-col items-center gap-3 px-3 py-10 text-center">
                          <FolderGit2 className="size-8 text-muted-foreground" />
                          <p className="text-sm text-muted-foreground">No repos on the rail yet.</p>
                          <div className="flex items-center gap-2">
                            <Button size="sm" variant="outline" onClick={openRepoManager}>
                              <FolderPlus className="size-3.5" /> Manage repos
                            </Button>
                          </div>
                        </div>
                      )}
                      {/* initial={false} so the rail drawing itself on launch
                          isn't mistaken for repos arriving — only genuine
                          track/untrack animates. */}
                      <AnimatePresence initial={false}>
                        {repos.map((repo) => (
                          <motion.div key={repo.key} {...railRowMotion}>
                            <RepoGroup
                              repo={repo}
                              quietDirs={quietDirs.get(repo.key)}
                              quietRevealed={!!quietRevealed[repo.key]}
                              onToggleQuiet={() =>
                                setQuietRevealed((m) => ({ ...m, [repo.key]: !m[repo.key] }))
                              }
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
                              overlays={overlays}
                              wins={wins}
                              actions={actions}
                              onToggle={toggleCollapsed}
                              onSelectFolder={selectFolder}
                              onSelect={selectSession}
                              onNewSession={newSession}
                              onNewTask={taskCreation.toggleTaskForm}
                              onRemoveRepo={requestRemoveRepo}
                              onDeleteWorktree={requestDeleteWorktree}
                              deletingDirs={deletingDirs}
                              deletingPhase={worktreeDelete.deletingPhase}
                              settingUpDirs={taskCreation.settingUpDirs}
                              onRenameCommit={commitRename}
                              onOpenDiff={openDiff}
                              onOpenFiles={openFiles}
                              onOpenPreview={openPreview}
                              // Undefined while `agentboard.jarvisPane` is off:
                              // the proof-of-concept surface has no entry point
                              // at all rather than one that opens a disabled
                              // pane.
                              onOpenJarvis={jarvisPane ? openJarvis : undefined}
                              onClosePane={removePane}
                              taskFormOpen={taskCreation.openTaskForms.has(repo.key)}
                              taskFormInitialGoal={taskCreation.reopenTasks.get(repo.key)?.goal}
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
                              pendingTasks={taskCreation.pendingTasks.filter(
                                (p) => p.repoKey === repo.key,
                              )}
                              onRetryPendingTask={taskCreation.retryPendingTask}
                              onDismissPendingTask={taskCreation.dismissPendingTask}
                            />
                          </motion.div>
                        ))}
                      </AnimatePresence>
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
                      fallback="Jarvis needs Linux/Wayland"
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
              {activeFolder && activeRepo && (
                <WorkingContext
                  repo={activeRepo}
                  folder={activeFolder}
                  pr={prForFolder(snapshot.prs, activeRepo.originUrl, activeFolder.branch)}
                  task={taskForFolder(snapshot.tasks, activeFolder.dir)}
                  deleting={deletingDirs.has(activeFolder.dir)}
                  actions={actions}
                  onOpenDiff={openDiff}
                  onOpenFiles={openFiles}
                  onOpenPreview={openPreview}
                  onOpenJarvis={jarvisPane ? openJarvis : undefined}
                  onNewSession={newSession}
                  onNewTask={newTaskForActiveRepo}
                  onRemoveRepo={requestRemoveRepo}
                  onDeleteWorktree={requestDeleteWorktree}
                />
              )}
              {wins && activeFolderDir && (
                <WindowStrip
                  windows={windowsForFolder}
                  activeWinId={activeWin?.id}
                  hasSelection={selected !== null}
                  updateWins={updateWins}
                  onFocusWindow={actions.focusWindow}
                  onNewWindow={() => void newWindow(activeFolderDir)}
                  onNewSession={() => void newSession(activeFolderDir)}
                  onCloseSession={() => {
                    if (selected) void closeSession(selected.sessionId);
                  }}
                />
              )}

              <PaneGrid
                open={open}
                cwds={cwds}
                activeWin={activeWin}
                activeFolderDir={activeFolderDir}
                sessionById={sessionById}
                folderOf={folderOf}
                folderByDir={folderByDir}
                now={now}
                actions={actions}
                focusedPaneId={focusedPaneId}
                onFocusPane={setFocusedPaneId}
                termAttention={termAttention}
                exitLabels={exitLabels}
                filesOpenRequests={filesOpenRequests}
                artifactRequests={artifactRequests}
                nativeVisible={nativeVisible}
                labelFor={labelFor}
                focusTerminalRequest={focusTerminalRequest}
                onSelectSession={selectSession}
                onExit={handleExit}
                onTitle={onTitle}
                onOpenTerminalPath={openTerminalPath}
                onRemovePane={removePane}
                columns={columns}
              />
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
        onOpenChange={closeOnFalse(worktreeDelete.clearConfirm)}
        onSwapOutcome={worktreeDelete.swapOutcome}
        onConfirm={worktreeDelete.confirmDeleteWorktree}
      />

      {/* The guards refused — shared shell, see `BlockedDeleteDialog`. */}
      <BlockedDeleteDialog
        open={worktreeDelete.blockedDelete != null}
        // Escape/cancel abandons the flow — except once the removal itself is
        // running, when "keep" can no longer be honored: the dialog stays up
        // (buttons locked) until the removal resolves and closes it honestly.
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
