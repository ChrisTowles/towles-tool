import { useState, type ReactNode } from "react";
import { toast } from "@/lib/toast";
import {
  GearIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  ListChecksIcon,
  ListPlusIcon,
  MoonIcon,
  PencilLineIcon,
  RecordIcon,
  SidebarIcon,
  SunIcon,
  TerminalWindowIcon,
} from "@phosphor-icons/react";
import { CommandPalette as Palette } from "@cloudflare/kumo";
import { useTheme } from "@/components/theme-provider";
import { requestAgentboardNav, useAgentboardState } from "@/lib/agentboard";
import { storeAddTask, useStoreSnapshot } from "@/lib/data";
import { openExternalUrl } from "@/lib/open-url";
import {
  paletteRepoEntries,
  paletteSessionEntries,
  palettePrEntries,
  paletteIssueEntries,
  paletteQuickAddEntry,
  paletteFilter,
  paletteNeedsDetail,
  paletteRecentScreens,
  type PaletteRepoEntry,
  type PaletteSessionEntry,
} from "@/lib/palette";
import { paletteTaskEntries, type PaletteTaskTarget } from "@/lib/palette-tasks";
import { SCREENS } from "@/lib/screens";
import { shortcutHint } from "@/lib/shortcuts";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace";

/** ⌘K launcher. Live sections — recent screens, Agentboard checkouts and
 * sessions, Board tasks, open PRs and issues — come from the same read-only hooks
 * the screens use; `shortcutHint()` keeps glyphs platform-correct, not hardcoded. */
