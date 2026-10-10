import {
  GearIcon,
  GitBranchIcon,
  MagnifyingGlassIcon,
  SidebarSimpleIcon,
  SparkleIcon,
} from "@phosphor-icons/react";
import { Badge, Button, Tooltip } from "@cloudflare/kumo";
import { CollectorDot, NeedsYouChip, NextUpChip } from "@/components/header-status";
import { ThemeToggle } from "@/components/theme-toggle";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { fmtClock, fmtCountdown, fmtDate, useAppTask, useStoreSnapshot } from "@/lib/data";
import { identityColor } from "@/lib/identity-color";
import { useNow } from "@/lib/now";
import { mouseAction } from "@/lib/shortcut-coach";
import { uiAction } from "@/lib/ui-action";
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
      <span title={`Main checkout — ${task.label}`}>
        <Badge
          variant="outline"
          className="text-kumo-subtle"
          icon={<GitBranchIcon className="size-3 text-sky-500" />}
        >
          {task.label}
        </Badge>
      </span>
    );
  }
  return (
    <span title={`Task worktree — ${task.label}`}>
      <Badge
        variant="outline"
        className={identityColor(task.label).badge}
        icon={<GitBranchIcon className="size-3" />}
      >
        {taskShortName(task.label)}
      </Badge>
    </span>
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
        <GitBranchIcon className="size-3.5" />
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
      <GitBranchIcon className="size-3.5" />
      TASK WORKTREE
    </span>
  );
}

/** Dead-center: the clock plus the next meeting's countdown (amber inside 15
 * minutes). Absolutely centered so it stays put regardless of what sits
 * left/right, on the shared app clock. */
function ClockCluster() {
  const { openTab, activeTab } = useWorkspace();
  const { snapshot } = useStoreSnapshot();
  const now = useNow();

  const nextEvent = snapshot.events
    .filter((e) => e.startTs > now)
    .toSorted((a, b) => a.startTs - b.startTs)[0];
  const eventSoon = nextEvent && nextEvent.startTs - now < 15 * 60_000;

  return (
    <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-2">
      <CheckoutKindChip />
      <span className="text-kumo-subtle/40">·</span>
      <span className="font-mono text-sm font-semibold tabular-nums text-kumo-default">
        {fmtClock(now)}
      </span>
      {/* First to go when the header gets tight — the centre cluster is
          absolutely positioned, so it collides rather than compressing. */}
      <span className="hidden text-kumo-subtle/40 xl:inline">·</span>
      <span className="hidden text-xs text-kumo-subtle xl:inline">{fmtDate(now)}</span>
      {nextEvent && (
        <>
          <span className="text-kumo-subtle/40">·</span>
          <button
            className={cn(
              "max-w-72 truncate rounded-md px-1.5 py-0.5 text-xs text-kumo-subtle hover:bg-kumo-tint",
              eventSoon && "text-amber-600 dark:text-amber-500",
            )}
            onClick={() => {
              uiAction("header.open_cockpit", activeTab, "meeting");
              openTab("cockpit");
            }}
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
        "relative flex h-11 shrink-0 items-center gap-2 border-b border-kumo-hairline px-2",
        task?.isWorktree && identityColor(task.label).wash,
      )}
    >
      <Tooltip
        content={
          <>
            {sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}{" "}
            <Kbd>{shortcutHint("sidebar")}</Kbd>
          </>
        }
        render={
          <Button
            variant="ghost"
            shape="square"
            size="sm"
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => {
              clicked("sidebar");
              toggleSidebar();
            }}
            icon={sidebarCollapsed ? <SidebarSimpleIcon /> : <SidebarSimpleIcon />}
          />
        }
      />

      <h1 className="font-heading shrink-0 px-1 text-sm font-semibold">Towles Tool</h1>

      <TaskBadge />
      {/* Second to go, for the same reason: the top task is context, not a
          signal. */}
      <span className="hidden min-w-0 lg:flex">
        <NextUpChip />
      </span>

      <ClockCluster />

      <div className="flex-1" />

      <NeedsYouChip />
      <CollectorDot />

      {/* Status left of the rule, controls right. Without it the freshness dot
          reads as a bullet belonging to "N need you". */}
      <div className="mx-1 h-4 w-px shrink-0 bg-kumo-hairline" />

      <Button
        variant="outline"
        size="sm"
        className="w-56 justify-between text-kumo-subtle"
        onClick={() => {
          clicked("palette");
          setPaletteOpen(true);
        }}
      >
        <span className="flex items-center gap-2">
          <MagnifyingGlassIcon className="size-3.5" />
          Search…
        </span>
        <Kbd>{shortcutHint("palette")}</Kbd>
      </Button>

      <ThemeToggle />

      <Tooltip
        content={
          <>
            Zen focus mode <Kbd>{shortcutHint("zen")}</Kbd>
          </>
        }
        render={
          <Button
            variant="ghost"
            shape="square"
            size="sm"
            aria-label="Enter zen focus mode"
            onClick={() => {
              clicked("zen");
              toggleZen();
            }}
            icon={<SparkleIcon />}
          />
        }
      />

      <Tooltip
        content={
          <>
            Settings <Kbd>{shortcutHint("settings")}</Kbd>
          </>
        }
        render={
          <Button
            variant="ghost"
            shape="square"
            size="sm"
            aria-label="Open settings"
            onClick={() => {
              clicked("settings");
              openSettingsTab();
            }}
            icon={<GearIcon />}
          />
        }
      />
    </header>
  );
}
