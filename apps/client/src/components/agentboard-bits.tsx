import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import {
  AppWindow,
  Box,
  Check,
  CheckCheck,
  ChevronDown,
  CircleDot,
  ExternalLink,
  Eye,
  EyeOff,
  FolderPlus,
  FolderTree,
  GitCompare,
  GitMerge,
  GitPullRequest,
  Link,
  Link2Off,
  Loader2,
  MoreVertical,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Input } from "@/components/ui/input";
import { Hint, ShortcutBadge } from "@/components/hint";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import {
  abSyncRepo,
  collapsedLiveColor,
  comparedBaseLabel,
  ctxPct,
  fmtDiffLines,
  fmtElapsed,
  folderLandedButHasWork,
  gitCheckedLabel,
  isCacheExpiring,
  isCold,
  modelContextLabel,
  modelLetter,
  needsCompact,
  statusColor,
  type AgentStatus,
  type CommitStat,
  type FolderData,
  type LandedVia,
  type PortDrift,
  type SessionData,
} from "@/lib/agentboard";
import {
  storeAttachTaskIssue,
  storeDetachTaskIssue,
  storeSearchIssues,
  type IssueItem,
  type PrItem,
  type TaskIssueLink,
} from "@/lib/data";
import { openInExternalEditor } from "@/lib/external-editor";
import { openExternalUrl } from "@/lib/open-url";
import { PR_TONE, prTone } from "@/lib/pr-tone";
import { mouseAction } from "@/lib/shortcut-coach";
import { shortcutAria, shortcutHint, withHint } from "@/lib/shortcuts";
import { invoke } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** Shared atoms for the Agentboard rail rows, folder headers, pane chrome and
 * working-context band, so each surface composes the same pieces. */

/** A square icon action. `title` is a Radix tooltip, not a native one, which a
 * WebKitGTK webview renders unreliably; it doubles as the `aria-label`.
 * `ghost` drops the resting border and is what every rail row uses. */
export function IconBtn({
  title,
  shortcut,
  onClick,
  className,
  ghost = false,
  children,
  ...props
}: {
  title: string;
  /** Registry id of the binding this button duplicates. The tooltip grows a
   * keycap badge and the click scores itself as a passed-up keystroke, so a
   * caller passing this must not also call `mouseAction`. Keycaps stay out of
   * `aria-label` — a screen reader gets the plain title plus
   * `aria-keyshortcuts`. */
  shortcut?: string;
  onClick: () => void;
  className?: string;
  ghost?: boolean;
  children: ReactNode;
} & Omit<ComponentProps<"button">, "onClick" | "title" | "children">) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={ghost ? "ghost" : "outline"}
          size="icon-xs"
          aria-label={title}
          aria-keyshortcuts={shortcut ? shortcutAria(shortcut) : undefined}
          onClick={(e) => {
            e.stopPropagation();
            // Every `IconBtn` is an agentboard atom, so that is the screen its clicks
            // score against — see the file header.
            if (shortcut) mouseAction(shortcut, "agentboard");
            onClick();
          }}
          className={cn("font-mono text-xs text-muted-foreground", className)}
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {title}
        {shortcut && <ShortcutBadge id={shortcut} />}
      </TooltipContent>
    </Tooltip>
  );
}

/** ✦ for an agent session, ❯ for a plain shell. */
export function Glyph({ agent }: { agent: boolean }) {
  return (
    <span
      className={cn(
        "w-4 shrink-0 text-center font-mono text-xs",
        agent ? "text-violet-500" : "text-muted-foreground/60",
      )}
    >
      {agent ? "✦" : "❯"}
    </span>
  );
}

/** Status dot mirroring `statusColor`; pulses while busy. Open ring =
 * paused/pending on you, filled = something happened — a shape cue, so
 * `waiting` and `complete` don't rely on hue alone to tell each other apart. */
export function Dot({ session }: { session: SessionData }) {
  if (!session.live) {
    return (
      <Hint label="not started">
        <span className="size-2 shrink-0 rounded-full border-[1.5px] border-muted-foreground/50 bg-transparent" />
      </Hint>
    );
  }
  const st = session.agentState?.status;
  if (st === "waiting") {
    return (
      <Hint label="agent waiting — needs your input">
        <span className="size-2 shrink-0 rounded-full border-[1.5px] border-blue-500 bg-transparent" />
      </Hint>
    );
  }
  return (
    <Hint label={st ? `agent ${st}` : "shell running, no agent"}>
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          st ? statusColor(st) : "bg-muted-foreground/40",
          st === "busy" && "animate-pulse",
        )}
      />
    </Hint>
  );
}

/** Micro-dot + count for agent rollups. Shape and color derive from `Dot` and
 * `statusColor`, so the buckets can't drift from them. */
export function DotCount({ status, n }: { status: AgentStatus; n: number }) {
  return (
    <span className="flex items-center gap-1 text-muted-foreground">
      <span
        className={cn(
          "size-1.5 rounded-full",
          status === "waiting"
            ? "border-[1.5px] border-blue-500 bg-transparent"
            : statusColor(status),
        )}
      />
      {n}
    </span>
  );
}

/** On a collapsed header: running sessions are hidden inside, so it doesn't
 * look asleep. Nothing when nothing is live. */
export function CollapsedLive({ sessions }: { sessions: SessionData[] }) {
  const color = collapsedLiveColor(sessions);
  if (!color) return null;
  const n = sessions.filter((s) => s.live).length;
  return (
    <Hint label={`${n} running session${n > 1 ? "s" : ""} hidden — expand to see`}>
      <span className="flex shrink-0 items-center gap-1">
        <span className={cn("size-2 rounded-full", color)} />
        <span className="font-mono text-[10px] text-muted-foreground/70">{n}</span>
      </span>
    </Hint>
  );
}

export function Chevron({ collapsed }: { collapsed: boolean }) {
  return (
    <ChevronDown
      className={cn(
        "size-3.5 shrink-0 text-muted-foreground transition-transform",
        collapsed && "-rotate-90",
      )}
    />
  );
}

/** Violet is "a Claude session is live here" app-wide: pane headers, selection
 * chip and in-editor hint all use it, so it reads as one signal. */
