import { useEffect, useState } from "react";
import {
  ArrowSquareOutIcon,
  CircleNotchIcon,
  GitPullRequestIcon,
  LinkBreakIcon,
  MagnifyingGlassIcon,
  RecordIcon,
} from "@phosphor-icons/react";
import { Dialog, DropdownMenu, Input } from "@cloudflare/kumo";
import { Hint } from "@/components/hint";
import { toast } from "@/lib/toast";
import { comparedBaseLabel } from "@/lib/agentboard/folder";
import { folderLandedButHasWork } from "@/lib/agentboard/landing";
import type { FolderData } from "@/lib/agentboard/types";
import {
  storeAttachTaskIssue,
  storeDetachTaskIssue,
  storeSearchIssues,
  type IssueItem,
  type PrItem,
  type TaskIssueLink,
} from "@/lib/data";
import { openExternalUrl } from "@/lib/open-url";
import { PR_TONE, prTone } from "@/lib/pr-tone";
import { cn } from "@/lib/utils";
import { unsafeToDeleteReason } from "./landed-badges";

/** Merged says the *PR's* content is safe and nothing about this checkout, so
 * local uncommitted or unlanded work overrides the purple with amber. */
export function PrChip({
  pr,
  stats,
}: {
  pr: PrItem;
  stats: Pick<FolderData, "dirty" | "commitsUnlanded" | "landed" | "comparedBase">;
}) {
  const merged = pr.state === "merged";
  const hasLocalWork = folderLandedButHasWork(stats, pr);
  const base = comparedBaseLabel(stats);
  const tone = hasLocalWork
    ? "border-warn/50 bg-warn/10 text-warn hover:bg-warn/20"
    : PR_TONE[prTone(pr)].chip;
  // Checks are what an *open* PR is judged on; a settled one is judged on how it
  // settled, and a closed PR's last red run is history rather than a task.
  const standing = merged
    ? "merged"
    : pr.state === "closed"
      ? "closed without merging"
      : `checks ${pr.checks}${pr.reviewState === "review_requested" ? ", review requested" : ""}`;
  return (
    <Hint
      label={
        hasLocalWork
          ? `${pr.title} — ${merged ? "merged" : stats.landed}, but this checkout still has ${unsafeToDeleteReason(stats, base)}. Commit or push before removing the task. Open on GitHub.`
          : `${pr.title} — ${standing}. Open on GitHub.`
      }
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void openExternalUrl(pr.url);
        }}
        className={cn(
          "flex h-5 shrink-0 items-center gap-1 rounded-md border px-1.5 font-mono text-mini transition-colors",
          tone,
        )}
      >
        <GitPullRequestIcon className="size-3" />#{pr.number}
        {hasLocalWork && <span aria-hidden>⚑</span>}
      </button>
    </Hint>
  );
}

/** An issue has no branch, so unlike a PR it never auto-attaches — this only
 * appears for one put there by "Attach issue…". */
export function IssueChip({ taskId, issue }: { taskId: number; issue: TaskIssueLink }) {
  const closed = issue.state === "closed";
  const tone = closed
    ? "border-merged/50 bg-merged/10 text-merged hover:bg-merged/20"
    : "border-kumo-hairline text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default";

  async function detach() {
    const result = await storeDetachTaskIssue(taskId, issue.repo, issue.number);
    if (result.isErr()) toast.error(`Couldn't detach — ${result.error.message}`);
    else toast.success(`Detached #${issue.number}`);
  }

  return (
    <DropdownMenu>
      <Hint
        label={`${issue.repo}#${issue.number} — ${closed ? "closed" : "open"}, linked to this task`}
      >
        <DropdownMenu.Trigger
          render={
            <button
              type="button"
              onClick={(e) => e.stopPropagation()}
              className={cn(
                "flex h-5 shrink-0 items-center gap-1 rounded-md border px-1.5 font-mono text-mini transition-colors",
                tone,
              )}
            >
              <RecordIcon className="size-3" />#{issue.number}
            </button>
          }
        />
      </Hint>
      <DropdownMenu.Content align="start" className="w-auto min-w-44">
        <DropdownMenu.Item
          onClick={() => void openExternalUrl(issue.url)}
          className="whitespace-nowrap"
          icon={<ArrowSquareOutIcon className="size-3.5" />}
        >
          Open on GitHub
        </DropdownMenu.Item>
        <DropdownMenu.Item
          variant="danger"
          onClick={() => void detach()}
          className="whitespace-nowrap"
          icon={<LinkBreakIcon className="size-3.5" />}
        >
          Detach issue
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

/** The dialog behind `RepoMenu`'s "Attach issue…". */
export function AttachIssueDialog({
  open,
  onOpenChange,
  dir,
  taskId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dir: string;
  taskId: number;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<IssueItem[]>([]);
  const [searching, setSearching] = useState(false);

  // Debounced so typing doesn't fire a `gh` call per keystroke.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const handle = setTimeout(() => {
      void storeSearchIssues(dir, q).then((r) => {
        setResults(r.unwrapOr([]));
        setSearching(false);
      });
    }, 300);
    return () => clearTimeout(handle);
  }, [query, dir]);

  async function attach(issue: IssueItem) {
    onOpenChange(false);
    const result = await storeAttachTaskIssue(taskId, issue.repo, issue.number, issue.url);
    result.match({
      ok: () => toast.success(`Attached #${issue.number}`),
      err: (e) => toast.error(`Couldn't attach — ${e.message}`),
    });
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="lg" className="flex flex-col gap-4 p-6">
        <Dialog.Title className="text-lg font-semibold">Attach issue</Dialog.Title>
        <div className="flex items-center gap-2">
          <MagnifyingGlassIcon className="size-4 shrink-0 text-kumo-subtle" />
          <Input
            aria-label="Search issues"
            autoFocus
            className="flex-1"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search issues by title, number, or text…"
          />
        </div>
        <div className="max-h-80 min-h-10 overflow-auto">
          {searching ? (
            <p className="p-2 text-xs text-kumo-subtle">
              <CircleNotchIcon className="mr-1 inline size-3 animate-spin" /> searching…
            </p>
          ) : results.length === 0 ? (
            <p className="p-2 text-xs text-kumo-subtle">
              {query.trim() ? "No matching issues." : "Type to search this repo's issues."}
            </p>
          ) : (
            <div className="flex flex-col">
              {results.map((issue) => (
                <button
                  key={`${issue.repo}#${issue.number}`}
                  type="button"
                  onClick={() => void attach(issue)}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-kumo-tint"
                >
                  <RecordIcon
                    className={cn(
                      "size-3.5 shrink-0",
                      issue.state === "closed" ? "text-merged" : "text-ok",
                    )}
                  />
                  <span className="shrink-0 font-mono text-mini text-kumo-subtle">
                    #{issue.number}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{issue.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
