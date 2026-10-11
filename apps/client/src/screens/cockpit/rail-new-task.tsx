import { Select } from "@cloudflare/kumo";
import { InlineNewTask, type NewTaskSubmit } from "@/components/inline-new-task";
import type { RepoData } from "@/lib/agentboard";

/** The repo a new task starts in: the selected row's, else the last used, else the first. */
export function defaultTaskRepo(
  repos: readonly RepoData[],
  selectedRepoKey: string | undefined,
  lastKey: string | null,
): RepoData | undefined {
  return (
    repos.find((r) => r.key === selectedRepoKey) ?? repos.find((r) => r.key === lastKey) ?? repos[0]
  );
}

/** The existing inline new-task form behind a repo picker, for the rail header's `+`. */
export function RailNewTask({
  repos,
  repoKey,
  onRepoChange,
  onCancel,
  onSubmit,
}: {
  repos: readonly RepoData[];
  repoKey: string;
  onRepoChange: (key: string) => void;
  onCancel: () => void;
  onSubmit: (repo: RepoData, input: NewTaskSubmit) => void;
}) {
  const repo = repos.find((r) => r.key === repoKey);
  if (!repo) return null;
  return (
    <div className="border-b border-kumo-hairline" data-testid="rail-new-task">
      <div className="px-2 pt-2">
        <Select
          aria-label="Repo for the new task"
          size="sm"
          className="w-full"
          value={repo.key}
          onValueChange={(v) => onRepoChange(String(v))}
          items={repos.map((r) => ({ value: r.key, label: r.name }))}
        />
      </div>
      <InlineNewTask
        key={repo.key}
        repo={{
          name: repo.name,
          dir: repo.folders[0].dir,
          key: repo.key,
          originUrl: repo.originUrl,
        }}
        onCancel={onCancel}
        onSubmit={(input) => onSubmit(repo, input)}
      />
    </div>
  );
}
