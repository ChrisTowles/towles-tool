import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import {
  AppWindow,
  Box,
  Check,
  ChevronDown,
  CircleDot,
  ExternalLink,
  Eye,
  EyeOff,
  Files,
  FolderPlus,
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
import { openExternalUrl } from "@/lib/open-url";
import { PR_TONE, prTone } from "@/lib/pr-tone";
import { mouseAction } from "@/lib/shortcut-coach";
import { shortcutHint, withHint } from "@/lib/shortcuts";
import { invoke } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/**
 * Shared atoms for the Agentboard UI — one visual language for the rail rows,
 * folder headers, pane chrome, and the working-context band, so each surface
 * composes the same pieces instead of hand-rolling its own variants.
 */

/** A small square icon action that *reads as a button* (bordered, hover fill)
 * — shadcn outline button at icon-xs, mono glyph or lucide icon inside.
 * `title` renders as a real (Radix) tooltip: instant, styled, and — unlike a
 * native `title` attribute or CSS `:hover` reveal — reliable in the Tauri
 * WebKitGTK webview. It doubles as the `aria-label`, since the glyph alone
 * says nothing. Clicks never bubble into the row/header the button sits on.
 *
 * `ghost` drops the resting border, and is what every *rail row* uses. A pane
 * header carries one toolbar on screen; the rail repeats one per repo and per
 * folder, so the bordered form put a dozen boxes down a column whose whole job
 * is to be scanned — the same "a box is a control or an alert, not a fact"
 * rule the git chips follow, applied to a control that is simply repeated too
 * often to shout. The hover fill still arrives when you point at it. */
export function IconBtn({
  title,
  onClick,
  className,
  ghost = false,
  children,
  ...props
}: {
  title: string;
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
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          className={cn("font-mono text-xs text-muted-foreground", className)}
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{title}</TooltipContent>
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

/** Status dot mirroring `statusColor`; pulses while busy. A session with no
 * live PTY shows a hollow ring — the record exists but nothing is running.
 * "Look at this" is the row's amber border (`sessionCatchesEye`), not the
 * dot — a resting board stays still.
 *
 * `waiting` renders as a hollow ring rather than a filled disc: a plain
 * blue circle reads too close to `complete`'s green at a glance (color is
 * the only cue between them), and can even be mistaken for a `busy` dot
 * caught mid-`animate-pulse` dip. The ring borrows the same shape language
 * already used for "not started" — open = paused/pending on you, filled =
 * something happened — so it's a real non-color cue, not just another hue,
 * while staying quieter than the row-wide amber `sessionCatchesEye` wash
 * that already flags a waiting session for real attention. */
export function Dot({ session }: { session: SessionData }) {
  if (!session.live) {
    return (
      <span
        title="not started"
        className="size-2 shrink-0 rounded-full border-[1.5px] border-muted-foreground/50 bg-transparent"
      />
    );
  }
  const st = session.agentState?.status;
  if (st === "waiting") {
    return (
      <span
        title="agent waiting — needs your input"
        className="size-2 shrink-0 rounded-full border-[1.5px] border-blue-500 bg-transparent"
      />
    );
  }
  return (
    <span
      title={st ? `agent ${st}` : "shell running, no agent"}
      className={cn(
        "size-2 shrink-0 rounded-full",
        st ? statusColor(st) : "bg-muted-foreground/40",
        st === "busy" && "animate-pulse",
      )}
    />
  );
}

/** A status-colored micro-dot + count, e.g. "●3", for agent rollups (the rail
 * chip and the nav sidebar). Color always derives from `statusColor`, and
 * `waiting` gets the same hollow-ring shape as the `Dot` atom, so the
 * buckets can never drift from it. */
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

/** Shown on a collapsed folder/repo header: a colored dot + count telling you
 * running sessions are hidden inside (so a collapsed folder doesn't look
 * asleep when agents are working in it). Nothing when nothing is live. */
export function CollapsedLive({ sessions }: { sessions: SessionData[] }) {
  const color = collapsedLiveColor(sessions);
  if (!color) return null;
  const n = sessions.filter((s) => s.live).length;
  return (
    <span
      className="flex shrink-0 items-center gap-1"
      title={`${n} running session${n > 1 ? "s" : ""} hidden — expand to see`}
    >
      <span className={cn("size-2 rounded-full", color)} />
      <span className="font-mono text-[10px] text-muted-foreground/70">{n}</span>
    </span>
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

/** Violet is the "a Claude session is live here" color across the app — the
 * pane headers, the selection chip, and the in-editor hint all use it, so it
 * reads as one signal rather than three unrelated decorations. */
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
    <span
      title={title}
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-md border border-violet-500/50 bg-violet-500/10 px-1.5 font-mono text-[10.5px] text-violet-500",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** rust-analyzer bridge state, shown only when there is something to say (a
 * non-Rust checkout renders nothing). This is the bridge's only observable
 * surface — it started as a spike whose failures went to console.warn. */
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
    <span
      title={title}
      className={cn(
        "shrink-0 rounded-md border px-1.5 font-mono text-[10.5px] whitespace-nowrap",
        look,
      )}
    >
      rust-analyzer {state === "starting" ? "…" : state}
    </span>
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

/** Marks a tracked checkout whose directory no longer exists on disk — a
 * "ghost". Deliberately grayscale (dashed, dimmed): a missing dir is a dead
 * state, not the live-attention amber the needs-you math owns, so it reads as
 * "gone/inert" rather than "look at me". Grayscale tokens carry light + dark. */
export function GhostBadge() {
  return (
    <span
      className="shrink-0 rounded-md border border-dashed border-muted-foreground/40 px-1 font-mono text-[10px] text-muted-foreground/70"
      title="This checkout's directory is gone (moved or deleted). Untrack it, or restore the directory to bring it back."
    >
      ⚠ missing
    </span>
  );
}

/** The `⎇ branch` line under a checkout's name. Worktree tasks are the common
 * case in the rail, so they stay quiet (muted, like the rest of the git row);
 * the *primary* checkout — the one clone whose `.git` is load-bearing for
 * every worktree — is the special row, and carries the sky tint that used to
 * be a "wt" badge on every task. */
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
    <span
      className={cn(
        "min-w-0 truncate font-mono text-[11px]",
        isWorktree ? "text-muted-foreground" : "text-sky-500",
      )}
      // Always the full branch, because this is the element every surface
      // truncates first: the rail row and the band both spend their slack on
      // it, so without the tooltip a long branch is simply unreadable.
      title={
        isWorktree
          ? branch
          : `${branch} — primary checkout, the main clone; its .git is load-bearing for every worktree`
      }
      onClick={onClick}
    >
      ⎇ {branch}
    </span>
  );
}

/** Shown on a worktree checkout mid-delete (`task_delete` in flight). The rail
 * row itself dims and goes `pointer-events-none` around this badge (see
 * `RepoGroup`'s `deletingDirs`/`FolderHeader`'s `deleting` prop) — this is
 * just the label explaining *why* the row went inert, same job `GhostBadge`
 * does for a missing directory. Red (not the neutral gray of `GhostBadge`):
 * unlike a ghost, which is passively gone, this is an active, irreversible
 * deletion in progress.
 *
 * `label` is the live phase text from `task://delete_progress` ("running
 * teardown command", "deleting git worktree", …); a static "deleting…" until
 * the first event for this dir lands (browser dev never gets one at all). */
export function DeletingBadge({ label }: { label?: string }) {
  return (
    <span
      className="flex shrink-0 items-center gap-1 rounded-md border border-red-500/40 bg-red-500/10 px-1 font-mono text-[10px] text-red-600 dark:text-red-400"
      title={
        label ? `Deleting this worktree from disk — ${label}…` : "Deleting this worktree from disk…"
      }
    >
      <Loader2 className="size-2.5 animate-spin" /> {label ? `${label}…` : "deleting…"}
    </span>
  );
}

/** Shown on a checkout whose setup step (`TT_TASK_SETUP` — an install) is
 * running, with how long it's been going. Setup runs after `task_create`
 * returns, so the pending row is already gone and the rail shows an ordinary
 * folder; this says the task isn't finished being built.
 *
 * Sky, not `DeletingBadge`'s red or `PortDriftBadge`'s amber: nothing is
 * wrong and nothing needs doing. The row stays interactive throughout. */
export function SettingUpBadge({ since, now }: { since: number; now: number }) {
  return (
    <span
      className="flex shrink-0 items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/10 px-1 font-mono text-[10px] text-sky-600 dark:text-sky-400"
      title="Running this task's setup step (TT_TASK_SETUP) — an install, so it can take a while"
    >
      <Loader2 className="size-2.5 animate-spin" /> setup {fmtElapsed(now - since)}
    </span>
  );
}

/** Marks a folder where a live pane's ports have drifted from what `.env`
 * currently claims — a sibling task's re-render (or a manual `tt task env`)
 * rotated a port this pane already bound to. Amber like `NeedsBadge`: unlike
 * the grayscale `GhostBadge`, this is something worth acting on (restart the
 * pane, or re-run `tt task env` and restart whatever's bound to the stale
 * port), not a dead state. */
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

/** Which branch every git stat on this folder was measured against — `vs
 * main` or `vs docs/readme-task-clean` for a task with a different creation
 * base — next to the branch name so the ↑↓/±  numbers beside it are never
 * ambiguous about what they mean. */
export function ComparedBaseBadge({
  folder,
}: {
  folder: Pick<FolderData, "comparedBase" | "baseBranch" | "taskBaseBranch">;
}) {
  const label = comparedBaseLabel(folder);
  const manual = Boolean(folder.baseBranch?.trim());
  return (
    <span
      className="shrink-0 px-0.5 font-mono text-[10px] text-muted-foreground/70"
      title={
        manual
          ? `Diffs against "${label}" — your override for this folder`
          : folder.taskBaseBranch
            ? `Diffs against "${label}" — the ref this task was created from`
            : `Diffs against "${label}" (origin/main-or-master auto-detect)`
      }
    >
      vs {label}
    </span>
  );
}

/** How far `comparedBase` has moved ahead of this branch — the old `↓2`, but
 * stated as the thing you'd actually do about it.
 *
 * Behind-ness is not a statistic about your work, it's a fact about someone
 * else's that has one response (rebase or merge the base in), which is why it
 * left the ahead/behind pair and became its own chip. Ahead-ness went the
 * other way, into `DiffButton`'s commit count, where it sits next to the ±
 * that belongs to it. Renders nothing when the base hasn't moved.
 *
 * The loudest of the three git chips, and the only *filled* one — it is the
 * one that asks for an action rather than reporting a quantity, so it should
 * be the thing the eye catches in the row. Weight and fill do that instead of
 * a hue: amber is spoken for (needs-you) and a base that has moved is far too
 * common to spend it on — nearly every row shows this chip most of the day,
 * which is exactly the kind of standing glow that teaches you to stop seeing
 * a color. See the `folder-rail-ui` skill's "two accent hues, one rule each".
 *
 * Glyph + count, not the words "base moved N": on the rail this chip shares
 * one line with the branch and both diff chips, and at ~95px the sentence was
 * the single widest thing that wasn't a number — enough to push the line into
 * a second and third row. The refresh glyph already says "bring this up to
 * date", the count says how far, and the tooltip carries the sentence for
 * whoever hasn't met the chip yet.
 */
export function BaseMovedChip({
  stats,
}: {
  stats: Pick<FolderData, "commitsBehind" | "comparedBase" | "baseBranch" | "taskBaseBranch">;
}) {
  const { commitsBehind } = stats;
  if (commitsBehind === 0) return null;
  const base = comparedBaseLabel(stats);
  return (
    <span
      className={`${CHIP_CLASS} bg-muted font-medium text-foreground`}
      title={`Base moved: ${base} has ${commitsBehind} commit${commitsBehind === 1 ? "" : "s"} this branch doesn't — rebase or merge ${base} in to catch up. Not a measure of your own work.`}
    >
      <RefreshCw className="size-3" />
      {commitsBehind}
    </span>
  );
}

/** One row of the `DiffButton` hover's per-commit breakdown: short SHA,
 * truncated subject, and that commit's own ± tally. */
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

/** The per-commit breakdown inside `CommittedChip`'s hover card: every commit
 * `comparedBase` doesn't have, oldest first, with its own ± tally, then the
 * committed total, then the uncommitted work on its own row below a divider —
 * a many-commit branch's ± tally isn't one anonymous blob.
 *
 * The two totals are never added together. This card is where the whole
 * distinction is spelled out in words, because the chips themselves only have
 * room for numbers. Commits are fetched lazily (only once the card actually
 * opens) and cached for the folder's lifetime in the parent's state. */
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
  /** Spell out what the chip counts (`uncommitted` / `committed`) instead of
   * leaning on the icon alone.
   *
   * On for the pane header, off for the rail — not a preference but a width
   * budget: the rail row already carries a branch, a PR chip, issue chips and
   * status badges, and two extra words there push the numbers off the end.
   * The icons stay meaningful in both places; the header is where there's
   * room to say which is which without hovering. */
  labeled?: boolean;
};

/** Shared chip chrome for the git-stat chips, so they can't drift apart.
 *
 * **No resting border.** A rail row carried ~20 identical bordered pills —
 * every button, every count, every badge — so nothing in it was loud and
 * nothing was quiet, and the eye had no entry point. The rule that replaced
 * that: a *box* means a control or an alert, plain type means a fact. Diff
 * stats are facts, and mono digits with a glyph in front of them are already
 * legible at 10.5px; the `folder-rail-ui` skill's own recipe for a diff stat
 * has always been a bare `font-mono` span, so the pills were the drift.
 *
 * The box comes back on hover, where it says "this is clickable" at the moment
 * that's the question being asked. */
const CHIP_CLASS =
  "flex h-5 shrink-0 items-center gap-1 rounded-md px-1 font-mono text-[10.5px] transition-colors";

/** The word naming what a chip counts, shown on wide surfaces only (see
 * [`DiffChipProps.labeled`]). Muted so the *number* stays the thing the eye
 * lands on — the label is there to be read once, not competed with. */
function ChipLabel({ text, labeled }: { text: string; labeled: boolean }) {
  if (!labeled) return null;
  return <span className="opacity-60">{text}</span>;
}

/** Ticking "checked 4s ago", re-rendered on its own 1s interval.
 *
 * A caller-passed `now` won't do: the rail only re-renders when the backend
 * snapshot changes, which is exactly the case where the age is *not* moving,
 * so the label would freeze precisely when the user is asking whether
 * anything is alive. Mounted only inside hover cards/tooltips, so the timer
 * exists for the one chip being inspected, not for every row on the rail. */
function CheckedAgo({ computedAtMs }: { computedAtMs: number | undefined }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{gitCheckedLabel(computedAtMs, now) ?? "not checked yet"}</>;
}

/** Uncommitted work: what the working tree holds that `HEAD` doesn't.
 *
 * First of the two chips because it is the only one whose contents **die with
 * the checkout** — that consequence, not size, is what orders them. Amber for
 * the same reason: it's the number to look at before deleting a worktree.
 *
 * **Always rendered, including at zero**, where it reads a muted `clean`. It
 * used to disappear on a clean tree, on the reasoning that its presence was
 * itself the `dirty` signal. That was wrong in the way that matters here: an
 * absent chip and a chip you didn't notice look identical, so "how much is
 * uncommitted?" — the exact question this pair exists to answer — had no
 * answer on screen for the clean case. A visible zero is an answer; nothing is
 * not. It also keeps the two chips side by side at a fixed position, so the
 * eye learns "left is uncommitted, right is committed" instead of re-reading
 * a row whose contents move.
 *
 * **Neutral chrome, not amber**, though a dirty tree is the more consequential
 * of the two counts. Amber means *needs you* in this app — a waiting or errored
 * agent, a failing PR — and uncommitted work is the normal state of any task
 * being worked on, so painting it amber put a standing false alarm on nearly
 * every active row and diluted the hue where it does mean something. The ±
 * keeps its green/red, which is the diff-stat convention rather than a status
 * color. See the `folder-rail-ui` skill's "two accent hues, one rule each". */
export function UncommittedChip({ stats, onOpen, labeled = false }: DiffChipProps) {
  const { uncommittedFiles, uncommittedAdded, uncommittedRemoved } = stats;
  const clean = uncommittedFiles === 0;
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
            clean
              ? // Nothing at stake: stay out of the way, and let the gap in
                // weight against the dirty state below carry the difference.
                "text-muted-foreground/60"
              : // Full-weight — this is work that exists nowhere but this
                // checkout, so it earns the loudest treatment available short
                // of the needs-you hue.
                "font-medium text-foreground"
          }`}
        >
          <Pencil className="size-3" />
          <ChipLabel text="uncommitted" labeled={labeled} />
          {clean ? (
            <span>clean</span>
          ) : (
            <>
              <span>{uncommittedFiles}f</span>
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

/** Committed work: what this branch's commits hold that `comparedBase`
 * doesn't. Always visible (even at zero, so the diff pane stays findable
 * from every row) and hovering previews the per-commit breakdown.
 *
 * **The count shown is `commitsUnlanded`, not `commitsAhead`, whenever they
 * disagree** — and that is the whole point of the chip. `commitsAhead` is SHA
 * reachability, so a rebase or squash merge that rewrote the commits leaves it
 * pinned at 15 forever; `commitsUnlanded` is content-based and correctly drops
 * to 0. The old chip led with the reachability number and mentioned the truth
 * only in a tooltip, so a finished task read as fifteen commits of pending
 * work. Now a fully-landed branch says so in a word, and a partly-landed one
 * shows `4/15c` rather than picking one number and hiding the other. */
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
            /* Unlabeled, the word has to double as the affordance ("this
               opens the diff"), since there's no number to show. Labeled,
               `committed` already names the chip, so the value slot can say
               plainly that there is nothing — matching `clean` next to it. */
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

/** One folder-header chip that opens a pane — the shared shell behind the
 * `files`/`preview`/`jarvis` buttons below, which differ only in glyph,
 * word and tooltip. `stopPropagation` because every one of these sits inside a
 * clickable folder row that would otherwise also fire.
 *
 * `mouseAction` is opt-in per chip rather than automatic: it must fire only for
 * a chip that is the exact twin of a keyboard shortcut, or the keyboard-habit
 * score counts a keystroke the user never passed up (see `lib/shortcut-coach`). */
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
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (shortcutTwin) mouseAction(shortcutTwin, "agentboard");
        onOpen();
      }}
      className={`${CHIP_CLASS} text-muted-foreground hover:bg-accent hover:text-foreground`}
      // A chip that scores a click as a passed-up keystroke has to name the
      // keystroke, so the hint rides on `shortcutTwin` rather than each
      // caller's `title`.
      title={shortcutTwin ? withHint(title, shortcutTwin) : title}
      aria-label={labeled ? undefined : label}
    >
      {glyph}
      {labeled && <span>{label}</span>}
    </button>
  );
}

/** What the four pane-open buttons take from their caller.
 *
 * `labeled` is the same width budget as [`DiffChipProps.labeled`], and set the
 * same way round: on for the pane header, off for the rail. These four sit at
 * the tail of the rail's git line, holding their width even while faded out,
 * so their words cost ~170px of a line that also has to fit a branch and two
 * ± chips — the cost that used to buy a third row of height. The glyph plus
 * the tooltip is the whole button on the rail; the header, which has room, is
 * where they say which is which without hovering. */
type PaneOpenButtonProps = { onOpen: () => void; labeled?: boolean };

/** The files entry point, DiffButton's sibling: opens the folder's full file
 * tree as a pane ("tell claude about any file"), always visible for the same
 * findability reason. */
export function FilesButton({ onOpen, labeled }: PaneOpenButtonProps) {
  return (
    <PaneOpenButton
      glyph={<Files className="size-3" />}
      label="files"
      title="Browse every file in this checkout — @ any of them to Claude"
      onOpen={onOpen}
      labeled={labeled}
      shortcutTwin="ab-toggle-files"
    />
  );
}

/** Opens the folder's native pane — a rectangle of the window Bevy draws into
 * (`components/jarvis-pane.tsx`), tiled beside the folder's terminals. Only
 * mounted when `agentboard.jarvisPane` is on, so the proof-of-concept costs
 * nothing (and shows nothing) until it's asked for. */
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

/** Opens the folder's live-preview pane — the task's own dev server embedded
 * beside its terminals, with draw-on-page feedback to that task's session. */
export function PreviewButton({ onOpen, labeled }: PaneOpenButtonProps) {
  return (
    <PaneOpenButton
      glyph={<AppWindow className="size-3" />}
      label="preview"
      title="Preview this checkout's dev server — annotate the page and send it to the agent"
      onOpen={onOpen}
      labeled={labeled}
    />
  );
}

/** Precise reason a landed branch's checkout still isn't safe to delete — the
 * two conditions `folderHoldsNoWork` checks, each named *with its own
 * consequence*, so the tooltip never leaves you guessing which one is blocking
 * it or how much it matters. Null once both are satisfied (the caller has
 * nothing left to warn about).
 *
 * The two axes are independent and are not equally serious, which is the whole
 * point of separating them: uncommitted changes exist nowhere but this
 * directory and deleting it destroys them, while unlanded commits stay on the
 * branch and survive. Collapsing both into one "still has work" phrase is what
 * made the old warning unreadable. */
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

/** Clickable `#N` chip for the folder's PR, tinted by the shared PR tone map
 * (`lib/pr-tone.ts`: cyan CI running · red failed/closed · green passing ·
 * gray no checks). Once merged the chip normally turns purple — the task is
 * done, time to `tt task rm` it — but merged only means the *PR's* content
 * is safe; it says nothing about this checkout. If `stats` shows uncommitted
 * changes or commits that haven't landed on the base branch yet
 * (`folderHoldsNoWork`), the chip turns amber (this app's needs-you hue)
 * instead, since removing the task would lose that work despite the PR being
 * merged — see the adjacent `SafeToDeleteBadge` for the positive case.
 * Opens GitHub. */
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
      title={
        hasLocalWork
          ? `${pr.title} — ${merged ? "merged" : stats.landed}, but this checkout still has ${unsafeToDeleteReason(stats, base)}. Commit or push before removing the task. Open on GitHub.`
          : merged
            ? `${pr.title} — merged. Open on GitHub.`
            : `${pr.title} — checks ${pr.checks}${pr.reviewState === "review_requested" ? ", review requested" : ""}. Open on GitHub.`
      }
    >
      <GitPullRequest className="size-3" />#{pr.number}
      {hasLocalWork && <span aria-hidden>⚑</span>}
    </button>
  );
}

