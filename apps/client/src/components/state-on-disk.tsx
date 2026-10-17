import { HardDrivesIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { fmtBytes } from "@/lib/format";
import type { DiskReport } from "@/lib/schemas/doctor";
import { Empty, Panel } from "@/components/store-bits";

/** Below this an entry is noise next to the GBs this panel exists to find. */
const SMALL_BYTES = 1024 ** 2;

/** A partial walk ran out of budget, so the number is a floor; an entry never
 * reached has nothing to show. */
function size(bytes: number, partial: boolean): string {
  if (!partial) return fmtBytes(bytes);
  return bytes === 0 ? "…" : `≥ ${fmtBytes(bytes)}`;
}

/** What the app keeps under its state root. Informational, so — like crashes —
 * not part of the screen's all-clear. `report` is `undefined` while measuring and
 * `null` when the scan failed. */
export function StateOnDisk({ report }: { report: DiskReport | null | undefined }) {
  const orphans = report?.scopes.filter((s) => s.orphan) ?? [];
  const small = report?.entries.filter((e) => e.bytes < SMALL_BYTES && !e.partial) ?? [];
  const large = report?.entries.filter((e) => !small.includes(e)) ?? [];
  const orphanBytes = orphans.reduce((sum, s) => sum + s.bytes, 0);
  return (
    <Panel
      title="State on disk"
      note={report ? size(report.totalBytes, report.partial) : undefined}
      icon={<HardDrivesIcon className="size-4" />}
    >
      {report === undefined ? (
        <Empty>Measuring…</Empty>
      ) : report === null ? (
        <Empty>Couldn't read the state directory.</Empty>
      ) : report.entries.length === 0 ? (
        <Empty>Nothing under {report.root}.</Empty>
      ) : (
        <>
          <div
            className="truncate px-3 py-1.5 font-mono text-xs text-kumo-subtle"
            title={report.root}
          >
            {report.root}
          </div>
          {large.map((e) => (
            <div
              key={e.name}
              className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm"
            >
              <span className="font-medium">{e.name}</span>
              <span className="font-mono text-xs text-kumo-subtle">{size(e.bytes, e.partial)}</span>
            </div>
          ))}
          {small.length > 0 && (
            <div className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm text-kumo-subtle">
              <span>{small.length} smaller</span>
              <span className="font-mono text-xs">
                {fmtBytes(small.reduce((sum, e) => sum + e.bytes, 0))}
              </span>
            </div>
          )}
          {orphans.length > 0 && (
            <div className="flex items-start gap-3 px-3 py-2 text-sm">
              <WarningCircleIcon className="mt-0.5 size-4 shrink-0 text-warn" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">Scopes with no checkout</span>
                  <span className="font-mono text-xs text-kumo-subtle">
                    {orphans.length} ·{" "}
                    {size(
                      orphanBytes,
                      orphans.some((s) => s.partial),
                    )}
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-kumo-subtle">
                  Nothing maps to these any more — safe to delete by hand.
                </div>
                {orphans.map((s) => (
                  <div
                    key={s.name}
                    className="mt-1 flex items-baseline justify-between gap-3 text-xs"
                    title={s.path}
                  >
                    <span className="truncate font-mono">{s.name}</span>
                    <span className="shrink-0 font-mono text-kumo-subtle">
                      {size(s.bytes, s.partial)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {report.residue.count > 0 && (
            <div className="flex items-start gap-3 px-3 py-2 text-sm">
              <WarningCircleIcon className="mt-0.5 size-4 shrink-0 text-warn" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">App data of removed tasks</span>
                  <span className="font-mono text-xs text-kumo-subtle">
                    {report.residue.count} · {size(report.residue.bytes, report.residue.partial)}
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-kumo-subtle">
                  Reclaim it with `tt task clean`.
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
