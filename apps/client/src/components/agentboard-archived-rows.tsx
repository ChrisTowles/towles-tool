/** The rail's way back to archived repos: one fold row beneath the tree, and a
 * restore row per repo once it is open. An archived repo is off the rail, not
 * gone, so this list is the only thing that has to know it exists. */
import { useState } from "react";
import { ArchiveIcon, ArrowCounterClockwiseIcon } from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo";
import { Chevron } from "@/components/agentboard-bits/status-dots";
import { Hint } from "@/components/hint";
import type { RepoData } from "@/lib/agentboard/types";
import { plural } from "@/lib/format";
import { liveSessionIds, setRepoArchived } from "@/lib/repo-actions";
import { repoAccentStyles, repoIcon } from "@/lib/repo-identity";
import { uiAction } from "@/lib/ui-action";

export function ArchivedRepoRows({ repos }: { repos: RepoData[] }) {
  // View state, like the idle stub's peek: it belongs to one glance.
  const [open, setOpen] = useState(false);
  if (repos.length === 0) return null;
  return (
    <div className="flex flex-col border-t border-kumo-hairline">
      <Hint label={open ? "Hide archived repos" : "Show archived repos to restore one"}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            uiAction("agentboard.archived_list", "agentboard", open ? "close" : "open");
            setOpen(!open);
          }}
          className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left font-mono text-mini text-kumo-subtle hover:text-kumo-default"
        >
          <Chevron collapsed={!open} />
          <ArchiveIcon className="size-3.5" />
          {repos.length} archived
        </button>
      </Hint>
      {open && repos.map((repo) => <ArchivedRepoRow key={repo.key} repo={repo} />)}
    </div>
  );
}

function ArchivedRepoRow({ repo }: { repo: RepoData }) {
  const RepoIcon = repoIcon(repo.meta);
  const accent = repoAccentStyles(repo);
  const tasks = repo.folders.length - 1;
  const live = liveSessionIds(repo).length;
  return (
    <div className="flex items-center gap-2 py-1 pr-2 pl-6 text-kumo-subtle">
      <RepoIcon className="size-3.5 shrink-0 opacity-70" style={accent.iconStyle} />
      <span className="min-w-0 truncate text-sm">{repo.name}</span>
      <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-micro">
        {tasks > 0 && <span>{plural(tasks, "task")}</span>}
        {live > 0 && <span className="text-agent">{live} live</span>}
      </span>
      <Button
        size="xs"
        variant="outline"
        icon={<ArrowCounterClockwiseIcon className="size-3" />}
        onClick={() => void setRepoArchived(repo.dir, repo.name, false, "agentboard")}
      >
        Restore
      </Button>
    </div>
  );
}
