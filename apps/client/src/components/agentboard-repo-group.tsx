/**
 * One repo in the rail: its sticky header, the checkouts under it, and each
 * checkout's sessions and panes. This is the file that decides what a repo's
 * subtree *contains* — which folders show, which are demoted to a quiet stub,
 * where the inline new-task form goes, how a window's rows are bracketed —
 * and delegates how each row *looks* to `FolderHeader`, `SessionRow`,
 * `ChatRow` and `ViewPaneRow`.
 */
import { type ReactElement } from "react";
import { FolderGit2, FolderPlus } from "lucide-react";
import {
  Chevron,
  CollapsedLive,
  IconBtn,
  NeedsBadge,
  RepoMenu,
} from "@/components/agentboard-bits";
import { FolderHeader } from "@/components/agentboard-folder-header";
import {
  ChatRow,
  ViewPaneRow,
  WindowSpine,
  viewPaneKind,
  type ViewPaneKind,
} from "@/components/agentboard-pane-rows";
import { SessionRow } from "@/components/agentboard-session-row";
import {
  InlineNewTask,
  PendingTaskRow,
  type NewTaskRepo,
  type NewTaskSubmit,
  type PendingTask,
} from "@/components/inline-new-task";
import { hasRepoColor, repoAccentStyles, repoIcon } from "@/lib/repo-identity";
import { cn } from "@/lib/utils";
import {
  isAgentPane,
  folderRemovableTask,
  isSoloRepo,
  pathScope,
  prForFolder,
  taskForFolder,
  type FolderData,
  type Overlay,
  type RepoData,
  type SessionActions,
  type SessionData,
  type WindowsPayload,
} from "@/lib/agentboard";
import { type PrItem, type TaskItem } from "@/lib/data";
import { mouseAction } from "@/lib/shortcut-coach";
import { shortcutHint } from "@/lib/shortcuts";
import { railRowMotion } from "@/lib/rail-motion";
import { AnimatePresence, motion } from "motion/react";

