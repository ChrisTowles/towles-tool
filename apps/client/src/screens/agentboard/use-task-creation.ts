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
  openTaskForms: Set<string>;
  reopenTasks: Map<string, { taskId: number; goal: string }>;
  settingUpDirs: Map<string, number>;
  toggleTaskForm: (repo: NewTaskRepo) => void;
  closeTaskForm: (key: string) => void;
  openReopenForm: (repo: NewTaskRepo, taskId: number, goal: string) => void;
  createTask: (
    repo: NewTaskRepo,
    input: NewTaskSubmit & { taskId?: number; reopen?: boolean },
  ) => Promise<void>;
};

// Needed *before* the create, for an MCP `task_start` caller that skipped the
// form's preflight.
async function resolveWorktreeDir(root: string, branch: string): Promise<string | null> {
  const check = await invoke<BranchCheck>("task_check_branch", { root, branch });
  return check.isOk() ? check.value.dir : null;
}

export function useTaskCreation(args: {
  /** Places the pane *without* stealing focus; `selectSession` also focuses. */
  mountSession: (folderDir: string, sessionId: string) => void;
  selectSession: (folderDir: string, sessionId: string) => void;
  launchClaudeIn: (
    target: StartClaudeTarget,
    prompt: string,
    options?: ClaudeLaunchOptions,
    label?: string,
  ) => Promise<void>;
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

  // Marked for the whole run so the folder header can badge the install.
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

  // The pane opens as soon as the worktree exists; setup runs after it.
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
    // `taskCreated` auto-focuses only if the user hasn't moved since submit.
    const focusAtSubmit = {
      sessionId: selectedRef.current,
      folderDir: activeFolderDirRef.current,
    };
    const taskId = input.taskId ?? (await createTaskForSubmit(input));
    const worktreeDir = input.worktree
      ? (input.dir ?? (await resolveWorktreeDir(repo.dir, input.branch)))
      : null;
    // Clear the frozen closed status first; live-agent sync settles it after.
    if (input.reopen && taskId !== undefined) {
      const reopened = await storeSetTaskStatus(taskId, "backlog");
      if (reopened.isErr()) toast.error(`Couldn't reopen that task — ${reopened.error.message}`);
    }
    // The binding is what puts the row on the rail, so it is bound to the dir
    // the worktree is *going* to live in, and awaited before the create starts.
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
    // 60s covers a fetch (10s server-side cap) plus a worktree add.
    const result = await invoke<TaskCreated>(
      "task_create",
      { root: repo.dir, branch: input.branch, base: input.base, dir: worktreeDir ?? "" },
      { schema: TaskCreatedSchema, timeoutMs: 60_000 },
    );
    if (result.isErr()) {
      // The row stays and reads `detached`, where its retry and delete live.
      toast.error(`couldn't create the worktree: ${result.error.message}`);
      return;
    }
    const created = result.value;
    // Re-bind: a branch can normalize on the way through the create.
    if (taskId !== undefined) {
      void storeTaskSetWorktree(taskId, repo.dir, created.branch, {
        repo: ownerRepoFromOrigin(repo.originUrl),
        dir: created.dir,
      });
    }
    for (const warning of created.warnings) {
      toast(warning);
    }
    runSetupInBackground(created.dir);

    const label =
      input.goal ||
      (imagePaths.length ? `attached ${imagePaths.length === 1 ? "image" : "images"}` : "");
    // No prompt means "leave the PTY at a bare shell".
    const prompt = input.launchClaude ? promptWithImages(input.goal, imagePaths) : "";
    await taskCreated(created, prompt, input.options, label, focusAtSubmit);
  }

  // Mounts the new task's first session in the background and starts Claude on
  // the goal, without stealing the user's view.
  async function taskCreated(
    created: TaskCreated,
    prompt: string,
    options: ClaudeLaunchOptions,
    label?: string,
    focusAtSubmit?: { sessionId: string | null; folderDir: string | null },
  ) {
    toast(`created ${created.name}${created.branch ? ` on ${created.branch}` : ""}`);
    // Deliberately NOT tracked as a repo: a task worktree is never a
    // `repos.json` entry (`RowRecord`'s doc), and an entry would shadow the
    // record as a bare "Root" row and strand a ghost on removal.
    const ensured = await invoke<{ id: string; name: string }>("ab_ensure_session", {
      dir: created.dir,
    });
    if (ensured.isErr()) return;
    const rec = ensured.value;
    mountSession(created.dir, rec.id);
    // Label even without a launch, or the task sits in the rail unnamed.
    if (label) void abSetSessionPurpose(rec.id, label);
    if (prompt) {
      // `launchClaudeIn` focuses the pane itself; the auto-focus below is
      // therefore bare-shell-only.
      await launchClaudeIn(
        { folderDir: created.dir, sessionId: rec.id, sessionName: rec.name, restart: false },
        prompt,
        options,
        label,
      );
      return;
    }
    // Bare-shell task: focus the parked pane only if the user stayed put.
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