export function CommandPalette() {
  const {
    paletteOpen,
    setPaletteOpen,
    recent,
    activeTab,
    openTab,
    openTabWithFocus,
    openSettingsTab,
    toggleSidebar,
  } = useWorkspace();
  const { theme, setTheme } = useTheme();
  const { repos } = useAgentboardState();
  const { snapshot } = useStoreSnapshot();
  const [query, setQuery] = useState("");

  const resolvedDark =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : theme === "dark";

  // Also clears the query: this close path skips `onOpenChange`, and a stale
  // filter greeting the next open reads as a broken palette. Every selection is
  // recorded here, against the screen the palette was opened from.
  const run = (action: string, detail: string | undefined, fn: () => void) => {
    setPaletteOpen(false);
    setQuery("");
    uiAction(action, activeTab, detail);
    fn();
  };

  // Reveal a checkout/session in Agentboard: switch to the tab, then hand the
  // target off through the read-only nav mailbox (Agentboard may not be mounted
  // yet — the request is stashed for its mount effect).
  const jumpToFolder = (entry: PaletteRepoEntry) =>
    run("palette.repo", paletteNeedsDetail(entry.needs > 0), () => {
      openTab("agentboard");
      requestAgentboardNav({ kind: "folder", folderDir: entry.folderDir });
    });
  const jumpToSession = (entry: PaletteSessionEntry) =>
    run("palette.session", paletteNeedsDetail(entry.needs), () => {
      openTab("agentboard");
      requestAgentboardNav({
        kind: "session",
        folderDir: entry.folderDir,
        sessionId: entry.sessionId,
      });
    });
  const jumpToTask = (target: PaletteTaskTarget) =>
    run("palette.board_task", target.kind, () => {
      if (target.kind === "worktree") {
        openTab("agentboard");
        requestAgentboardNav({ kind: "folder", folderDir: target.folderDir });
      } else {
        openTabWithFocus({ screen: "board", kind: "todo", id: String(target.taskId) });
      }
    });

  // MRU shortcut — empty while a query is typed, so the exact-title match in
  // "Go to" keeps the initial selection (see `paletteRecentScreens`).
  const recentScreens = paletteRecentScreens(recent, activeTab, query);

  const repoEntries = paletteRepoEntries(repos);
  const sessionEntries = paletteSessionEntries(repos);
  const taskEntries = paletteTaskEntries(snapshot.tasks, repos);
  const prEntries = palettePrEntries(snapshot.prs);
  const issueEntries = paletteIssueEntries(snapshot.issues);
  const quickAdd = paletteQuickAddEntry(query);

  const createTodo = (title: string) =>
    run("palette.create", "todo", () => {
      void storeAddTask(title);
      toast.success("Todo added", { description: title });
    });

  const groups: PaletteGroup[] = [];
  if (recentScreens.length > 0) {
    groups.push({
      id: "recent",
      label: "Recent",
      items: recentScreens.map((id) => {
        const screen = SCREENS[id];
        return {
          id: `recent:${id}`,
          label: `recent ${screen.title}`,
          keywords: screen.keywords,
          node: (
            <>
              <screen.icon className="size-4 text-kumo-subtle" />
              {screen.title}
            </>
          ),
          select: () => run("palette.recent", id, () => openTab(id)),
        };
      }),
    });
  }
  groups.push({
    id: "go-to",
    label: "Go to",
    items: Object.values(SCREENS).map((screen) => ({
      id: `go:${screen.id}`,
      label: screen.title,
      keywords: screen.keywords,
      node: (
        <>
          <screen.icon className="size-4 text-kumo-subtle" />
          {screen.title}
        </>
      ),
      select: () => run("palette.go_to", screen.id, () => openTab(screen.id)),
    })),
  });
  if (repoEntries.length > 0) {
    groups.push({
      id: "repos",
      label: "Agentboard repos",
      items: repoEntries.map((entry) => ({
        id: `repo:${entry.key}`,
        label: `repo ${entry.repoName} ${entry.folderName} ${entry.folderDir}`,
        keywords: entry.keywords,
        node: (
          <>
            <GitBranchIcon className="size-4 shrink-0 text-kumo-subtle" />
            <span className="truncate">{entry.repoName}</span>
            <span className="ml-1 truncate text-kumo-subtle">{entry.folderName}</span>
            {entry.needs > 0 && <Hint className="text-blue-500">{entry.needs} need you</Hint>}
          </>
        ),
        select: () => jumpToFolder(entry),
      })),
    });
  }
  if (sessionEntries.length > 0) {
    groups.push({
      id: "sessions",
      label: "Agentboard sessions",
      items: sessionEntries.map((entry) => ({
        id: `session:${entry.key}`,
        label: `session ${entry.label} ${entry.repoName} ${entry.folderName}`,
        keywords: entry.keywords,
        node: (
          <>
            <TerminalWindowIcon className="size-4 shrink-0 text-kumo-subtle" />
            <span className="truncate">{entry.label}</span>
            <span className="ml-1 truncate text-kumo-subtle">{entry.repoName}</span>
            {entry.needs && <Hint className="text-blue-500">needs you</Hint>}
          </>
        ),
        select: () => jumpToSession(entry),
      })),
    });
  }
  if (taskEntries.length > 0) {
    groups.push({
      id: "tasks",
      label: "Board tasks",
      items: taskEntries.map((entry) => ({
        id: `task:${entry.key}`,
        label: entry.value,
        keywords: entry.keywords,
        node: (
          <>
            <ListChecksIcon className="size-4 shrink-0 text-kumo-subtle" />
            <span className="truncate">{entry.title}</span>
            {entry.meta && <span className="ml-1 truncate text-kumo-subtle">{entry.meta}</span>}
          </>
        ),
        select: () => jumpToTask(entry.target),
      })),
    });
  }
  if (prEntries.length > 0) {
    groups.push({
      id: "prs",
      label: "Open pull request",
      items: prEntries.map((entry) => ({
        id: `pr:${entry.key}`,
        label: `pr ${entry.repo} ${entry.number} ${entry.title}`,
        keywords: entry.keywords,
        node: (
          <>
            <GitPullRequestIcon className="size-4 shrink-0 text-kumo-subtle" />
            <span className="truncate">
              {entry.repo}
              <span className="text-kumo-subtle"> #{entry.number}</span>
            </span>
            <span className="ml-1 truncate text-kumo-subtle">{entry.title}</span>
          </>
        ),
        select: () =>
          run("palette.pr", entry.checks || undefined, () => void openExternalUrl(entry.url)),
      })),
    });
  }
  if (issueEntries.length > 0) {
    groups.push({
      id: "issues",
      label: "Open issue",
      items: issueEntries.map((entry) => ({
        id: `issue:${entry.key}`,
        label: `issue ${entry.repo} ${entry.number} ${entry.title}`,
        keywords: entry.keywords,
        node: (
          <>
            <RecordIcon className="size-4 shrink-0 text-kumo-subtle" />
            <span className="truncate">
              {entry.repo}
              <span className="text-kumo-subtle"> #{entry.number}</span>
            </span>
            <span className="ml-1 truncate text-kumo-subtle">{entry.title}</span>
          </>
        ),
        select: () => run("palette.issue", undefined, () => void openExternalUrl(entry.url)),
      })),
    });
  }
  groups.push({
    id: "actions",
    label: "Actions",
    items: [
      {
        id: "action:quicklog",
        label: "Journal: log a line",
        keywords: ["journal", "log", "note", "today"],
        node: (
          <>
            <PencilLineIcon className="size-4 text-kumo-subtle" />
            Journal: log a line
            <Hint>{shortcutHint("quicklog")}</Hint>
          </>
        ),
        select: () =>
          run("palette.action", "quicklog", () => window.dispatchEvent(new Event("quicklog:open"))),
      },
      {
        id: "action:theme",
        label: `Switch to ${resolvedDark ? "light" : "dark"} theme`,
        keywords: ["theme", "dark", "light"],
        node: (
          <>
            {resolvedDark ? (
              <SunIcon className="size-4 text-kumo-subtle" />
            ) : (
              <MoonIcon className="size-4 text-kumo-subtle" />
            )}
            Switch to {resolvedDark ? "light" : "dark"} theme
          </>
        ),
        select: () =>
          run("palette.action", "theme", () => setTheme(resolvedDark ? "light" : "dark")),
      },
      {
        id: "action:sidebar",
        label: "Toggle sidebar",
        keywords: ["sidebar", "panel"],
        node: (
          <>
            <SidebarIcon className="size-4 text-kumo-subtle" />
            Toggle sidebar
            <Hint>{shortcutHint("sidebar")}</Hint>
          </>
        ),
        select: () => run("palette.action", "sidebar", toggleSidebar),
      },
      {
        id: "action:settings",
        label: "Open settings",
        keywords: ["settings", "preferences"],
        node: (
          <>
            <GearIcon className="size-4 text-kumo-subtle" />
            Open settings
            <Hint>{shortcutHint("settings")}</Hint>
          </>
        ),
        select: () => run("palette.action", "settings", () => openSettingsTab()),
      },
    ],
  });

  const results = rankGroups(groups, query);
  if (quickAdd) {
    results.push({
      id: "create",
      label: "Create",
      items: [
        {
          id: quickAdd.key,
          label: `create todo ${quickAdd.title}`,
          keywords: [],
          node: (
            <>
              <ListPlusIcon className="size-4 shrink-0 text-kumo-subtle" />
              <span className="truncate">
                Create todo: <span className="text-kumo-subtle">{quickAdd.title}</span>
              </span>
            </>
          ),
          select: () => createTodo(quickAdd.title),
        },
      ],
    });
  }

  return (
    <Palette.Root
      open={paletteOpen}
      onOpenChange={(open) => {
        setPaletteOpen(open);
        if (!open) setQuery("");
      }}
      items={results}
      value={query}
      onValueChange={setQuery}
      itemToStringValue={(x) => x.label}
    >
      <Palette.Input
        placeholder="Search screens, repos, sessions, tasks, PRs, issues…"
        autoComplete="off"
        spellCheck={false}
      />
      <Palette.List>
        <Palette.Results>
          {(group: PaletteGroup) => (
            <Palette.Group key={group.id} items={group.items}>
              <Palette.GroupLabel>{group.label}</Palette.GroupLabel>
              <Palette.Items>
                {(item: PaletteRow) => (
                  <Palette.Item key={item.id} value={item} onClick={item.select}>
                    {item.node}
                  </Palette.Item>
                )}
              </Palette.Items>
            </Palette.Group>
          )}
        </Palette.Results>
        <Palette.Empty>Nothing matches.</Palette.Empty>
      </Palette.List>
      <Palette.Footer>
        <span>↑↓ navigate</span>
        <span>↵ select</span>
        <span>esc close</span>
      </Palette.Footer>
    </Palette.Root>
  );
}