export function RepoGroup({
  repo,
  now,
  compactPct,
  prs,
  tasks,
  selectedSessionId,
  activePaneId,
  activeFolderDir,
  collapsed,
  renaming,
  titles,
  overlays,
  wins,
  actions,
  onToggle,
  onSelectFolder,
  onSelect,
  onNewSession,
  onNewTask,
  onRemoveRepo,
  onDeleteWorktree,
  deletingDirs,
  deletingPhase,
  settingUpDirs,
  onRenameCommit,
  onOpenDiff,
  onOpenFiles,
  onOpenPreview,
  onOpenAgent,
  onOpenJarvis,
  onClosePane,
  quietDirs,
  quietRevealed,
  onToggleQuiet,
  taskFormOpen,
  taskFormInitialGoal,
  onCancelTaskForm,
  onSubmitTaskForm,
  pendingTasks,
  onRetryPendingTask,
  onDismissPendingTask,
}: {
  repo: RepoData;
  now: number;
  compactPct: number;
  prs: PrItem[];
  /** Board tasks (`store://snapshot`), for mapping a folder → its bound task's
   * linked issues (the rail IssueChips). Threaded the same way `prs` is. */
  tasks: TaskItem[];
  selectedSessionId: string | null;
  /** The focused pane tile (`focusedPaneId`) — what marks a *chat* row active,
   * since a chat has no session record for `selectedSessionId` to name. */
  activePaneId: string | null;
  activeFolderDir: string | null;
  collapsed: Record<string, boolean>;
  renaming: string | null;
  titles: Record<string, string>;
  overlays: Record<string, Overlay>;
  wins: WindowsPayload | null;
  actions: SessionActions;
  onToggle: (key: string) => void;
  onSelectFolder: (folderDir: string) => void;
  onSelect: (folderDir: string, sessionId: string) => void;
  onNewSession: (folderDir: string, launchClaude?: boolean) => void;
  /** Toggles the inline new-task form open/closed for a task-convention repo
   * (worktree hub) — never a blocking modal, see InlineNewTask. */
  onNewTask: (repo: NewTaskRepo) => void;
  onRemoveRepo: (dirs: string[], label: string) => void;
  /** Delete a worktree from disk (guarded `task_delete`). */
  onDeleteWorktree: (dir: string, label: string) => void;
  /** Folder dirs whose `task_delete` is currently in flight — that row dims
   * and disables until it resolves (deleted → the row vanishes on the next
   * poll; blocked/failed → the row goes interactive again). */
  deletingDirs?: Set<string>;
  /** Live phase text for a dir mid-delete (dir → "running teardown
   * command", "deleting git worktree", …), fed by `task://delete_progress`
   * events. Absent for a dir in `deletingDirs` just means no phase event has
   * landed yet — `DeletingBadge` falls back to a static label. */
  deletingPhase?: Map<string, string>;
  /** Checkouts whose setup step is still running → when it started (epoch
   * ms). See `SettingUpBadge`. */
  settingUpDirs?: Map<string, number>;
  onRenameCommit: (sessionId: string, name: string) => void;
  /** Opens the folder's diff pane in its focused window. */
  onOpenDiff: (dir: string) => void;
  /** Opens the folder's files pane in its focused window. */
  onOpenFiles: (dir: string) => void;
  /** Opens the folder's live-preview pane in its focused window. */
  onOpenPreview: (dir: string) => void;
  /** Opens the folder's rendered-agent pane in its focused window. */
  onOpenAgent: (dir: string) => void;
  /** Opens the folder's native (Bevy) pane in its focused window — undefined
   * while `agentboard.jarvisPane` is off, which hides the entry point rather
   * than offering one that opens nothing. */
  onOpenJarvis?: (dir: string) => void;
  /** Drops one pane from its window — a chat row's ✕ (which ends the session
   * behind it, see `AgentPane`) and a view row's ✕ alike. */
  onClosePane: (paneId: string) => void;
  /** Dirs the hide-inactive filter tucks behind a "N quiet" stub (empty/
   * undefined when the filter is off). Quiet folders demote to the stub
   * instead of vanishing — nothing ever silently disappears from the rail. */
  quietDirs?: Set<string>;
  /** Whether this repo's quiet folders are temporarily shown. */
  quietRevealed?: boolean;
  onToggleQuiet?: () => void;
  /** Whether this repo's inline new-task form is open. */
  taskFormOpen: boolean;
  /** Pre-fills the goal field — set when the form was opened to reopen a
   * closed task rather than to start a new one. */
  taskFormInitialGoal?: string;
  onCancelTaskForm: () => void;
  onSubmitTaskForm: (input: NewTaskSubmit) => void;
  /** This repo's in-flight `task_create` calls — see PendingTask. */
  pendingTasks: PendingTask[];
  onRetryPendingTask: (id: string) => void;
  onDismissPendingTask: (id: string) => void;
}) {
  const solo = isSoloRepo(repo);
  const quiet = quietDirs ?? new Set<string>();
  const showQuiet = quietRevealed ?? false;

  const pendingRows = pendingTasks.map((p) => (
    <PendingTaskRow
      key={p.id}
      pending={p}
      now={now}
      onRetry={onRetryPendingTask}
      onDismiss={onDismissPendingTask}
    />
  ));

  const sessionRow = (folder: FolderData, s: SessionData) => (
    <motion.div key={s.id} {...railRowMotion}>
      <SessionRow
        session={s}
        folderDir={folder.dir}
        now={now}
        compactPct={compactPct}
        title={titles[s.id]}
        active={selectedSessionId === s.id}
        renaming={renaming === s.id}
        overlay={overlays[s.id]}
        actions={actions}
        onSelect={() => onSelect(folder.dir, s.id)}
        onRenameCommit={(name) => onRenameCommit(s.id, name)}
      />
    </motion.div>
  );

  const chatRow = (folder: FolderData, paneId: string) => (
    <motion.div key={paneId} {...railRowMotion}>
      <ChatRow
        folderDir={folder.dir}
        active={activePaneId === paneId}
        onSelect={() => onOpenAgent(folder.dir)}
        onClose={() => onClosePane(paneId)}
      />
    </motion.div>
  );

  // One opener per view-pane kind. A table rather than a ternary chain so the
  // next kind is an entry, not another level of nesting — and so `jarvis`'s
  // absence is expressible: its row can outlive the setting being turned back
  // off (the layout persists), and with no opener a click is a no-op, leaving ✕
  // as the row's only live affordance.
  const viewPaneOpener: Record<ViewPaneKind, ((dir: string) => void) | undefined> = {
    diff: onOpenDiff,
    files: onOpenFiles,
    preview: onOpenPreview,
    jarvis: onOpenJarvis,
  };

  const viewRow = (folder: FolderData, paneId: string, kind: ViewPaneKind) => (
    <motion.div key={paneId} {...railRowMotion}>
      <ViewPaneRow
        kind={kind}
        active={activePaneId === paneId}
        onSelect={() => viewPaneOpener[kind]?.(folder.dir)}
        onClose={() => onClosePane(paneId)}
      />
    </motion.div>
  );

  /**
   * One rail row per pane of a folder's window, whichever kind it is: a PTY
   * session, the folder's chat, or one of its views (diff, files, preview).
   *
   * The rail used to list PTY sessions and nothing else, so a folder read "no
   * sessions" with a live conversation on screen beside it — and a diff or file
   * tree you had opened was reachable only by finding it in the pane area. What
   * is open in a folder is now the rail's answer, not the pane area's alone.
   */
  const paneRow = (folder: FolderData, paneId: string, byId: Map<string, SessionData>) => {
    const session = byId.get(paneId);
    if (session) return sessionRow(folder, session);
    if (isAgentPane(paneId)) return chatRow(folder, paneId);
    const kind = viewPaneKind(paneId);
    return kind ? viewRow(folder, paneId, kind) : null;
  };

  // Sessions render grouped by the window (pane group) they belong to: a
  // window holding multiple panes gets a vertical color spine running beside
  // its rows (no text label — window names carry no signal in the rail);
  // sessions in no window ("loose" shells) list on their own below. Grouping
  // is purely visual — the click mechanics that move panes in and out of
  // windows are unchanged.
  //
  // One AnimatePresence per window group plus one for the loose rows: a
  // group's exiting row has to stay inside its own spine while it collapses.
  // Closing a window's *last* pane unmounts the group wrapper outright, so
  // that row does not animate — a spine with nothing left to attach to is not
  // worth keeping on screen for an extra frame.
  const sessionRows = (folder: FolderData) => {
    const folderWins = (wins?.windows ?? []).filter((w) => w.folderDir === folder.dir);
    // A chat is something running in this folder even though it is not a PTY
    // session, so the "nothing running here" hint has to account for it — the
    // whole complaint this row work came from was a folder reading "no
    // sessions" with a live conversation on screen beside it. A diff/files/
    // preview pane, by contrast, is not something running, so it doesn't
    // suppress the hint — it just gets its row below it.
    const chatOpen = folderWins.some((w) => w.panes.some(isAgentPane));
    const byId = new Map(folder.sessions.map((s) => [s.id, s] as const));
    const grouped = new Set(folderWins.flatMap((w) => w.panes));
    const loose = folder.sessions.filter((s) => !grouped.has(s.id));
    const groups = folderWins
      .map((w) => ({
        win: w,
        rows: w.panes
          .map((id) => paneRow(folder, id, byId))
          .filter((row): row is ReactElement => row !== null),
      }))
      .filter((g) => g.rows.length > 0);
    return (
      <>
        {folder.sessions.length === 0 && !chatOpen && (
          <div className="flex items-center gap-2.5 py-1 pr-3 pl-9 text-[11px] italic text-muted-foreground/60">
            no sessions
            <button
              type="button"
              onClick={() => onNewSession(folder.dir, true)}
              className="not-italic text-violet-500 hover:underline"
            >
              ✦ start Claude
            </button>
            <span className="text-muted-foreground/40">·</span>
            <button
              type="button"
              onClick={() => onNewSession(folder.dir, false)}
              className="not-italic text-violet-500 hover:underline"
            >
              + shell
            </button>
          </div>
        )}
        {groups.map(({ win, rows }) => (
          <div key={win.id} className="relative">
            {rows.length > 1 && (
              <WindowSpine
                win={win}
                folderWins={folderWins}
                count={rows.length}
                onFocus={() => actions.focusWindow(win.id)}
              />
            )}
            <AnimatePresence initial={false}>{rows}</AnimatePresence>
          </div>
        ))}
        <AnimatePresence initial={false}>{loose.map((s) => sessionRow(folder, s))}</AnimatePresence>
      </>
    );
  };

  // Solo repo: collapse repo + folder into one header (repo · branch).
  if (solo) {
    const folder = repo.folders[0];
    const isCollapsed = collapsed[repo.key];
    if (quiet.has(folder.dir) && !showQuiet) {
      return <QuietRepoStub name={repo.name} count={1} onToggle={onToggleQuiet} />;
    }
    const deleting = deletingDirs?.has(folder.dir) ?? false;
    const deletingLabel = deletingPhase?.get(folder.dir);
    const settingUpSince = settingUpDirs?.get(folder.dir);
    return (
      <div
        className={cn("border-b", deleting && "pointer-events-none opacity-50")}
        data-focus-kind="repo"
        data-focus-id={repo.key}
      >
        <FolderHeader
          scope="repo"
          title={repo.name}
          meta={repo.meta}
          folder={folder}
          needs={repo.needs}
          pr={prForFolder(prs, repo.originUrl, folder.branch)}
          task={taskForFolder(tasks, folder.dir)}
          collapsed={isCollapsed}
          now={now}
          active={activeFolderDir === folder.dir}
          deleting={deleting}
          deletingLabel={deletingLabel}
          settingUpSince={settingUpSince}
          actions={actions}
          onToggle={() => {
            onToggle(repo.key);
            onSelectFolder(folder.dir);
          }}
          onNewSession={() => onNewSession(folder.dir)}
          onNewTask={() => onNewTask({ name: repo.name, dir: folder.dir, key: repo.key })}
          onRemoveRepo={() => onRemoveRepo([folder.dir], repo.name)}
          onDeleteWorktree={
            folderRemovableTask(folder) ? () => onDeleteWorktree(folder.dir, repo.name) : undefined
          }
          onOpenDiff={() => onOpenDiff(folder.dir)}
          onOpenFiles={() => onOpenFiles(folder.dir)}
          onOpenPreview={() => onOpenPreview(folder.dir)}
          onOpenAgent={() => onOpenAgent(folder.dir)}
          onOpenJarvis={onOpenJarvis ? () => onOpenJarvis(folder.dir) : undefined}
        />
        {taskFormOpen && (
          <InlineNewTask
            repo={{ name: repo.name, dir: folder.dir, key: repo.key }}
            onCancel={onCancelTaskForm}
            onSubmit={onSubmitTaskForm}
            initialGoal={taskFormInitialGoal}
          />
        )}
        {pendingRows}
        {!isCollapsed && <div className="pb-2">{sessionRows(folder)}</div>}
        {quiet.size > 0 && showQuiet && (
          <QuietToggleRow count={quiet.size} revealed onToggle={onToggleQuiet} />
        )}
      </div>
    );
  }

  // Multi-checkout repo: repo header, then each folder as a sub-header. Quiet
  // folders (hide-inactive filter) tuck behind a stub toggle row; a repo with
  // *only* quiet folders shrinks to a single dim stub line.
  const repoCollapsed = collapsed[repo.key];
  const shownFolders = showQuiet ? repo.folders : repo.folders.filter((f) => !quiet.has(f.dir));
  if (shownFolders.length === 0) {
    return <QuietRepoStub name={repo.name} count={quiet.size} onToggle={onToggleQuiet} />;
  }
  // One of this repo's checkouts is the focused folder — bubble the violet
  // active edge up to the repo header too, so a collapsed (or just
  // easy-to-miss) repo row still shows it holds the folder you're looking
  // at (folder-rail rule: focus never stops at the child level).
  const repoActive = repo.folders.some((f) => f.dir === activeFolderDir);
  const scopePrefix = pathScope(repo.folders[0].dir);
  const RepoIcon = repoIcon(repo.meta);
  // The header is sticky, so its wash must resolve to an opaque color — rows
  // scroll underneath it and a translucent tint reads as a rendering glitch.
  const accent = repoAccentStyles(repo.meta, "var(--card)");
  // Identity never outranks true status: a repo waiting on you (amber) never
  // gets the calmer identity wash laid over it. Being the active selection is
  // shown as a ring, not a fill, so it layers over the identity wash instead
  // of replacing it.
  const statusOwnsRow = repo.needs > 0;
  return (
    <div className="border-b" data-focus-kind="repo" data-focus-id={repo.key}>
      <div
        style={statusOwnsRow ? undefined : { ...accent.edgeStyle, ...accent.surfaceStyle }}
        className={cn(
          // Every background on this row must be fully opaque. It is sticky, so
          // folder and session rows scroll *underneath* it — a translucent tint
          // (bg-accent/60 for active, /50 for hover) lets their text show
          // through the stuck header and reads as a rendering glitch.
          "sticky top-0 z-10 flex w-full items-center gap-2 border-b border-l-2 border-border border-l-transparent bg-card px-3 py-2 hover:bg-accent",
          repoActive && "border-l-violet-500 ring-1 ring-inset ring-violet-500/50",
        )}
      >
        <button
          type="button"
          onClick={() => onToggle(repo.key)}
          className="flex min-w-0 flex-1 items-center gap-2"
        >
          <Chevron collapsed={repoCollapsed} />
          <RepoIcon
            className={cn("size-3.5 shrink-0", !hasRepoColor(repo.meta) && "text-muted-foreground")}
            style={accent.iconStyle}
          />
          {scopePrefix && (
            <span className="shrink-0 font-mono text-sm text-muted-foreground/60">
              {scopePrefix}
            </span>
          )}
          <span className="truncate text-sm font-semibold">{repo.name}</span>
          <span className="ml-auto flex items-center gap-2">
            {repoCollapsed && <CollapsedLive sessions={repo.folders.flatMap((f) => f.sessions)} />}
            {repo.needs > 0 && <NeedsBadge n={repo.needs} />}
          </span>
        </button>
        {/* Same fixed-width right-edge toolbar as the folder rows — see the
            cluster comment in `FolderHeader`. */}
        <div className="flex shrink-0 items-center gap-1 pl-1">
          <IconBtn
            ghost
            title={`New task — goal, issues, branch (${shortcutHint("ab-new-task")})`}
            onClick={() => {
              mouseAction("ab-new-task", "agentboard");
              onNewTask({ name: repo.name, dir: repo.folders[0].dir, key: repo.key });
            }}
            className="hover:text-violet-500"
          >
            <FolderPlus className="size-3.5" />
          </IconBtn>
          <RepoMenu
            ghost
            onRemove={() =>
              onRemoveRepo(
                repo.folders.map((f) => f.dir),
                repo.name,
              )
            }
            dir={repo.folders[0].dir}
            quiet={repo.folders[0].quiet}
            onNewTask={() =>
              onNewTask({ name: repo.name, dir: repo.folders[0].dir, key: repo.key })
            }
          />
        </div>
      </div>
      {taskFormOpen && (
        <InlineNewTask
          repo={{ name: repo.name, dir: repo.folders[0].dir, key: repo.key }}
          onCancel={onCancelTaskForm}
          onSubmit={onSubmitTaskForm}
          initialGoal={taskFormInitialGoal}
        />
      )}
      {pendingRows}
      {/* The collapse test stays *outside* AnimatePresence: inside it,
          collapsing a repo would read as every folder being deleted at once
          and play a full exit on each. Unmounting the boundary itself
          collapses instantly, matching how session rows already behave. */}
      {!repoCollapsed && (
        <AnimatePresence initial={false}>
          {shownFolders.map((folder) => {
            const key = `${repo.key}::${folder.dir}`;
            const fCollapsed = collapsed[key];
            const deleting = deletingDirs?.has(folder.dir) ?? false;
            const deletingLabel = deletingPhase?.get(folder.dir);
            const settingUpSince = settingUpDirs?.get(folder.dir);
            return (
              <motion.div
                key={folder.dir}
                {...railRowMotion}
                // The dim goes through `animate`, not an opacity-50 class:
                // this element is animated, so motion writes an inline
                // opacity that a class could never win against.
                animate={{ opacity: deleting ? 0.5 : 1, x: 0 }}
                className={cn(deleting && "pointer-events-none")}
              >
                <FolderHeader
                  scope="folder"
                  title={folder.name}
                  folder={folder}
                  needs={folder.needs}
                  pr={prForFolder(prs, repo.originUrl, folder.branch)}
                  task={taskForFolder(tasks, folder.dir)}
                  collapsed={fCollapsed}
                  now={now}
                  active={activeFolderDir === folder.dir}
                  deleting={deleting}
                  deletingLabel={deletingLabel}
                  settingUpSince={settingUpSince}
                  actions={actions}
                  onToggle={() => {
                    onToggle(key);
                    onSelectFolder(folder.dir);
                  }}
                  onNewSession={() => onNewSession(folder.dir)}
                  onRemoveRepo={() => onRemoveRepo([folder.dir], folder.name)}
                  onDeleteWorktree={
                    folderRemovableTask(folder)
                      ? () => onDeleteWorktree(folder.dir, folder.name)
                      : undefined
                  }
                  onOpenDiff={() => onOpenDiff(folder.dir)}
                  onOpenFiles={() => onOpenFiles(folder.dir)}
                  onOpenPreview={() => onOpenPreview(folder.dir)}
                  onOpenAgent={() => onOpenAgent(folder.dir)}
                  onOpenJarvis={onOpenJarvis ? () => onOpenJarvis(folder.dir) : undefined}
                />
                {!fCollapsed && <div className="pb-1">{sessionRows(folder)}</div>}
              </motion.div>
            );
          })}
        </AnimatePresence>
      )}
      {!repoCollapsed && quiet.size > 0 && (
        <QuietToggleRow count={quiet.size} revealed={showQuiet} onToggle={onToggleQuiet} />
      )}
    </div>
  );
}

