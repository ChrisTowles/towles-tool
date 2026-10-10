import { Badge, Button, LayerCard, Tooltip } from "@cloudflare/kumo";
import { ArrowSquareOutIcon, RecordIcon, EyeSlashIcon } from "@phosphor-icons/react";
import { fmtAge, type CollectRun, type IssueItem } from "@/lib/data";
import { openExternalUrl } from "@/lib/open-url";
import { cn } from "@/lib/utils";

/** Shared atoms for screens rendering store-snapshot data (Cockpit, Pull
 * requests, Config) — one home so the row anatomy can't drift between them. */

export function Panel({
  title,
  note,
  icon,
  action,
  children,
}: {
  title: string;
  note?: string;
  icon: React.ReactNode;
  /** A header control beside `note`, e.g. the work queue's Start button. */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <LayerCard render={<section />}>
      <LayerCard.Secondary className="flex items-center justify-between">
        <div className="flex items-center gap-2 font-medium text-kumo-default">
          {icon}
          {title}
        </div>
        <div className="flex items-center gap-3">
          {note && <span className="text-xs text-kumo-subtle">{note}</span>}
          {action}
        </div>
      </LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col divide-y divide-kumo-hairline p-0">
        {children}
      </LayerCard.Primary>
    </LayerCard>
  );
}

/** "Nothing here" copy. `inline` drops the centered padding for callers already
 * inside a {@link Card}, which supplies its own. */
export function Empty({
  children,
  inline = false,
}: {
  children: React.ReactNode;
  inline?: boolean;
}) {
  return (
    <p className={cn("text-sm text-muted-foreground", !inline && "px-3 py-8 text-center")}>
      {children}
    </p>
  );
}

/** Section shell: bordered card, title, optional right-aligned `note`. `action`
 * is a sibling of the title, for a control `note` can't express as text. */
export function Card({
  title,
  note,
  action,
  children,
}: {
  title: string;
  note?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3.5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {note && <span className="font-mono text-[11px] text-muted-foreground">{note}</span>}
        {action}
      </div>
      {children}
    </div>
  );
}

/** One headline number with its label and an optional sub-line. */
export function StatTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card px-3.5 py-2.5">
      <div className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-xl font-semibold text-foreground">{value}</div>
      {detail && <div className="text-[11px] text-muted-foreground">{detail}</div>}
    </div>
  );
}

/** A horizontal magnitude bar: a truncated label, a proportional fill against
 * `max`, and the raw count right-aligned. */
export function BarRow({
  label,
  count,
  max,
  tone,
}: {
  label: string;
  count: number;
  max: number;
  tone?: string;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span
        className={cn("w-28 truncate font-mono text-xs", tone ?? "text-foreground")}
        title={label}
      >
        {label}
      </span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-violet-500"
          style={{ width: `${Math.max(2, (count / max) * 100)}%` }}
        />
      </div>
      <span className="w-10 shrink-0 text-right font-mono text-xs text-muted-foreground">
        {count}
      </span>
    </div>
  );
}

/** The largest count in a set of {@link BarRow} rows, floored at 1 so a bar
 * never divides by zero. */
export function maxCount(rows: { count: number }[]): number {
  return Math.max(1, ...rows.map((r) => r.count));
}

/** Inline row dismissal, for screens with no per-row dropdown to hang it off. */
export function DismissButton({ onDismiss, label }: { onDismiss: () => void; label: string }) {
  return (
    <Tooltip
      content={label}
      render={
        <Button
          size="sm"
          shape="square"
          variant="ghost"
          className="shrink-0 opacity-0 group-hover:opacity-100"
          aria-label={label}
          onClick={onDismiss}
          icon={<EyeSlashIcon size={14} />}
        />
      }
    />
  );
}

/** One issue row. `actions` renders a trailing control *outside* the anchor, so
 * nested interactive elements stay valid; without it, a glyph. */
export function IssueRow({
  issue,
  now,
  actions,
}: {
  issue: IssueItem;
  now: number;
  actions?: React.ReactNode;
}) {
  return (
    <div className="group flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-kumo-tint">
      <a
        href={issue.url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => {
          e.preventDefault();
          void openExternalUrl(issue.url);
        }}
        className="flex min-w-0 flex-1 items-center gap-3"
      >
        <RecordIcon size={16} weight="bold" className="shrink-0 text-kumo-success" />
        <div className="min-w-0 flex-1">
          <div className="truncate">{issue.title}</div>
          <div className="truncate font-mono text-xs text-kumo-subtle">
            {issue.repo} #{issue.number} · {fmtAge(issue.updatedTs, now)}
          </div>
        </div>
      </a>
      <div className="flex shrink-0 items-center gap-1">
        {issue.labels.slice(0, 2).map((l) => (
          <Badge key={l} variant="outline">
            {l}
          </Badge>
        ))}
      </div>
      {actions ?? (
        <ArrowSquareOutIcon
          size={14}
          className="shrink-0 text-kumo-subtle opacity-0 group-hover:opacity-100"
        />
      )}
    </div>
  );
}

/** One collector's freshness: green age, red with the error, muted "never". */
export function CollectorFreshness({ run, now }: { run: CollectRun | undefined; now: number }) {
  if (!run) {
    return <span className="font-mono text-[11px] text-muted-foreground/60">never ran</span>;
  }
  if (!run.ok) {
    return (
      <span
        className="truncate font-mono text-[11px] text-red-600 dark:text-red-500"
        title={run.message}
      >
        failed {fmtAge(run.ranAt, now)}
        {run.message ? ` · ${run.message}` : ""}
      </span>
    );
  }
  return (
    <span className="font-mono text-[11px] text-muted-foreground">
      ran {fmtAge(run.ranAt, now)}
      {run.message ? ` · ${run.message}` : ""}
    </span>
  );
}