export function ClaudeBadge({
  title = "A Claude Code session in this folder is connected — highlighted lines become its selection context",
  className,
  children = "✦ claude",
}: {
  title?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <Hint label={title}>
      <span
        className={cn(
          "flex shrink-0 items-center gap-1 rounded-md border border-violet-500/50 bg-violet-500/10 px-1.5 font-mono text-[10.5px] text-violet-500",
          className,
        )}
      >
        {children}
      </span>
    </Hint>
  );
}

/** rust-analyzer bridge state — its only observable surface. A non-Rust
 * checkout renders nothing. */
export function LspBadge({
  state,
  detail,
}: {
  state: "starting" | "ready" | "failed";
  detail?: string;
}) {
  const look = {
    ready: "border-emerald-500/50 bg-emerald-500/10 text-emerald-500",
    failed: "border-red-500/50 bg-red-500/10 text-red-500",
    starting: "border-muted-foreground/40 bg-muted text-muted-foreground",
  }[state];
  const title = {
    ready: "rust-analyzer is connected — hovers and completions are live",
    failed: `rust-analyzer failed to start: ${detail ?? "unknown error"}`,
    starting: "rust-analyzer is starting…",
  }[state];
  return (
    <Hint label={title}>
      <span
        className={cn(
          "shrink-0 rounded-md border px-1.5 font-mono text-[10.5px] whitespace-nowrap",
          look,
        )}
      >
        rust-analyzer {state === "starting" ? "…" : state}
      </span>
    </Hint>
  );
}

export function NeedsBadge({ n, className }: { n: number; className?: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-md border border-amber-500/50 bg-amber-500/10 px-1.5 font-mono text-[10.5px] text-amber-500",
        className,
      )}
    >
      {n} ⚑
    </span>
  );
}

/** A tracked checkout whose directory is gone. Grayscale, not the needs-you
 * amber: this is inert, not something to act on. */
export function GhostBadge() {
  return (
    <Hint label="This checkout's directory is gone (moved or deleted). Untrack it, or restore the directory to bring it back.">
      <span className="shrink-0 rounded-md border border-dashed border-muted-foreground/40 px-1 font-mono text-[10px] text-muted-foreground/70">
        ⚠ missing
      </span>
    </Hint>
  );
}

/** The `⎇ branch` line. Worktree tasks are the common case, so they stay
 * muted; the primary checkout is the special row and carries the sky tint. */
export function BranchLabel({
  branch,
  isWorktree,
  onClick,
}: {
  branch: string;
  isWorktree: boolean;
  onClick?: () => void;
}) {
  return (
    // Always the full branch: every surface truncates this element first, so
    // without the tooltip a long branch is unreadable.
    <Hint
      label={
        isWorktree
          ? branch
          : `${branch} — primary checkout, the main clone; its .git is load-bearing for every worktree`
      }
    >
      <span
        className={cn(
          "min-w-0 truncate font-mono text-[11px]",
          isWorktree ? "text-muted-foreground" : "text-sky-500",
        )}
        onClick={onClick}
      >
        ⎇ {branch}
      </span>
    </Hint>
  );
}

/** Why a mid-delete row went inert. Red, not `GhostBadge`'s gray: this is an
 * active, irreversible deletion. `label` is the backend's live phase text, and
 * falls back to a static "deleting…" before the first one lands. */
export function DeletingBadge({ label }: { label?: string }) {
  return (
    <Hint
      label={
        label ? `Deleting this worktree from disk — ${label}…` : "Deleting this worktree from disk…"
      }
    >
      <span className="flex shrink-0 items-center gap-1 rounded-md border border-red-500/40 bg-red-500/10 px-1 font-mono text-[10px] text-red-600 dark:text-red-400">
        <Loader2 className="size-2.5 animate-spin" /> {label ? `${label}…` : "deleting…"}
      </span>
    </Hint>
  );
}

/** Why a task's row can exist before its directory does. Sky, not
 * `DeletingBadge`'s red: nothing is wrong and nothing is being destroyed. */
export function CreatingBadge({ label }: { label?: string }) {
  return (
    <span
      className="flex shrink-0 items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/10 px-1 font-mono text-[10px] text-sky-600 dark:text-sky-400"
      title={label ? `Creating this worktree — ${label}…` : "Creating this worktree…"}
    >
      <Loader2 className="size-2.5 animate-spin" /> {label ? `${label}…` : "creating…"}
    </span>
  );
}

/** An open task whose worktree isn't on disk: a failed create, an outside
 * delete, a restart mid-removal. The row stays and says so rather than
 * vanishing with the directory and stranding a card on the Board. */
export function DetachedBadge() {
  return (
    <span
      className="shrink-0 rounded-md border border-amber-500/50 bg-amber-500/10 px-1 font-mono text-[10px] text-amber-500"
      title="This task's worktree isn't on disk — start it again to recreate one, or delete the task to close it"
    >
      no worktree
    </span>
  );
}

/** The remedies for a `no worktree` row. Inline and boxed, unlike the rail's
 * other affordances: every other control here needs the missing directory. */
export function DetachedActions({
  onRecreate,
  onClose,
}: {
  /** Absent when there's no branch to rebuild on (`folderRecreateBranch`). */
  onRecreate?: () => void;
  onClose?: () => void;
}) {
  return (
    <>
      {onRecreate && (
        <Hint label="Recreate this task's worktree on its branch — the task keeps its place, issues and PRs">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRecreate();
            }}
            className="flex h-5 shrink-0 items-center gap-1 rounded-md border border-border/70 px-1.5 font-mono text-[10.5px] text-muted-foreground transition-colors hover:border-sky-500/50 hover:bg-sky-500/10 hover:text-sky-600 dark:hover:text-sky-400"
          >
            <RefreshCw className="size-3" /> Recreate
          </button>
        </Hint>
      )}
      {onClose && (
        <Hint label="Close this task — record it as done or abandoned; nothing is deleted from disk">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="flex h-5 shrink-0 items-center gap-1 rounded-md border border-border/70 px-1.5 font-mono text-[10.5px] text-muted-foreground transition-colors hover:border-red-500/50 hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
          >
            <CheckCheck className="size-3" /> Close…
          </button>
        </Hint>
      )}
    </>
  );
}

