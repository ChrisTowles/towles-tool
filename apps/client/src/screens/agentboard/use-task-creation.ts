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
  type SessionData,
  type StartClaudeTarget,
  type StatePayload,
} from "@/lib/agentboard";
import { storeSetTaskStatus, storeTaskSetWorktree } from "@/lib/data";
import { NotInTauri } from "@/lib/errors";
import { TaskCreatedSchema } from "@/lib/schemas/task";
import { invoke } from "@/lib/tauri";
import { createTaskForSubmit } from "./helpers";

export type TaskCreation = {
  /** Repo keys whose inline new-task form is open — see InlineNewTask. A form
   * stays embedded in the rail rather than a modal, so several repos can have
   * one open (or a create in flight) at once without blocking each other. */
  openTaskForms: Set<string>;
  /** Repo keys whose open form is reopening a closed task rather than starting
   * a new one — the pre-filled goal and the existing task id to bind instead of
   * minting a new board row. */
  reopenTasks: Map<string, { taskId: number; goal: string }>;
  /** Checkouts whose setup step is running → when it started. The install
   * runs after the pane is already open (see `runSetupInBackground`), so this
   * badges an ordinary folder row rather than describing a row's existence. */
  settingUpDirs: Map<string, number>;
  /** Open/close a repo's form — clicking the affordance again closes it. */
  toggleTaskForm: (repo: NewTaskRepo) => void;
  closeTaskForm: (key: string) => void;
  /** Board's "Reopen" action: open the task's repo's form pre-filled with its
   * text, bound to its existing id — submitting mints a fresh worktree for this
   * same task instead of a new card. */
  openReopenForm: (repo: NewTaskRepo, taskId: number, goal: string) => void;
  createTask: (
    repo: NewTaskRepo,
    input: NewTaskSubmit & { taskId?: number; reopen?: boolean },
  ) => Promise<void>;
};

/**
 * Creating a task from an inline rail form, end to end: board card → worktree
 * → session → Claude on the goal.
 *
 * The board task (#339) is the unit of work and is created *first*, before any
 * worktree exists — the worktree is an attribute of the task, not the other way
 * around. The binding written at submit covers both jobs: the repo half keeps
 * the task out of the Board's "No repo" lane, and the *directory* half is what
 * puts its row on the rail, since the rail's rows are the task records with a
 * binding rather than whatever `git worktree list` reports.
 *
 * So there is no in-flight bookkeeping here and no second row component. The
 * row is real from the moment the form is submitted; `task_create` only adds
 * the live phase label to a row already on screen, and a create that fails
 * leaves that row reading `detached`, where its retry and delete live.
 */