type PaletteRow = {
  id: string;
  /** What `paletteFilter` scores the query against. */
  label: string;
  keywords: string[];
  node: ReactNode;
  select: () => void;
};

type PaletteGroup = { id: string; label: string; items: PaletteRow[] };

/** `ml-auto` right-hand hint on a row (shortcut glyphs, "needs you"). */
function Hint({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("ml-auto pl-2 text-xs text-kumo-subtle", className)}>{children}</span>;
}

/** Kumo hands filtering to the caller, so apply `paletteFilter` here and rank:
 * best score first within a group, best-scoring group first. An
 * empty query keeps declared order. */
function rankGroups(groups: PaletteGroup[], query: string): PaletteGroup[] {
  const ranked: { group: PaletteGroup; best: number }[] = [];
  for (const group of groups) {
    const scored = group.items
      .map((item) => ({ item, score: paletteFilter(item.label, query, item.keywords) }))
      .filter((s) => s.score > 0)
      .toSorted((a, b) => b.score - a.score);
    const first = scored[0];
    if (first) {
      ranked.push({
        group: { ...group, items: scored.map((s) => s.item) },
        best: first.score,
      });
    }
  }
  const ordered = query.trim() ? ranked.toSorted((a, b) => b.best - a.best) : ranked;
  return ordered.map((r) => r.group);
}
