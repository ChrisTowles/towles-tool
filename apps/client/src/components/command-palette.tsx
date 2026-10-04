import { useState } from "react";
import { toast } from "sonner";
import {
  CircleDot,
  FolderGit2,
  GitPullRequest,
  ListPlus,
  ListTodo,
  Moon,
  PanelLeft,
  PenLine,
  Settings,
  Sun,
  TerminalSquare,
} from "lucide-react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
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
  const taskEntries = paletteTaskEntries(snapshot.tasks);
  const prEntries = palettePrEntries(snapshot.prs);
  const issueEntries = paletteIssueEntries(snapshot.issues);
  const quickAdd = paletteQuickAddEntry(query);

  const createTodo = (title: string) =>
    run("palette.create", "todo", () => {
      void storeAddTask(title);
      toast.success("Todo added", { description: title });
    });

  return (
    <CommandDialog
      open={paletteOpen}
      onOpenChange={(open) => {
        setPaletteOpen(open);
        if (!open) setQuery("");
      }}
    >
      <Command filter={paletteFilter}>
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search screens, repos, sessions, tasks, PRs, issues…"
        />
        <CommandList>
          <CommandEmpty>Nothing matches.</CommandEmpty>
          {recentScreens.length > 0 && (
            <>
              <CommandGroup heading="Recent">
                {recentScreens.map((id) => {
                  const screen = SCREENS[id];
                  return (
                    <CommandItem
                      key={id}
                      value={`recent ${screen.title}`}
                      keywords={screen.keywords}
                      onSelect={() => run("palette.recent", id, () => openTab(id))}
                    >
                      <screen.icon />
                      {screen.title}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
              <CommandSeparator />
            </>
          )}
          <CommandGroup heading="Go to">
            {Object.values(SCREENS).map((screen) => (
              <CommandItem
                key={screen.id}
                keywords={screen.keywords}
                onSelect={() => run("palette.go_to", screen.id, () => openTab(screen.id))}
              >
                <screen.icon />
                {screen.title}
              </CommandItem>
            ))}
          </CommandGroup>
          {repoEntries.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Agentboard repos">
                {repoEntries.map((entry) => (
                  <CommandItem
                    key={entry.key}
                    value={`repo ${entry.repoName} ${entry.folderName} ${entry.folderDir}`}
                    keywords={entry.keywords}
                    onSelect={() => jumpToFolder(entry)}
                  >
                    <FolderGit2 />
                    <span className="truncate">{entry.repoName}</span>
                    <span className="ml-1 truncate text-muted-foreground">{entry.folderName}</span>
                    {entry.needs > 0 && (
                      <CommandShortcut className="text-blue-500">
                        {entry.needs} need you
                      </CommandShortcut>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}
          {sessionEntries.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Agentboard sessions">
                {sessionEntries.map((entry) => (
                  <CommandItem
                    key={entry.key}
                    value={`session ${entry.label} ${entry.repoName} ${entry.folderName}`}
                    keywords={entry.keywords}
                    onSelect={() => jumpToSession(entry)}
                  >
                    <TerminalSquare />
                    <span className="truncate">{entry.label}</span>
                    <span className="ml-1 truncate text-muted-foreground">{entry.repoName}</span>
                    {entry.needs && (
                      <CommandShortcut className="text-blue-500">needs you</CommandShortcut>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}
          {taskEntries.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Board tasks">
                {taskEntries.map((entry) => (
                  <CommandItem
                    key={entry.key}
                    value={entry.value}
                    keywords={entry.keywords}
                    onSelect={() => jumpToTask(entry.target)}
                  >
                    <ListTodo />
                    <span className="truncate">{entry.title}</span>
                    {entry.meta && (
                      <span className="ml-1 truncate text-muted-foreground">{entry.meta}</span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}
          {prEntries.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Open pull request">
                {prEntries.map((entry) => (
                  <CommandItem
                    key={entry.key}
                    value={`pr ${entry.repo} ${entry.number} ${entry.title}`}
                    keywords={entry.keywords}
                    onSelect={() =>
                      run(
                        "palette.pr",
                        entry.checks || undefined,
                        () => void openExternalUrl(entry.url),
                      )
                    }
                  >
                    <GitPullRequest />
                    <span className="truncate">
                      {entry.repo}
                      <span className="text-muted-foreground"> #{entry.number}</span>
                    </span>
                    <span className="ml-1 truncate text-muted-foreground">{entry.title}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}
          {issueEntries.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Open issue">
                {issueEntries.map((entry) => (
                  <CommandItem
                    key={entry.key}
                    value={`issue ${entry.repo} ${entry.number} ${entry.title}`}
                    keywords={entry.keywords}
                    onSelect={() =>
                      run("palette.issue", undefined, () => void openExternalUrl(entry.url))
                    }
                  >
                    <CircleDot />
                    <span className="truncate">
                      {entry.repo}
                      <span className="text-muted-foreground"> #{entry.number}</span>
                    </span>
                    <span className="ml-1 truncate text-muted-foreground">{entry.title}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}
          <CommandSeparator />
          <CommandGroup heading="Actions">
            <CommandItem
              keywords={["journal", "log", "note", "today"]}
              onSelect={() =>
                run("palette.action", "quicklog", () =>
                  window.dispatchEvent(new Event("quicklog:open")),
                )
              }
            >
              <PenLine />
              Journal: log a line
              <CommandShortcut>{shortcutHint("quicklog")}</CommandShortcut>
            </CommandItem>
            <CommandItem
              keywords={["theme", "dark", "light"]}
              onSelect={() =>
                run("palette.action", "theme", () => setTheme(resolvedDark ? "light" : "dark"))
              }
            >
              {resolvedDark ? <Sun /> : <Moon />}
              Switch to {resolvedDark ? "light" : "dark"} theme
            </CommandItem>
            <CommandItem
              keywords={["sidebar", "panel"]}
              onSelect={() => run("palette.action", "sidebar", toggleSidebar)}
            >
              <PanelLeft />
              Toggle sidebar
              <CommandShortcut>{shortcutHint("sidebar")}</CommandShortcut>
            </CommandItem>
            <CommandItem
              keywords={["settings", "preferences"]}
              onSelect={() => run("palette.action", "settings", () => openSettingsTab())}
            >
              <Settings />
              Open settings
              <CommandShortcut>{shortcutHint("settings")}</CommandShortcut>
            </CommandItem>
          </CommandGroup>
          {quickAdd && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Create">
                <CommandItem
                  key={quickAdd.key}
                  value={`create todo ${quickAdd.title}`}
                  keywords={["todo", "task", "add", "new", quickAdd.title]}
                  onSelect={() => createTodo(quickAdd.title)}
                >
                  <ListPlus />
                  <span className="truncate">
                    Create todo: <span className="text-muted-foreground">{quickAdd.title}</span>
                  </span>
                </CommandItem>
              </CommandGroup>
            </>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
