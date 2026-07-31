import { useState } from "react";
import { toast } from "sonner";
import type {
  BranchCheck,
  NewTaskRepo,
  NewTaskSubmit,
  TaskCreated,
} from "@/components/inline-new-task";
import {
  abSetSessionPurpose,
  ownerRepoFromOrigin,
  promptWithImages,
  type ClaudeLaunchOptions,
  type StartClaudeTarget,
} from "@/lib/agentboard";
import { storeSetTaskStatus, storeTaskSetWorktree } from "@/lib/data";
import { NotInTauri } from "@/lib/errors";
import { TaskCreatedSchema } from "@/lib/schemas/task";
import { invoke } from "@/lib/tauri";
import { createTaskForSubmit } from "./helpers";

export type TaskCreation = {
  /** Repo keys whose inline new-task form is open — several can be at once. */
  openTaskForms: Set<string>;
  /** Repo keys whose open form reopens a closed task: its goal + id to rebind. */
  reopenTasks: Map<string, { taskId: number; goal: string }>;
  /** Checkouts whose background setup step is running → when it started. */
  settingUpDirs: Map<string, number>;
  /** Open/close a repo's form — clicking the affordance again closes it. */
  toggleTaskForm: (repo: NewTaskRepo) => void;
  closeTaskForm: (key: string) => void;
  /** Board's "Reopen": open the repo's form pre-filled, bound to the same task. */
  openReopenForm: (repo: NewTaskRepo, taskId: number, goal: string) => void;
  createTask: (
    repo: NewTaskRepo,
    input: NewTaskSubmit & { taskId?: number; reopen?: boolean },
  ) => Promise<void>;
};

/**
 * Creating a task end to end: board card → worktree → session → Claude on the
 * goal. The board task is created *first*; its worktree binding is what puts
 * the row on the rail, so a failed create leaves the row reading `detached`.
 */
/** The worktree dir for `branch`, when the MCP `task_start` caller skipped
 * the form's preflight — needed *before* the create. */
async function resolveWorktreeDir(root: string, branch: string): Promise<string | null> {
  const check = await invoke<BranchCheck>("task_check_branch", { root, branch });
  return check.isOk() ? check.value.dir : null;
}

