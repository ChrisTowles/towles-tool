import { Result } from "effect";
/** What a repo's rail block *contains*: the repo in a left column, its
 * checkouts as lines beside it. How each line looks belongs to `CheckoutLine`,
 * `SessionChip` and `ViewPaneChip`. */
import { type CSSProperties, useState } from "react";
import { toast } from "@/lib/toast";
import { PlusIcon } from "@phosphor-icons/react";
import { Tooltip } from "@cloudflare/kumo";
import { ShortcutBadge } from "@/components/hint";
import { mouseAction } from "@/lib/shortcut-coach";
import { shortcutAria } from "@/lib/shortcuts";
import { NeedsBadge } from "@/components/agentboard-bits/badges";
import { IconBtn } from "@/components/agentboard-bits/primitives";
import { RepoMenu } from "@/components/agentboard-bits/repo-menu";
import { Chevron, CollapsedLive } from "@/components/agentboard-bits/status-dots";
import { FoldToggleRow, FoldedRepoStub } from "@/components/agentboard-fold-rows";
import { CheckoutLine } from "@/components/agentboard-checkout-line";
import { HomeHeader } from "@/components/agentboard-home-header";
import { ViewPaneChip, viewPaneKind, type ViewPaneKind } from "@/components/agentboard-pane-chips";
import { SessionChip } from "@/components/agentboard-session-chip";
import {
  InlineNewTask,
  type NewTaskRepo,
  type NewTaskSubmit,
  type TaskFormSeed,
} from "@/components/inline-new-task";
import { normalizeHex, repoAccentStyles, repoIcon } from "@/lib/repo-identity";
import { cn } from "@/lib/utils";
import type { SessionActions } from "@/lib/agentboard/actions";
import {
  folderBusy,
  folderDetached,
  folderIsHome,
  folderIsUnclaimed,
  folderRecreateBranch,
  folderPhaseLabel,
  folderTask,
  isHomeRepo,
  keptWhenCollapsed,
  pathScope,
  prForFolder,
  taskForFolder,
  withoutFolded,
} from "@/lib/agentboard/folder";
import { folderRemovableTask, type TaskBlocker } from "@/lib/agentboard/landing";
import type { FolderData, RepoData, SessionData, WindowsPayload } from "@/lib/agentboard/types";
import { taskAdoptWorktree, type PrItem, type TaskItem } from "@/lib/data";
import { NotInTauri } from "@/lib/errors";
import { uiAction } from "@/lib/ui-action";
import { railChipMotion, railRowMotion } from "@/lib/rail-motion";
import { setRepoArchived } from "@/lib/repo-actions";
import { folderNodeKey, sessionNodeKey } from "@/lib/rail-nodes";
import { AnimatePresence, motion } from "motion/react";

const IDLE_HINT = "Checkouts with nothing going on right now";
const UNMANAGED_HINT =
  "Worktrees no task of yours claims — an agent's own, or one added by hand. Adopt one to make it a task.";

/** Undefined for every line but `detected` — that is what hides the affordance. */
function adoptWorktree(folder: FolderData) {
  const task = folderTask(folder);
  if (!folderIsUnclaimed(folder) || !task) return undefined;
  return () => {
    uiAction("agentboard.adopt_worktree", "agentboard");
    void taskAdoptWorktree(task.id).then((result) => {
      if (Result.isFailure(result) && !NotInTauri.is(result.failure))
        toast.error(result.failure.message);
    });
  };
}

