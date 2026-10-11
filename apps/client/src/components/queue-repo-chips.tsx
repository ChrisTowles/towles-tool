import { useEffect, useState } from "react";
import type { RepoData } from "@/lib/agentboard";
import { NotInTauri } from "@/lib/errors";
import { repoChipStyle, repoIcon } from "@/lib/repo-identity";
import { applyRepoOrder, orderSettled, reorderDirs, sameOrder } from "@/lib/repo-manager";
import { invoke } from "@/lib/tauri";
import { toast } from "@/lib/toast";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";

/** One button per repo, in its color: a click starts a task there, a drag
 * reorders them — the same repo order the tree and Settings show. */
export function QueueRepoChips({
  repos,
  activeKey,
  onPick,
}: {
  repos: readonly RepoData[];
  /** The repo whose new-task form is open. */
  activeKey: string | null;
  onPick: (repo: RepoData) => void;
}) {
  // Optimistic until the snapshot carries the drag, the way Settings does it.
  const [order, setOrder] = useState<string[] | null>(null);
  const [dragDir, setDragDir] = useState<string | null>(null);
  const [dropBefore, setDropBefore] = useState<string | null>(null);
  const snapshotDirs = repos.map((r) => r.dir);
  const settled = orderSettled(order, snapshotDirs);
  useEffect(() => {
    if (settled) setOrder(null);
  }, [settled]);
  const ordered = applyRepoOrder(repos, order);

  const drop = (beforeDir: string | "end") => {
    const dragged = dragDir;
    setDragDir(null);
    setDropBefore(null);
    if (!dragged) return;
    const current = ordered.map((r) => r.dir);
    const next = reorderDirs(current, dragged, beforeDir);
    if (sameOrder(current, next)) return;
    setOrder(next);
    uiAction("repo.reordered", "agentboard", "queue");
    void invoke("ab_set_repo_order", { dirs: next }).then((res) => {
      if (res.isErr() && !NotInTauri.is(res.error)) {
        toast.error(`Couldn't save the repo order — ${res.error.message}`);
        setOrder(null);
      }
    });
  };

  return (
    <div
      role="group"
      aria-label="New task"
      className="flex flex-wrap gap-1.5 px-3 py-2"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        drop("end");
      }}
    >
      {ordered.length === 0 && (
        <p className="text-xs text-kumo-subtle">Track a repo to start tasks.</p>
      )}
      {ordered.map((repo) => {
        const Icon = repoIcon(repo.meta);
        const active = repo.key === activeKey;
        return (
          <button
            key={repo.key}
            type="button"
            draggable
            data-testid="queue-repo-chip"
            aria-pressed={active}
            title={`New task in ${repo.name} — drag to reorder`}
            onClick={() => onPick(repo)}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              // Firefox/WebKit refuse to start a drag with an empty payload.
              e.dataTransfer.setData("text/plain", repo.dir);
              setDragDir(repo.dir);
            }}
            onDragEnd={() => {
              setDragDir(null);
              setDropBefore(null);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              if (dragDir && dragDir !== repo.dir) setDropBefore(repo.dir);
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              drop(repo.dir);
            }}
            style={repoChipStyle(repo, active)}
            className={cn(
              "flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm font-semibold transition-colors active:cursor-grabbing",
              dragDir === repo.dir && "opacity-40",
              dropBefore === repo.dir && "ring-2 ring-violet-500",
            )}
          >
            <Icon aria-hidden className="size-3.5 shrink-0" />
            {repo.name}
          </button>
        );
      })}
    </div>
  );
}
