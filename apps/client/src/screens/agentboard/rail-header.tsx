import { useState } from "react";
import {
  CalendarClock,
  FolderCog,
  FolderGit2,
  FolderPlus,
  FolderX,
  GitPullRequest,
  PanelLeftClose,
  Plus,
  RadioTower,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { DismissButton } from "@/components/store-bits";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Hint } from "@/components/hint";
import { cn } from "@/lib/utils";
import { RAIL_RECENT_HOUR_CHOICES } from "@/lib/rail-prefs";
import type { RailFilter } from "@/lib/settings";
import { mouseAction } from "@/lib/shortcut-coach";
import { uiAction } from "@/lib/ui-action";
import { NewRepoDialog, type NewRepoMode } from "./new-repo-dialog";
import type { AttentionItem } from "./use-attention";

const FILTER_SUMMARY: Record<RailFilter, string> = {
  all: "all checkouts",
  active: "only checkouts with something going on",
  recent: "only checkouts worked in recently",
};

const keepOpen = (e: Event) => e.preventDefault();

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

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
          // The screen's Escape closes panes; a search field's Escape means the search.
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

function AddRepoMenu({
  onOpenRepoManager,
  onNewRepo,
}: {
  onOpenRepoManager: () => void;
  onNewRepo: (mode: NewRepoMode) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Add a repo"
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-violet-500 hover:bg-accent/50"
        >
          <Plus className="size-3.5" /> Repo
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuItem onSelect={() => onNewRepo("create")}>
          <FolderPlus /> Create new repo…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onNewRepo("clone")}>
          <FolderGit2 /> Clone from GitHub…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onOpenRepoManager}>
          <FolderCog /> Track or manage repos…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Every view preference is a radio or a checkbox, so its state reads from a