/** Clickable `#N` chip for a GitHub issue *manually linked* to this folder's
 * bound task — the issue-side mirror of {@link PrChip}. Unlike a PR, an issue
 * has no branch, so it never auto-attaches: this chip only appears for issues
 * put there by "Attach issue…" (`RepoMenu`), and it's the visible answer to
 * "does this task hold that issue?". A closed issue tints purple (done, like
 * `PrChip`'s merged tint); an open one stays a quiet neutral. The chip is a
 * menu: open on GitHub, or detach (issues are user-managed, so removal is a
 * first-class action, not a Board-only chore). */
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
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "flex h-5 shrink-0 items-center gap-1 rounded-md border px-1.5 font-mono text-[10.5px] transition-colors",
            tone,
          )}
          title={`${issue.repo}#${issue.number} — ${closed ? "closed" : "open"}, linked to this task`}
        >
          <CircleDot className="size-3" />#{issue.number}
        </button>
      </DropdownMenuTrigger>
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

/** The dialog behind `RepoMenu`'s "Attach issue…" — searches the folder repo's
 * issues (all states, via `store_search_issues`) and links the picked one to
 * the folder's bound task. Search is debounced so typing doesn't fire a `gh`
 * call per keystroke; a blank query shows nothing. This is the manual,
 * deliberate counterpart to PR auto-attach — issues have no branch to match a
 * folder on, so associating one is always an explicit act. */
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

  // Debounced live search: a blank query resets to nothing without shelling
  // out; otherwise wait for a typing pause before the `gh` round-trip. The
  // cleanup cancels a pending timer so only the latest keystroke queries, and
  // browser dev (`NotInTauri`) quietly yields an empty list rather than a
  // toast on every pause.
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

