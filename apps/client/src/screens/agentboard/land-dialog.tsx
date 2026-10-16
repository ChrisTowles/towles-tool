import { Button, Dialog } from "@cloudflare/kumo";
import type { QueueItem } from "@/lib/schemas/queue";

/** Confirm a batch landing: every PR it would merge, by name, before anything merges. */
export function LandQueueDialog({
  rows,
  busy,
  onOpenChange,
  onConfirm,
}: {
  rows: readonly QueueItem[] | null;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const n = rows?.length ?? 0;
  return (
    <Dialog.Root open={rows != null} onOpenChange={onOpenChange}>
      <Dialog size="lg" className="p-6">
        <div className="mb-4 flex flex-col gap-1.5">
          <Dialog.Title className="text-lg font-semibold">
            Land {n} approved PR{n === 1 ? "" : "s"}?
          </Dialog.Title>
          <Dialog.Description className="text-sm text-kumo-subtle">
            Each merges the way its repo lands PRs — as an admin if branch protection alone blocks
            it — and its task closes as done. A checkout still holding work keeps its worktree.
          </Dialog.Description>
        </div>
        <ul className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto text-sm">
          {rows?.map((r) => (
            <li key={r.folderDir} className="flex items-baseline gap-2">
              <span className="shrink-0 font-mono text-xs text-kumo-subtle">
                {r.pr?.repo}#{r.pr?.number}
              </span>
              <span className="truncate">{r.title}</span>
            </li>
          ))}
        </ul>
        <div className="mt-6 flex justify-end gap-2">
          <Dialog.Close
            render={(props) => (
              <Button {...props} variant="secondary">
                Cancel
              </Button>
            )}
          />
          <Button variant="primary" loading={busy} onClick={onConfirm}>
            Merge &amp; close {n}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
