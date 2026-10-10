import { Badge, Button } from "@cloudflare/kumo";
import { PlayIcon, QueueIcon } from "@phosphor-icons/react";
import { Empty, Panel } from "@/components/store-bits";
import { requestAgentboardNav } from "@/lib/agentboard";
import { shortcutHint } from "@/lib/shortcuts";
import type { QueueItem, QueueReason } from "@/lib/cockpit-queue";
import { fmtAge } from "@/lib/data";
import { uiAction } from "@/lib/ui-action";
import { useWorkspace } from "@/lib/workspace";

const REASON_FACE: Record<
  QueueReason,
  { label: string; variant: "red" | "orange" | "blue" | "neutral" }
> = {
  errored: { label: "errored", variant: "red" },
  waitingForInput: { label: "needs input", variant: "orange" },
  finished: { label: "finished", variant: "blue" },
  cleanup: { label: "clean up", variant: "neutral" },
};

/** The loop's home: Start opens the head of the queue in Agentboard, and
 * `ab-jump-next` there walks the rest in this same order. */
export function CockpitWorkQueue({
  queue,
  now,
  live,
}: {
  queue: QueueItem[];
  now: number;
  live: boolean;
}) {
  const { openTab } = useWorkspace();
  const head = queue.find((item) => item.sessionId) ?? queue[0];

  function open(item: QueueItem, via: "start" | "row") {
    uiAction("cockpit.queue_open", "cockpit", `${via}:${item.reason}`);
    requestAgentboardNav(
      item.sessionId
        ? { kind: "session", folderDir: item.folderDir, sessionId: item.sessionId }
        : { kind: "folder", folderDir: item.folderDir },
    );
    openTab("agentboard");
  }

  return (
    <div className="lg:col-span-2">
      <Panel
        title="Work queue"
        note={
          queue.length === 0
            ? undefined
            : `${queue.length} waiting · ${shortcutHint("ab-jump-next")} for next`
        }
        icon={<QueueIcon size={16} />}
        action={
          head ? (
            <Button
              size="sm"
              variant="primary"
              icon={<PlayIcon weight="fill" />}
              onClick={() => open(head, "start")}
            >
              Start
            </Button>
          ) : null
        }
      >
        {queue.length === 0 ? (
          <Empty>
            {live ? "Nothing waiting on you — every agent is working." : "Not connected yet."}
          </Empty>
        ) : (
          queue.map((item) => <QueueRow key={item.id} item={item} now={now} onOpen={open} />)
        )}
      </Panel>
    </div>
  );
}

function QueueRow({
  item,
  now,
  onOpen,
}: {
  item: QueueItem;
  now: number;
  onOpen: (item: QueueItem, via: "row") => void;
}) {
  const face = REASON_FACE[item.reason];
  return (
    <button
      type="button"
      onClick={() => onOpen(item, "row")}
      className="group flex items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-kumo-tint"
    >
      <Badge variant={face.variant} className="w-24 shrink-0 justify-center">
        {face.label}
      </Badge>
      <div className="min-w-0 flex-1">
        <div className="truncate">{item.title}</div>
        <div className="truncate font-mono text-xs text-kumo-subtle">
          {item.repo} · {item.folderName} · {item.branch}
        </div>
      </div>
      {item.sinceMs !== undefined && (
        <span className="shrink-0 font-mono text-xs tabular-nums text-kumo-subtle">
          {fmtAge(item.sinceMs, now)}
        </span>
      )}
    </button>
  );
}