/** How this branch's work reached the base, straight from git — `merged`,
 * `rebase-merged` or `squash-merged` (see `FolderData.landed`).
 *
 * This exists because a squash merge — how this repo's PRs land — is invisible
 * to every naive git check, so a fully merged task used to read as outstanding
 * work with nothing on screen to contradict it. It also covers the task that
 * never had a PR at all, where GitHub can say nothing and this is the only
 * evidence there is.
 *
 * Purple, matching `PrChip`'s merged tint, because it reports the *same*
 * status by other means — this is "it landed", not the separate, actionable
 * "and nothing here would be lost" that `SafeToDeleteBadge` says in emerald.
 * A plain `<span>`: a fact, not a control (rule: static things must not look
 * clickable). Gating lives in {@link FolderLandedBadge}. */
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

/** {@link LandedBadge} plus the rule about when it may show at all: only when a
 * merged `PrChip` isn't already saying the same thing — one signal per fact.
 * This is the whole point of `landed`: a task with no PR (or one whose branch
 * merged locally) can still report that it's finished. */
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

/** The positive counterpart to `PrChip`'s amber warning: a folder whose PR
 * merged, has no uncommitted changes, and has every commit landed on its
 * base — `folderSafeToDelete`. A PR-less task never gets here, by design: git
 * can prove content landed but not that it was *accepted*, so the affirmative
 * claim is gated on the merged PR. Deliberately louder than a bare chip (the bug
 * this replaces: a subdued purple "#N" was the *only* signal, indistinguishable
 * at a glance from an ordinary merged-but-still-active checkout). Emerald
 * (this app's "done/complete" hue — matches `statusColor`'s `complete` dot and
 * the diff `+` count) rather than the PR chip's purple, so it reads as a
 * distinct, actionable "you're done here" rather than another PR-state tint.
 * Clicking goes straight to the same guarded delete-worktree confirmation as
 * the folder's "···" menu — not a shortcut around it, just a louder path to
 * it, since this state is exactly when you'd want to take that action. */
