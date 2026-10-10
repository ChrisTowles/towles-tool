import { Badge } from "@cloudflare/kumo";
import { PulseIcon } from "@phosphor-icons/react";
import { Empty, Panel } from "@/components/store-bits";
import { ciEmptyCopy, ciRunTitle, ciTone, groupCiRunsByRepo, orderCiRuns } from "@/lib/cockpit-ci";
import { filterByRepo } from "@/lib/cockpit-filter";
import { type CiRun, fmtAge } from "@/lib/data";
import { openExternalUrl } from "@/lib/open-url";
import { type PrTone } from "@/lib/pr-tone";
import { uiAction } from "@/lib/ui-action";

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
      <Panel title="CI health" note={note} icon={<PulseIcon size={16} />}>
        {visible.length === 0 ? (
          <Empty>{ciEmptyCopy(live, runs.length, repo)}</Empty>
        ) : (
          groupCiRunsByRepo(visible).map(([repoName, repoRuns]) => (
            <div key={repoName} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="w-44 shrink-0 truncate font-mono text-xs text-kumo-subtle">
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

const CI_BADGE: Record<PrTone, "green" | "red" | "teal" | "neutral" | "purple" | "orange"> = {
  passing: "green",
  failed: "red",
  running: "teal",
  plain: "neutral",
  merged: "purple",
  review: "orange",
};

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
      className="rounded-full transition-opacity hover:opacity-80"
    >
      <Badge variant={CI_BADGE[tone]}>
        <span className="font-medium">{run.workflow}</span>
        <span className="ml-1.5 opacity-70">{fmtAge(run.updatedMs, now)}</span>
      </Badge>
    </button>
  );
}
