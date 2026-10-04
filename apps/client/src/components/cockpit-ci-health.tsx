import { Activity } from "lucide-react";
import { Empty, Panel } from "@/components/store-bits";
import { ciRunTitle, ciTone, groupCiRunsByRepo, orderCiRuns } from "@/lib/cockpit-ci";
import { filterByRepo } from "@/lib/cockpit-filter";
import { type CiRun, fmtAge } from "@/lib/data";
import { openExternalUrl } from "@/lib/open-url";
import { PR_TONE } from "@/lib/pr-tone";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";

/** Each tracked repo's default-branch CI, one chip per workflow, red first — the
 * panel that says a nightly has been failing for a week. `repo` is the Cockpit's
 * active filter chip; `null` shows every repo. */
export function CockpitCiHealth({
  runs,
  repo,
  now,
  live,
}: {
  runs: CiRun[];
  repo: string | null;
  now: number;
  live: boolean;
}) {
  const visible = orderCiRuns(filterByRepo(runs, repo));
  const failing = visible.filter((run) => ciTone(run) === "failed").length;
  const note =
    visible.length === 0 ? undefined : failing === 0 ? "all green" : `${failing} failing`;
  return (
    <div className="lg:col-span-2">
      <Panel title="CI health" note={note} icon={<Activity className="size-4" />}>
        {visible.length === 0 ? (
          <Empty>
            {live ? "No default-branch workflow runs collected yet." : "Not connected yet."}
          </Empty>
        ) : (
          groupCiRunsByRepo(visible).map(([repoName, repoRuns]) => (
            <div key={repoName} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="w-44 shrink-0 truncate font-mono text-xs text-muted-foreground">
                {repoName}
              </span>
              {repoRuns.map((run) => (
                <CiChip key={run.workflow} run={run} now={now} />
              ))}
            </div>
          ))
        )}
      </Panel>
    </div>
  );
}

function CiChip({ run, now }: { run: CiRun; now: number }) {
  const tone = ciTone(run);
  return (
    <button
      type="button"
      title={ciRunTitle(run)}
      onClick={() => {
        uiAction("cockpit.open_ci_run", "cockpit", tone);
        void openExternalUrl(run.url);
      }}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs",
        PR_TONE[tone].chip,
      )}
    >
      <span className="font-medium">{run.workflow}</span>
      <span className="opacity-70">{fmtAge(run.updatedMs, now)}</span>
    </button>
  );
}
