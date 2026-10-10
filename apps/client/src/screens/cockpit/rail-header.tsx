import { useState } from "react";
import {
  BroadcastIcon,
  CalendarDotsIcon,
  FolderMinusIcon,
  FolderPlusIcon,
  FolderSimpleUserIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  SidebarSimpleIcon,
  SlidersHorizontalIcon,
  XIcon,
} from "@phosphor-icons/react";
import { DismissButton } from "@/components/store-bits";
import { DropdownMenu, Input } from "@cloudflare/kumo";
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
      <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-kumo-subtle" />
      <Input
        size="xs"
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
        className="pr-12 pl-6.5"
      />
      {query !== "" && (
        <span className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-1">
          {hidden > 0 && <span className="font-mono text-[10px] text-kumo-subtle">−{hidden}</span>}
          <button
            type="button"
            onClick={() => onSet("")}
            aria-label="Clear the repo filter"
            className="rounded-sm p-0.5 text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
          >
            <XIcon className="size-3" />
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
      <DropdownMenu.Trigger
        render={
          <button
            type="button"
            aria-label="Add a repo"
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-violet-500 hover:bg-kumo-tint"
          >
            <PlusIcon className="size-3.5" /> Repo
          </button>
        }
      />
      <DropdownMenu.Content align="end" className="w-60">
        <DropdownMenu.Item onClick={() => onNewRepo("create")} icon={<FolderPlusIcon />}>
          Create new repo…
        </DropdownMenu.Item>
        <DropdownMenu.Item onClick={() => onNewRepo("clone")} icon={<GitBranchIcon />}>
          Clone from GitHub…
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item onClick={onOpenRepoManager} icon={<FolderSimpleUserIcon />}>
          Track or manage repos…
        </DropdownMenu.Item>
      </DropdownMenu.Content>
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
        <DropdownMenu.Trigger
          render={
            <button
              type="button"
              aria-label="View options"
              className={cn(
                "flex items-center gap-1 rounded-md px-1.5 py-1 text-xs hover:bg-kumo-tint",
                filter === "all"
                  ? "text-kumo-subtle hover:text-kumo-default"
                  : "text-violet-500 hover:text-violet-400",
              )}
            >
              <SlidersHorizontalIcon className="size-3.5" />
              {filter === "active" && <span>Active</span>}
              {filter === "recent" && <span className="font-mono">{recentHours}h</span>}
            </button>
          }
        />
      </Hint>
      <DropdownMenu.Content align="end" className="w-64">
        <DropdownMenu.Group>
          <DropdownMenu.Label>Show checkouts</DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={filter}
            onValueChange={(next) => {
              uiAction("agentboard.rail_filter", "cockpit", next);
              props.onSetFilter(next as RailFilter);
            }}
          >
            <DropdownMenu.RadioItem value="all" closeOnClick={false}>
              All
              <DropdownMenu.RadioItemIndicator />
            </DropdownMenu.RadioItem>
            <DropdownMenu.RadioItem value="active" closeOnClick={false}>
              With something going on
              <DropdownMenu.RadioItemIndicator />
            </DropdownMenu.RadioItem>
            <DropdownMenu.RadioItem value="recent" closeOnClick={false}>
              Worked in recently
              <DropdownMenu.RadioItemIndicator />
            </DropdownMenu.RadioItem>
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Group>
        {filter === "recent" && (
          <div className="flex items-center gap-1 px-2 pt-1 pb-1.5">
            {RAIL_RECENT_HOUR_CHOICES.map((hours) => (
              <button
                key={hours}
                type="button"
                aria-pressed={hours === recentHours}
                onClick={() => {
                  uiAction("agentboard.rail_recent_hours", "cockpit", String(hours));
                  props.onSetRecentHours(hours);
                }}
                className={cn(
                  "flex-1 rounded-md border py-0.5 font-mono text-[11px] hover:bg-kumo-tint",
                  hours === recentHours
                    ? "border-violet-500/40 bg-violet-500/10 text-violet-500"
                    : "border-transparent text-kumo-subtle hover:text-kumo-default",
                )}
              >
                {hours}h
              </button>
            ))}
          </div>
        )}
        <DropdownMenu.Separator />
        <DropdownMenu.Group>
          <DropdownMenu.Label>Also show</DropdownMenu.Label>
          {quietCount > 0 && (
            <DropdownMenu.CheckboxItem
              checked={props.showQuiet}
              closeOnClick={false}
              onCheckedChange={(on) => {
                uiAction("agentboard.show_quiet", "cockpit", on ? "on" : "off");
                props.onSetShowQuiet(on);
              }}
            >
              <span className="flex-1">Checkouts marked quiet</span>
              <span className="font-mono text-[11px] text-kumo-subtle">{quietCount}</span>
            </DropdownMenu.CheckboxItem>
          )}
          <DropdownMenu.CheckboxItem
            checked={props.showUnmanagedWorktrees}
            closeOnClick={false}
            onCheckedChange={(on) => {
              uiAction("agentboard.show_unmanaged_worktrees", "cockpit", on ? "on" : "off");
              props.onSetShowUnmanagedWorktrees(on);
            }}
          >
            Worktrees not made by tt task
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.CheckboxItem
            checked={props.jarvisPane}
            closeOnClick={false}
            onCheckedChange={(on) => {
              uiAction("agentboard.jarvis_pane", "cockpit", on ? "on" : "off");
              props.onSetJarvisPane(on);
            }}
          >
            <span className="flex-1">Jarvis pane</span>
            <span className="text-[11px] text-kumo-subtle">experimental</span>
          </DropdownMenu.CheckboxItem>
        </DropdownMenu.Group>
        {props.dismissedPrCount > 0 && (
          <>
            <DropdownMenu.Separator />
            <DropdownMenu.Item
              disabled={props.clearingDismissals}
              onClick={props.onClearDismissals}
            >
              Bring back {plural(props.dismissedPrCount, "dismissed PR")}
            </DropdownMenu.Item>
          </>
        )}
      </DropdownMenu.Content>
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
      <div className="flex items-center justify-between gap-2 border-b border-kumo-hairline px-3 py-2">
        <RepoSearch query={props.query} onSet={props.onSetQuery} hidden={props.queryHidden} />
        <span className="flex shrink-0 items-center gap-0.5">
          {!props.agentScanOk && (
            <Hint label="Can't reach `claude agents` — agent status on these rows is missing, not empty. Retrying with a widening backoff.">
              <span
                role="status"
                aria-label="Agent status unavailable"
                className="rounded-md p-1 text-amber-500"
              >
                <BroadcastIcon className="size-3.5" />
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
                className="rounded-md p-1 text-amber-500 hover:bg-kumo-tint hover:text-amber-400"
              >
                <FolderMinusIcon className="size-3.5" />
              </button>
            </Hint>
          )}
          <AddRepoMenu
            onOpenRepoManager={props.onOpenRepoManager}
            onNewRepo={(mode) => {
              uiAction(`repo.${mode}_opened`, "cockpit");
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
                mouseAction("ab-toggle-rail", "cockpit");
                props.onCollapseRail();
              }}
              aria-label="Collapse the rail to icons"
              className="rounded-md p-1 text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
            >
              <SidebarSimpleIcon className="size-3.5" />
            </button>
          </Hint>
        </span>
      </div>

      {attention.length > 0 && (
        <div className="flex flex-col gap-1 border-b border-kumo-hairline p-2">
          {attention.map((a) => (
            <div
              key={a.key}
              className={cn(
                "group flex items-center gap-1 rounded-md border border-l-2 pr-1 hover:bg-kumo-tint",
                a.border,
              )}
            >
              <button
                type="button"
                onClick={a.onClick}
                className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
              >
                {a.kind === "pr" ? (
                  <GitPullRequestIcon className="size-3.5 shrink-0 text-kumo-subtle" />
                ) : (
                  <CalendarDotsIcon className="size-3.5 shrink-0 text-kumo-subtle" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{a.title}</span>
                  <span className="block truncate text-[11px] text-kumo-subtle">{a.sub}</span>
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