export function SafeToDeleteBadge({
  base,
  landed,
  onDeleteWorktree,
}: {
  base: string;
  /** How git saw the branch land, when it could tell — named in the tooltip so
   * the claim is attributable rather than asserted. */
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

/** Visual weight per model family, scaling with how much the model matters:
 * Haiku/Sonnet are the quiet workhorses (neutral, read only when looked for),
 * Opus tints violet — the rail's agent hue, "a serious brain is on this" —
 * and Fable/Mythos get the meta cluster's only *filled* chip, a fuchsia→violet
 * gradient, so the top-tier model is spottable without hunting. Deliberately
 * not amber (needs-you) and not animated (resting facts don't pulse). */
const MODEL_TONE: Record<string, string> = {
  O: "border-violet-500/50 bg-violet-500/10 text-violet-600 dark:text-violet-400",
  F: "border-transparent bg-gradient-to-br from-fuchsia-500 to-violet-500 font-semibold text-white",
  M: "border-transparent bg-gradient-to-br from-fuchsia-500 to-violet-500 font-semibold text-white",
};

/** Which Claude model is powering a live agent session, as a boxed single
 * letter (`H`/`S`/`O`/`F`/`M` — see `modelLetter`) in the row's meta cluster,
 * weighted by tier (see {@link MODEL_TONE}). The tooltip carries the exact id
 * plus context (`claude-opus-4-8 · 412K / 1M`). Renders nothing when the model
 * is unknown or the family unrecognized. */
export function ModelBadge({ session }: { session: SessionData }) {
  const d = session.agentState?.details;
  const letter = modelLetter(d?.model);
  if (!session.live || !letter) return null;
  return (
    <span
      title={modelContextLabel(d) ?? undefined}
      className={cn(
        "flex h-4 shrink-0 items-center rounded-md border px-1 font-mono text-[10px] font-medium",
        MODEL_TONE[letter] ?? "border-border bg-muted/30 text-muted-foreground",
      )}
    >
      {letter}
    </span>
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
  // Which model, and how much context a cold resume would re-send — the two
  // facts that turn "this is cold" into "this is what it would cost". Drops
  // out cleanly (separator and all) on the rare session we can't name.
  const what = modelContextLabel(d);
  const lead = what ? `${what} — ` : "";

  if (needsCompact(d, now, compactPct)) {
    // Pulses like the busy dot — a cold-and-huge session is a live nudge
    // ("compact this before you resume it"), not a passive fact.
    const pill =
      "shrink-0 animate-pulse rounded-md border border-sky-500/50 bg-sky-500/10 px-1.5 font-mono text-[10.5px] text-sky-500";
    const hint = `${lead}${pct}% of context used and the prompt cache expired, so resuming re-reads everything.`;
    return onCompact ? (
      <button
        type="button"
        title={`${hint} Click to /compact.`}
        onClick={(e) => {
          e.stopPropagation();
          onCompact();
        }}
        className={cn(pill, "hover:bg-sky-500/20")}
      >
        ❄ {pct}%{long && " compact"}
      </button>
    ) : (
      <span title={`${hint} Consider /compact or a fresh session.`} className={pill}>
        ❄ {pct}%{long && " compact"}
      </span>
    );
  }

  const expiring = isCacheExpiring(d, now);
  const warmth = cold
    ? "❄"
    : `${d.cacheTtlMs === 3_600_000 ? "⧗" : "◔"}${fmtMins(d.cacheExpiresAt! - now)}`;
  return (
    <span
      title={
        cold
          ? `${lead}prompt cache expired`
          : expiring
            ? `${lead}prompt cache expires soon; any message re-warms it, a cold resume re-reads everything at full price`
            : `${lead}prompt cache warm, time left`
      }
      className={cn(
        "shrink-0 font-mono text-[10.5px]",
        expiring
          ? "text-amber-500"
          : cold
            ? "font-medium text-sky-500"
            : "text-muted-foreground/70",
      )}
    >
      {/* Fixed 4ch slot ("100%"), right-aligned: the percent is 1–3 digits,
          and without a reserved width every element after it drifts per row,
          so the rail's meta columns never line up vertically. */}
      <span className="inline-block w-[4ch] text-right">{pct}%</span>{" "}
      <span className="inline-block min-w-[4ch]">{warmth}</span>
    </span>
  );
}

/** Millis → whole minutes for the cache countdown, floored at 1 ("<1m" ≈ 1m). */
export function fmtMins(ms: number): string {
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

/** "···" overflow menu for a checkout — the one place every secondary action
 * lives, shared verbatim by the rail's repo/folder headers and the
 * working-context band atop the panes (so the two surfaces never diverge):
 * full folder path (when given), "New task…" (task-convention repos),
 * "Delete worktree…" (worktree checkouts, guarded `task_delete`), "Sync now",
 * "Create issue…", "Mark quiet"/"Unmark quiet" (forces this folder into the
 * rail filter's stub row under either narrowing mode, regardless of its actual
 * activity — see `isFolderFiltered`), and "Remove from rail". */
export function RepoMenu({
  path,
  onRemove,
  dir,
  isWorktree,
  quiet,
  onNewTask,
  onDeleteWorktree,
  taskId,
  ghost = false,
}: {
  path?: string;
  onRemove: () => void;
  dir: string;
  /** Worktree checkouts have no "Remove from rail" — meaningless (they are
   * auto-discovered from the primary and would reappear next poll); deletion
   * is the "Delete worktree…" item instead. */
  isWorktree?: boolean;
  /** Whether this folder currently has the quiet override set
   * (`FolderData.quiet`) — flips the menu item between "Mark"/"Unmark". */
  quiet: boolean;
  /** Opens the new-task modal — set only on a task-convention repo. */
  onNewTask?: () => void;
  /** Deletes this worktree from disk (guarded, `task_delete`) — set only
   * on worktree checkouts. */
  onDeleteWorktree?: () => void;
  /** The board task bound to this folder's worktree, when one exists. Set
   * enables "Attach issue…" — you can only link an issue to a task, so a
   * folder with no bound task doesn't offer it. */
  taskId?: number;
  /** Ghost trigger (no resting border) — see [`IconBtn`]'s `ghost`. */
  ghost?: boolean;
}) {
  const [attachOpen, setAttachOpen] = useState(false);

  async function syncNow() {
    (await abSyncRepo(dir)).match({
      ok: (result) => {
        // `started: false` means a sync for this dir was already in flight
        // (e.g. another window) — quietly ignore rather than double-toast.
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
        <DropdownMenuTrigger asChild>
          <Button
            variant={ghost ? "ghost" : "outline"}
            size="icon-xs"
            title="More actions"
            className="text-muted-foreground"
          >
            <MoreVertical className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto min-w-56">
          {path && (
            <>
              <DropdownMenuLabel className="font-mono text-[11px] font-normal whitespace-nowrap text-muted-foreground">
                {path}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
            </>
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
              <Trash2 className="size-3.5" /> Delete worktree…
              <DropdownMenuShortcut>{shortcutHint("ab-remove-task")}</DropdownMenuShortcut>
            </DropdownMenuItem>
          )}
          {(onNewTask || onDeleteWorktree) && <DropdownMenuSeparator />}
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

/** What a pane tile shows when it has no content to render: a dashed outline,
 * one line saying what happened, and a single way out. The three cases are a
 * folder pane whose folder is gone (diff, files) and a terminal pane whose
 * shell crashed — that last one passes `detail` to report how it died, and
 * `tone="alert"` to say the pane didn't mean to end up here.
 *
 * Removal is the only affordance on purpose: restarting is the rail's job, so
 * a tile that offers it competes with the rail for the same decision. */
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
  /** This pane is the one the user last clicked into — see the focus-ring
   * rule in `screens/agentboard.tsx`'s `focusedPaneId`. */
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
        onClick={onRemove}
        className="flex items-center gap-1 font-mono text-xs hover:text-sky-500"
      >
        <X className="size-3" /> close pane
      </button>
    </div>
  );
}
