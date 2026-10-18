import { Result } from "effect";
import { useEffect, useState } from "react";
import { CaretDownIcon, CaretRightIcon, XIcon } from "@phosphor-icons/react";
import { Button, Dialog } from "@cloudflare/kumo";
import { fmtClock, journalToday, type IssueItem } from "@/lib/data";
import { issueKey, type LandedToday } from "@/lib/board-github";
import { cn } from "@/lib/utils";
import { mouseAction } from "@/lib/shortcut-coach";
import { NotInTauri } from "@/lib/errors";
import { openExternalUrl } from "@/lib/open-url";

/** An issue's labels and assignees as a bare mono fact beside its `#N` chip. */
export function IssueFacts({ issue }: { issue: IssueItem }) {
  const facts = [
    issue.labels.join(", "),
    issue.assignees.length > 0 ? issue.assignees.map((a) => `@${a}`).join(" ") : "unassigned",
  ].filter(Boolean);
  return <span className="truncate font-mono text-mini text-kumo-subtle">{facts.join(" · ")}</span>;
}

/** Open issues carrying a watched label that no task has taken yet. Folds to its
 * header so a long list never pushes the lanes off screen. */
export function WatchedIssues({
  issues,
  open,
  onOpenChange,
  cursorKey,
  canStart,
  onStart,
  onDismiss,
}: {
  issues: IssueItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The `issueKey` the board's keyboard cursor is on, if it is on one of these. */
  cursorKey: string | null;
  /** Why an issue can't be started here, or null when it can. */
  canStart: (issue: IssueItem) => string | null;
  onStart: (issue: IssueItem) => void;
  onDismiss: (issue: IssueItem) => void;
}) {
  if (issues.length === 0) return null;
  const Caret = open ? CaretDownIcon : CaretRightIcon;
  return (
    <section className="mb-4 rounded-lg border bg-muted/30 p-2">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-1 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        <Caret aria-hidden className="size-3" />
        Watched issues
        <span className="rounded-full bg-muted px-1.5 font-mono text-micro normal-case">
          {issues.length}
        </span>
      </button>
      {open && (
        <ul className="mt-1.5 flex flex-col gap-1">
          {issues.map((issue) => {
            const blocked = canStart(issue);
            const cursor = cursorKey === issueKey(issue.repo, issue.number);
            return (
              <li
                key={`${issue.repo}#${issue.number}`}
                data-board-cursor={cursor || undefined}
                aria-current={cursor || undefined}
                className={cn(
                  "flex scroll-mb-3 items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-accent/50",
                  cursor && "ring-1 ring-inset ring-agent",
                )}
              >
                <a
                  href={issue.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => {
                    e.preventDefault();
                    mouseAction("board-open-link", "board");
                    void openExternalUrl(issue.url);
                  }}
                  title={`${issue.repo}#${issue.number} on GitHub`}
                  className="shrink-0 font-mono text-mini text-muted-foreground hover:text-foreground hover:underline"
                >
                  {issue.repo.split("/").pop()}#{issue.number}
                </a>
                <span className="min-w-0 truncate">{issue.title}</span>
                <IssueFacts issue={issue} />
                <Button
                  variant="secondary"
                  size="xs"
                  className="ml-auto shrink-0"
                  disabled={blocked !== null}
                  title={blocked ?? "Open the new-task form with this issue attached"}
                  onClick={() => onStart(issue)}
                >
                  Start task
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  shape="square"
                  className="shrink-0"
                  aria-label={`Dismiss #${issue.number} until it changes`}
                  title="Dismiss until it changes"
                  icon={<XIcon className="size-3.5" />}
                  onClick={() => onDismiss(issue)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** What shipped today: merged PRs, tasks closed as done, and the daily note. */
export function LandedTodayDialog({
  open,
  onOpenChange,
  landed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  landed: LandedToday;
}) {
  const [journal, setJournal] = useState<{ lines: string[]; error: string | null } | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void journalToday().then((result) => {
      if (cancelled) return;
      setJournal(
        Result.match(result, {
          onSuccess: (lines) => ({ lines, error: null as string | null }),
          onFailure: (e) => ({ lines: [] as string[], error: NotInTauri.is(e) ? null : e.message }),
        }),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const empty = landed.prs.length === 0 && landed.tasks.length === 0;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog size="lg" className="flex max-h-[80vh] flex-col gap-4 p-6">
        <div className="flex flex-col gap-1">
          <Dialog.Title className="text-lg font-semibold">Landed today</Dialog.Title>
          <Dialog.Description className="text-sm text-kumo-subtle">
            Your PRs merged since midnight, tasks closed as done, and today’s journal.
          </Dialog.Description>
        </div>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
          {empty && <p className="text-sm text-kumo-subtle">Nothing merged or closed yet today.</p>}
          {landed.prs.length > 0 && (
            <LandedSection heading="Merged PRs">
              {landed.prs.map((pr) => (
                <li key={`${pr.repo}#${pr.number}`} className="flex items-baseline gap-2">
                  <span className="shrink-0 font-mono text-mini text-kumo-subtle">
                    {fmtClock(pr.updatedTs)}
                  </span>
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => {
                      e.preventDefault();
                      void openExternalUrl(pr.url);
                    }}
                    className="min-w-0 truncate hover:underline"
                  >
                    {pr.title}
                  </a>
                  <span className="ml-auto shrink-0 font-mono text-mini text-merged">
                    {pr.repo.split("/").pop()}#{pr.number}
                  </span>
                </li>
              ))}
            </LandedSection>
          )}
          {landed.tasks.length > 0 && (
            <LandedSection heading="Tasks done">
              {landed.tasks.map((task) => (
                <li key={task.id} className="flex items-baseline gap-2">
                  <span className="shrink-0 font-mono text-mini text-kumo-subtle">
                    {task.completedAt !== undefined ? fmtClock(task.completedAt) : ""}
                  </span>
                  <span className="min-w-0 truncate">{task.text}</span>
                </li>
              ))}
            </LandedSection>
          )}
          {journal?.error && (
            <p className="text-sm text-danger">Couldn’t read today’s journal — {journal.error}</p>
          )}
          {journal && journal.lines.length > 0 && (
            <LandedSection heading="Journal">
              {journal.lines.map((line, i) => (
                <li key={i} className="font-mono text-mini">
                  {line}
                </li>
              ))}
            </LandedSection>
          )}
        </div>
      </Dialog>
    </Dialog.Root>
  );
}

function LandedSection({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {heading}
      </h3>
      <ul className="flex flex-col gap-1 text-sm">{children}</ul>
    </section>
  );
}
