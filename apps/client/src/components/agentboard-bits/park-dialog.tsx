import { useState, type ReactNode } from "react";
import { Button, Dialog, Input } from "@cloudflare/kumo";
import {
  PARK_KINDS,
  PARK_LABEL,
  revisitAt,
  savePark,
  type RevisitPreset,
} from "@/lib/agentboard/park";
import type { ParkKind } from "@/lib/schemas/queue";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";

const KIND_WORD: Record<ParkKind, string> = {
  later: "Later",
  blocked: "Blocked",
  parked: "Parked",
};

const REVISIT: { value: RevisitPreset; label: string }[] = [
  { value: "none", label: "No date" },
  { value: "tomorrow", label: "Tomorrow" },
  { value: "week", label: "In a week" },
  { value: "date", label: "On…" },
];

/** "Park…": the kind, an optional revisit date and an optional note. Mounted
 * per open, so each open starts from the defaults. */
export function ParkDialog({
  open,
  onOpenChange,
  taskId,
  title,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: number;
  title: string;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="base" className="flex flex-col gap-4 p-6">
        {open && <ParkForm taskId={taskId} title={title} onDone={() => onOpenChange(false)} />}
      </Dialog>
    </Dialog.Root>
  );
}

function ParkForm({
  taskId,
  title,
  onDone,
}: {
  taskId: number;
  title: string;
  onDone: () => void;
}) {
  const [kind, setKind] = useState<ParkKind>("later");
  const [revisit, setRevisit] = useState<RevisitPreset>("none");
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const untilMs = revisitAt(revisit, Date.now(), date);
  const dateMissing = revisit === "date" && untilMs === null;

  async function submit() {
    if (dateMissing) return;
    uiAction("task.park_dialog", "agentboard", kind);
    if (await savePark(taskId, kind, { note, untilMs })) onDone();
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-col gap-1">
        <Dialog.Title className="text-lg font-semibold">Park task</Dialog.Title>
        <p className="truncate text-sm text-kumo-subtle">{title}</p>
      </div>
      <Choice label="Why">
        {PARK_KINDS.map((k) => (
          <Pill key={k} on={kind === k} hint={PARK_LABEL[k].hint} onClick={() => setKind(k)}>
            {KIND_WORD[k]}
          </Pill>
        ))}
      </Choice>
      <p className="-mt-2 text-xs text-kumo-subtle">{PARK_LABEL[kind].hint}</p>
      <Choice label="Revisit">
        {REVISIT.map((r) => (
          <Pill key={r.value} on={revisit === r.value} onClick={() => setRevisit(r.value)}>
            {r.label}
          </Pill>
        ))}
      </Choice>
      {revisit === "date" && (
        <Input
          type="date"
          aria-label="Revisit date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      )}
      <Input
        aria-label="Note"
        placeholder="Note for when you come back (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={dateMissing}>
          Park
        </Button>
      </div>
    </form>
  );
}

function Choice({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-14 shrink-0 text-xs text-kumo-subtle">{label}</span>
      <div role="group" aria-label={label} className="flex flex-wrap gap-1">
        {children}
      </div>
    </div>
  );
}

function Pill({
  on,
  hint,
  onClick,
  children,
}: {
  on: boolean;
  hint?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={hint}
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "rounded-md border px-2 py-0.5 text-xs",
        on
          ? "border-agent/40 bg-agent/10 text-agent"
          : "border-kumo-hairline text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default",
      )}
    >
      {children}
    </button>
  );
}
