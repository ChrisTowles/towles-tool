import { useMemo } from "react";
import { RollupDots } from "@/components/agentboard-bits";
import { Button, Tooltip } from "@cloudflare/kumo";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  agentRollup,
  rollupAlertColor,
  rollupAlertTextColor,
  useAgentboardState,
} from "@/lib/agentboard";
import { dmsNeedingAttention, useStoreSnapshot } from "@/lib/data";
import { useNow } from "@/lib/now";
import { NAV_SECTIONS, SCREENS } from "@/lib/screens";
import { Kbd } from "@/components/ui/kbd";
import { ShortcutBadge } from "@/components/hint";
import { shortcutAria, shortcutHint, tabShortcutId } from "@/lib/shortcuts";
import { useWorkspace } from "@/lib/workspace";
import { mouseAction } from "@/lib/shortcut-coach";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";

/** The shared clock, not `Date.now()`: a cache going cold emits no state event. */
function useAgentRollup() {
  const { repos, compactRecommendPercent } = useAgentboardState();
  const now = useNow();
  return useMemo(
    () => agentRollup(repos, now, compactRecommendPercent),
    [repos, now, compactRecommendPercent],
  );
}

export function AppSidebar() {
  const { activeTab, openTab, openTabs } = useWorkspace();
  const rollup = useAgentRollup();
  const { snapshot } = useStoreSnapshot();
  const slackUnread = dmsNeedingAttention(snapshot).length > 0;

  return (
    <ScrollArea className="h-full">
      <nav className="flex flex-col gap-4 p-2">
        {NAV_SECTIONS.map((section) => (
          <div key={section.label} className="flex flex-col gap-0.5">
            <div className="px-2 pb-1 text-xs font-medium text-kumo-subtle">{section.label}</div>
            {section.screens.map((id) => {
              const screen = SCREENS[id];
              const active = activeTab === id;
              const showBadge = id === "cockpit" && rollup.total > 0;
              const showSlackDot = id === "slack" && slackUnread;
              // `mod+1…9` address open tabs by position, so the digit exists
              // only once this screen *is* one — and it is the row's last
              // resort for the trailing slot, yielding to any live count.
              const tabId = tabShortcutId(openTabs, id);
              return (
                <Button
                  key={id}
                  variant="ghost"
                  size="sm"
                  aria-current={active || undefined}
                  // The digit is decoration: in the accessible name it renames
                  // the control to "Board Ctrl+2". The binding belongs in
                  // `aria-keyshortcuts`.
                  aria-label={screen.title}
                  aria-keyshortcuts={tabId ? shortcutAria(tabId) : undefined}
                  className={cn(
                    "justify-start font-normal",
                    active && "bg-kumo-tint text-kumo-default",
                  )}
                  onClick={() => {
                    if (tabId) mouseAction(tabId, activeTab);
                    else if (id === "settings") mouseAction("settings", activeTab);
                    else uiAction("sidebar.navigate", activeTab, id);
                    openTab(id);
                  }}
                >
                  <screen.icon className="text-kumo-subtle" />
                  {screen.title}
                  {showBadge && (
                    <span className="ml-auto flex items-center gap-1.5 font-mono text-[10.5px] text-kumo-subtle">
                      {rollup.total}
                      <RollupDots r={rollup} />
                      {rollup.compact > 0 && (
                        <span className="text-sky-500" title="cold sessions worth compacting">
                          ❄{rollup.compact}
                        </span>
                      )}
                    </span>
                  )}
                  {showSlackDot && (
                    <span
                      className="ml-auto size-1.5 rounded-full bg-rose-500"
                      title="unanswered DM"
                    />
                  )}
                  {tabId && !showBadge && !showSlackDot && (
                    <Kbd aria-hidden className="ml-auto opacity-50">
                      {shortcutHint(tabId)}
                    </Kbd>
                  )}
                </Button>
              );
            })}
          </div>
        ))}
      </nav>
    </ScrollArea>
  );
}

/** The Agentboard rollup rides along as a corner badge, so collapsing the
 * sidebar never hides "something needs you". */
export function AppSidebarIcons() {
  const { activeTab, openTab, openTabs } = useWorkspace();
  const rollup = useAgentRollup();
  const { snapshot } = useStoreSnapshot();
  const badgeColor = rollupAlertColor(rollup);
  const slackUnread = dmsNeedingAttention(snapshot).length > 0;

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col items-center gap-1 py-2">
        {NAV_SECTIONS.map((section, i) => (
          <div key={section.label} className="flex flex-col items-center gap-1">
            {i > 0 && <div className="my-1 h-px w-6 bg-kumo-hairline" />}
            {section.screens.map((id) => {
              const screen = SCREENS[id];
              const active = activeTab === id;
              const showBadge = id === "cockpit" && rollup.total > 0;
              const showSlackDot = id === "slack" && slackUnread;
              const tabId = tabShortcutId(openTabs, id);
              return (
                <Tooltip
                  key={id}
                  side="right"
                  content={
                    <>
                      {screen.title}
                      {tabId && <ShortcutBadge id={tabId} />}
                      {showBadge &&
                        ` — ${rollup.total} agent${rollup.total === 1 ? "" : "s"}${rollup.waiting > 0 ? `, ${rollup.waiting} waiting` : ""}${rollup.error > 0 ? `, ${rollup.error} errored` : ""}`}
                      {showSlackDot && " — unanswered DM"}
                    </>
                  }
                  render={
                    <button
                      type="button"
                      aria-label={screen.title}
                      aria-keyshortcuts={tabId ? shortcutAria(tabId) : undefined}
                      aria-current={active || undefined}
                      onClick={() => {
                        if (tabId) mouseAction(tabId, activeTab);
                        else if (id === "settings") mouseAction("settings", activeTab);
                        else uiAction("sidebar.navigate", activeTab, id);
                        openTab(id);
                      }}
                      className={cn(
                        "relative flex size-9 shrink-0 items-center justify-center rounded-md border-l-2 border-transparent text-kumo-subtle hover:bg-kumo-tint",
                        active && "border-l-violet-500 bg-kumo-tint text-kumo-default",
                      )}
                    />
                  }
                >
                  <screen.icon className="size-4" />
                  {showBadge && (
                    <span
                      className={cn(
                        "absolute -right-1 -bottom-1 min-w-4 rounded-full px-0.5 text-center font-mono text-[9px] leading-[14px]",
                        badgeColor,
                        rollupAlertTextColor(badgeColor),
                      )}
                    >
                      {rollup.total}
                    </span>
                  )}
                  {showSlackDot && (
                    <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-rose-500" />
                  )}
                </Tooltip>
              );
            })}
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
