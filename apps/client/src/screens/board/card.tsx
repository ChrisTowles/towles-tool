import { useRef, useState } from "react";
import { DotsThreeIcon, NoteIcon } from "@phosphor-icons/react";
import { Badge, Button, Dialog, DropdownMenu, Input } from "@cloudflare/kumo";
import { IssueFacts } from "@/components/board-github-bits";
import { issueKey } from "@/lib/board-github";
import type { BoardAgentStatus } from "@/lib/board-agent-status";
import { repoAccentStyles, repoIcon, type RepoIdentity } from "@/lib/repo-identity";
import { cn } from "@/lib/utils";
import {
  fmtClock,
  fmtDate,
  type IssueItem,
  type PrItem,
  type TaskIssueLink,
  type TaskItem,
  type TaskOutcome,
  type TaskPrLink,
} from "@/lib/data";
import { taskRollup } from "@/lib/board-rollup";
import { openExternalUrl } from "@/lib/open-url";
import { PR_TONE, prTone } from "@/lib/pr-tone";
import { AgentStatusChip, NotesField } from "@/screens/board/card-bits";

export function Card({
  task,
  repos,
  repoIdentity,
  repoLabel,
  onOpenAgentboard,
  agent,
  onOpenSession,
  openIssues,
  issuesByKey,
  openPrs,
  onReopen,
  onPromote,
  onAttachIssue,
  onDetachIssue,
  onAttachPr,
  onDetachPr,
  onRename,
  onSetNotes,
  onClose,
  onRestore,
  onPurge,
}: {
  task: TaskItem;
  repos: string[];
  repoIdentity?: RepoIdentity;
  /** Set only in flat (no-swimlane) mode, where no lane header names the repo. */
  repoLabel?: string;
  /** Undefined when the repo isn't on the rail — the affordances don't render. */
  onOpenAgentboard?: () => void;
  /** The rail's loudest session in this task's worktree; null when it has none. */
  agent: BoardAgentStatus | null;
  onOpenSession: (folderDir: string, sessionId: string) => void;
  openIssues: IssueItem[];
  /** Cached issue rows, for a linked issue's labels and assignees. */
  issuesByKey: Map<string, IssueItem>;
  openPrs: PrItem[];
  /** Mints a fresh worktree bound to the task's existing id — both reopening a
   * closed task and starting a worktree-less "task only" one. */
  onReopen: (task: TaskItem) => void;
  onPromote: (id: number, repo: string) => void;
  onAttachIssue: (id: number, issue: IssueItem) => void;
  onDetachIssue: (id: number, link: TaskIssueLink) => void;
  onAttachPr: (id: number, pr: PrItem) => void;
  onDetachPr: (id: number, link: TaskPrLink) => void;
  onRename: (id: number, text: string) => void;
  onSetNotes: (id: number, notes: string) => void;
  /** Removes the worktree/panes, keeps the row. */
  onClose: (id: number, outcome: TaskOutcome) => void;
  onRestore: (id: number) => void;
  /** Only offered when no worktree is bound. */
  onPurge: (id: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(task.text);
  // What the confirm dialog is confirming: a close (with the chosen outcome,
  // worktree-bound tasks only — a bare row closes without asking) or a purge.
  const [confirming, setConfirming] = useState<
    { kind: "close"; outcome: TaskOutcome } | { kind: "purge" } | null
  >(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const hasNotes = (task.notes ?? "").trim() !== "";
  const summary = (task.summary ?? "").trim();
  // Derived backend-side (`TaskItem::with_derived_fields`) so every consumer
  // agrees. No worktree means the useful action is starting/reopening one,
  // not a dead-end navigation to an empty rail row.
  const { closed, hasWorktree } = task;
  const outcome = task.displayOutcome ?? null;
  const archived = task.archivedAt !== undefined;
  const attachableIssues = openIssues.filter(
    (i) => !task.issues.some((l) => l.repo === i.repo && l.number === i.number),
  );
  const attachablePrs = openPrs.filter(
    (p) => !task.prs.some((l) => l.repo === p.repo && l.number === p.number),
  );
  const hasLinks = task.issues.length > 0 || task.prs.length > 0;
  // The collector moves a fully-resolved linked task to `done` on its own, so
  // a card can finish without anyone touching it (see `lib/board-rollup.ts`).
  const rollup = taskRollup(task);
  const rollupTitle = rollup
    ? [
        "Moved to done automatically — every linked issue and PR is resolved:",
        ...rollup.evidence.map((e) => `  ${e.qualified} ${e.state}`),
        task.completedAt !== undefined &&
          `Done ${fmtDate(task.completedAt)} at ${fmtClock(task.completedAt)}`,
      ]
        .filter(Boolean)
        .join("\n")
    : undefined;
  // The wash mixes into the card's own opaque background.
  const accent = repoAccentStyles(repoIdentity, "var(--background)");
  const RepoGlyph = repoIdentity ? repoIcon(repoIdentity.meta) : null;
  const identityStyle = { ...accent.edgeStyle, ...accent.surfaceStyle };
  const branch = task.worktree?.branch;
  const detached = branch !== undefined && !hasWorktree;
  const identityRowText = [repoLabel, branch && `⎇ ${branch}${detached ? " · detached" : ""}`]
    .filter(Boolean)
    .join(" · ");

  function startRename() {
    setEditValue(task.text);
    setEditing(true);
  }

  function commitRename() {
    setEditing(false);
    onRename(task.id, editValue);
  }

  return (
    <div
      data-focus-kind="todo"
      data-focus-id={String(task.id)}
      className={cn(
        "group rounded-md border border-l-2 bg-background p-2.5 text-sm shadow-sm",
        closed && "opacity-60",
        archived && "opacity-40",
      )}
      style={identityStyle}
    >
      <div className="flex items-start gap-1.5">
        {RepoGlyph && (
          <RepoGlyph
            aria-hidden
            className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
            style={accent.iconStyle}
          />
        )}
        {editing ? (
          <Input
            size="xs"
            ref={inputRef}
            autoFocus
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setEditing(false);
            }}
            onBlur={commitRename}
            className="min-w-0 flex-1"
            aria-label="Rename todo"
          />
        ) : (
          <span
            onDoubleClick={startRename}
            // Only done work is struck through — an abandoned task ended, but
            // striking it would claim it was finished.
            className={cn("min-w-0 flex-1", outcome === "done" && "line-through")}
          >
            {task.text}
          </span>
        )}
        <DropdownMenu>
          <DropdownMenu.Trigger
            render={
              <Button
                variant="ghost"
                size="xs"
                shape="square"
                className="-mr-1 -mt-1"
                aria-label="Todo actions"
                icon={<DotsThreeIcon className="size-4" />}
              />
            }
          />
          <DropdownMenu.Content align="end" className="w-48">
            {hasWorktree && onOpenAgentboard ? (
              <>
                <DropdownMenu.Item onClick={onOpenAgentboard}>Open on Agentboard</DropdownMenu.Item>
                <DropdownMenu.Separator />
              </>
            ) : (
              !closed && (
                <>
                  <DropdownMenu.Item onClick={() => onReopen(task)}>
                    Start task
                    <span className="ml-auto text-micro text-kumo-subtle">new worktree</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator />
                </>
              )
            )}
            <DropdownMenu.Item onClick={startRename}>Rename</DropdownMenu.Item>
            <DropdownMenu.Group>
              <DropdownMenu.Label className="pb-0.5 pt-1 text-kumo-subtle">
                Notes
              </DropdownMenu.Label>
              <div
                className="px-2 py-1"
                // Keep the menu open and stop its typeahead from eating keystrokes.
                onKeyDown={(e) => e.stopPropagation()}
              >
                <NotesField task={task} onSetNotes={onSetNotes} />
              </div>
            </DropdownMenu.Group>
            {closed && !archived && (
              <>
                <DropdownMenu.Separator />
                <DropdownMenu.Item onClick={() => onReopen(task)}>
                  Reopen
                  <span className="ml-auto text-micro text-kumo-subtle">new worktree</span>
                </DropdownMenu.Item>
              </>
            )}
            <DropdownMenu.Separator />
            {attachableIssues.length > 0 && (
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger>Attach issue…</DropdownMenu.SubTrigger>
                <DropdownMenu.SubContent className="max-h-72 overflow-y-auto">
                  {attachableIssues.map((issue) => (
                    <DropdownMenu.Item
                      key={`${issue.repo}#${issue.number}`}
                      onClick={() => onAttachIssue(task.id, issue)}
                    >
                      <span className="mr-1.5 font-mono text-kumo-subtle">#{issue.number}</span>
                      <span className="max-w-56 truncate">{issue.title}</span>
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.SubContent>
              </DropdownMenu.Sub>
            )}
            {attachablePrs.length > 0 && (
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger>Attach PR…</DropdownMenu.SubTrigger>
                <DropdownMenu.SubContent className="max-h-72 overflow-y-auto">
                  {attachablePrs.map((pr) => (
                    <DropdownMenu.Item
                      key={`${pr.repo}#${pr.number}`}
                      onClick={() => onAttachPr(task.id, pr)}
                    >
                      <span className="mr-1.5 font-mono text-kumo-subtle">#{pr.number}</span>
                      <span className="max-w-56 truncate">{pr.title}</span>
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.SubContent>
              </DropdownMenu.Sub>
            )}
            {hasLinks && (
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger>Detach…</DropdownMenu.SubTrigger>
                <DropdownMenu.SubContent>
                  {task.issues.map((link) => (
                    <DropdownMenu.Item
                      key={`i${link.repo}#${link.number}`}
                      onClick={() => onDetachIssue(task.id, link)}
                    >
                      issue #{link.number} · {link.repo}
                    </DropdownMenu.Item>
                  ))}
                  {task.prs.map((link) => (
                    <DropdownMenu.Item
                      key={`p${link.repo}#${link.number}`}
                      onClick={() => onDetachPr(task.id, link)}
                    >
                      PR #{link.number} · {link.repo}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.SubContent>
              </DropdownMenu.Sub>
            )}
            {repos.length > 0 ? (
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger>Create issue in…</DropdownMenu.SubTrigger>
                <DropdownMenu.SubContent>
                  {repos.map((repo) => (
                    <DropdownMenu.Item key={repo} onClick={() => onPromote(task.id, repo)}>
                      {repo}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.SubContent>
              </DropdownMenu.Sub>
            ) : (
              <DropdownMenu.Item disabled>No repos to file in</DropdownMenu.Item>
            )}
            <DropdownMenu.Separator />
            {/* How a task ends. Open tasks close with an outcome (taking their
                worktree with them — confirmed when one exists, immediate for a
                bare row). Archived ones can come back. The permanent delete
                survives only for rows with no worktree bound — the backend
                refuses it otherwise. */}
            {!closed && (
              <>
                <DropdownMenu.Item
                  onClick={() =>
                    hasWorktree
                      ? setConfirming({ kind: "close", outcome: "done" })
                      : onClose(task.id, "done")
                  }
                >
                  Close as done
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onClick={() =>
                    hasWorktree
                      ? setConfirming({ kind: "close", outcome: "abandoned" })
                      : onClose(task.id, "abandoned")
                  }
                >
                  Close as abandoned
                </DropdownMenu.Item>
              </>
            )}
            {archived && (
              <DropdownMenu.Item onClick={() => onRestore(task.id)}>Restore</DropdownMenu.Item>
            )}
            {!hasWorktree && (
              <DropdownMenu.Item variant="danger" onClick={() => setConfirming({ kind: "purge" })}>
                Delete permanently…
              </DropdownMenu.Item>
            )}
          </DropdownMenu.Content>
        </DropdownMenu>
      </div>

      {/* The goal the task was created for — only when it says something the
          title doesn't already (a goal-less-title submit stores the same
          text in both). */}
      {task.goal && task.goal !== task.text && (
        <div className="mt-1.5 truncate text-xs text-muted-foreground" title={task.goal}>
          {task.goal}
        </div>
      )}

      {/* The identity row: the repo name in flat mode (where no lane header
          says it), plus the worktree branch when one exists — a branchless task in
          grouped mode renders nothing here, its lane header already identifies
          it. Clickable when the repo has an Agentboard rail row. */}
      {(repoLabel !== undefined || branch || agent) && (
        <div
          className={cn(
            "mt-1.5 flex items-center gap-2 font-mono text-mini text-muted-foreground",
            detached && "italic text-muted-foreground/70",
          )}
        >
          {!identityRowText ? null : hasWorktree && onOpenAgentboard ? (
            <button
              type="button"
              onClick={onOpenAgentboard}
              title={`Open on Agentboard — ${task.worktree?.dir}`}
              className="min-w-0 truncate text-left hover:text-foreground hover:underline"
            >
              {identityRowText}
            </button>
          ) : !closed ? (
            <button
              type="button"
              onClick={() => onReopen(task)}
              title="Start this task — mints a new worktree"
              className="min-w-0 truncate text-left hover:text-foreground hover:underline"
            >
              {identityRowText}
            </button>
          ) : (
            <span
              className="min-w-0 truncate"
              title={
                task.worktree?.dir ?? (branch ? `worktree removed — branch ${branch}` : undefined)
              }
            >
              {identityRowText}
            </span>
          )}
          {agent && (
            <AgentStatusChip
              agent={agent}
              onOpen={() => onOpenSession(agent.folderDir, agent.session.id)}
            />
          )}
        </div>
      )}
      {(hasLinks || hasNotes || closed) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {/* How the task ended: ✓ teal for done, ⊘ muted for abandoned — the
              one honest terminal column needs the badge to say which. */}
          {outcome && (
            <Badge
              variant="outline"
              className={cn(
                "gap-1 font-mono text-micro",
                outcome === "done" ? "text-ok" : "text-kumo-subtle",
              )}
            >
              {outcome === "done" ? "✓ done" : "⊘ abandoned"}
            </Badge>
          )}
          {archived && (
            <Badge variant="outline" className="text-micro text-kumo-subtle">
              archived
            </Badge>
          )}
          {task.issues.map((link) => {
            const cached = issuesByKey.get(issueKey(link.repo, link.number));
            return (
              <span
                key={`i${link.repo}#${link.number}`}
                className="flex min-w-0 max-w-full items-baseline gap-1"
              >
                <a
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => {
                    e.preventDefault();
                    void openExternalUrl(link.url);
                  }}
                  title={`${link.repo}#${link.number} · ${link.state}`}
                  className={cn(
                    "font-mono text-mini text-muted-foreground hover:text-foreground hover:underline",
                    link.state === "closed" && "line-through opacity-60",
                  )}
                >
                  #{link.number}
                </a>
                {cached && link.state !== "closed" && <IssueFacts issue={cached} />}
              </span>
            );
          })}
          {task.prs.map((link) => {
            // Compact link chips stay muted unless something is settled or
            // wrong — running/passing/plain would be noise at this size.
            const tone = prTone(link);
            return (
              <a
                key={`p${link.repo}#${link.number}`}
                href={link.url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => {
                  e.preventDefault();
                  void openExternalUrl(link.url);
                }}
                title={`${link.repo}#${link.number} · ${link.state}${link.checks !== "none" ? ` · checks ${link.checks}` : ""}`}
                className={cn(
                  "font-mono text-mini hover:underline",
                  tone === "merged" || tone === "failed"
                    ? PR_TONE[tone].text
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                PR #{link.number}
                {link.state === "merged" && " ✓"}
              </a>
            );
          })}
          {hasNotes && (
            <span title={task.notes}>
              <Badge variant="outline" className="gap-1 text-micro text-kumo-subtle">
                <NoteIcon aria-hidden className="size-3" />
                Notes
              </Badge>
            </span>
          )}
        </div>
      )}
      {/* Why a card nobody closed is sitting in `done`. The chips above carry
          the same states, but as decoration — this names the refs as the
          cause, so an unexpectedly-finished card is self-explaining rather
          than something to go re-derive on GitHub. */}
      {rollup && (
        <p className="mt-1 text-mini leading-tight text-muted-foreground" title={rollupTitle}>
          Rolled up — {rollup.summary}
        </p>
      )}

      {/* What the agent reported when it finished (MCP `task_summary`). This
          is the card's copy of a wrap-up that otherwise dies with the
          worktree's terminal, and it's what the user reads to confirm the
          work before closing the task — so it renders inline, not behind a
          tooltip like `notes`. Collapsed to a few lines; click to expand. */}
      {summary && (
        <button
          type="button"
          onClick={() => setSummaryOpen((open) => !open)}
          className="mt-2 block w-full rounded border border-dashed bg-muted/30 p-1.5 text-left"
        >
          <span className="mb-0.5 flex items-baseline gap-1.5 text-micro text-muted-foreground">
            <span className="font-medium uppercase tracking-wide">Summary</span>
            {task.summaryAt !== undefined && (
              <span className="opacity-70">
                {fmtDate(task.summaryAt)} {fmtClock(task.summaryAt)}
              </span>
            )}
            {/* The affordance: cropped text alone doesn't say it's cropped. */}
            <span className="ml-auto opacity-70">{summaryOpen ? "less" : "more"}</span>
          </span>
          <span
            className={cn(
              "block whitespace-pre-wrap text-mini leading-snug text-foreground/80",
              // Height, not `line-clamp-*`: WebKitGTK reports the clamp but
              // ignores it once `whitespace-pre-wrap` gives the text hard
              // newlines. A max-height crops with no engine dependency.
              !summaryOpen && "max-h-16 overflow-hidden",
            )}
          >
            {summary}
          </span>
        </button>
      )}

      <Dialog.Root open={confirming != null} onOpenChange={(open) => !open && setConfirming(null)}>
        <Dialog size="lg" className="p-6">
          <div className="mb-4 flex flex-col gap-2">
            <Dialog.Title className="text-lg font-semibold">
              {confirming?.kind === "purge"
                ? "Delete this task permanently?"
                : `Close as ${confirming?.outcome ?? "done"}?`}
            </Dialog.Title>
            {/* Close names the worktree: it deletes the checkout on disk and
                its terminals, and a confirm that only mentioned the card would
                be understating what the button does. Still promises the
                guards — work that would be lost stops the close and reopens
                as the blocked dialog, which is where discarding is agreed
                to. */}
            <Dialog.Description className="text-sm">
              {confirming?.kind === "purge"
                ? `“${task.text}” and its record will be removed for good. Closed tasks are normally archived, not deleted — this is the exception.`
                : `“${task.text}” stays on the board as ${
                    confirming?.outcome ?? "done"
                  }, but its worktree and any terminals in it will be removed. Uncommitted or unlanded work stops the close rather than being discarded.`}
            </Dialog.Description>
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close
              render={(p) => (
                <Button {...p} variant="secondary">
                  Cancel
                </Button>
              )}
            />
            <Button
              variant={confirming?.kind === "purge" ? "destructive" : "primary"}
              onClick={() => {
                if (confirming?.kind === "purge") onPurge(task.id);
                else if (confirming) onClose(task.id, confirming.outcome);
                setConfirming(null);
              }}
            >
              {confirming?.kind === "purge"
                ? "Delete permanently"
                : `Close as ${confirming?.outcome ?? "done"}`}
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </div>
  );
}