/** A git worktree no task claims — Claude Code's own, or one added by hand. It
 * still has a `detected` record, so it holds its position and can be adopted. */
export function NoTaskBadge({ onAdopt }: { onAdopt?: () => void }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <span
        className="rounded-md border border-border bg-muted/40 px-1 font-mono text-[10px] text-muted-foreground"
        title="A git worktree of this repo that no task claims — adopt it to track it as your own work"
      >
        no task
      </span>
      {onAdopt && (
        <button
          type="button"
          className="rounded-md px-1 font-mono text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Track this worktree as one of your tasks — the row keeps its place"
          onClick={(e) => {
            e.stopPropagation();
            onAdopt();
          }}
        >
          adopt
        </button>
      )}
    </span>
  );
}

/** Setup (`TT_TASK_SETUP`) runs after `task_create` returns, so the pending row
 * is already gone; this says the task isn't finished being built. The row
 * stays interactive throughout. */
export function SettingUpBadge({ since, now }: { since: number; now: number }) {
  return (
    <Hint label="Running this task's setup step (TT_TASK_SETUP) — an install, so it can take a while">
      <span className="flex shrink-0 items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/10 px-1 font-mono text-[10px] text-sky-600 dark:text-sky-400">
        <Loader2 className="size-2.5 animate-spin" /> setup {fmtElapsed(now - since)}
      </span>
    </Hint>
  );
}

/** A live pane's ports have drifted from what `.env` now claims — a sibling
 * task's re-render rotated a port this pane already bound to. Amber: worth
 * acting on (restart the pane), not a dead state. */
