import { FunnelSimpleIcon } from "@phosphor-icons/react";
import type { RepoData } from "@/lib/agentboard";
import { repoChipStyle } from "@/lib/repo-identity";
import type { QueueItem } from "@/lib/schemas/queue";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";

const PILL = "flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold";

/** Narrow the queue to some repos: a click shows just that one (again shows
 * all), Ctrl/Shift-click adds or drops one. Offered once two repos have tasks. */
export function QueueRepoFilter({
  repos,
  items,
  repoByFolder,
  picked,
  onChange,
}: {
  /** In the board's repo order. */
  repos: readonly RepoData[];
  /** The whole queue, so a repo filtered out still offers its pill. */
  items: readonly QueueItem[];
  repoByFolder: ReadonlyMap<string, RepoData>;
  picked: ReadonlySet<string>;
  onChange: (picked: ReadonlySet<string>) => void;
}) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = repoByFolder.get(item.folderDir)?.key;
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const offered = repos.filter((r) => counts.has(r.key));
  if (offered.length < 2 && picked.size === 0) return null;

  const pick = (key: string, many: boolean) => {
    let next: Set<string>;
    if (many) {
      next = new Set(picked);
      if (!next.delete(key)) next.add(key);
    } else {
      next = picked.size === 1 && picked.has(key) ? new Set() : new Set([key]);
    }
    uiAction("queue.filter", "agentboard", next.size === 0 ? "all" : many ? "many" : "one");
    onChange(next);
  };

  return (
    <div
      role="group"
      aria-label="Filter the queue by repo"
      className="flex flex-wrap items-center gap-1 border-t border-kumo-hairline px-3 py-1.5"
    >
      <FunnelSimpleIcon aria-hidden className="mr-0.5 size-3.5 text-kumo-subtle" />
      <button
        type="button"
        aria-pressed={picked.size === 0}
        onClick={() => {
          if (picked.size === 0) return;
          uiAction("queue.filter", "agentboard", "all");
          onChange(new Set());
        }}
        className={cn(
          PILL,
          picked.size === 0
            ? "border-kumo-line bg-kumo-tint text-kumo-default"
            : "border-transparent text-kumo-subtle hover:text-kumo-default",
        )}
      >
        All
      </button>
      {offered.map((repo) => {
        const on = picked.has(repo.key);
        return (
          <button
            key={repo.key}
            type="button"
            aria-pressed={on}
            data-testid="queue-repo-filter"
            title={`Only ${repo.name} — Ctrl/Shift-click to add or drop`}
            onClick={(e) => pick(repo.key, e.ctrlKey || e.metaKey || e.shiftKey)}
            style={repoChipStyle(repo, on)}
            className={PILL}
          >
            {repo.name}
            <span className="tabular-nums opacity-70">{counts.get(repo.key)}</span>
          </button>
        );
      })}
    </div>
  );
}
