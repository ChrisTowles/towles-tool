import { useState } from "react";
import { pointBrowserPane } from "@/components/browser-pane";
import type { SessionActions } from "@/lib/agentboard/actions";
import type { RepoData, SessionData } from "@/lib/agentboard/types";
import type { TaskItem } from "@/lib/data";
import { errorMessage, NotInTauri } from "@/lib/errors";
import { openExternalUrl } from "@/lib/open-url";
import { ciLogUrl, landable, restartable } from "@/lib/queue";
import type { QueueItem } from "@/lib/schemas/queue";
import { invoke } from "@/lib/tauri";
import { toast } from "@/lib/toast";
import { uiAction } from "@/lib/ui-action";

/** The queue's per-row verbs, shared by the row buttons and the queue chords.
 * Each returns `false` when it doesn't apply, so a chord falls through. */
export type QueueRowActions = {
  landAll: () => boolean;
  openCiLog: (item: QueueItem) => boolean;
  restart: (item: QueueItem) => boolean;
  fork: (item: QueueItem) => boolean;
};

type LandResult = {
  folderDir: string;
  title: string;
  status: "landed" | "merged" | "skipped" | "failed";
  message: string | null;
};

/** How a batch landing went, in one toast line per outcome that needs reading. */
export function landSummary(results: readonly LandResult[]): { ok: string; problems: string[] } {
  const landed = results.filter((r) => r.status === "landed").length;
  const problems = results
    .filter((r) => r.status !== "landed")
    .map((r) => {
      const what = r.status === "merged" ? "merged, task left open" : r.status;
      return `${r.title}: ${what}${r.message ? ` — ${r.message}` : ""}`;
    });
  return { ok: `Landed ${landed} of ${results.length}`, problems };
}

export function useQueueActions(a: {
  shownQueueItems: readonly QueueItem[];
  sessionById: Map<string, SessionData>;
  tasks: readonly TaskItem[];
  repoByFolder: ReadonlyMap<string, RepoData>;
  /** Undefined while the browser pane is switched off. */
  openBrowser: ((dir: string) => void) | undefined;
  selectFolder: (dir: string) => void;
  actions: Pick<SessionActions, "restartClaude">;
  setStartClaudePrompt: (prompt: string) => void;
  openFork: (repoKey: string, base: string) => void;
}) {
  const [landRows, setLandRows] = useState<QueueItem[] | null>(null);
  const [landBusy, setLandBusy] = useState(false);

  const actions: QueueRowActions = {
    landAll: () => {
      const rows = a.shownQueueItems.filter(landable);
      if (rows.length === 0) {
        toast.info("No approved, green PRs to land.");
        return false;
      }
      setLandRows(rows);
      return true;
    },
    openCiLog: (item) => {
      const url = ciLogUrl(item);
      if (!url) return false;
      uiAction("queue.ci_log", "agentboard", a.openBrowser ? "pane" : "external");
      if (!a.openBrowser) {
        void openExternalUrl(url);
        return true;
      }
      a.selectFolder(item.folderDir);
      pointBrowserPane(item.folderDir, url);
      a.openBrowser(item.folderDir);
      return true;
    },
    restart: (item) => {
      const session = item.sessionId ? a.sessionById.get(item.sessionId) : undefined;
      if (!restartable(item) || !session) return false;
      uiAction("queue.restart", "agentboard");
      const task = a.tasks.find((t) => t.id === item.taskId);
      a.actions.restartClaude(item.folderDir, session);
      // The goal it was started on, for Enter to confirm or an edit to redirect.
      a.setStartClaudePrompt(task?.goal || session.purpose || task?.text || "");
      return true;
    },
    fork: (item) => {
      const repo = a.repoByFolder.get(item.folderDir);
      if (item.taskId == null || !repo || !item.branch) return false;
      uiAction("queue.fork", "agentboard");
      a.openFork(repo.key, item.branch);
      return true;
    },
  };

  async function confirmLand() {
    if (!landRows) return;
    setLandBusy(true);
    uiAction("queue.land_batch", "agentboard", String(landRows.length));
    const result = await invoke<LandResult[]>(
      "queue_land",
      { folderDirs: landRows.map((r) => r.folderDir) },
      // A merge plus a fetch and a worktree removal, per row.
      { timeoutMs: 120_000 * landRows.length },
    );
    setLandBusy(false);
    setLandRows(null);
    if (result.isErr()) {
      if (!NotInTauri.is(result.error)) toast.error(errorMessage(result.error));
      return;
    }
    const { ok, problems } = landSummary(result.value);
    if (problems.length === 0) toast.success(ok);
    else toast.error(`${ok}. ${problems.join("; ")}`);
  }

  return { actions, landRows, setLandRows, landBusy, confirmLand };
}