export function RepoGroup({
  repo,
  now,
  prs,
  tasks,
  selectedSessionId,
  activePaneId,
  activeFolderDir,
  cursorKey,
  hotkeys,
  collapsed,
  renaming,
  titles,
  wins,
  actions,
  onToggle,
  onSelectFolder,
  onSelect,
  onNewSession,
  onNewRootShell,
  onNewTask,
  onRemoveRepo,
  onDeleteWorktree,
  onDiscardWorktree,
  deleteBlockers,
  onRecreateWorktree,
  settingUpDirs,
  onRenameCommit,
  onOpenFiles,
  onOpenPreview,
  onOpenBrowser,
  onClosePane,
  idleDirs,
  idleRevealed,
  onToggleIdle,
  unmanagedDirs,
  unmanagedRevealed,
  onToggleUnmanaged,
  quietDirs,
  taskFormOpen,
  taskFormSeed,
  onCancelTaskForm,
  onSubmitTaskForm,
}: {
  repo: RepoData;
  now: number;
  prs: PrItem[];
  tasks: TaskItem[];
  selectedSessionId: string | null;
  /** A view pane has no session record, so `selectedSessionId` can't name it. */
  activePaneId: string | null;
  activeFolderDir: string | null;
  /** The rail cursor's `railNodes` key — the one row wearing the focus ring. */
  cursorKey: string | null;
  /** Session id → its jump digit, while the chord is held; absent otherwise. */
  hotkeys?: Map<string, number>;
  collapsed: Record<string, boolean>;
  renaming: string | null;
  titles: Record<string, string>;
  wins: WindowsPayload | null;
  actions: SessionActions;
  onToggle: (key: string) => void;
  onSelectFolder: (folderDir: string) => void;
  onSelect: (folderDir: string, sessionId: string) => void;
  onNewSession: (folderDir: string, launchClaude?: boolean) => void;
  /** A shell in the root checkout, focused — the repo column's "+". */
  onNewRootShell: () => void;
  onNewTask: (repo: NewTaskRepo) => void;
  onRemoveRepo: (dirs: string[], label: string) => void;
  onDeleteWorktree: (dir: string, label: string) => void;
  onDiscardWorktree: (dir: string, label: string) => void;
  /** Dir → what refused its last delete. */
  deleteBlockers: ReadonlyMap<string, TaskBlocker[]>;
  onRecreateWorktree: (folder: FolderData) => void;
  /** Checkouts whose setup step is still running → when it started (epoch ms). */
  settingUpDirs?: Map<string, number>;
  onRenameCommit: (sessionId: string, name: string) => void;
  onOpenFiles: (dir: string) => void;
  onOpenPreview: (dir: string) => void;
  onOpenBrowser?: (dir: string) => void;
  onClosePane: (paneId: string) => void;
  /** Folders the rail *filter* excludes — demoted to a stub rather than gone,
   * since nobody chose the filter per checkout. Empty when it is off. */
  idleDirs?: Set<string>;
  idleRevealed?: boolean;
  onToggleIdle?: () => void;
  /** Worktrees no task claims — agents make their own, so they fold into a stub
   * of their own instead of one line apiece burying the work you asked for. */
  unmanagedDirs?: Set<string>;
  unmanagedRevealed?: boolean;
  onToggleUnmanaged?: () => void;
  /** Folders marked quiet by hand, normally already gone from `repo`
   * (`partitionQuiet`). One arriving here is peeked or active, and gets a
   * badge saying so. */
  quietDirs?: Set<string>;
  taskFormOpen: boolean;
  /** Set when the form was opened on someone's behalf: a reopen, or an issue. */
  taskFormSeed?: TaskFormSeed;
  onCancelTaskForm: () => void;
  onSubmitTaskForm: (input: NewTaskSubmit) => void;
}) {
  // JS state, not CSS `:hover` — WebKitGTK doesn't reliably update `:hover`.
  const [repoHovered, setRepoHovered] = useState(false);
  const idle = idleDirs ?? new Set<string>();
  const showIdle = idleRevealed ?? false;
  const unmanaged = unmanagedDirs ?? new Set<string>();
  const showUnmanaged = unmanagedRevealed ?? false;
  const quiet = quietDirs ?? new Set<string>();

  const sessionChip = (folder: FolderData, s: SessionData) => (
    <motion.div key={s.id} {...railChipMotion} className="flex min-w-0">
      <SessionChip
        cursor={cursorKey === sessionNodeKey(s.id)}
        session={s}
        folderDir={folder.dir}
        now={now}
        title={titles[s.id]}
        active={selectedSessionId === s.id}
        hotkey={hotkeys?.get(s.id)}
        renaming={renaming === s.id}
        actions={actions}
        onSelect={onSelect}
        onRenameCommit={onRenameCommit}
      />
    </motion.div>
  );

  // A table, not a ternary chain, so `browser`'s absence is expressible: its
  // chip outlives the setting (the layout persists), and no opener means ✕ only.
  const viewPaneOpener: Record<ViewPaneKind, ((dir: string) => void) | undefined> = {
    files: onOpenFiles,
    preview: onOpenPreview,
    browser: onOpenBrowser,
  };

  /** One chip per pane, PTY session or view, in window order, then the
   * sessions no window holds: what is open in a folder is the rail's answer. */
  const chips = (folder: FolderData) => {
    const byId = new Map(folder.sessions.map((s) => [s.id, s] as const));
    const panes = (wins?.windows ?? [])
      .filter((w) => w.folderDir === folder.dir)
      .flatMap((w) => w.panes);
    const placed = new Set(panes);
    const out = panes.map((paneId) => {
      const session = byId.get(paneId);
      if (session) return sessionChip(folder, session);
      const kind = viewPaneKind(paneId);
      if (!kind) return null;
      return (
        <motion.div key={paneId} {...railChipMotion} className="flex">
          <ViewPaneChip
            kind={kind}
            active={activePaneId === paneId}
            onSelect={() => viewPaneOpener[kind]?.(folder.dir)}
            onClose={() => onClosePane(paneId)}
          />
        </motion.div>
      );
    });
    for (const s of folder.sessions) if (!placed.has(s.id)) out.push(sessionChip(folder, s));
    // The way in only on the line you're in (and home, the line you came to
    // start one in), or every untouched checkout repeats it.
    const empty =
      folder.sessions.length === 0 && (activeFolderDir === folder.dir || folderIsHome(folder));
    return (
      <>
        <AnimatePresence initial={false}>{out}</AnimatePresence>
        {empty && (
          <span className="flex items-center gap-2 px-1.5 text-mini whitespace-nowrap text-kumo-subtle">
            <button
              type="button"
              onClick={() => onNewSession(folder.dir, true)}
              className="hover:text-agent"
            >
              ✦ start Claude
            </button>
            <button
              type="button"
              onClick={() => onNewSession(folder.dir, false)}
              className="hover:text-kumo-default"
            >
              + shell
            </button>
          </span>
        )}
      </>
    );
  };

  // Home: one folder, no repo around it, and a heavier rule under it so it
  // reads as apart from the repos.
  if (isHomeRepo(repo)) {
    const folder = repo.folders[0];
    const isCollapsed = collapsed[repo.key];
    return (
      <div className="border-b-2" data-focus-kind="repo" data-focus-id={repo.key}>
        <HomeHeader
          identity={repo}
          folder={folder}
          needs={repo.needs}
          collapsed={isCollapsed}
          active={activeFolderDir === folder.dir}
          cursor={cursorKey === repo.key}
          onToggle={() => {
            onToggle(repo.key);
            onSelectFolder(folder.dir);
          }}
          onNewSession={() => onNewSession(folder.dir)}
          onOpenFiles={() => onOpenFiles(folder.dir)}
        />
        {!isCollapsed && (
          <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 py-1 pr-3 pl-8">
            {chips(folder)}
          </div>
        )}
      </div>
    );
  }

  const repoCollapsed = collapsed[repo.key];
  const shownFolders = withoutFolded(
    withoutFolded(repo.folders, unmanaged, showUnmanaged),
    idle,
    showIdle,
  );
  const lineFolders = repoCollapsed
    ? keptWhenCollapsed(shownFolders, activeFolderDir)
    : shownFolders;
  const foldedCount = shownFolders.length - lineFolders.length;
  // Both folds gave way at once: the one row left has to undo both, or a repo
  // of nothing but agents' worktrees opens onto another stub.
  if (shownFolders.length === 0) {
    return (
      <FoldedRepoStub
        name={repo.name}
        idle={idle.size}
        unmanaged={unmanaged.size}
        onToggle={() => {
          if (idle.size > 0) onToggleIdle?.();
          if (unmanaged.size > 0) onToggleUnmanaged?.();
        }}
      />
    );
  }
  const scopePrefix = pathScope(repo.folders[0].dir);
  const RepoIcon = repoIcon(repo.meta);
  const accent = repoAccentStyles(repo);
  const newTask = () => onNewTask({ name: repo.name, dir: repo.folders[0].dir, key: repo.key });
  // Identity never outranks status: a repo waiting on you keeps the amber edge.
  const statusOwnsEdge = repo.needs > 0;
  return (
    <div className="@container/repo border-b" data-focus-kind="repo" data-focus-id={repo.key}>
      <div className="flex flex-col @[34rem]/repo:flex-row">
        <div
          onMouseEnter={() => setRepoHovered(true)}
          onMouseLeave={() => setRepoHovered(false)}
          style={statusOwnsEdge ? undefined : accent.edgeStyle}
          className={cn(
            "flex items-center gap-2 border-l-[3px] border-l-transparent bg-background px-3 py-2",
            "@[34rem]/repo:sticky @[34rem]/repo:top-0 @[34rem]/repo:z-10 @[34rem]/repo:w-44 @[34rem]/repo:shrink-0 @[34rem]/repo:flex-col @[34rem]/repo:items-start @[34rem]/repo:self-start @[34rem]/repo:gap-1",
            statusOwnsEdge && "border-l-warn",
            cursorKey === repo.key && "ring-1 ring-inset ring-agent",
          )}
        >
          <div className="flex min-w-0 max-w-full items-center gap-1">
            <button
              type="button"
              aria-label={repoCollapsed ? `Unfold ${repo.name}` : `Fold ${repo.name}`}
              onClick={() => onToggle(repo.key)}
              className="flex shrink-0 items-center gap-1"
            >
              <Chevron collapsed={repoCollapsed} />
              {scopePrefix && (
                <span className="font-mono text-xs text-muted-foreground/60 @[34rem]/repo:hidden">
                  {scopePrefix}
                </span>
              )}
            </button>
            {/* The name is the new-task button: the rail's most common act gets
                its biggest, brightest target. */}
            <Tooltip
              side="bottom"
              content={
                <>
                  New task in {repo.name}
                  <ShortcutBadge id="ab-new-task" />
                </>
              }
              render={
                <button
                  type="button"
                  aria-label={`New task in ${repo.name}`}
                  aria-keyshortcuts={shortcutAria("ab-new-task")}
                  onClick={() => {
                    mouseAction("ab-new-task", "agentboard");
                    newTask();
                  }}
                  style={namePillStyle(repo.color)}
                  className={cn(
                    "flex min-w-0 items-center gap-1.5 rounded-md bg-agent px-2 py-0.5 text-white shadow-sm",
                    "transition hover:brightness-115 active:brightness-95",
                  )}
                >
                  <RepoIcon weight="bold" className="size-3.5 shrink-0" />
                  <span className="truncate text-sm font-semibold">{repo.name}</span>
                  <PlusIcon weight="bold" className="size-3 shrink-0 opacity-80" />
                </button>
              }
            />
          </div>
          <span className="ml-auto flex items-center gap-2 @[34rem]/repo:ml-5">
            {repoCollapsed && <CollapsedLive sessions={repo.folders.flatMap((f) => f.sessions)} />}
            {repo.needs > 0 && <NeedsBadge n={repo.needs} />}
          </span>
          {/* Resting in the narrow header layout, where it has always been;
              in the column it waits for hover so the column stays a name. */}
          <div
            className={cn(
              "flex shrink-0 items-center gap-0.5 @[34rem]/repo:ml-4",
              !repoHovered && "@[34rem]/repo:opacity-0 @[34rem]/repo:focus-within:opacity-100",
            )}
          >
            <IconBtn
              ghost
              title="New shell in the root checkout"
              onClick={onNewRootShell}
              className="hover:text-agent"
            >
              <PlusIcon className="size-3.5" />
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
              // The repo speaks for the whole repo: "Mark quiet" covers the root
              // checkout *and* every worktree, or the repo stays on the rail.
              quietDirs={repo.folders.map((f) => f.dir)}
              quiet={repo.folders.every((f) => f.quiet)}
              dirMissing={repo.folders[0].dirMissing}
              onArchive={() => void setRepoArchived(repo.dir, repo.name, true, "agentboard")}
              onNewTask={newTask}
            />
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col py-0.5">
          {taskFormOpen && (
            <InlineNewTask
              key={formSeedKey(taskFormSeed)}
              repo={{ name: repo.name, dir: repo.folders[0].dir, key: repo.key }}
              onCancel={onCancelTaskForm}
              onSubmit={onSubmitTaskForm}
              initialGoal={taskFormSeed?.goal}
              initialIssue={taskFormSeed?.issue}
            />
          )}
          {/* Keyed on the fold so folding remounts the list instead of
              playing a full exit on every line as if each were deleted. */}
          <AnimatePresence key={repoCollapsed ? "folded" : "open"} initial={false}>
            {lineFolders.map((folder) => {
              const deleting = folderBusy(folder);
              return (
                <motion.div
                  key={folder.dir}
                  {...railRowMotion}
                  // Dim via `animate`, not a class: motion writes an inline
                  // opacity no class could win against.
                  animate={{ ...railRowMotion.animate, opacity: deleting ? 0.5 : 1 }}
                  className={cn(deleting && "pointer-events-none")}
                >
                  <CheckoutLine
                    title={folder.name}
                    folder={folder}
                    quiet={quiet.has(folder.dir)}
                    needs={folder.needs}
                    pr={prForFolder(prs, repo.originUrl, folder.branch)}
                    task={taskForFolder(tasks, folder.dir)}
                    cursor={cursorKey === folderNodeKey(repo.key, folder.dir)}
                    now={now}
                    active={activeFolderDir === folder.dir}
                    deleting={deleting}
                    onAdoptWorktree={adoptWorktree(folder)}
                    deletingLabel={folderPhaseLabel(folder)}
                    settingUpSince={settingUpDirs?.get(folder.dir)}
                    onSelect={() => onSelectFolder(folder.dir)}
                    onRemoveRepo={() => onRemoveRepo([folder.dir], folder.name)}
                    onDeleteWorktree={
                      folderRemovableTask(folder)
                        ? () => onDeleteWorktree(folder.dir, folder.name)
                        : undefined
                    }
                    onDiscardWorktree={
                      folderRemovableTask(folder)
                        ? () => onDiscardWorktree(folder.dir, folder.name)
                        : undefined
                    }
                    deleteBlockers={deleteBlockers.get(folder.dir)}
                    onRecreateWorktree={
                      folderRecreateBranch(folder) && folderDetached(folder)
                        ? () => onRecreateWorktree(folder)
                        : undefined
                    }
                    onOpenFiles={() => onOpenFiles(folder.dir)}
                    onOpenPreview={() => onOpenPreview(folder.dir)}
                  >
                    {chips(folder)}
                  </CheckoutLine>
                </motion.div>
              );
            })}
          </AnimatePresence>
          {foldedCount > 0 && (
            <button
              type="button"
              onClick={() => onToggle(repo.key)}
              className="px-3 py-2 text-left text-mini text-kumo-subtle hover:text-kumo-default"
            >
              {foldedCount} {lineFolders.length > 0 ? "more " : ""}checkout
              {foldedCount === 1 ? "" : "s"} folded
            </button>
          )}
          {!repoCollapsed && unmanaged.size > 0 && (
            <FoldToggleRow
              count={unmanaged.size}
              noun="unmanaged"
              hint={UNMANAGED_HINT}
              revealed={showUnmanaged}
              onToggle={onToggleUnmanaged}
            />
          )}
          {!repoCollapsed && idle.size > 0 && (
            <FoldToggleRow
              count={idle.size}
              noun="idle"
              hint={IDLE_HINT}
              revealed={showIdle}
              onToggle={onToggleIdle}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** A new seed remounts an open form: its fields are seeded once, at mount. */
function formSeedKey(seed: TaskFormSeed | undefined): string {
  if (seed?.issue) return `issue:${seed.issue.repo}#${seed.issue.number}`;
  return seed?.taskId !== undefined ? `task:${seed.taskId}` : "new";
}

/** The repo's own color, solid, so each name pill keeps its identity; a repo
 * with no color falls back to the class's `bg-agent`. */
function namePillStyle(color: string | undefined): CSSProperties | undefined {
  const hex = color ? normalizeHex(color) : null;
  return hex ? { backgroundColor: hex } : undefined;
}