/** A repo whose checkouts are all quiet (hide-inactive filter), demoted to
 * one dim row instead of removed — the repo stays findable, just out of the
 * way. Clicking restores the full group until toggled back. */
function QuietRepoStub({
  name,
  count,
  onToggle,
}: {
  name: string;
  count: number;
  onToggle?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title="Nothing going on here right now — click to show"
      className="flex w-full items-center gap-2 border-b bg-card px-3 py-1.5 text-left text-muted-foreground/60 hover:bg-accent/40 hover:text-muted-foreground"
    >
      <Chevron collapsed />
      <FolderGit2 className="size-3.5 shrink-0 opacity-60" />
      <span className="min-w-0 truncate text-sm">{name}</span>
      <span className="ml-auto shrink-0 font-mono text-[10px]">
        {count === 1 ? "quiet" : `${count} quiet`}
      </span>
    </button>
  );
}

/** The stub/toggle row under a repo's visible folders: "N quiet" when its
 * quiet checkouts are tucked away, "hide N quiet" while they're shown. */
function QuietToggleRow({
  count,
  revealed,
  onToggle,
}: {
  count: number;
  revealed: boolean;
  onToggle?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-1.5 py-1 pr-3 pl-6 text-left font-mono text-[10.5px] text-muted-foreground/50 hover:text-muted-foreground"
    >
      <Chevron collapsed={!revealed} />
      {revealed ? `hide ${count} quiet` : `${count} quiet`}
    </button>
  );
}
