import {
  Archive,
  Box,
  CalendarClock,
  CircleSlash,
  Search,
  Eye,
  EyeOff,
  FolderGit2,
  FolderPlus,
  FolderX,
  GitPullRequest,
  History,
  PanelLeftClose,
  RadioTower,
  X,
} from "lucide-react";
import { DismissButton } from "@/components/store-bits";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Hint } from "@/components/hint";
import { cn } from "@/lib/utils";
import { RAIL_RECENT_HOUR_CHOICES } from "@/lib/rail-prefs";
import type { RailFilter } from "@/lib/settings";
import { mouseAction } from "@/lib/shortcut-coach";
import { uiAction } from "@/lib/ui-action";
import type { AttentionItem } from "./use-attention";

/** Icon + resting tooltip per rail filter. The icon *is* the readout — an
 * always-open menu would cost a rail row, so the trigger has to say which mode
 * is on without being opened. */
const FILTER_META: Record<RailFilter, { icon: typeof Eye; title: string }> = {
  all: { icon: Eye, title: "Showing every checkout" },
  active: {
    icon: EyeOff,
    title:
      "Showing only checkouts with something going on (a live session, a dirty tree, unpushed commits, an agent waiting)",
  },
  recent: { icon: History, title: "Showing only checkouts you worked in recently" },
};

