import {
  FolderGit2,
  GitBranch,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Sparkles,
} from "lucide-react";
import { CollectorDot, NeedsYouChip, TopTaskChip } from "@/components/header-status";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { fmtClock, fmtCountdown, fmtDate, useAppTask, useStoreSnapshot } from "@/lib/data";
import { identityColor } from "@/lib/identity-color";
import { useNow } from "@/lib/now";
import { mouseAction } from "@/lib/shortcut-coach";
import { shortcutHint } from "@/lib/shortcuts";
import { useWorkspace } from "@/lib/workspace";

/** Strip the shared prefix so the badge reads "task-2", not the whole repo name. */
function taskShortName(task: string): string {
  const m = task.match(/task-\w+$/i);
  return m ? m[0] : task;
}

/** Main checkout: quiet chip, sky folder (the rail's primary-checkout hue).
 * Task worktree: color-washed chip, branch glyph — readable without the name. */
function TaskBadge() {
  const task = useAppTask();
  if (!task) return null;
  if (!task.isWorktree) {
    return (
      <Badge
        variant="outline"
        className="text-muted-foreground"
        title={`Main checkout — ${task.label}`}
      >
        <FolderGit2 className="text-sky-500" />
        {task.label}
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className={identityColor(task.label).badge}
      title={`Task worktree — ${task.label}`}
    >
      <GitBranch />
      {taskShortName(task.label)}
    </Badge>
  );
}

/** Dead-center kind readout: MAIN CHECKOUT in sky vs TASK WORKTREE in the
 * checkout's accent — the words themselves, not just a hue to decode. */
function CheckoutKindChip() {
  const task = useAppTask();
  if (!task) return null;
  if (!task.isWorktree) {
    return (
      <span className="flex items-center gap-1.5 font-mono text-xs font-semibold text-sky-500">
        <FolderGit2 className="size-3.5" />
        MAIN CHECKOUT
      </span>
    );
  }
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 font-mono text-xs font-semibold",
        identityColor(task.label).text,
      )}
    >
      <GitBranch className="size-3.5" />
      TASK WORKTREE
    </span>
  );
}

/** Dead-center: the clock plus the next meeting's countdown (amber inside 15
 * minutes). Absolutely centered so it stays put regardless of what sits
 * left/right, on the shared app clock. */
function ClockCluster() {
  const { openTab } = useWorkspace();
  const { snapshot } = useStoreSnapshot();
  const now = useNow();

  const nextEvent = snapshot.events
    .filter((e) => e.startTs > now)
    .toSorted((a, b) => a.startTs - b.startTs)[0];
  const eventSoon = nextEvent && nextEvent.startTs - now < 15 * 60_000;

  return (
    <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-2">
      <CheckoutKindChip />
      <span className="text-muted-foreground/40">·</span>
      <span className="font-mono text-sm font-semibold tabular-nums text-foreground">
        {fmtClock(now)}
      </span>
      {/* First to go when the header gets tight — the centre cluster is
          absolutely positioned, so it collides rather than compressing. */}
      <span className="hidden text-muted-foreground/40 xl:inline">·</span>
      <span className="hidden text-xs text-muted-foreground xl:inline">{fmtDate(now)}</span>
      {nextEvent && (
        <>
          <span className="text-muted-foreground/40">·</span>
          <button
            className={cn(
              "max-w-72 truncate rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent/50",
              eventSoon && "text-amber-600 dark:text-amber-500",
            )}
            onClick={() => openTab("cockpit")}
          >
            {nextEvent.title} in {fmtCountdown(nextEvent.startTs - now)}
          </button>
        </>
      )}
    </div>
  );
}

export function AppHeader() {
  const { sidebarCollapsed, toggleSidebar, setPaletteOpen, openSettingsTab, toggleZen, activeTab } =
    useWorkspace();
  const task = useAppTask();
  // Every control in this header has a shortcut twin, so each click is a
  // measured (and occasionally coached) miss — see `lib/shortcut-coach.ts`.
  const clicked = (id: string) => mouseAction(id, activeTab);

  return (
    <header
      className={cn(
        "relative flex h-11 shrink-0 items-center gap-2 border-b px-2",
        task?.isWorktree && identityColor(task.label).wash,
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => {
              clicked("sidebar");
              toggleSidebar();
            }}
          >
            {sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}{" "}
          <Kbd>{shortcutHint("sidebar")}</Kbd>
        </TooltipContent>
      </Tooltip>

      <h1 className="font-heading shrink-0 px-1 text-sm font-semibold">Towles Tool</h1>

      <TaskBadge />
      {/* Second to go, for the same reason: the top task is context, not a
          signal. */}
      <span className="hidden min-w-0 lg:flex">
        <TopTaskChip />
      </span>

      <ClockCluster />

      <div className="flex-1" />

      <NeedsYouChip />
      <CollectorDot />

      {/* Status left of the rule, controls right. Without it the freshness dot
          reads as a bullet belonging to "N need you". */}
      <div className="mx-1 h-4 w-px shrink-0 bg-border" />

      <Button
        variant="outline"
        size="sm"
        className="w-56 justify-between text-muted-foreground"
        onClick={() => {
          clicked("palette");
          setPaletteOpen(true);
        }}
      >
        <span className="flex items-center gap-2">
          <Search className="size-3.5" />
          Search…
        </span>
        <Kbd>{shortcutHint("palette")}</Kbd>
      </Button>

      <ThemeToggle />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Enter zen focus mode"
            onClick={() => {
              clicked("zen");
              toggleZen();
            }}
          >
            <Sparkles />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Zen focus mode <Kbd>{shortcutHint("zen")}</Kbd>
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Open settings"
            onClick={() => {
              clicked("settings");
              openSettingsTab();
            }}
          >
            <Settings />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          Settings <Kbd>{shortcutHint("settings")}</Kbd>
        </TooltipContent>
      </Tooltip>
    </header>
  );
}
