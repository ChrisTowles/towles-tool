import {
  CircleCheck,
  CircleDot,
  CircleX,
  Clock,
  ExternalLink,
  EyeOff,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fmtAge, type CollectRun, type IssueItem, type PrItem } from "@/lib/data";
import { openExternalUrl } from "@/lib/open-url";
import { checksTone, PR_TONE, type ChecksTone } from "@/lib/pr-tone";
import { cn } from "@/lib/utils";

/** Shared atoms for screens rendering store-snapshot data (Cockpit, Pull
 * requests, Config) — one home so the row anatomy can't drift between them. */

export function Panel({
  title,
  note,
  icon,
  children,
}: {
  title: string;
  note?: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col overflow-hidden rounded-lg border">
      <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          {icon}
          {title}
        </div>
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </div>
      <div className="flex flex-col divide-y">{children}</div>
    </section>
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

/** Icon + label per checks tone — the color comes from `lib/pr-tone.ts`, where
 * red/amber are reserved for genuine failure/needs-you. */
const CHECKS_FACE: Record<ChecksTone, { icon: LucideIcon; label: string }> = {
  passing: { icon: CircleCheck, label: "passing" },
  failed: { icon: CircleX, label: "failing" },
  plain: { icon: CircleDot, label: "no checks" },
  running: { icon: Clock, label: "pending" },
};

/** CI check-rollup badge. `checksTone` renders unknown strings as pending, so a
 * new collector value degrades visibly. Ignores PR state: a merged PR passes. */
export function ChecksBadge({ checks }: { checks: string }) {
  const tone = checksTone(checks);
  const { icon: Icon, label } = CHECKS_FACE[tone];
  return (
    <Badge className={cn("shrink-0", PR_TONE[tone].badge)}>
      <Icon className="size-3" /> {label}
    </Badge>
  );
}

/** Inline row dismissal, for screens with no per-row dropdown to hang it off. */
export function DismissButton({ onDismiss, label }: { onDismiss: () => void; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="size-7 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
          aria-label={label}
          onClick={onDismiss}
        >
          <EyeOff className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** One pull-request row. `actions` renders a trailing control *outside* the
 * anchor, so nested interactive elements stay valid; without it, a glyph. */
export function PrRow({
  pr,
  now,
  actions,
}: {
  pr: PrItem;
  now: number;
  actions?: React.ReactNode;
}) {
  const reviewRequested = pr.reviewState === "review_requested";
  return (
    <div
      data-focus-kind="pr"
      data-focus-id={`${pr.repo}#${pr.number}`}
      className="group flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-accent/40"
    >
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => {
          e.preventDefault();
          void openExternalUrl(pr.url);
        }}
        className="flex min-w-0 flex-1 items-center gap-3"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate">{pr.title}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">
            {pr.repo} #{pr.number} · {fmtAge(pr.updatedTs, now)}
          </div>
        </div>
      </a>
      {reviewRequested && (
        <Badge className={cn("shrink-0", PR_TONE.review.badge)}>review you</Badge>
      )}
      <ChecksBadge checks={pr.checks} />
      {actions ?? (
        <ExternalLink className="size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
      )}
    </div>
  );
}

/** One issue-queue row; `actions` works as in {@link PrRow}. */
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
    <div className="group flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-accent/40">
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
        <CircleDot className="size-4 shrink-0 text-green-600 dark:text-green-500" />
        <div className="min-w-0 flex-1">
          <div className="truncate">{issue.title}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">
            {issue.repo} #{issue.number} · {fmtAge(issue.updatedTs, now)}
          </div>
        </div>
      </a>
      <div className="flex shrink-0 items-center gap-1">
        {issue.labels.slice(0, 2).map((l) => (
          <Badge key={l} variant="outline" className="text-[10px]">
            {l}
          </Badge>
        ))}
      </div>
      {actions ?? (
        <ExternalLink className="size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
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