// The middle two answers aren't degrees of one thing: "going on" is about
// *now*, "worked recently" is the last N hours. A menu, not a cycling icon, so
// the hour span sits with the mode it measures.
function RailFilterMenu(props: {
  filter: RailFilter;
  recentHours: number;
  onSetFilter: (next: RailFilter) => void;
  onSetRecentHours: (next: number) => void;
}) {
  const { filter, recentHours, onSetFilter, onSetRecentHours } = props;
  const { icon: Icon, title } = FILTER_META[filter];
  return (
    <DropdownMenu>
      <Hint label={title}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Which checkouts to show"
            className={cn(
              "flex items-center gap-0.5 rounded-md p-1 hover:bg-accent/50",
              filter === "all"
                ? "text-muted-foreground hover:text-foreground"
                : "text-violet-500 hover:text-violet-400",
            )}
          >
            <Icon className="size-3.5" />
            {filter === "recent" && (
              <span className="font-mono text-[10px] leading-none">{recentHours}h</span>
            )}
          </button>
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>Show</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={filter}
          onValueChange={(next) => {
            uiAction("agentboard.rail_filter", "agentboard", next);
            onSetFilter(next as RailFilter);
          }}
        >
          <DropdownMenuRadioItem value="all">Everything</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="active">Only what&apos;s going on</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="recent">Worked recently</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        {filter === "recent" && (
          // Deliberately not menu items: picking a span is a refinement of the
          // mode above it, so the menu stays open while you compare 4h to 8h.
          <div className="flex items-center gap-1 px-2 pb-1.5 pt-1">
            {RAIL_RECENT_HOUR_CHOICES.map((hours) => (
              <button
                key={hours}
                type="button"
                aria-pressed={hours === recentHours}
                onClick={() => {
                  uiAction("agentboard.rail_recent_hours", "agentboard", String(hours));
                  onSetRecentHours(hours);
                }}
                className={cn(
                  "flex-1 rounded-md border py-0.5 font-mono text-[11px] hover:bg-accent/50",
                  hours === recentHours
                    ? "border-violet-500/40 bg-violet-500/10 text-violet-500"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {hours}h
              </button>
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Type-to-narrow over repo, branch and task title. Transient: no persistence,
// Escape clears, and the count of what it hides sits in the field itself, so a
// forgotten query can't read as a rail that lost repos.
function RepoSearch({
  query,
  onSet,
  hidden,
}: {
  query: string;
  onSet: (next: string) => void;
  hidden: number;
}) {
  return (
    <div className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={query}
        onChange={(e) => onSet(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          // Stop here: the screen's Escape closes panes and clears selection,
          // and a search field's Escape means the search.
          e.stopPropagation();
          onSet("");
        }}
        placeholder="Filter repos…"
        aria-label="Filter repos"
        spellCheck={false}
        className="h-6 py-0 pr-12 pl-6.5 text-xs"
      />
      {query !== "" && (
        <span className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-1">
          {hidden > 0 && (
            <span className="font-mono text-[10px] text-muted-foreground/70">−{hidden}</span>
          )}
          <button
            type="button"
            onClick={() => onSet("")}
            aria-label="Clear the repo filter"
            className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </span>
      )}
    </div>
  );
}

// Marking a checkout quiet takes it off the rail, so the count of what that
// hid belongs where you look before wondering where a repo went — beside the
// filter, not at the far end of the tree.
function QuietToggle({
  count,
  on,
  onSet,
}: {
  count: number;
  on: boolean;
  onSet: (next: boolean) => void;
}) {
  return (
    <Hint
      label={
        on
          ? `Showing ${count} checkout${count === 1 ? "" : "s"} marked quiet — click to hide them again`
          : `${count} checkout${count === 1 ? "" : "s"} marked quiet ${count === 1 ? "is" : "are"} hidden — click to show them`
      }
    >
      <button
        type="button"
        onClick={() => {
          uiAction("agentboard.show_quiet", "agentboard", on ? "off" : "on");
          onSet(!on);
        }}
        aria-label={on ? "Hide checkouts marked quiet" : "Show checkouts marked quiet"}
        aria-pressed={on}
        className={cn(
          "flex items-center gap-0.5 rounded-md p-1 hover:bg-accent/50",
          on
            ? "text-violet-500 hover:text-violet-400"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        {/* Not an eye: the filter beside this one already owns that glyph,
            and two of them a few pixels apart read as one control. */}
        <Archive className="size-3.5" />
        <span className="font-mono text-[10px] leading-none">{count}</span>
      </button>
    </Hint>
  );
}

// The rail's fixed top: title row, filter/cleanup affordances, and the
// attention strip. Everything below this scrolls.
export function RailHeader(props: {
  attention: AttentionItem[];
  missingRepoCount: number;
  agentScanOk: boolean;
  dismissedPrCount: number;
  clearingDismissals: boolean;
  filter: RailFilter;
  recentHours: number;
  onSetFilter: (next: RailFilter) => void;
  onSetRecentHours: (next: number) => void;
  /** Checkouts marked quiet by hand — shown or hidden, this is how many. */
  quietCount: number;
  showQuiet: boolean;
  onSetShowQuiet: (next: boolean) => void;
  /** Free-text repo filter. Transient by design — nothing persists it, so the
   * rail never opens already narrowed to yesterday's search. */
  query: string;
  onSetQuery: (next: string) => void;
  /** Repos the query is currently hiding; 0 when nothing is typed. */
  queryHidden: number;
  showUnmanagedWorktrees: boolean;
  onSetShowUnmanagedWorktrees: (next: boolean) => void;
  jarvisPane: boolean;
  onSetJarvisPane: (next: boolean) => void;
  onOpenRepoManager: () => void;
  onCleanupMissing: () => void;
  onClearDismissals: () => void;
  onCollapseRail: () => void;
}) {
  const {
    attention,
    missingRepoCount,
    agentScanOk,
    dismissedPrCount,
    clearingDismissals,
    filter,
    recentHours,
    onSetFilter,
    onSetRecentHours,
    quietCount,
    showQuiet,
    onSetShowQuiet,
    query,
    onSetQuery,
    queryHidden,
    showUnmanagedWorktrees,
    onSetShowUnmanagedWorktrees,
    jarvisPane,
    onSetJarvisPane,
    onOpenRepoManager,
    onCleanupMissing,
    onClearDismissals,
    onCollapseRail,
  } = props;
  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        {/* The filter takes the row the "REPOS" heading used to hold: the rail
            is self-evidently the repo list, and a heading can't find a repo. */}
        <RepoSearch query={query} onSet={onSetQuery} hidden={queryHidden} />
        <span className="flex shrink-0 items-center gap-0.5">
          <Hint label="Manage tracked repos in Settings — track, reorder, icon and color">
            <button
              type="button"
              onClick={onOpenRepoManager}
              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-violet-500 hover:bg-accent/50"
            >
              <FolderPlus className="size-3.5" /> Manage repos
            </button>
          </Hint>
          {!agentScanOk && (
            <Hint label="Can't reach `claude agents` — agent status on these rows is missing, not empty. Retrying with a widening backoff.">
              <span
                role="status"
                aria-label="Agent status unavailable"
                className="rounded-md p-1 text-amber-500"
              >
                <RadioTower className="size-3.5" />
              </span>
            </Hint>
          )}
          {missingRepoCount > 0 && (
            <Hint
              label={`Untrack ${missingRepoCount} repo${missingRepoCount === 1 ? "" : "s"} whose director${missingRepoCount === 1 ? "y is" : "ies are"} gone from disk`}
            >
              <button
                type="button"
                onClick={onCleanupMissing}
                aria-label={`Untrack ${missingRepoCount} missing repos`}
                className="rounded-md p-1 text-amber-500 hover:bg-accent/50 hover:text-amber-400"
              >
                <FolderX className="size-3.5" />
              </button>
            </Hint>
          )}
          <RailFilterMenu
            filter={filter}
            recentHours={recentHours}
            onSetFilter={onSetFilter}
            onSetRecentHours={onSetRecentHours}
          />
          {/* Only with marks to speak for: the count is what makes hiding
              reversible, so it appears exactly when something is hidden — or
              would be if you flipped this off. */}
          {quietCount > 0 && (
            <QuietToggle count={quietCount} on={showQuiet} onSet={onSetShowQuiet} />
          )}
          <Hint
            label={
              showUnmanagedWorktrees
                ? 'Showing every git worktree — the ones agents made for themselves fold into a per-repo "N unmanaged" row you can open. Click to drop them entirely.'
                : "Showing only the tasks you asked for — click to also find worktrees agents made for themselves, or ones added by hand"
            }
          >
            <button
              type="button"
              onClick={() => {
                uiAction(
                  "agentboard.show_unmanaged_worktrees",
                  "agentboard",
                  showUnmanagedWorktrees ? "off" : "on",
                );
                onSetShowUnmanagedWorktrees(!showUnmanagedWorktrees);
              }}
              aria-label={
                showUnmanagedWorktrees
                  ? "Show only worktrees you asked for"
                  : "Show every git worktree, including ones you didn't ask for"
              }
              aria-pressed={showUnmanagedWorktrees}
              className={cn(
                "rounded-md p-1 hover:bg-accent/50",
                showUnmanagedWorktrees
                  ? "text-violet-500 hover:text-violet-400"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <FolderGit2 className="size-3.5" />
            </button>
          </Hint>
          {/* Jarvis, the native Bevy surface: this toggles both the strip at
              the bottom of the rail and whether a checkout can tile one as a
              *pane* (`components/jarvis-pane.tsx`) — one switch for the whole
              proof-of-concept. Left off, no surface is ever created and no
              renderer runs; turned off after the fact, the surfaces are parked
              rather than freed, because a Bevy app can't be dropped in-process
              (`crates-tauri/tt-pane`). */}
          <Hint
            label={
              jarvisPane
                ? "Jarvis (native Bevy surface) is on — rail strip plus a “jarvis” button on each checkout that tiles one as a pane. Click to turn it off"
                : "Turn on Jarvis, the native Bevy surface: a rail strip, and a “jarvis” pane you can tile beside a checkout's terminals (proof-of-concept; Linux/Wayland only)"
            }
          >
            <button
              type="button"
              onClick={() => {
                uiAction("agentboard.jarvis_pane", "agentboard", jarvisPane ? "off" : "on");
                onSetJarvisPane(!jarvisPane);
              }}
              aria-label={jarvisPane ? "Hide the Jarvis pane" : "Show the Jarvis pane"}
              aria-pressed={jarvisPane}
              className={cn(
                "rounded-md p-1 hover:bg-accent/50",
                jarvisPane
                  ? "text-violet-500 hover:text-violet-400"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Box className="size-3.5" />
            </button>
          </Hint>
          {dismissedPrCount > 0 && (
            <Hint
              label={`Bring back ${dismissedPrCount} dismissed PR${dismissedPrCount === 1 ? "" : "s"}`}
            >
              <button
                type="button"
                onClick={onClearDismissals}
                disabled={clearingDismissals}
                aria-label="Clear all dismissed PRs"
                className="rounded-md p-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-60"
              >
                <CircleSlash className="size-3.5" />
              </button>
            </Hint>
          )}
          <Hint label="Collapse the rail to icons" shortcut="ab-toggle-rail">
            <button
              type="button"
              onClick={() => {
                mouseAction("ab-toggle-rail", "agentboard");
                onCollapseRail();
              }}
              aria-label="Collapse the rail to icons"
              className="rounded-md p-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            >
              <PanelLeftClose className="size-3.5" />
            </button>
          </Hint>
        </span>
      </div>

      {attention.length > 0 && (
        <div className="flex flex-col gap-1 border-b p-2">
          {attention.map((a) => (
            <div
              key={a.key}
              className={cn(
                "group flex items-center gap-1 rounded-md border border-l-2 pr-1 hover:bg-accent/50",
                a.border,
              )}
            >
              <button
                type="button"
                onClick={a.onClick}
                className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
              >
                {a.kind === "pr" ? (
                  <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <CalendarClock className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{a.title}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{a.sub}</span>
                </span>
              </button>
              {a.onDismiss && <DismissButton label="Dismiss" onDismiss={a.onDismiss} />}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
