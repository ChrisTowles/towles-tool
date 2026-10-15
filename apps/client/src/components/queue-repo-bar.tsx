import { useEffect, useState } from "react";
import { PlusIcon, XIcon } from "@phosphor-icons/react";
import type { RepoData } from "@/lib/agentboard";
import { NotInTauri } from "@/lib/errors";
import { repoAccentStyles, repoChipStyle, repoIcon } from "@/lib/repo-identity";
import { applyRepoOrder, orderSettled, reorderDirs, sameOrder } from "@/lib/repo-manager";
import type { QueueItem } from "@/lib/schemas/queue";
import { invoke } from "@/lib/tauri";
import { toast } from "@/lib/toast";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";

/** One pill per repo, in the tree's and Settings' order: the name narrows the
 * queue to it (again shows all, Ctrl/Shift-click adds or drops one), the `+`
 * starts a task there, a drag reorders them. Neutral until picked — the repo's
 * color stays on its icon, so seven repos don't paint the rail. */
export function QueueRepoBar({
  repos,
  items,
  repoByFolder,
  picked,
  onFilterChange,
  activeKey,
  onPick,
}: {
  repos: readonly RepoData[];
  /** The whole queue, so a repo filtered out still shows its count. */
  items: readonly QueueItem[];
  repoByFolder: ReadonlyMap<string, RepoData>;
  picked: ReadonlySet<string>;
  onFilterChange: (picked: ReadonlySet<string>) => void;
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

  const counts = new Map<string, number>();
  for (const item of items) {
    const key = repoByFolder.get(item.folderDir)?.key;
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

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

  const filter = (key: string, many: boolean) => {
    let next: Set<string>;
    if (many) {
      next = new Set(picked);
      if (!next.delete(key)) next.add(key);
    } else {
      next = picked.size === 1 && picked.has(key) ? new Set() : new Set([key]);
    }
    uiAction("queue.filter", "agentboard", next.size === 0 ? "all" : many ? "many" : "one");
    onFilterChange(next);
  };

  return (
    <div
      role="group"
      aria-label="Repos"
      className="flex flex-wrap items-center gap-1 px-3 py-2"
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
        const on = picked.has(repo.key);
        const formOpen = repo.key === activeKey;
        const n = counts.get(repo.key);
        return (
          <div
            key={repo.key}
            draggable
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
            style={on ? repoChipStyle(repo) : undefined}
            className={cn(
              "flex items-center overflow-hidden rounded-md border text-xs active:cursor-grabbing",
              !on && "border-kumo-line",
              dragDir === repo.dir && "opacity-40",
              dropBefore === repo.dir && "ring-2 ring-violet-500",
            )}
          >
            <button
              type="button"
              aria-pressed={on}
              data-testid="queue-repo-filter"
              title={`Only ${repo.name} — Ctrl/Shift-click to add or drop, drag to reorder`}
              onClick={(e) => filter(repo.key, e.ctrlKey || e.metaKey || e.shiftKey)}
              className={cn(
                "flex cursor-pointer items-center gap-1 py-0.5 pr-1.5 pl-2 font-semibold",
                !on && (n ? "text-kumo-default hover:bg-kumo-tint" : "text-kumo-subtle"),
                !on && !n && "hover:bg-kumo-tint hover:text-kumo-default",
              )}
            >
              <Icon
                aria-hidden
                style={on ? undefined : repoAccentStyles(repo).iconStyle}
                className="size-3.5 shrink-0"
              />
              {repo.name}
              {n !== undefined && <span className="tabular-nums opacity-70">{n}</span>}
            </button>
            <button
              type="button"
              aria-pressed={formOpen}
              aria-label={`New task in ${repo.name}`}
              title={`New task in ${repo.name}`}
              data-testid="queue-repo-new"
              onClick={() => onPick(repo)}
              className={cn(
                "flex cursor-pointer items-center self-stretch border-l border-inherit px-1",
                formOpen
                  ? "bg-kumo-brand text-white"
                  : "text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default",
              )}
            >
              <PlusIcon aria-hidden className="size-3" weight="bold" />
            </button>
          </div>
        );
      })}
      {picked.size > 0 && (
        <button
          type="button"
          onClick={() => {
            uiAction("queue.filter", "agentboard", "all");
            onFilterChange(new Set());
          }}
          className="flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
        >
          <XIcon aria-hidden className="size-3" />
          All repos
        </button>
      )}
    </div>
  );
}