// checkmark rather than from an icon's color. The trigger lights up only when
// the rail is narrowed below "all".
function ViewMenu(props: {
  filter: RailFilter;
  recentHours: number;
  onSetFilter: (next: RailFilter) => void;
  onSetRecentHours: (next: number) => void;
  quietCount: number;
  showQuiet: boolean;
  onSetShowQuiet: (next: boolean) => void;
  showUnmanagedWorktrees: boolean;
  onSetShowUnmanagedWorktrees: (next: boolean) => void;
  jarvisPane: boolean;
  onSetJarvisPane: (next: boolean) => void;
  dismissedPrCount: number;
  clearingDismissals: boolean;
  onClearDismissals: () => void;
}) {
  const { filter, recentHours, quietCount } = props;
  return (
    <DropdownMenu>
      <Hint label={`View options — showing ${FILTER_SUMMARY[filter]}`}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="View options"
            className={cn(
              "flex items-center gap-1 rounded-md px-1.5 py-1 text-xs hover:bg-accent/50",
              filter === "all"
                ? "text-muted-foreground hover:text-foreground"
                : "text-violet-500 hover:text-violet-400",
            )}
          >
            <SlidersHorizontal className="size-3.5" />
            {filter === "active" && <span>Active</span>}
            {filter === "recent" && <span className="font-mono">{recentHours}h</span>}
          </button>
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Show checkouts</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={filter}
          onValueChange={(next) => {
            uiAction("agentboard.rail_filter", "agentboard", next);
            props.onSetFilter(next as RailFilter);
          }}
        >
          <DropdownMenuRadioItem value="all" onSelect={keepOpen}>
            All
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="active" onSelect={keepOpen}>
            With something going on
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="recent" onSelect={keepOpen}>
            Worked in recently
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        {filter === "recent" && (
          <div className="flex items-center gap-1 px-2 pt-1 pb-1.5">
            {RAIL_RECENT_HOUR_CHOICES.map((hours) => (
              <button
                key={hours}
                type="button"
                aria-pressed={hours === recentHours}
                onClick={() => {
                  uiAction("agentboard.rail_recent_hours", "agentboard", String(hours));
                  props.onSetRecentHours(hours);
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
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Also show</DropdownMenuLabel>
        {quietCount > 0 && (
          <DropdownMenuCheckboxItem
            checked={props.showQuiet}
            onSelect={keepOpen}
            onCheckedChange={(on) => {
              uiAction("agentboard.show_quiet", "agentboard", on ? "on" : "off");
              props.onSetShowQuiet(on);
            }}
          >
            <span className="flex-1">Checkouts marked quiet</span>
            <span className="font-mono text-[11px] text-muted-foreground">{quietCount}</span>
          </DropdownMenuCheckboxItem>
        )}
        <DropdownMenuCheckboxItem
          checked={props.showUnmanagedWorktrees}
          onSelect={keepOpen}
          onCheckedChange={(on) => {
            uiAction("agentboard.show_unmanaged_worktrees", "agentboard", on ? "on" : "off");
            props.onSetShowUnmanagedWorktrees(on);
          }}
        >
          Worktrees not made by tt task
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={props.jarvisPane}
          onSelect={keepOpen}
          onCheckedChange={(on) => {
            uiAction("agentboard.jarvis_pane", "agentboard", on ? "on" : "off");
            props.onSetJarvisPane(on);
          }}
        >
          <span className="flex-1">Jarvis pane</span>
          <span className="text-[11px] text-muted-foreground">experimental</span>
        </DropdownMenuCheckboxItem>
        {props.dismissedPrCount > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={props.clearingDismissals}
              onSelect={props.onClearDismissals}
            >
              Bring back {plural(props.dismissedPrCount, "dismissed PR")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The rail's fixed top: search, the add and view menus, alerts, and the
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
  quietCount: number;
  showQuiet: boolean;
  onSetShowQuiet: (next: boolean) => void;
  /** Transient by design, so the rail never opens narrowed to yesterday's search. */
  query: string;
  onSetQuery: (next: string) => void;
  queryHidden: number;
  showUnmanagedWorktrees: boolean;
  onSetShowUnmanagedWorktrees: (next: boolean) => void;
  jarvisPane: boolean;
  onSetJarvisPane: (next: boolean) => void;
  /** Where a created or cloned repo goes, most likely first. */
  parentDirs: string[];
  onOpenRepoManager: () => void;
  onCleanupMissing: () => void;
  onClearDismissals: () => void;
  onCollapseRail: () => void;
}) {
  const { attention, missingRepoCount } = props;
  const [newRepo, setNewRepo] = useState<NewRepoMode | null>(null);
  return (
    <>
      <NewRepoDialog
        mode={newRepo}
        parentDirs={props.parentDirs}
        onClose={() => setNewRepo(null)}
      />
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <RepoSearch query={props.query} onSet={props.onSetQuery} hidden={props.queryHidden} />
        <span className="flex shrink-0 items-center gap-0.5">
          {!props.agentScanOk && (
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
              label={`Untrack ${plural(missingRepoCount, "repo")} whose directory is gone from disk`}
            >
              <button
                type="button"
                onClick={props.onCleanupMissing}
                aria-label={`Untrack ${plural(missingRepoCount, "missing repo")}`}
                className="rounded-md p-1 text-amber-500 hover:bg-accent/50 hover:text-amber-400"
              >
                <FolderX className="size-3.5" />
              </button>
            </Hint>
          )}
          <AddRepoMenu
            onOpenRepoManager={props.onOpenRepoManager}
            onNewRepo={(mode) => {
              uiAction(`repo.${mode}_opened`, "agentboard");
              setNewRepo(mode);
            }}
          />
          <ViewMenu
            filter={props.filter}
            recentHours={props.recentHours}
            onSetFilter={props.onSetFilter}
            onSetRecentHours={props.onSetRecentHours}
            quietCount={props.quietCount}
            showQuiet={props.showQuiet}
            onSetShowQuiet={props.onSetShowQuiet}
            showUnmanagedWorktrees={props.showUnmanagedWorktrees}
            onSetShowUnmanagedWorktrees={props.onSetShowUnmanagedWorktrees}
            jarvisPane={props.jarvisPane}
            onSetJarvisPane={props.onSetJarvisPane}
            dismissedPrCount={props.dismissedPrCount}
            clearingDismissals={props.clearingDismissals}
            onClearDismissals={props.onClearDismissals}
          />
          <Hint label="Collapse the rail to icons" shortcut="ab-toggle-rail">
            <button
              type="button"
              onClick={() => {
                mouseAction("ab-toggle-rail", "agentboard");
                props.onCollapseRail();
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
