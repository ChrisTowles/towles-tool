import { useEffect, type Dispatch, type SetStateAction } from "react";
import { claudeResumeCommand } from "@/lib/agentboard/claude-command";
import { termWriteRetry } from "@/lib/agentboard/pty";
import {
  consumePendingAgentboardNav,
  consumePendingOpenSessions,
  onAgentboardNavRequest,
  onOpenSessionRequest,
  type AgentboardNav,
  type PendingOpenSession,
} from "@/lib/agentboard/requests";
import { toast } from "@/lib/toast";
import type { TaskCreation } from "./use-task-creation";
import type { useViewPanes } from "./use-view-panes";

type ViewPanes = ReturnType<typeof useViewPanes>;

/** Handoffs from outside the screen: Claude Sessions' "Open in Agentboard", and
 * the palette / MCP navigation requests. Both subscribe once at mount, so every
 * handler here is the first render's — the pending-request bridge in
 * `lib/agentboard/requests.ts` says why this can't be a plain function call. */
export function useBoardRequests(args: {
  selectSession: (folderDir: string, sessionId: string) => void;
  withLiveSession: (
    sessionId: string,
    fn: () => Promise<unknown>,
    folderDir?: string,
  ) => Promise<void>;
  setActiveFolderDir: Dispatch<SetStateAction<string | null>>;
  ackFolder: (folderDir: string) => void;
  taskCreation: TaskCreation;
  viewPanes: Pick<
    ViewPanes,
    "openClaudeSessionInEditor" | "openFileFromRequest" | "showPreviewFile"
  >;
  openNextUp: () => void;
}) {
  // Claude Sessions' "Open in Agentboard" handoff.
  useEffect(() => {
    let cancelled = false;
    let tail = Promise.resolve();

    const handle = (req: PendingOpenSession) => {
      tail = tail.then(async () => {
        if (cancelled) return;
        toast(`✦ resuming ${req.label} — claude --resume ${req.resumeId.slice(0, 8)}`);
        await args.withLiveSession(
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

  // Command-palette "jump to repo/session" handoff (`requestAgentboardNav`).
  useEffect(() => {
    const { selectSession, setActiveFolderDir, ackFolder, taskCreation, viewPanes } = args;
    const handle = (req: AgentboardNav) => {
      if (req.kind === "session") {
        selectSession(req.folderDir, req.sessionId);
      } else if (req.kind === "reopen-task") {
        setActiveFolderDir(req.repoDir);
        ackFolder(req.repoDir);
        taskCreation.openSeededForm(
          { name: req.repoName, dir: req.repoDir, key: req.repoKey, originUrl: req.originUrl },
          { taskId: req.taskId, goal: req.goal },
        );
      } else if (req.kind === "new-task-from-issue") {
        setActiveFolderDir(req.repoDir);
        ackFolder(req.repoDir);
        taskCreation.openSeededForm(
          { name: req.repoName, dir: req.repoDir, key: req.repoKey, originUrl: req.originUrl },
          { issue: req.issue },
        );
      } else if (req.kind === "start-task") {
        // The MCP `task_start` tool.
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
            // Unknown here — `createTask` derives it from the branch.
            dir: null,
            worktree: true,
            launchClaude: true,
            pr: null,
            templateSetup: "",
            taskId: req.taskId,
          },
        );
      } else if (req.kind === "open-claude-session") {
        void viewPanes.openClaudeSessionInEditor(req.folderDir, req.sessionId);
      } else if (req.kind === "open-file") {
        viewPanes.openFileFromRequest(req);
      } else if (req.kind === "show-file") {
        // The MCP `preview_file` tool — the agent has something to *show*.
        viewPanes.showPreviewFile(req);
      } else if (req.kind === "queue-next") {
        args.openNextUp();
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
}