export function useTaskCreation(args: {
  /** Spawn a session's PTY and place its pane *without* stealing focus. */
  mountSession: (folderDir: string, sessionId: string) => void;
  /** Mount + focus + ack, the same path a rail click uses. */
  selectSession: (folderDir: string, sessionId: string) => void;
  launchClaudeIn: (
    target: StartClaudeTarget,
    prompt: string,
    options?: ClaudeLaunchOptions,
    label?: string,
  ) => Promise<void>;
  /** Live focus, read at resolve time to avoid stealing the user's view. */
  selectedRef: React.RefObject<string | null>;
  activeFolderDirRef: React.RefObject<string | null>;
  railCollapsed: boolean;
  toggleRail: () => void;
}): TaskCreation {
  const {
    mountSession,
    selectSession,
    launchClaudeIn,
    selectedRef,
    activeFolderDirRef,
    railCollapsed,
    toggleRail,
  } = args;

  const [openTaskForms, setOpenTaskForms] = useState<Set<string>>(new Set());
  const [reopenTasks, setReopenTasks] = useState<Map<string, { taskId: number; goal: string }>>(
    new Map(),
  );
  const [settingUpDirs, setSettingUpDirs] = useState<Map<string, number>>(new Map());

  function toggleTaskForm(repo: NewTaskRepo) {
    setOpenTaskForms((prev) => {
      const next = new Set(prev);
      if (next.has(repo.key)) next.delete(repo.key);
      else next.add(repo.key);
      return next;
    });
  }

  function closeTaskForm(key: string) {
    setOpenTaskForms((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setReopenTasks((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }

  function openReopenForm(repo: NewTaskRepo, taskId: number, goal: string) {
    if (railCollapsed) toggleRail();
    setReopenTasks((prev) => new Map(prev).set(repo.key, { taskId, goal }));
    setOpenTaskForms((prev) => new Set(prev).add(repo.key));
  }

  // Both setup paths mark the dir for the whole run so the folder header can
  // badge the install; a retry is the same install, only the toasts differ.
  function markSetupRunning(dir: string) {
    setSettingUpDirs((prev) => new Map(prev).set(dir, Date.now()));
  }

  function clearSetupRunning(dir: string) {
    setSettingUpDirs((prev) => {
      if (!prev.has(dir)) return prev;
      const next = new Map(prev);
      next.delete(dir);
      return next;
    });
  }

  // Setup can fail without invalidating the task — give it a one-click retry.
  async function retrySetup(dir: string) {
    markSetupRunning(dir);
    const result = await invoke<string | null>("task_run_setup", { dir });
    clearSetupRunning(dir);
    result.match({
      ok: (warning) => {
        if (warning) toast(warning, { action: retryAction(dir) });
        else toast("setup succeeded");
      },
      err: (e) => toast(e.message),
    });
  }

  function retryAction(dir: string) {
    return { label: "Retry", onClick: () => void retrySetup(dir) };
  }

  // The pane opens as soon as the worktree exists; setup runs afterward in the
  // background. Failure gets the retry-able toast, success is silent.
  function runSetupInBackground(dir: string) {
    markSetupRunning(dir);
    void invoke<string | null>("task_run_setup", { dir }).then((result) => {
      clearSetupRunning(dir);
      result.match({
        ok: (warning) => {
          if (warning) toast(warning, { action: retryAction(dir) });
        },
        err: (e) => toast(e.message),
      });
    });
  }

  async function createTask(
    repo: NewTaskRepo,
    input: NewTaskSubmit & { taskId?: number; reopen?: boolean },
  ) {
    // Focus at submit time — `taskCreated`'s yardstick for whether
    // auto-focusing the new task would steal a view the user moved to since.
    const focusAtSubmit = {
      sessionId: selectedRef.current,
      folderDir: activeFolderDirRef.current,
    };
    const taskId = input.taskId ?? (await createTaskForSubmit(input));
    const worktreeDir = input.worktree
      ? (input.dir ?? (await resolveWorktreeDir(repo.dir, input.branch)))
      : null;
    // A reopened task is closed (frozen status): clear that first; live-agent
    // sync settles it into backlog/doing once the fresh worktree exists.
    if (input.reopen && taskId !== undefined) {
      const reopened = await storeSetTaskStatus(taskId, "backlog");
      if (reopened.isErr()) toast.error(`Couldn't reopen that task — ${reopened.error.message}`);
    }
    // Bind repo, branch and the dir the worktree is *going* to live in, up
    // front: the binding is what puts the row on the rail, before `git fetch`
    // has started. Awaited — the row must exist before the create starts, or
    // the phase the backend stamps has no row to land on.
    if (taskId !== undefined) {
      const bound = await storeTaskSetWorktree(
        taskId,
        repo.dir,
        input.worktree ? input.branch : undefined,
        {
          repo: ownerRepoFromOrigin(repo.originUrl),
          dir: worktreeDir ?? undefined,
        },
      );
      if (bound.isErr() && !NotInTauri.is(bound.error)) {
        toast(`couldn't bind the task to its repo: ${bound.error.message}`);
      }
    }
    if (!input.worktree) {
      toast("task added to the board");
      return;
    }
    const imagePaths = input.imagePaths;
    // 60s covers a fetch (10s server-side cap) plus a worktree add — the
    // install no longer runs inside `task_create`.
    const result = await invoke<TaskCreated>(
      "task_create",
      { root: repo.dir, branch: input.branch, base: input.base, dir: worktreeDir ?? "" },
      { schema: TaskCreatedSchema, timeoutMs: 60_000 },
    );
    if (result.isErr()) {
      // The row stays and reads as `detached`, where its retry and delete
      // live — so the failure needs no bookkeeping of its own here.
      toast.error(`couldn't create the worktree: ${result.error.message}`);
      return;
    }
    const created = result.value;
    // Re-bind with what the create actually produced (a branch can normalize
    // on the way through).
    if (taskId !== undefined) {
      void storeTaskSetWorktree(taskId, repo.dir, created.branch, {
        repo: ownerRepoFromOrigin(repo.originUrl),
        dir: created.dir,
      });
    }
    // Only fetch/worktree-add/secret-inherit warnings land here — the install
    // reports through its own toast.
    for (const warning of created.warnings) {
      toast(warning);
    }
    runSetupInBackground(created.dir);

    // An image with no typed goal is still a valid ask — give the rail
    // something to show rather than an unlabeled session.
    const label =
      input.goal ||
      (imagePaths.length ? `attached ${imagePaths.length === 1 ? "image" : "images"}` : "");
    // The goal launches exactly as it reads — prompt improvers rewrite the
    // field *before* submit. No prompt means "leave the PTY at a bare shell".
    const prompt = input.launchClaude ? promptWithImages(input.goal, imagePaths) : "";
    await taskCreated(created, prompt, input.options, label, focusAtSubmit);
  }

  // A task the inline form just created: mount its first session in the
  // background and start Claude on the goal, without stealing the user's view.
  async function taskCreated(
    created: TaskCreated,
    prompt: string,
    options: ClaudeLaunchOptions,
    /** The goal as typed — image paths appended to the prompt stay out of it. */
    label?: string,
    /** Focus at submit time; auto-focus only if the user hasn't moved since. */
    focusAtSubmit?: { sessionId: string | null; folderDir: string | null },
  ) {
    toast(`created ${created.name}${created.branch ? ` on ${created.branch}` : ""}`);
    // Deliberately NOT tracked as a repo: the binding written in `createTask`
    // put the row on the rail, and a task worktree is never a `repos.json`
    // entry (`RowRecord`'s doc) — an entry shadows the record as a bare
    // "Root" row and strands a ghost when a removal skips the untrack.
    // `ab_ensure_session` reuses the folder's default not-started session if
    // one exists rather than opening a surprise split pane beside it.
    const ensured = await invoke<{ id: string; name: string }>("ab_ensure_session", {
      dir: created.dir,
    });
    if (ensured.isErr()) return;
    const rec = ensured.value;
    mountSession(created.dir, rec.id);
    // Label even without a launch — the goal is why this session exists, and
    // an unlaunched task would otherwise sit in the rail as an unnamed shell.
    if (label) void abSetSessionPurpose(rec.id, label);
    if (prompt) {
      // `launchClaudeIn` waits for the PTY's first frame itself and focuses
      // the pane on its own, so the auto-focus below is bare-shell-only.
      await launchClaudeIn(
        { folderDir: created.dir, sessionId: rec.id, sessionName: rec.name, restart: false },
        prompt,
        options,
        label,
      );
      return;
    }
    // Bare-shell task: focus the parked pane, but only if the user is still
    // where they were at submit — otherwise the toast is the signal.
    const stayedPut =
      selectedRef.current === (focusAtSubmit?.sessionId ?? null) &&
      activeFolderDirRef.current === (focusAtSubmit?.folderDir ?? null);
    if (stayedPut) selectSession(created.dir, rec.id);
  }

  return {
    openTaskForms,
    reopenTasks,
    settingUpDirs,
    toggleTaskForm,
    closeTaskForm,
    openReopenForm,
    createTask,
  };
}
