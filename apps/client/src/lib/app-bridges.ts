// Backend pushes that must be heard from launch, whatever screen is open:
// Agentboard mounts on first visit, so a listener there would miss them. Each
// is an app feed, started once by `startAppEffects` and stopped with the app.
import { Effect } from "effect";
import { feed } from "@/lib/atoms/feed";
import { read } from "@/lib/atoms/registry";
import { reposAtom } from "@/lib/agentboard/state";
import { subscribeAutoArchived } from "@/lib/auto-archive";
import { subscribeAutoClosed } from "@/lib/auto-close";
import { subscribeEditorOpenFile } from "@/lib/editor-open";
import { subscribePreviewShow } from "@/lib/preview-artifact";
import { repeatDetail, repeatTitle, watchRepeatedErrors } from "@/lib/repeated-errors";
import { subscribeSummon } from "@/lib/summon";
import { subscribeTaskStart } from "@/lib/task-start";
import { toast } from "@/lib/toast";
import { uiAction } from "@/lib/ui-action";
import { activeTabAtom, openTab } from "@/lib/workspace";

/** Hold a `subscribe…` until the feed stops. */
const hold = (start: () => () => void) =>
  Effect.acquireRelease(Effect.sync(start), (stop) => Effect.sync(stop));

// Repos are read at delivery time: a push can land before the first snapshot.
const reposNow = () => read(reposAtom);
const toAgentboard = () => openTab("agentboard");

feed("app-bridges", () =>
  Effect.all([
    hold(() =>
      subscribeTaskStart(
        reposNow,
        (payload) =>
          toast.error(
            `Couldn't start task ${payload.taskId} — ${payload.repoRoot} isn't tracked on Agentboard`,
          ),
        toAgentboard,
      ),
    ),
    hold(() =>
      watchRepeatedErrors((e) =>
        toast.error(repeatTitle(e), {
          description: repeatDetail(e),
          actions: [
            {
              label: "Open Doctor",
              onClick: () => {
                uiAction("repeated_error.open_doctor", read(activeTabAtom));
                openTab("doctor");
              },
            },
          ],
        }),
      ),
    ),
    hold(() => subscribePreviewShow(reposNow, toAgentboard)),
    hold(() => subscribeSummon(reposNow, toAgentboard)),
    hold(() => subscribeEditorOpenFile(reposNow, toAgentboard)),
    hold(subscribeAutoClosed),
    hold(subscribeAutoArchived),
  ]),
);
