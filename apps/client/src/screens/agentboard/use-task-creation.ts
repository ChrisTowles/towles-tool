import { useState } from "react";
import { toast } from "sonner";
import type {
  NewTaskRepo,
  NewTaskSubmit,
  PendingTask,
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
  /** `task_create` calls fired from an inline form and still running (or
   * failed) — rendered as a PendingTaskRow until they resolve. */
  pendingTasks: PendingTask[];
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
  retryPendingTask: (id: string) => void;
  dismissPendingTask: (id: string) => void;
};

/**
 * Creating a task from an inline rail form, end to end: board card → worktree
 * → session → Claude on the goal.
 *
 * The board task (#339) is the unit of work and is created *first*, before any
 * worktree exists — the worktree is an attribute of the task, not the other way
 * around, and binding the repo at submit time is what keeps every task out of
 * the Board's "No repo" lane. The `task_create` call itself runs in the
 * background, tracked as a PendingTaskRow rather than a blocking modal, so the
 * user can keep working anywhere else while the worktree resolves.
 */
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
  const [pendingTasks, setPendingTasks] = useState<PendingTask[]>([]);

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

  // The setup step (npm install/etc.) can fail without invalidating the task
  // itself — `task_create`'s warning already says so. Give it a one-click
  // retry rather than making the user remember to re-run it from a terminal.
  async function retrySetup(dir: string) {
    (await invoke<string | null>("task_run_setup", { dir })).match({
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
    void invoke<string | null>("task_run_setup", { dir }).then((result) => {
      result.match({
        ok: (warning) => {
          if (warning) toast(warning, { action: retryAction(dir) });
        },
        err: (e) => toast(e.message),
      });
    });
  }

  // Keyed by branch (unique per repo, since a collision is already rejected
  // before submit), so a retry just re-runs this under the same id.
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
    // A reopened task is closed (`outcome`/`archivedAt` set, frozen status):
    // clear that first, the same way any status move out of `done` does
    // (`Store::set_task_status`). The Agentboard's own live-agent sync then
    // settles it into backlog/doing once the fresh worktree exists.
    if (input.reopen && taskId !== undefined) {
      const reopened = await storeSetTaskStatus(taskId, "backlog");
      if (reopened.isErr()) toast.error(`Couldn't reopen that task — ${reopened.error.message}`);
    }
    // Bind the repo before any worktree exists. The Board groups tasks into
    // repo swimlanes, and the repo is known here — at the `+` the user clicked
    // — so binding it now is what keeps every task out of the "No repo" lane,
    // including a "task only" submit that never gets a branch or dir.
    if (taskId !== undefined) {
      void storeTaskSetWorktree(taskId, repo.dir, undefined, {
        repo: ownerRepoFromOrigin(repo.originUrl),
      });
    }
    if (!input.worktree) {
      toast("task added to the board");
      return;
    }
    const id = `${repo.key}::${input.branch}`;
    setPendingTasks((prev) => [
      ...prev.filter((p) => p.id !== id),
      {
        id,
        repoKey: repo.key,
        repoDir: repo.dir,
        repoName: repo.name,
        goal: input.goal,
        branch: input.branch,
        base: input.base,
        options: input.options,
        imagePaths: input.imagePaths,
        taskId,
        launchClaude: input.launchClaude,
        repoOriginUrl: repo.originUrl,
        startedAt: Date.now(),
        status: "creating",
      },
    ]);
    const imagePaths = input.imagePaths;
    // 60s, not the 12-minute budget this used to need — `task_create` no
    // longer waits on the install (which owned nearly all of that time), so
    // what's left is just a fetch (10s server-side cap) and a worktree add.
    const result = await invoke<TaskCreated>(
      "task_create",
      { root: repo.dir, branch: input.branch, base: input.base },
      { schema: TaskCreatedSchema, timeoutMs: 60_000 },
    );
    if (result.isErr()) {
      const error = result.error.message;
      setPendingTasks((prev) =>
        prev.map((p) => (p.id === id ? { ...p, status: "error" as const, error } : p)),
      );
      return;
    }
    const created = result.value;
    // Bind the task to its worktree (branch + dir + repo identity for PR
    // auto-attach). Fire-and-forget: the snapshot re-emit repaints the card.
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
    setPendingTasks((prev) => prev.filter((p) => p.id !== id));
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

  function retryPendingTask(id: string) {
    const p = pendingTasks.find((x) => x.id === id);
    if (!p) return;
    void createTask(
      { name: p.repoName, dir: p.repoDir, key: p.repoKey, originUrl: p.repoOriginUrl },
      {
        goal: p.goal,
        // Unused by this call — `taskId` below is set, so `createTask` skips
        // `createTaskForSubmit` entirely and never reads `title` on a retry.
        title: p.goal || p.branch,
        branch: p.branch,
        base: p.base,
        options: p.options,
        imagePaths: p.imagePaths,
        // The task already exists — a retry must rebind it, not mint a
        // duplicate card. (Issues are already attached to it, too.)
        issues: [],
        worktree: true,
        launchClaude: p.launchClaude,
        taskId: p.taskId,
      },
    );
  }

  function dismissPendingTask(id: string) {
    setPendingTasks((prev) => prev.filter((p) => p.id !== id));
  }

  return {
    openTaskForms,
    reopenTasks,
    pendingTasks,
    toggleTaskForm,
    closeTaskForm,
    openReopenForm,
    createTask,
    retryPendingTask,
    dismissPendingTask,
  };
}
