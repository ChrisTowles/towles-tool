import type { ComponentProps } from "react";
import { FolderPlusIcon, GitBranchIcon } from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo";
import { AnimatePresence, motion } from "motion/react";
import { RepoGroup } from "@/components/agentboard-repo-group";
import type { NewTaskRepo } from "@/components/inline-new-task";
import type { FolderData, RepoData } from "@/lib/agentboard/types";
import { railRowMotion } from "@/lib/rail-motion";
import type { TaskCreation } from "./use-task-creation";

type GroupProps = ComponentProps<typeof RepoGroup>;

/** What every `RepoGroup` gets alike; the per-repo props are derived below. */
type SharedGroupProps = Omit<
  GroupProps,
  | "repo"
  | "idleDirs"
  | "idleRevealed"
  | "onToggleIdle"
  | "unmanagedDirs"
  | "unmanagedRevealed"
  | "onToggleUnmanaged"
  | "quietDirs"
  | "onNewRootShell"
  | "onNewTask"
  | "onRecreateWorktree"
  | "taskFormOpen"
  | "taskFormInitialGoal"
  | "onCancelTaskForm"
  | "onSubmitTaskForm"
>;

/** The tree rail's body: every repo → checkout → session, or the empty and
 * no-match states standing in for it. */
export function CheckoutTree({
  repos,
  shownRepos,
  query,
  onClearQuery,
  quietCount,
  showQuiet,
  onOpenRepoManager,
  idleDirs,
  idleRevealed,
  onToggleIdle,
  unmanagedDirs,
  unmanagedRevealed,
  onToggleUnmanaged,
  quietDirs,
  taskCreation,
  onNewRootShell,
  onNewTask,
  onRecreateWorktree,
  shared,
}: {
  repos: RepoData[];
  shownRepos: RepoData[];
  query: string;
  onClearQuery: () => void;
  quietCount: number;
  showQuiet: boolean;
  onOpenRepoManager: () => void;
  idleDirs: Map<string, Set<string>>;
  idleRevealed: Set<string>;
  onToggleIdle: (repoKey: string) => void;
  unmanagedDirs: Map<string, Set<string>>;
  unmanagedRevealed: Set<string>;
  onToggleUnmanaged: (repoKey: string) => void;
  quietDirs: Map<string, Set<string>>;
  taskCreation: TaskCreation;
  onNewRootShell: (repo: RepoData) => void;
  onNewTask: (target: NewTaskRepo) => void;
  onRecreateWorktree: (repo: RepoData, folder: FolderData) => void;
  shared: SharedGroupProps;
}) {
  return (
    <div className="flex flex-col">
      {repos.length === 0 && (
        <div className="flex flex-col items-center gap-3 px-3 py-10 text-center">
          <GitBranchIcon className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No repos on the rail yet.</p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={onOpenRepoManager}
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
            No repo or branch matches <span className="font-mono text-foreground">{query}</span>.
          </p>
          <Button size="sm" variant="outline" onClick={onClearQuery}>
            Clear filter
          </Button>
          {quietCount > 0 && !showQuiet && (
            <p className="text-xs text-muted-foreground/70">
              {quietCount} quiet checkout{quietCount === 1 ? " is" : "s are"} hidden — the ▤ button
              above searches them too once shown.
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
              onToggleIdle={() => onToggleIdle(repo.key)}
              unmanagedDirs={unmanagedDirs.get(repo.key)}
              unmanagedRevealed={unmanagedRevealed.has(repo.key)}
              onToggleUnmanaged={() => onToggleUnmanaged(repo.key)}
              quietDirs={quietDirs.get(repo.key)}
              onNewRootShell={() => onNewRootShell(repo)}
              onNewTask={onNewTask}
              onRecreateWorktree={(folder) => onRecreateWorktree(repo, folder)}
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
              {...shared}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
