import { InlineNewTask, type NewTaskSubmit } from "@/components/inline-new-task";
import type { RepoData } from "@/lib/agentboard/types";

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

/** The existing inline new-task form, for one repo — picked by its queue chip or tree `+`. */
export function RailNewTask({
  repo,
  onCancel,
  onSubmit,
}: {
  repo: RepoData;
  onCancel: () => void;
  onSubmit: (repo: RepoData, input: NewTaskSubmit) => void;
}) {
  return (
    <div className="border-b border-kumo-hairline" data-testid="rail-new-task">
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