/**
 * Where the worktree for `branch` will be. The inline form already knows (its
 * branch preflight returns it), so this only runs for callers that don't — the
 * MCP `task_start` tool, which picks every field itself. Called from
 * `createTask` rather than duplicated per caller, since binding the dir
 * *before* the create is what puts the row on the rail, and a caller that
 * forgot would silently go back to the row appearing a poll late.
 */
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
  /** Live copies of the user's focus, read at resolve time to decide whether
   * auto-focusing the new task would steal their view. */
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

  // Both setup paths below mark the dir for the whole run, so the folder
  // header can say the install is going. A retry is the same install, so it
  // gets the same badge; only the toasts differ.
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

  // The setup step (npm install/etc.) can fail without invalidating the task
  // itself — `task_create`'s warning already says so. Give it a one-click
  // retry rather than making the user remember to re-run it from a terminal.
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

  // `task_create` no longer runs the install step itself (see the Rust doc
  // comment on `task_create`) — the pane opens as soon as the worktree
  // exists, and this fires the setup afterward, in the background, into a
  // worktree the user may already be typing in. A failure surfaces through
  // the same retry-able toast `retrySetup` uses; success is silent, matching
  // what an inline `task_create` warning used to look like — nothing, unless
  // something actually went wrong.
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
    // Where the user's attention sits at submit time. `task_create` is async
    // (fetch + worktree add, up to 60s), so by the time the pane exists the
    // user may have moved on — this is the yardstick `taskCreated` uses to
    // decide whether auto-focusing the new task would steal their view.
    const focusAtSubmit = {
      sessionId: selectedRef.current,
      folderDir: activeFolderDirRef.current,
    };
    const taskId = input.taskId ?? (await createTaskForSubmit(input));
    const worktreeDir = input.worktree
      ? (input.dir ?? (await resolveWorktreeDir(repo.dir, input.branch)))
      : null;
    // A reopened task is closed (`outcome`/`archivedAt` set, frozen status):
    // clear that first, the same way any status move out of `done` does
    // (`Store::set_task_status`). The Agentboard's own live-agent sync then
    // settles it into backlog/doing once the fresh worktree exists.
    if (input.reopen && taskId !== undefined) {
      const reopened = await storeSetTaskStatus(taskId, "backlog");
      if (reopened.isErr()) toast.error(`Couldn't reopen that task — ${reopened.error.message}`);
    }
    // Bind the whole worktree up front — repo, branch, and the directory the
    // worktree is *going* to live in (`task_check_branch` derived it from the
    // branch). This is what puts the row on the rail: the rail's row list is
    // the set of task records with a binding, so writing the binding here
    // means the row is on screen before `git fetch` has started, not a poll
    // after `worktree add` finished. The repo half also keeps every task out
    // of the Board's "No repo" lane, including a "task only" submit that never
    // gets a branch or dir.
    //
    // Awaited, unlike the fire-and-forget bind this replaced: the row has to
    // exist before the create starts, or the phase the backend stamps has no
    // row to land on.
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
    // 60s, not the 12-minute budget this used to need — `task_create` no
    // longer waits on the install (which owned nearly all of that time), so
    // what's left is just a fetch (10s server-side cap) and a worktree add.
    const result = await invoke<TaskCreated>(
      "task_create",
      { root: repo.dir, branch: input.branch, base: input.base, dir: worktreeDir ?? "" },
      { schema: TaskCreatedSchema, timeoutMs: 60_000 },
    );
    if (result.isErr()) {
      // The row stays — it is the task's record, and the task still exists.
      // With nothing on disk and nothing running, it reads as `detached`,
      // where its own retry and delete actions live. That's the whole reason
      // the failure needs no bookkeeping of its own here.
      toast.error(`couldn't create the worktree: ${result.error.message}`);
      return;
    }
    const created = result.value;
    // Re-bind with what the create actually produced. Normally identical to
    // the predicted binding above; this is what corrects the rare case where
    // they differ (a branch normalized on the way through).
    if (taskId !== undefined) {
      void storeTaskSetWorktree(taskId, repo.dir, created.branch, {
        repo: ownerRepoFromOrigin(repo.originUrl),
        dir: created.dir,
      });
    }
    // Only fetch/worktree-add/secret-inherit warnings land here now — the
    // install step runs separately below, after the pane opens, and reports
    // through its own toast.
    for (const warning of created.warnings) {
      toast(warning);
    }
    runSetupInBackground(created.dir);

    // An image with no typed goal is still a valid ask — give the rail
    // something to show rather than an unlabeled session.
    const label =
      input.goal ||
      (imagePaths.length ? `attached ${imagePaths.length === 1 ? "image" : "images"}` : "");
    // The goal is launched exactly as it reads in the form. Prompt improvers
    // rewrite that field *before* submit (see `inline-new-task.tsx`), so there
    // is deliberately nothing to apply here — what you saw is what launches.
    // "Start Claude on the goal" unchecked → no prompt, which is already how
    // `taskCreated` says "don't type anything into the PTY".
    const prompt = input.launchClaude ? promptWithImages(input.goal, imagePaths) : "";
    await taskCreated(created, prompt, input.options, label, focusAtSubmit);
  }

  // A task the inline form just created: track it in the rail, mount its
  // first session in the background, and start Claude on the goal in that
  // session's PTY — without switching the user's current view over to it.
  // They can jump to it via the rail whenever they're ready.
  async function taskCreated(
    created: TaskCreated,
    prompt: string,
    options: ClaudeLaunchOptions,
    /** The goal as the user typed it — what the rail and the toast show, so
     * the image paths `promptWithImages` appended stay out of both. */
    label?: string,
    /** The user's selection/active folder when they submitted the form. Used
     * to auto-focus the new task's pane only if they haven't navigated away
     * during the async create. */
    focusAtSubmit?: { sessionId: string | null; folderDir: string | null },
  ) {
    toast(`created ${created.name}${created.branch ? ` on ${created.branch}` : ""}`);
    await invoke("ab_add_repo", { path: created.dir });
    // A freshly tracked folder already gets a default not-started session —
    // reuse it rather than adding a second one, which would open as a
    // surprise split pane beside the empty default.
    const fresh = await invoke<StatePayload>("ab_get_state", {});
    const folder = fresh.isOk()
      ? fresh.value.repos.flatMap((r) => r.folders).find((f) => f.dir === created.dir)
      : undefined;
    let rec = folder?.sessions[0] ?? null;
    if (!rec) {
      const added = await invoke<SessionData>("ab_add_session", { dir: created.dir, name: null });
      if (added.isErr()) return;
      rec = added.value;
    }
    mountSession(created.dir, rec.id);
    // Label the session before deciding whether to launch: the goal is why
    // this session exists either way, and a task created with "Start Claude"
    // unchecked would otherwise sit in the rail as an unnamed shell.
    if (label) void abSetSessionPurpose(rec.id, label);
    // An empty prompt is the one signal for "leave the PTY at a bare shell" —
    // both a goal-less submit and an unchecked "Start Claude on the goal"
    // arrive here the same way.
    if (prompt) {
      // `launchClaudeIn` waits for the PTY's first frame itself — a proxy for
      // "the shell is actually reading input", since a successful term_write
      // only proves the Rust-side conduit exists, not that zsh finished
      // sourcing its rc files. This path also focuses the pane on its own
      // (`withLiveSession` must render it to type into it), so the auto-focus
      // below is only for the bare-shell case.
      await launchClaudeIn(
        { folderDir: created.dir, sessionId: rec.id, sessionName: rec.name, restart: false },
        prompt,
        options,
        label,
      );
      return;
    }
    // Bare-shell task: `mountSession` placed the pane in the background so as
    // not to yank the user's view mid-create. Now that it exists, focus it —
    // but only if the user is still where they were at submit. If they moved
    // to another session/folder while the (async) create ran, landing them on
    // the new task would be exactly the focus-theft `mountSession` avoids, so
    // leave the pane parked and let the toast (`created …`) be the signal.
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
