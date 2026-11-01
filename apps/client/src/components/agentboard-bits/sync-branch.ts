import { Result } from "effect";
import { toast } from "@/lib/toast";
import { folderTask } from "@/lib/agentboard/folder";
import type { FolderData } from "@/lib/agentboard/types";
import { taskSyncBranch } from "@/lib/data";
import { NotInTauri } from "@/lib/errors";
import { uiAction } from "@/lib/ui-action";

/** Records the checkout's live branch on its task. Undefined without a task;
 * `BranchDriftBadge` itself decides whether it shows (`folderBranchDrift`). */
export function syncBranch(folder: FolderData) {
  const task = folderTask(folder);
  if (!task) return undefined;
  return () => {
    uiAction("agentboard.sync_branch", "agentboard");
    void taskSyncBranch(task.id).then((result) => {
      if (Result.isSuccess(result)) {
        const { previous, current } = result.success;
        toast.success(`Recorded ${current} on the task${previous ? ` (was ${previous})` : ""}`);
      } else if (!NotInTauri.is(result.failure)) {
        toast.error(result.failure.message);
      }
    });
  };
}
