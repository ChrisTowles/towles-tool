/** What a repo's rail subtree *contains*. How each row *looks* belongs to
 * `FolderHeader`, `SessionRow` and `ViewPaneRow`. */
import { type ReactElement } from "react";
import { toast } from "sonner";
import { FolderGit2, FolderPlus } from "lucide-react";
import { Hint } from "@/components/hint";
import {
  Chevron,
  CollapsedLive,
  IconBtn,
  NeedsBadge,
  RepoMenu,
} from "@/components/agentboard-bits";
import { FolderHeader } from "@/components/agentboard-folder-header";
import {
  ViewPaneRow,
  WindowSpine,
  viewPaneKind,
  type ViewPaneKind,
} from "@/components/agentboard-pane-rows";
import { SessionRow } from "@/components/agentboard-session-row";
import { InlineNewTask, type NewTaskRepo, type NewTaskSubmit } from "@/components/inline-new-task";
import { hasRepoColor, repoAccentStyles, repoIcon } from "@/lib/repo-identity";
import { cn } from "@/lib/utils";
import {
  folderBusy,
  folderDetached,
  folderIsUnclaimed,
  folderRecreateBranch,
  folderPhaseLabel,
  folderRemovableTask,
  folderTask,
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
import { taskAdoptWorktree, type PrItem, type TaskItem } from "@/lib/data";
import { NotInTauri } from "@/lib/errors";
import { uiAction } from "@/lib/ui-action";
import { railRowMotion } from "@/lib/rail-motion";
import { AnimatePresence, motion } from "motion/react";

/** Undefined for every row but `detected` — that is what hides the affordance. */
function adoptWorktree(folder: FolderData) {
  const task = folderTask(folder);
  if (!folderIsUnclaimed(folder) || !task) return undefined;
  return () => {
    uiAction("agentboard.adopt_worktree", "agentboard");
    void taskAdoptWorktree(task.id).then((result) => {
      if (result.isErr() && !NotInTauri.is(result.error)) toast.error(result.error.message);
    });
  };
}

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
  onRecreateWorktree,
  settingUpDirs,
  onRenameCommit,
  onOpenDiff,
  onOpenFiles,
  onOpenPreview,
  onOpenJarvis,
  onOpenBrowser,
  onClosePane,
  quietDirs,
  quietRevealed,
  onToggleQuiet,
  taskFormOpen,
  taskFormInitialGoal,
  onCancelTaskForm,
  onSubmitTaskForm,
}: {
  repo: RepoData;
  now: number;
  compactPct: number;
  prs: PrItem[];
  tasks: TaskItem[];
  selectedSessionId: string | null;
  /** A view pane has no session record, so `selectedSessionId` can't name it. */
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
  onNewTask: (repo: NewTaskRepo) => void;
  onRemoveRepo: (dirs: string[], label: string) => void;
  onDeleteWorktree: (dir: string, label: string) => void;
  onRecreateWorktree: (folder: FolderData) => void;
  /** Checkouts whose setup step is still running → when it started (epoch ms). */
  settingUpDirs?: Map<string, number>;
  onRenameCommit: (sessionId: string, name: string) => void;
  onOpenDiff: (dir: string) => void;
  onOpenFiles: (dir: string) => void;
  onOpenPreview: (dir: string) => void;
  /** Undefined while `agentboard.jarvisPane` is off: hide the entry point
   * rather than offer one that opens nothing. */
  onOpenJarvis?: (dir: string) => void;
  onOpenBrowser?: (dir: string) => void;
  onClosePane: (paneId: string) => void;
  /** Quiet folders demote to a stub rather than vanish — nothing silently
   * disappears from the rail. Empty when the filter is off. */
  quietDirs?: Set<string>;
  quietRevealed?: boolean;
  onToggleQuiet?: () => void;
  taskFormOpen: boolean;
  /** Set when the form was opened to reopen a closed task, not to start one. */
  taskFormInitialGoal?: string;
  onCancelTaskForm: () => void;
  onSubmitTaskForm: (input: NewTaskSubmit) => void;
}) {
  const solo = isSoloRepo(repo);
  const quiet = quietDirs ?? new Set<string>();
  const showQuiet = quietRevealed ?? false;

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

  // A table, not a ternary chain, so `jarvis`'s absence is expressible: its row
  // outlives the setting (the layout persists), and no opener means ✕ only.
  const viewPaneOpener: Record<ViewPaneKind, ((dir: string) => void) | undefined> = {
    diff: onOpenDiff,
    files: onOpenFiles,
    preview: onOpenPreview,
    browser: onOpenBrowser,
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

  /** One rail row per pane, PTY session or view: what is open in a folder is
   * the rail's answer, not the pane area's alone. */
  const paneRow = (folder: FolderData, paneId: string, byId: Map<string, SessionData>) => {
    const session = byId.get(paneId);
    if (session) return sessionRow(folder, session);
    const kind = viewPaneKind(paneId);
    return kind ? viewRow(folder, paneId, kind) : null;
  };

  // Grouping is purely visual; the mechanics that move panes between windows
  // are unchanged. One AnimatePresence per group plus one for loose rows, so a
  // group's exiting row stays inside its own spine while it collapses.
  const sessionRows = (folder: FolderData) => {
    const folderWins = (wins?.windows ?? []).filter((w) => w.folderDir === folder.dir);
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
        {folder.sessions.length === 0 && (
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
    // Phase rides on the folder, so a row is never dimmed for a departed one.
    const deleting = folderBusy(folder);
    const deletingLabel = folderPhaseLabel(folder);
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
          onAdoptWorktree={adoptWorktree(folder)}
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
          onRecreateWorktree={
            folderRecreateBranch(folder) && folderDetached(folder)
              ? () => onRecreateWorktree(folder)
              : undefined
          }
          onOpenDiff={() => onOpenDiff(folder.dir)}
          onOpenFiles={() => onOpenFiles(folder.dir)}
          onOpenPreview={() => onOpenPreview(folder.dir)}
          onOpenBrowser={onOpenBrowser ? () => onOpenBrowser(folder.dir) : undefined}
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
        {!isCollapsed && <div className="pb-2">{sessionRows(folder)}</div>}
        {quiet.size > 0 && showQuiet && (
          <QuietToggleRow count={quiet.size} revealed onToggle={onToggleQuiet} />
        )}
      </div>
    );
  }

  // Multi-checkout repo: repo header, then each folder as a sub-header. A repo
  // with *only* quiet folders shrinks to a single dim stub line.
  const repoCollapsed = collapsed[repo.key];
  const shownFolders = showQuiet ? repo.folders : repo.folders.filter((f) => !quiet.has(f.dir));
  if (shownFolders.length === 0) {
    return <QuietRepoStub name={repo.name} count={quiet.size} onToggle={onToggleQuiet} />;
  }
  // Folder-rail rule: focus never stops at the child level, so a collapsed repo
  // row still shows it holds the folder you're looking at.
  const repoActive = repo.folders.some((f) => f.dir === activeFolderDir);
  const scopePrefix = pathScope(repo.folders[0].dir);
  const RepoIcon = repoIcon(repo.meta);
  // Sticky header: every background on this row must resolve to a fully opaque
  // color, or rows scrolling underneath show through and read as a glitch.
  const accent = repoAccentStyles(repo.meta, "var(--card)");
  // Identity never outranks status: a repo waiting on you keeps the amber. The
  // active selection is a ring, not a fill, so it layers over the wash.
  const statusOwnsRow = repo.needs > 0;
  return (
    <div className="border-b" data-focus-kind="repo" data-focus-id={repo.key}>
      <div
        style={statusOwnsRow ? undefined : { ...accent.edgeStyle, ...accent.surfaceStyle }}
        className={cn(
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
        {/* Same fixed-width right-edge toolbar as the folder rows. */}
        <div className="flex shrink-0 items-center gap-1 pl-1">
          <IconBtn
            ghost
            title="New task — goal, issues, branch"
            shortcut="ab-new-task"
            onClick={() => {
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
            dirMissing={repo.folders[0].dirMissing}
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
      {/* Collapse test outside AnimatePresence: inside, collapsing a repo would
          play a full exit on every folder as if each were deleted. */}
      {!repoCollapsed && (
        <AnimatePresence initial={false}>
          {shownFolders.map((folder) => {
            const key = `${repo.key}::${folder.dir}`;
            const fCollapsed = collapsed[key];
            const deleting = folderBusy(folder);
            const deletingLabel = folderPhaseLabel(folder);
            const settingUpSince = settingUpDirs?.get(folder.dir);
            return (
              <motion.div
                key={folder.dir}
                {...railRowMotion}
                // Dim via `animate`, not a class: motion writes an inline
                // opacity no class could win against.
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
                  onAdoptWorktree={adoptWorktree(folder)}
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
                  onRecreateWorktree={
                    folderRecreateBranch(folder) && folderDetached(folder)
                      ? () => onRecreateWorktree(folder)
                      : undefined
                  }
                  onOpenDiff={() => onOpenDiff(folder.dir)}
                  onOpenFiles={() => onOpenFiles(folder.dir)}
                  onOpenPreview={() => onOpenPreview(folder.dir)}
                  onOpenBrowser={onOpenBrowser ? () => onOpenBrowser(folder.dir) : undefined}
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

/** An all-quiet repo, demoted to one dim row rather than removed. */
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
    <Hint label="Nothing going on here right now — click to show">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 border-b bg-card px-3 py-1.5 text-left text-muted-foreground/60 hover:bg-accent/40 hover:text-muted-foreground"
      >
        <Chevron collapsed />
        <FolderGit2 className="size-3.5 shrink-0 opacity-60" />
        <span className="min-w-0 truncate text-sm">{name}</span>
        <span className="ml-auto shrink-0 font-mono text-[10px]">
          {count === 1 ? "quiet" : `${count} quiet`}
        </span>
      </button>
    </Hint>
  );
}

/** The stub row under a repo's visible folders: "N quiet" / "hide N quiet". */
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