export function PortDriftBadge({ drift }: { drift: PortDrift[] }) {
  if (drift.length === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="shrink-0 rounded-md border border-amber-500/50 bg-amber-500/10 px-1 font-mono text-[10px] text-amber-500">
          ⚡ port drift
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start">
        <div className="flex flex-col gap-0.5 font-mono text-[11px]">
          <span className="text-muted-foreground">
            {drift.length === 1 ? "A pane" : "Panes"} started before{" "}
            {drift.length === 1 ? "this" : "these"} port{drift.length === 1 ? "" : "s"} last changed
            — restart to pick up the current .env:
          </span>
          {drift.map((d) => (
            <span key={`${d.key}:${d.spawnedPort}:${d.currentPort}`}>
              {d.key} {d.spawnedPort} → {d.currentPort}
            </span>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/** Which branch every git stat here was measured against, so the ± numbers
 * beside it are never ambiguous. */
export function ComparedBaseBadge({
  folder,
}: {
  folder: Pick<FolderData, "comparedBase" | "baseBranch" | "taskBaseBranch">;
}) {
  const label = comparedBaseLabel(folder);
  const manual = Boolean(folder.baseBranch?.trim());
  return (
    <Hint
      label={
        manual
          ? `Diffs against "${label}" — your override for this folder`
          : folder.taskBaseBranch
            ? `Diffs against "${label}" — the ref this task was created from`
            : `Diffs against "${label}" (origin/main-or-master auto-detect)`
      }
    >
      <span className="shrink-0 px-0.5 font-mono text-[10px] text-muted-foreground/70">
        vs {label}
      </span>
    </Hint>
  );
}

/** How far `comparedBase` has moved ahead — a fact about someone else's work
 * with one response, so it's its own chip. The only *filled* git chip: weight,
 * not a hue, since amber is spoken for and this shows on nearly every row. */
export function BaseMovedChip({
  stats,
}: {
  stats: Pick<FolderData, "commitsBehind" | "comparedBase" | "baseBranch" | "taskBaseBranch">;
}) {
  const { commitsBehind } = stats;
  if (commitsBehind === 0) return null;
  const base = comparedBaseLabel(stats);
  return (
    <Hint
      label={`Base moved: ${base} has ${commitsBehind} commit${commitsBehind === 1 ? "" : "s"} this branch doesn't — rebase or merge ${base} in to catch up. Not a measure of your own work.`}
    >
      <span className={`${CHIP_CLASS} bg-muted font-medium text-foreground`}>
        <RefreshCw className="size-3" />
        {commitsBehind}
      </span>
    </Hint>
  );
}

/** One row of the per-commit breakdown: SHA, subject, that commit's ±. */
function CommitStatRow({ commit }: { commit: CommitStat }) {
  return (
    <div className="flex items-center gap-2 font-mono text-[10.5px] leading-tight">
      <span className="shrink-0 text-muted-foreground/70">{commit.sha.slice(0, 7)}</span>
      <span className="min-w-0 flex-1 truncate text-foreground">{commit.subject}</span>
      <span className="shrink-0 text-emerald-600 dark:text-emerald-400">+{commit.linesAdded}</span>
      <span className="shrink-0 text-red-600 dark:text-red-400">−{commit.linesRemoved}</span>
    </div>
  );
}

/** `CommittedChip`'s hover card. The two totals are never added together —
 * this is where that distinction is spelled out, since the chips have room
 * only for numbers. Commits are fetched lazily and cached by the parent. */
function CommitBreakdownPreview({
  commits,
  stats,
  base,
}: {
  commits: CommitStat[] | null;
  stats: Pick<
    FolderData,
    | "committedFiles"
    | "committedAdded"
    | "committedRemoved"
    | "uncommittedFiles"
    | "uncommittedAdded"
    | "uncommittedRemoved"
  >;
  base: string;
}) {
  if (commits == null) {
    return <p className="p-1 text-xs text-muted-foreground">loading commits…</p>;
  }
  return (
    <div className="max-h-80 overflow-auto">
      <div className="flex flex-col gap-1">
        {commits.length === 0 ? (
          <p className="text-xs text-muted-foreground">no commits ahead of {base}</p>
        ) : (
          commits.map((c) => <CommitStatRow key={c.sha} commit={c} />)
        )}
      </div>
      <div className="mt-1.5 flex items-center gap-2 border-t border-border/70 pt-1.5 font-mono text-[10.5px] font-semibold">
        <span className="min-w-0 flex-1 text-foreground">
          Committed
          {commits.length > 0 && ` — ${commits.length} commit${commits.length === 1 ? "" : "s"}`}
          {stats.committedFiles > 0 &&
            `, ${stats.committedFiles} file${stats.committedFiles === 1 ? "" : "s"}`}
        </span>
        <span className="shrink-0 text-emerald-600 dark:text-emerald-400">
          +{stats.committedAdded}
        </span>
        <span className="shrink-0 text-red-600 dark:text-red-400">−{stats.committedRemoved}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-2 border-t border-dashed border-border/70 pt-1.5 font-mono text-[10.5px]">
        <span className="min-w-0 flex-1 text-muted-foreground">
          {stats.uncommittedFiles === 0
            ? "Uncommitted — nothing"
            : `Uncommitted — ${stats.uncommittedFiles} file${stats.uncommittedFiles === 1 ? "" : "s"}, lost if this checkout is deleted`}
        </span>
        {stats.uncommittedFiles > 0 && (
          <>
            <span className="shrink-0 text-emerald-600 dark:text-emerald-400">
              +{stats.uncommittedAdded}
            </span>
            <span className="shrink-0 text-red-600 dark:text-red-400">
              −{stats.uncommittedRemoved}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/** Fields both diff chips read, plus what they need to open the pane. */
type DiffChipStats = Pick<
  FolderData,
  | "dir"
  | "committedFiles"
  | "committedAdded"
  | "committedRemoved"
  | "uncommittedFiles"
  | "uncommittedAdded"
  | "uncommittedRemoved"
  | "uncommittedCapped"
  | "commitsAhead"
  | "commitsUnlanded"
  | "landed"
  | "comparedBase"
  | "baseBranch"
  | "computedAtMs"
>;

type DiffChipProps = {
  stats: DiffChipStats;
  onOpen: () => void;
  /** On for the pane header, off for the rail — a width budget, not a
   * preference: two extra words push the rail row's numbers off the end. */
  labeled?: boolean;
};

/** Shared chrome for the git-stat chips. No resting border: a box means a
 * control or an alert, plain type means a fact, and diff stats are facts. The
 * box returns on hover, when "is this clickable?" is the question. */
const CHIP_CLASS =
  "flex h-5 shrink-0 items-center gap-1 rounded-md px-1 font-mono text-[10.5px] transition-colors";

/** Muted, so the *number* stays what the eye lands on. */
function ChipLabel({ text, labeled }: { text: string; labeled: boolean }) {
  if (!labeled) return null;
  return <span className="opacity-60">{text}</span>;
}

/** Ticking "checked 4s ago" on its own interval: a caller-passed `now` would
 * freeze exactly when nothing is changing, which is when the user is asking
 * whether anything is alive. Mounted only inside an open hover card. */
function CheckedAgo({ computedAtMs }: { computedAtMs: number | undefined }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{gitCheckedLabel(computedAtMs, now) ?? "not checked yet"}</>;
}

/** What the working tree holds that `HEAD` doesn't — first of the two chips
 * because its contents die with the checkout. Always rendered, `clean` at
 * zero: an absent chip and one you didn't notice look identical. Neutral
 * chrome, since uncommitted work is the normal state of an active task. */
export function UncommittedChip({ stats, onOpen, labeled = false }: DiffChipProps) {
  const { uncommittedFiles, uncommittedAdded, uncommittedRemoved, uncommittedCapped } = stats;
  const clean = uncommittedFiles === 0;
  // A `+` because the count is a floor: an untracked directory was too large
  // to list, so the real number is higher. The diff pane's banner names it.
  const filesLabel = `${uncommittedFiles}${uncommittedCapped ? "+" : ""}f`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            mouseAction("ab-toggle-diff", "agentboard");
            onOpen();
          }}
          className={`${CHIP_CLASS} hover:bg-accent ${
            clean ? "text-muted-foreground/60" : "font-medium text-foreground"
          }`}
        >
          <Pencil className="size-3" />
          <ChipLabel text="uncommitted" labeled={labeled} />
          {clean ? (
            <span>clean</span>
          ) : (
            <>
              <span>{filesLabel}</span>
              <span className="text-emerald-600 dark:text-emerald-400">
                +{fmtDiffLines(uncommittedAdded)}
              </span>
              <span className="text-red-600 dark:text-red-400">
                −{fmtDiffLines(uncommittedRemoved)}
              </span>
            </>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start">
        {/* `TooltipContent` is an `inline-flex` row — multi-paragraph content
            needs its own column wrapper or the lines lay out side by side. */}
        <div className="flex flex-col gap-0.5">
          <span>
            {clean
              ? "Nothing uncommitted — every change here is in a commit."
              : uncommittedCapped
                ? `At least ${uncommittedFiles} files not committed — an untracked directory was too large to list; open the diff for which one.`
                : `${uncommittedFiles} file${uncommittedFiles === 1 ? "" : "s"} not committed — staged, unstaged or untracked.`}
          </span>
          <span className="opacity-70">
            {clean
              ? "Deleting this checkout would lose nothing that isn't on the branch."
              : "Deleting this checkout destroys these. Untracked files count here but add no ± (they have no diff yet)."}
          </span>
          <span className="opacity-70">{withHint("Opens the diff pane", "ab-toggle-diff")}</span>
          <span className="opacity-70">
            <CheckedAgo computedAtMs={stats.computedAtMs} />
          </span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/** What this branch's commits hold that `comparedBase` doesn't. Shows
 * `commitsUnlanded`, not `commitsAhead`, whenever they disagree: the latter is
 * SHA reachability, so a squash merge leaves it pinned at 15 forever while the
 * content-based count correctly drops to 0. */
export function CommittedChip({ stats, onOpen, labeled = false }: DiffChipProps) {
  const { dir, committedAdded, committedRemoved, commitsAhead, commitsUnlanded, baseBranch } =
    stats;
  const base = comparedBaseLabel(stats);
  const [commits, setCommits] = useState<CommitStat[] | null>(null);

  const landedClean = commitsAhead > 0 && stats.landed != null && commitsUnlanded === 0;
  const partly = commitsUnlanded > 0 && commitsUnlanded !== commitsAhead;
  const tone = landedClean
    ? "text-muted-foreground/60 hover:bg-accent"
    : "text-muted-foreground hover:bg-accent hover:text-foreground";

  return (
    <HoverCard
      openDelay={250}
      onOpenChange={(open) => {
        if (open && commits == null) {
          void invoke<CommitStat[]>("ab_get_commit_stats", {
            dir,
            baseBranch: baseBranch?.trim() || null,
          }).then((c) => setCommits(c.unwrapOr([])));
        }
      }}
    >
      <HoverCardTrigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            mouseAction("ab-toggle-diff", "agentboard");
            onOpen();
          }}
          className={`${CHIP_CLASS} ${tone}`}
        >
          <GitCompare className="size-3" />
          <ChipLabel text="committed" labeled={labeled} />
          {commitsAhead === 0 ? (
            /* Unlabeled, the word doubles as the affordance; labeled,
               `committed` already names the chip. */
            <span>{labeled ? "none" : "diff"}</span>
          ) : landedClean ? (
            <span>
              {commitsAhead}c {stats.landed}
            </span>
          ) : (
            <>
              <span>{partly ? `${commitsUnlanded}/${commitsAhead}c` : `${commitsAhead}c`}</span>
              <span className="text-emerald-600 dark:text-emerald-400">
                +{fmtDiffLines(committedAdded)}
              </span>
              <span className="text-red-600 dark:text-red-400">
                −{fmtDiffLines(committedRemoved)}
              </span>
            </>
          )}
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        side="bottom"
        align="start"
        className="w-[28rem] max-w-[calc(100vw-2rem)]"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-1.5 text-[11px] leading-snug text-muted-foreground">
          {commitsAhead === 0 ? (
            <>Nothing committed beyond {base}.</>
          ) : landedClean ? (
            <>
              All {commitsAhead} commit{commitsAhead === 1 ? "" : "s"} are already on {base} (
              {stats.landed}) — the commit count stays put because the rewrite gave them new SHAs,
              but nothing here is outstanding.
            </>
          ) : partly ? (
            <>
              {commitsUnlanded} of {commitsAhead} commits are not on {base} yet; the rest already
              landed under different SHAs.
            </>
          ) : (
            <>
              {commitsAhead} commit{commitsAhead === 1 ? "" : "s"} not on {base} yet.
            </>
          )}{" "}
          <CheckedAgo computedAtMs={stats.computedAtMs} />.{" "}
          {withHint("Opens the diff pane", "ab-toggle-diff")}.
        </p>
        <CommitBreakdownPreview commits={commits} stats={stats} base={base} />
      </HoverCardContent>
    </HoverCard>
  );
}

/** The shell behind the `files`/`preview`/`jarvis` chips. `mouseAction` is
 * opt-in per chip: it must fire only for an exact shortcut twin, or the
 * keyboard-habit score counts a keystroke the user never passed up. */
function PaneOpenButton({
  glyph,
  label,
  title,
  onOpen,
  shortcutTwin,
  labeled = false,
}: PaneOpenButtonProps & {
  glyph: ReactNode;
  label: string;
  title: string;
  /** Shortcut id this chip duplicates, when it has one. */
  shortcutTwin?: string;
}) {
  return (
    // A chip scoring a click as a passed-up keystroke has to name it, so the
    // hint rides on `shortcutTwin` rather than the caller's `title`.
    <Hint label={title} shortcut={shortcutTwin}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (shortcutTwin) mouseAction(shortcutTwin, "agentboard");
          onOpen();
        }}
        className={`${CHIP_CLASS} text-muted-foreground hover:bg-accent hover:text-foreground`}
        aria-label={label}
      >
        {glyph}
        {labeled && <span>{label}</span>}
      </button>
    </Hint>
  );
}

/** `labeled` is the same width budget as [`DiffChipProps.labeled`]: these four
 * sit at the tail of the rail's git line, where their words cost ~170px. */
type PaneOpenButtonProps = { onOpen: () => void; labeled?: boolean };

/** Opens the folder's file tree as a pane. `FolderTree`, not lucide's `Files`:
 * two stacked pages is the near-universal *copy* glyph. */
export function FilesButton({ onOpen, labeled }: PaneOpenButtonProps) {
  return (
    <PaneOpenButton
      glyph={<FolderTree className="size-3" />}
      label="files"
      title="Browse every file in this checkout — @ any of them to Claude"
      onOpen={onOpen}
      labeled={labeled}
      shortcutTwin="ab-toggle-files"
    />
  );
}

/** Opens the rectangle Bevy draws into (`components/jarvis-pane.tsx`). Mounted
 * only when `agentboard.jarvisPane` is on. */
export function JarvisButton({ onOpen, labeled }: PaneOpenButtonProps) {
  return (
    <PaneOpenButton
      glyph={<Box className="size-3" />}
      label="jarvis"
      title="Open the native Bevy pane in this checkout's window — real GPU output, not DOM"
      onOpen={onOpen}
      labeled={labeled}
    />
  );
}

/** The task's own dev server embedded beside its terminals, with draw-on-page
 * feedback to that task's session. `Eye`, not `AppWindow`: a window outline is
 * one more generic rectangle next to the file glyph. */
export function PreviewButton({ onOpen, labeled }: PaneOpenButtonProps) {
  return (
    <PaneOpenButton
      glyph={<Eye className="size-3" />}
      label="preview"
      title="Preview this checkout's dev server — annotate the page and send it to the agent"
      onOpen={onOpen}
      labeled={labeled}
    />
  );
}

/** A real Chrome on the app-owned profile, tiled beside the terminals —
 * sign-ins made there persist across restarts. Mounted only when
 * `agentboard.browserPane` is on. */
export function BrowserButton({ onOpen, labeled }: PaneOpenButtonProps) {
  return (
    <PaneOpenButton
      glyph={<AppWindow className="size-3" />}
      label="chrome"
      title="Open a real Chrome in this window — log in once, it sticks"
      onOpen={onOpen}
      labeled={labeled}
    />
  );
}

/** Why a landed branch's checkout still isn't safe to delete, each condition
 * named with its own consequence — they are not equally serious: uncommitted
 * changes die with the directory, unlanded commits stay on the branch. */
function unsafeToDeleteReason(
  stats: Pick<FolderData, "dirty" | "commitsUnlanded">,
  base: string,
): string | null {
  const reasons: string[] = [];
  if (stats.dirty) reasons.push("uncommitted changes — deleting this checkout destroys them");
  if (stats.commitsUnlanded > 0) {
    reasons.push(
      `${stats.commitsUnlanded} commit${stats.commitsUnlanded === 1 ? "" : "s"} not on ${base} yet — those stay on the branch`,
    );
  }
  if (reasons.length === 0) return null;
  return reasons.join("; and ");
}

/** The folder's PR, tinted by `lib/pr-tone.ts`. Merged means the *PR's*
 * content is safe and says nothing about this checkout, so local uncommitted
 * or unlanded work overrides the merged purple with needs-you amber. */
export function PrChip({
  pr,
  stats,
}: {
  pr: PrItem;
  stats: Pick<FolderData, "dirty" | "commitsUnlanded" | "landed" | "comparedBase">;
}) {
  const merged = pr.state === "merged";
  const hasLocalWork = folderLandedButHasWork(stats, pr);
  const base = comparedBaseLabel(stats);
  const tone = hasLocalWork
    ? "border-amber-500/50 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 dark:text-amber-400"
    : PR_TONE[prTone(pr)].chip;
  return (
    <Hint
      label={
        hasLocalWork
          ? `${pr.title} — ${merged ? "merged" : stats.landed}, but this checkout still has ${unsafeToDeleteReason(stats, base)}. Commit or push before removing the task. Open on GitHub.`
          : merged
            ? `${pr.title} — merged. Open on GitHub.`
            : `${pr.title} — checks ${pr.checks}${pr.reviewState === "review_requested" ? ", review requested" : ""}. Open on GitHub.`
      }
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void openExternalUrl(pr.url);
        }}
        className={cn(
          "flex h-5 shrink-0 items-center gap-1 rounded-md border px-1.5 font-mono text-[10.5px] transition-colors",
          tone,
        )}
      >
        <GitPullRequest className="size-3" />#{pr.number}
        {hasLocalWork && <span aria-hidden>⚑</span>}
      </button>
    </Hint>
  );
}

/** An issue *manually linked* to this folder's bound task. Unlike a PR, an
 * issue has no branch, so it never auto-attaches — this only appears for one
 * put there by "Attach issue…", and detaching is a first-class action. */
export function IssueChip({ taskId, issue }: { taskId: number; issue: TaskIssueLink }) {
  const closed = issue.state === "closed";
  const tone = closed
    ? "border-purple-500/50 bg-purple-500/10 text-purple-600 hover:bg-purple-500/20 dark:text-purple-400"
    : "border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground";

  async function detach() {
    const result = await storeDetachTaskIssue(taskId, issue.repo, issue.number);
    if (result.isErr()) toast.error(`Couldn't detach — ${result.error.message}`);
    else toast.success(`Detached #${issue.number}`);
  }

  return (
    <DropdownMenu>
      <Hint
        label={`${issue.repo}#${issue.number} — ${closed ? "closed" : "open"}, linked to this task`}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "flex h-5 shrink-0 items-center gap-1 rounded-md border px-1.5 font-mono text-[10.5px] transition-colors",
              tone,
            )}
          >
            <CircleDot className="size-3" />#{issue.number}
          </button>
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="start" className="w-auto min-w-44">
        <DropdownMenuItem
          onSelect={() => void openExternalUrl(issue.url)}
          className="whitespace-nowrap"
        >
          <ExternalLink className="size-3.5" /> Open on GitHub
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => void detach()}
          className="whitespace-nowrap"
        >
          <Link2Off className="size-3.5" /> Detach issue
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The dialog behind `RepoMenu`'s "Attach issue…". The manual counterpart to
 * PR auto-attach: an issue has no branch to match a folder on. */
function AttachIssueDialog({
  open,
  onOpenChange,
  dir,
  taskId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dir: string;
  taskId: number;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<IssueItem[]>([]);
  const [searching, setSearching] = useState(false);

  // Debounced so typing doesn't fire a `gh` call per keystroke; the cleanup
  // cancels a pending timer so only the latest keystroke queries.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const handle = setTimeout(() => {
      void storeSearchIssues(dir, q).then((r) => {
        setResults(r.unwrapOr([]));
        setSearching(false);
      });
    }, 300);
    return () => clearTimeout(handle);
  }, [query, dir]);

  async function attach(issue: IssueItem) {
    onOpenChange(false);
    const result = await storeAttachTaskIssue(taskId, issue.repo, issue.number, issue.url);
    result.match({
      ok: () => toast.success(`Attached #${issue.number}`),
      err: (e) => toast.error(`Couldn't attach — ${e.message}`),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Attach issue</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search issues by title, number, or text…"
          />
        </div>
        <div className="max-h-80 min-h-10 overflow-auto">
          {searching ? (
            <p className="p-2 text-xs text-muted-foreground">
              <Loader2 className="mr-1 inline size-3 animate-spin" /> searching…
            </p>
          ) : results.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">
              {query.trim() ? "No matching issues." : "Type to search this repo's issues."}
            </p>
          ) : (
            <div className="flex flex-col">
              {results.map((issue) => (
                <button
                  key={`${issue.repo}#${issue.number}`}
                  type="button"
                  onClick={() => void attach(issue)}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                >
                  <CircleDot
                    className={cn(
                      "size-3.5 shrink-0",
                      issue.state === "closed" ? "text-purple-500" : "text-emerald-500",
                    )}
                  />
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    #{issue.number}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{issue.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** How this branch's work reached the base, straight from git. A squash merge
 * — how this repo's PRs land — is invisible to naive git checks, and a task
 * that never had a PR has no other evidence at all. Purple, matching
 * `PrChip`'s merged tint, since it reports the same status by other means. */
export function LandedBadge({ landed, base }: { landed: LandedVia; base: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex h-5 shrink-0 items-center gap-1 rounded-md border border-purple-500/50 bg-purple-500/10 px-1.5 font-mono text-[10.5px] text-purple-600 dark:text-purple-400">
          <GitMerge className="size-3" />
          {landed}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start">
        {`Git says this branch's work is already on ${base} (${landed}), with or without a PR.`}
      </TooltipContent>
    </Tooltip>
  );
}

/** {@link LandedBadge}, gated on a merged `PrChip` not already saying the same
 * thing — one signal per fact. */
export function FolderLandedBadge({
  folder,
  pr,
}: {
  folder: Pick<FolderData, "landed" | "comparedBase">;
  pr?: PrItem | null;
}) {
  if (!folder.landed || pr?.state === "merged") return null;
  return <LandedBadge landed={folder.landed} base={comparedBaseLabel(folder)} />;
}

/** The positive counterpart to `PrChip`'s amber warning (`folderSafeToDelete`).
 * A PR-less task never gets here by design: git can prove content landed but
 * not that it was *accepted*. Clicking reaches the same guarded confirmation
 * as the "···" menu — a louder path to it, not a shortcut around it. */
export function SafeToDeleteBadge({
  base,
  landed,
  onDeleteWorktree,
}: {
  base: string;
  /** Named in the tooltip, so the claim is attributable rather than asserted. */
  landed?: LandedVia | null;
  onDeleteWorktree: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDeleteWorktree();
          }}
          className="flex h-5 shrink-0 items-center gap-1 rounded-md border border-emerald-500/50 bg-emerald-500/10 px-1.5 font-mono text-[10.5px] text-emerald-600 transition-colors hover:bg-emerald-500/20 dark:text-emerald-400"
        >
          <Check className="size-3" /> safe to delete
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start">
        No uncommitted changes, and every commit has landed on {base}
        {landed ? ` (${landed})` : ""}. Nothing here would be lost — click to delete this worktree.
      </TooltipContent>
    </Tooltip>
  );
}

/** Weight per model family: Haiku/Sonnet neutral, Opus violet, Fable/Mythos
 * the cluster's only filled chip. Never amber (needs-you), never animated. */
const MODEL_TONE: Record<string, string> = {
  O: "border-violet-500/50 bg-violet-500/10 text-violet-600 dark:text-violet-400",
  F: "border-transparent bg-gradient-to-br from-fuchsia-500 to-violet-500 font-semibold text-white",
  M: "border-transparent bg-gradient-to-br from-fuchsia-500 to-violet-500 font-semibold text-white",
};

/** The live session's model as a boxed letter (`modelLetter`), weighted by
 * tier ({@link MODEL_TONE}). Nothing when the family is unrecognized. */
export function ModelBadge({ session }: { session: SessionData }) {
  const d = session.agentState?.details;
  const letter = modelLetter(d?.model);
  if (!session.live || !letter) return null;
  return (
    <Hint label={modelContextLabel(d) ?? undefined}>
      <span
        className={cn(
          "flex h-4 shrink-0 items-center rounded-md border px-1 font-mono text-[10px] font-medium",
          MODEL_TONE[letter] ?? "border-border bg-muted/30 text-muted-foreground",
        )}
      >
        {letter}
      </span>
    </Hint>
  );
}

/** Context/cache health for a live agent session, in the row's meta cluster.
 * Quiet mono text: `41% ◔4m` while warm (⧗ for a 1h cache), `41% ❄` when cold,
 * and an ice-washed `❄ 63% compact` pill when cold at/over the threshold. */
export function CacheBadge({
  session,
  now,
  compactPct,
  onCompact,
  long = false,
}: {
  session: SessionData;
  now: number;
  compactPct: number;
  /** When set, the ❄ compact pill is clickable and runs /compact directly. */
  onCompact?: () => void;
  /** Long form spells out "compact"; the rail uses the short `❄ N%`. */
  long?: boolean;
}) {
  const d = session.agentState?.details;
  if (!session.live || !d?.contextUsed || !d.contextMax) return null;
  const pct = ctxPct(d);
  const cold = isCold(d, now);
  const what = modelContextLabel(d);
  const lead = what ? `${what} — ` : "";

  if (needsCompact(d, now, compactPct)) {
    // Pulses like the busy dot: a live nudge, not a passive fact.
    const pill =
      "shrink-0 animate-pulse rounded-md border border-sky-500/50 bg-sky-500/10 px-1.5 font-mono text-[10.5px] text-sky-500";
    const hint = `${lead}${pct}% of context used and the prompt cache expired, so resuming re-reads everything.`;
    return onCompact ? (
      <Hint label={`${hint} Click to /compact.`}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onCompact();
          }}
          className={cn(pill, "hover:bg-sky-500/20")}
        >
          ❄ {pct}%{long && " compact"}
        </button>
      </Hint>
    ) : (
      <Hint label={`${hint} Consider /compact or a fresh session.`}>
        <span className={pill}>
          ❄ {pct}%{long && " compact"}
        </span>
      </Hint>
    );
  }

  const expiring = isCacheExpiring(d, now);
  const warmth = cold
    ? "❄"
    : `${d.cacheTtlMs === 3_600_000 ? "⧗" : "◔"}${fmtMins(d.cacheExpiresAt! - now)}`;
  return (
    <Hint
      label={
        cold
          ? `${lead}prompt cache expired`
          : expiring
            ? `${lead}prompt cache expires soon; any message re-warms it, a cold resume re-reads everything at full price`
            : `${lead}prompt cache warm, time left`
      }
    >
      <span
        className={cn(
          "shrink-0 font-mono text-[10.5px]",
          expiring
            ? "text-amber-500"
            : cold
              ? "font-medium text-sky-500"
              : "text-muted-foreground/70",
        )}
      >
        {/* Fixed 4ch slot: the percent is 1–3 digits, and without a reserved
            width the rail's meta columns never line up vertically. */}
        <span className="inline-block w-[4ch] text-right">{pct}%</span>{" "}
        <span className="inline-block min-w-[4ch]">{warmth}</span>
      </span>
    </Hint>
  );
}

/** Millis → whole minutes for the cache countdown, floored at 1 ("<1m" ≈ 1m). */
export function fmtMins(ms: number): string {
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

/** The one place every secondary action for a checkout lives, shared verbatim
 * by the rail's headers and the working-context band so the two can't diverge.
 * "Mark quiet" forces the folder into the filter's stub row whatever its
 * actual activity (`isFolderFiltered`). */
export function RepoMenu({
  path,
  onRemove,
  dir,
  isWorktree,
  quiet,
  onNewTask,
  onDeleteWorktree,
  deleteLabel,
  taskId,
  dirMissing,
  ghost = false,
}: {
  path?: string;
  onRemove: () => void;
  dir: string;
  /** Worktree checkouts have no "Remove from rail": auto-discovered from the
   * primary, they would reappear next poll. */
  isWorktree?: boolean;
  quiet: boolean;
  /** Set only on a task-convention repo. */
  onNewTask?: () => void;
  /** Set only on worktree checkouts. */
  onDeleteWorktree?: () => void;
  /** A detached row's directory is already gone, so "Delete worktree…" would
   * name something that isn't there. */
  deleteLabel?: string;
  /** Enables "Attach issue…" — an issue can only be linked to a task. */
  taskId?: number;
  /** A gone directory can't be opened in an editor, so the item hides. */
  dirMissing?: boolean;
  /** See [`IconBtn`]'s `ghost`. */
  ghost?: boolean;
}) {
  const [attachOpen, setAttachOpen] = useState(false);

  async function syncNow() {
    (await abSyncRepo(dir)).match({
      ok: (result) => {
        // Already in flight elsewhere — ignore rather than double-toast.
        if (!result.started) return;
        if (result.ok) toast.success("Synced with GitHub");
        else toast.error(result.message ?? "Sync failed");
      },
      err: (e) => toast.error(e.message),
    });
  }

  async function toggleQuiet() {
    const result = await invoke<void>("ab_set_folder_quiet", {
      dir,
      quiet: !quiet,
    });
    if (result.isErr()) toast.error(`Couldn't update — ${result.error.message}`);
  }

  return (
    <>
      <DropdownMenu>
        <Hint label="More actions">
          <DropdownMenuTrigger asChild>
            <Button
              variant={ghost ? "ghost" : "outline"}
              size="icon-xs"
              aria-label="More actions"
              className="text-muted-foreground"
            >
              <MoreVertical className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </Hint>
        <DropdownMenuContent align="end" className="w-auto min-w-56">
          {path && (
            <>
              <DropdownMenuLabel className="font-mono text-[11px] font-normal whitespace-nowrap text-muted-foreground">
                {path}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
            </>
          )}
          {!dirMissing && (
            <DropdownMenuItem
              onSelect={() => void openInExternalEditor(dir, { where: "rail.menu" })}
              className="whitespace-nowrap"
            >
              <ExternalLink className="size-3.5" /> Open in editor
            </DropdownMenuItem>
          )}
          {onNewTask && (
            <DropdownMenuItem
              onSelect={() => {
                mouseAction("ab-new-task", "agentboard");
                onNewTask();
              }}
              className="whitespace-nowrap"
            >
              <FolderPlus className="size-3.5" /> New task…
              <DropdownMenuShortcut>{shortcutHint("ab-new-task")}</DropdownMenuShortcut>
            </DropdownMenuItem>
          )}
          {onDeleteWorktree && (
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => {
                mouseAction("ab-remove-task", "agentboard");
                onDeleteWorktree();
              }}
              className="whitespace-nowrap"
            >
              <Trash2 className="size-3.5" /> {deleteLabel ?? "Delete worktree…"}
              <DropdownMenuShortcut>{shortcutHint("ab-remove-task")}</DropdownMenuShortcut>
            </DropdownMenuItem>
          )}
          {(!dirMissing || onNewTask || onDeleteWorktree) && <DropdownMenuSeparator />}
          <DropdownMenuItem onSelect={() => void syncNow()} className="whitespace-nowrap">
            <RefreshCw className="size-3.5" /> Sync now
          </DropdownMenuItem>
          {taskId != null && (
            <DropdownMenuItem onSelect={() => setAttachOpen(true)} className="whitespace-nowrap">
              <Link className="size-3.5" /> Attach issue…
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => void toggleQuiet()} className="whitespace-nowrap">
            {quiet ? (
              <>
                <Eye className="size-3.5" /> Unmark quiet
              </>
            ) : (
              <>
                <EyeOff className="size-3.5" /> Mark quiet
              </>
            )}
          </DropdownMenuItem>
          {!isWorktree && (
            <DropdownMenuItem
              variant="destructive"
              onSelect={onRemove}
              className="whitespace-nowrap"
            >
              <Trash2 className="size-3.5" /> Remove from rail
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {taskId != null && (
        <AttachIssueDialog
          open={attachOpen}
          onOpenChange={setAttachOpen}
          dir={dir}
          taskId={taskId}
        />
      )}
    </>
  );
}

/** What a pane tile shows with no content: a gone folder, or a crashed shell
 * (which passes `detail` and `tone="alert"`). Removal is the only affordance
 * on purpose — restarting is the rail's job. */
export function PanePlaceholder({
  label,
  detail,
  tone = "muted",
  focused = false,
  onRemove,
}: {
  label: string;
  detail?: string;
  tone?: "muted" | "alert";
  /** See the focus-ring rule at `screens/agentboard.tsx`'s `focusedPaneId`. */
  focused?: boolean;
  onRemove: () => void;
}) {
  return (
    <div
      className={cn(
        "flex h-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-muted-foreground",
        focused && "border-violet-500/60",
        tone === "alert" && "border-amber-500/40",
      )}
    >
      <span className="text-sm">{label}</span>
      {detail && <span className="font-mono text-xs text-amber-500">{detail}</span>}
      <button
        type="button"
        onClick={() => {
          // Only the focused tile is the chord's twin — see `PaneHeader`'s `focused`.
          if (focused) mouseAction("ab-close-pane", "agentboard");
          onRemove();
        }}
        className="flex items-center gap-1 font-mono text-xs hover:text-sky-500"
      >
        <X className="size-3" /> close pane {focused && shortcutHint("ab-close-pane")}
      </button>
    </div>
  );
}
