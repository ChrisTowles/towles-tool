import { Button, DropdownMenu } from "@cloudflare/kumo";
import {
  ArrowSquareOutIcon,
  DotsThreeIcon,
  EyeSlashIcon,
  GitForkIcon,
  PaperPlaneTiltIcon,
} from "@phosphor-icons/react";
import { IssueRow } from "@/components/store-bits";
import type { RepoData } from "@/lib/agentboard";
import { type IssueItem, storeItemDismiss } from "@/lib/data";
import { NotInTauri } from "@/lib/errors";
import { openExternalUrl } from "@/lib/open-url";
import { invoke } from "@/lib/tauri";
import { toast } from "@/lib/toast";
import { uiAction } from "@/lib/ui-action";

/** A tracked checkout an issue can be dispatched into. */
type TaskTarget = { dir: string; branch: string; name: string };

/** Folds the ssh/https/scp forms enough to compare the trailing `owner/name`.
 * Only filters the menu — the Rust guard (`validate_task_for_repo`) re-checks
 * authoritatively before any dispatch. */
function repoMatches(originUrl: string | null | undefined, repo: string): boolean {
  if (!originUrl) return false;
  const norm = originUrl
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(/:/g, "/");
  return norm.endsWith(`/${repo.toLowerCase()}`);
}

/** The rail's issue drawer: issues assigned to you, newest first. Not queue rows —
 * an issue is work you could pick up, not something waiting on you. */
export function CockpitIssues({
  issues,
  repos,
  now,
}: {
  issues: IssueItem[];
  repos: RepoData[];
  now: number;
}) {
  const tasksFor = (repo: string): TaskTarget[] =>
    repos
      .filter((r) => repoMatches(r.originUrl, repo))
      .flatMap((r) => r.folders.map((f) => ({ dir: f.dir, branch: f.branch, name: f.name })));
  if (issues.length === 0) {
    return <p className="px-3 py-3 text-xs text-kumo-subtle">No issues assigned to you.</p>;
  }
  return (
    <>
      {issues
        .toSorted((a, b) => b.updatedTs - a.updatedTs)
        .map((issue) => (
          <IssueRow
            key={`${issue.repo}#${issue.number}`}
            issue={issue}
            now={now}
            actions={<IssueActions issue={issue} tasks={tasksFor(issue.repo)} />}
          />
        ))}
    </>
  );
}

/** Run an issue-dispatch command; the Rust side's message is authoritative. */
async function runIssueCommand(cmd: string, args: Record<string, unknown>) {
  uiAction("cockpit.issue_dispatch", "cockpit", cmd);
  (await invoke<string>(cmd, args)).match({
    ok: (msg) => toast.success(msg),
    err: (e) => toast.error(e.message),
  });
}

/** The snapshot re-emits from Rust, so nothing optimistic. */
async function dismissIssue(issue: IssueItem) {
  uiAction("cockpit.item_dismiss", "cockpit", "issue");
  const result = await storeItemDismiss("issue", issue.repo, issue.number, issue.updatedTs);
  if (result.isErr() && !NotInTauri.is(result.error)) toast.error(result.error.message);
}

/** Open in the browser, or dispatch into a tracked task checkout. The Rust
 * command re-runs the clean-tree guard and toasts. */
function IssueActions({ issue, tasks }: { issue: IssueItem; tasks: TaskTarget[] }) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button
            size="sm"
            shape="square"
            variant="ghost"
            className="shrink-0 opacity-0 group-hover:opacity-100 data-[popup-open]:opacity-100"
            aria-label="Issue actions"
            icon={<DotsThreeIcon size={16} weight="bold" />}
          />
        }
      />
      <DropdownMenu.Content align="end" className="w-52">
        <DropdownMenu.Item
          onClick={() => {
            uiAction("cockpit.open_external", "cockpit", "issue");
            void openExternalUrl(issue.url);
          }}
          icon={ArrowSquareOutIcon}
        >
          Open in browser
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <TaskSubmenu
          icon={PaperPlaneTiltIcon}
          label="Assign to task"
          tasks={tasks}
          onPick={(task) =>
            void runIssueCommand("cockpit_assign_issue", {
              repo: issue.repo,
              number: issue.number,
              taskDir: task.dir,
            })
          }
        />
        <TaskSubmenu
          icon={GitForkIcon}
          label="Create branch"
          tasks={tasks}
          onPick={(task) =>
            void runIssueCommand("cockpit_create_issue_branch", {
              repo: issue.repo,
              number: issue.number,
              title: issue.title,
              taskDir: task.dir,
            })
          }
        />
        <DropdownMenu.Separator />
        <DropdownMenu.Item onClick={() => void dismissIssue(issue)} icon={EyeSlashIcon}>
          Dismiss
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

/** Candidate task checkouts, or a disabled hint when the repo isn't tracked. */
function TaskSubmenu({
  icon,
  label,
  tasks,
  onPick,
}: {
  icon: React.ComponentProps<typeof DropdownMenu.SubTrigger>["icon"];
  label: string;
  tasks: TaskTarget[];
  onPick: (task: TaskTarget) => void;
}) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger icon={icon}>{label}</DropdownMenu.SubTrigger>
      <DropdownMenu.SubContent className="w-64">
        {tasks.length === 0 ? (
          <DropdownMenu.Item disabled>No matching task checkout</DropdownMenu.Item>
        ) : (
          tasks.map((task) => (
            <DropdownMenu.Item key={task.dir} onClick={() => onPick(task)}>
              <div className="flex min-w-0 flex-col">
                <span className="truncate">{task.name}</span>
                <span className="truncate font-mono text-xs text-kumo-subtle">{task.branch}</span>
              </div>
            </DropdownMenu.Item>
          ))
        )}
      </DropdownMenu.SubContent>
    </DropdownMenu.Sub>
  );
}
