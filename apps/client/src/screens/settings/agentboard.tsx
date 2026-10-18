import { useCallback, useEffect, useRef, useState } from "react";
import { DotsSixVerticalIcon, FolderPlusIcon, GitBranchIcon } from "@phosphor-icons/react";
import { toast } from "@/lib/toast";
import { ToggleGroup } from "@cloudflare/kumo/primitives/toggle-group";
import { Toggle } from "@cloudflare/kumo/primitives/toggle";
import { Button, Dialog, Input, InputArea, Popover, Select } from "@cloudflare/kumo";
import type { RepoCandidate } from "@/lib/agentboard/actions";
import { useAgentboardState } from "@/lib/agentboard/state";
import type { RepoData } from "@/lib/agentboard/types";
import {
  applyRepoOrder,
  orderSettled,
  reorderDirs,
  sameOrder,
  showAddPath,
  untrackedCandidates,
} from "@/lib/repo-manager";
import {
  paletteColor,
  repoAccentStyles,
  repoIcon,
  REPO_ICONS,
  type RepoMeta,
} from "@/lib/repo-identity";
import { liveSessionIds, trackRepo, untrackRepo } from "@/lib/repo-actions";
import { uiAction } from "@/lib/ui-action";
import { invoke } from "@/lib/tauri";
import { matchesFilter } from "@/lib/settings-filter";
import { NotInTauri } from "@/lib/errors";
import {
  DEFAULT_NOTIFY_THRESHOLD,
  DEFAULT_ADVANCE_AFTER_SUBMIT,
  DEFAULT_AUTO_RESUME,
  NOTIFY_LEVELS,
  type NotifyLevel,
  type UserSettings,
} from "@/lib/settings";
import { DEFAULT_BROWSER_PANE, DEFAULT_JARVIS_PANE } from "@/lib/rail-prefs";
import { DEFAULT_TERMINAL_FONT_SIZE, clampTerminalFontSize } from "@/lib/terminal-prefs";
import { PALETTE } from "@/lib/colors";
import { cn } from "@/lib/utils";
import { PromptImproversEditor } from "./collectors";
import { TaskTemplatesEditor } from "./task-templates";
import {
  CadenceRow,
  DEFAULT_COMPACT_RECOMMEND_PERCENT,
  SettingRow,
  ToggleRow,
  type FilterRow,
  type FilterSection,
  type Flush,
  type Update,
} from "./common";

export function agentboardSections(
  settings: UserSettings | null,
  update: Update,
  flush: Flush,
): FilterSection[] {
  const rows: FilterRow[] = [
    {
      label: "Scan roots",
      keywords: ["repo", "discovery", "directory", "picker", "add repo"],
      node: <AgentboardSettings />,
    },
    {
      label: "Repos",
      keywords: [
        "repo",
        "track",
        "untrack",
        "add repo",
        "remove",
        "rail",
        "order",
        "reorder",
        "icon",
        "color",
      ],
      node: <RepoManager />,
    },
  ];
  if (settings) {
    rows.push(
      {
        label: "Prompt improvers",
        keywords: [
          "prompt",
          "improver",
          "improve",
          "goal",
          "plan",
          "brainstorm",
          "template",
          "new task",
        ],
        node: (
          <PromptImproversEditor
            improvers={settings.promptImprovers ?? []}
            onChange={(improvers, opts) =>
              update((s) => ({ ...s, promptImprovers: improvers }), opts)
            }
            onCommit={() => void flush()}
          />
        ),
      },
      {
        label: "Task templates",
        keywords: ["template", "preset", "new task", "goal", "setup", "improver", "--template"],
        node: (
          <TaskTemplatesEditor
            templates={settings.taskTemplates ?? []}
            improvers={settings.promptImprovers ?? []}
            onChange={(taskTemplates, opts) => update((s) => ({ ...s, taskTemplates }), opts)}
            onCommit={() => void flush()}
          />
        ),
      },
      {
        label: "Next-prompt suggestion",
        keywords: ["next", "prompt", "suggest", "haiku", "budget", "mod", "claude", "/next"],
        node: (
          <NextPromptEditor
            value={settings.nextPrompt ?? {}}
            onChange={(nextPrompt) => update((s) => ({ ...s, nextPrompt }))}
            onCommit={() => void flush()}
          />
        ),
      },
      {
        label: "Copy suggestions",
        keywords: ["clipboard", "copy", "clip", "haiku", "budget", "mod", "claude", "turn"],
        node: (
          <ClipSuggestEditor
            value={settings.clipSuggest ?? {}}
            onChange={(clipSuggest) => update((s) => ({ ...s, clipSuggest }))}
            onCommit={() => void flush()}
          />
        ),
      },
      {
        label: "Desktop notifications",
        keywords: [
          "notification",
          "desktop",
          "alert",
          "needs you",
          "meeting",
          "pr",
          "review",
          "ci",
          "checks",
          "collector",
        ],
        node: (
          <ToggleRow
            id="notify"
            label="Desktop notifications"
            description="Fire desktop notifications for meetings, agents needing you, PR/CI activity, and collector health. Status only — act in the session's terminal."
            checked={settings.agentboard?.notify ?? true}
            onCheckedChange={(v) =>
              update((s) => ({
                ...s,
                agentboard: { ...s.agentboard, notify: v },
              }))
            }
          />
        ),
      },
      {
        label: "Notification threshold",
        keywords: [
          "notification",
          "threshold",
          "urgency",
          "level",
          "important",
          "urgent",
          "routine",
          "alert",
        ],
        node: (
          <NotifyThresholdRow
            disabled={!(settings.agentboard?.notify ?? true)}
            value={settings.agentboard?.notifyThreshold ?? DEFAULT_NOTIFY_THRESHOLD}
            onValue={(v) =>
              update((s) => ({
                ...s,
                agentboard: { ...s.agentboard, notifyThreshold: v },
              }))
            }
          />
        ),
      },
      {
        label: "Compaction recommendation",
        keywords: ["context", "compact", "percent", "threshold", "session", "usage"],
        node: (
          <CadenceRow
            label="Compaction recommendation"
            description="Flag a session for compaction once its context usage exceeds this percentage."
            unit="%"
            value={
              settings.agentboard?.compactRecommendPercent ?? DEFAULT_COMPACT_RECOMMEND_PERCENT
            }
            onValue={(n) =>
              update(
                (s) => ({
                  ...s,
                  agentboard: {
                    ...s.agentboard,
                    compactRecommendPercent: Math.min(100, Math.max(1, n)),
                  },
                }),
                { defer: true },
              )
            }
            onCommit={() => void flush()}
          />
        ),
      },
      {
        label: "Copy on select",
        keywords: ["terminal", "clipboard", "selection", "copy"],
        node: (
          <ToggleRow
            id="copy_on_select"
            label="Copy on select"
            description="Copy the terminal selection to the clipboard as soon as you finish selecting, without Ctrl/⌘+Shift+C."
            checked={settings.agentboard?.copyOnSelect ?? true}
            onCheckedChange={(v) =>
              update((s) => ({
                ...s,
                agentboard: { ...s.agentboard, copyOnSelect: v },
              }))
            }
          />
        ),
      },
      {
        label: "Jarvis pane",
        keywords: ["jarvis", "bevy", "native", "pane", "3d", "render", "gpu", "rail"],
        node: (
          <ToggleRow
            id="jarvis_pane"
            label="Jarvis pane"
            description="Turn on Jarvis, the native Bevy surface: a strip at the bottom of the Agentboard rail, plus a “jarvis” button on each checkout that tiles one as a pane beside its terminals. A proof-of-concept, and Linux/Wayland only — leave it off and nothing is ever drawn. It also needs a build made with the `bevy` Cargo feature, off by default because compiling it dwarfs the rest of the app; without one, opening a pane reports it unsupported. Turning it back off parks what you opened rather than reclaiming it; relaunch for that."
            checked={settings.agentboard?.jarvisPane ?? DEFAULT_JARVIS_PANE}
            onCheckedChange={(v) =>
              update((s) => ({
                ...s,
                agentboard: { ...s.agentboard, jarvisPane: v },
              }))
            }
          />
        ),
      },
      {
        label: "Chrome pane",
        keywords: ["chrome", "browser", "web", "pane", "login", "sign in", "cdp", "headless"],
        node: (
          <ToggleRow
            id="browser_pane"
            label="Chrome pane"
            description="Add a “chrome” button to each checkout that opens a real Chrome beside its terminals. It keeps its own browser profile, separate from your personal Chrome and empty to start — sign into a site once there and it stays signed in. Needs Chrome or Chromium installed."
            checked={settings.agentboard?.browserPane ?? DEFAULT_BROWSER_PANE}
            onCheckedChange={(v) =>
              update((s) => ({
                ...s,
                agentboard: { ...s.agentboard, browserPane: v },
              }))
            }
          />
        ),
      },
      {
        label: "Terminal font size",
        keywords: ["terminal", "font", "size", "zoom", "text"],
        node: (
          <CadenceRow
            label="Terminal font size"
            description="Font size (px) for the app's terminals. Zoom in/out live with Ctrl/⌘ +/- (Ctrl/⌘ 0 resets)."
            unit="px"
            value={settings.agentboard?.terminalFontSize ?? DEFAULT_TERMINAL_FONT_SIZE}
            onValue={(n) =>
              update(
                (s) => ({
                  ...s,
                  agentboard: { ...s.agentboard, terminalFontSize: clampTerminalFontSize(n) },
                }),
                { defer: true },
              )
            }
            onCommit={() => void flush()}
          />
        ),
      },
      {
        label: "Close landed tasks automatically",
        keywords: ["close", "done", "merged", "landed", "worktree", "remove", "task"],
        node: (
          <ToggleRow
            id="auto_close_landed"
            label="Close landed tasks automatically"
            description="Once a task's work is in the base branch and its checkout holds nothing else, close it as done and remove its worktree. Never while its agent is working or asking."
            checked={settings.agentboard?.autoCloseLanded ?? true}
            onCheckedChange={(v) =>
              update((s) => ({
                ...s,
                agentboard: { ...s.agentboard, autoCloseLanded: v },
              }))
            }
          />
        ),
      },
      {
        label: "Shortcuts work in terminal",
        keywords: ["shortcut", "keyboard", "terminal", "focus", "hotkey", "jump", "needs you"],
        node: (
          <ToggleRow
            id="shortcuts_in_terminal"
            label="Shortcuts work in terminal"
            description="Board-wide shortcuts (jump to next/prev session needing you, close/split session, toggle diff/rail) fire even while a terminal has focus, instead of being sent to the shell."
            checked={settings.agentboard?.shortcutsWorkInTerminal ?? true}
            onCheckedChange={(v) =>
              update((s) => ({
                ...s,
                agentboard: { ...s.agentboard, shortcutsWorkInTerminal: v },
              }))
            }
          />
        ),
      },
      {
        label: "Resume sessions on launch",
        keywords: ["resume", "restart", "launch", "claude", "session", "restore"],
        node: (
          <ToggleRow
            id="auto_resume"
            label="Resume sessions on launch"
            description="Relaunch every pane that was running Claude when the app last closed, with claude --resume. Off, the app asks which to relaunch."
            checked={settings.agentboard?.autoResume ?? DEFAULT_AUTO_RESUME}
            onCheckedChange={(v) =>
              update((s) => ({ ...s, agentboard: { ...s.agentboard, autoResume: v } }))
            }
          />
        ),
      },
      {
        label: "Move to the next agent after answering",
        keywords: ["advance", "next", "focus", "queue", "needs you", "answer", "submit"],
        node: (
          <ToggleRow
            id="advance_after_submit"
            label="Move to the next agent after answering"
            description="When you send a prompt to an agent that was waiting on you, focus moves to the next one asking, finished or errored. Keep typing in the pane and you stay."
            checked={settings.agentboard?.advanceAfterSubmit ?? DEFAULT_ADVANCE_AFTER_SUBMIT}
            onCheckedChange={(v) =>
              update((s) => ({ ...s, agentboard: { ...s.agentboard, advanceAfterSubmit: v } }))
            }
          />
        ),
      },
    );
  }
  return [{ rows }];
}

/** The least urgent level still allowed through. Shown-but-disabled while
 * the master switch is off, so the choice stays discoverable; the kind→level
 * mapping lives in Rust (`tt_config::NotifyKind::level`). */
function NotifyThresholdRow({
  value,
  disabled,
  onValue,
}: {
  value: NotifyLevel;
  disabled: boolean;
  onValue: (v: NotifyLevel) => void;
}) {
  const current = NOTIFY_LEVELS.find((l) => l.value === value) ?? NOTIFY_LEVELS[0];
  return (
    <SettingRow label="Notification threshold" description={current.description}>
      <Select
        aria-label="Notification threshold"
        className="w-44"
        value={value}
        disabled={disabled}
        onValueChange={(v) => {
          if (!v) return;
          uiAction("settings.notify_threshold", "settings", v);
          onValue(v as NotifyLevel);
        }}
        items={NOTIFY_LEVELS.map((level) => ({ value: level.value, label: level.label }))}
      />
    </SettingRow>
  );
}

/** Scan-root editor for repo discovery: `scanRoots` in `repos.json` over the
 * `ab_*` commands, not the shared settings file. Empty falls back to
 * `~/code`. */
function AgentboardSettings() {
  const [roots, setRoots] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string | null>(null);

  useEffect(() => {
    void invoke<string[]>("ab_get_scan_roots").then((r) => setRoots(r.unwrapOr([]).join("\n")));
  }, []);

  // Autosave, like the rest of this screen. Deliberately does *not* write the
  // normalized list back into the textarea: this fires mid-typing, and replacing
  // the value would eat the blank line you just opened and jump the cursor.
  const persist = useCallback(async () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const raw = pending.current;
    if (raw === null) return;
    pending.current = null;
    const list = raw
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const stored = await invoke("ab_set_scan_roots", { roots: list });
    if (stored.isErr()) {
      if (!NotInTauri.is(stored.error)) {
        toast.error(`Couldn't save scan roots — ${stored.error.message}`);
      }
      return;
    }
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  }, []);

  const edit = (next: string) => {
    setRoots(next);
    pending.current = next;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => void persist(), 600);
  };

  // Commit a pending edit if the pane unmounts (a tab switch drops it).
  const persistRef = useRef(persist);
  persistRef.current = persist;
  useEffect(
    () => () => {
      void persistRef.current();
    },
    [],
  );

  if (roots === null) {
    return <div className="text-sm text-kumo-subtle">Loading…</div>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-sm font-medium">Scan roots</div>
        <p className="text-sm text-kumo-subtle">
          One directory per line. The repo list below scans these for git repos. Leave empty to use{" "}
          <span className="font-mono">~/code</span>. A leading <span className="font-mono">~</span>{" "}
          expands to your home directory.
        </p>
      </div>
      <InputArea
        value={roots}
        aria-label="Scan roots"
        onChange={(e) => edit(e.target.value)}
        onBlur={() => void persist()}
        rows={5}
        placeholder="~/code"
        className="font-mono text-xs"
        spellCheck={false}
      />
      {saved && <span className="text-xs text-kumo-subtle">Saved.</span>}
    </div>
  );
}

/** The **one** place repos are managed. Identity is offered only for
 * *tracked* repos: an untracked candidate has nowhere to show an icon, so
 * those rows carry a Track action rather than dead controls. */
function RepoManager() {
  const { repos } = useAgentboardState();
  const [candidates, setCandidates] = useState<RepoCandidate[]>([]);
  const [query, setQuery] = useState("");
  const [confirm, setConfirm] = useState<{
    dir: string;
    name: string;
    /** Live session ids closed on confirm — see `untrack`. */
    sessionIds: string[];
  } | null>(null);
  // Optimistic order, held only until a poll reports the same sequence — a
  // dropped row must not snap back for the length of the IPC round-trip.
  const [order, setOrder] = useState<string[] | null>(null);
  const [dragDir, setDragDir] = useState<string | null>(null);
  const [dropBefore, setDropBefore] = useState<string | null>(null);

  const refresh = async () => {
    setCandidates((await invoke<RepoCandidate[]>("ab_discover_repos")).unwrapOr([]));
  };

  // This pane only exists while the Agentboard tab is the selected one (only
  // that pane renders), so a mount is exactly "the tab was shown".
  useEffect(() => {
    void refresh();
  }, []);

  const snapshotDirs = repos.map((r) => r.dir);
  const ordered = applyRepoOrder(repos, order);
  const trackedDirs = new Set(snapshotDirs);
  // Drop the optimistic overlay once the snapshot reflects the drag.
  const settled = orderSettled(order, snapshotDirs);
  useEffect(() => {
    if (settled) setOrder(null);
  }, [settled]);

  const visibleRepos = ordered.filter((r) => matchesFilter(query, r.name, [r.dir]));
  const visibleCandidates = untrackedCandidates(candidates, trackedDirs).filter((c) =>
    matchesFilter(query, c.name, [c.dir]),
  );

  const track = async (path: string) => {
    if (await trackRepo(path, "settings")) await refresh();
  };

  const untrack = async (dir: string, name: string, sessionIds: string[] = []) => {
    if (await untrackRepo(dir, name, sessionIds, "settings")) await refresh();
  };

  // Untracking a repo whose sessions are still running stops them, so that
  // case confirms first (same guard the deleted dialog carried).
  const requestUntrack = (repo: RepoData) => {
    const liveIds = liveSessionIds(repo);
    if (liveIds.length === 0) {
      void untrack(repo.dir, repo.name);
      return;
    }
    setConfirm({ dir: repo.dir, name: repo.name, sessionIds: liveIds });
  };

  const drop = (beforeDir: string | "end") => {
    const dragged = dragDir;
    setDragDir(null);
    setDropBefore(null);
    if (!dragged) return;
    const current = ordered.map((r) => r.dir);
    const next = reorderDirs(current, dragged, beforeDir);
    if (sameOrder(current, next)) return;
    setOrder(next);
    uiAction("repo.reordered", "settings");
    void invoke("ab_set_repo_order", { dirs: next }).then((res) => {
      if (res.isErr() && !NotInTauri.is(res.error)) {
        toast.error(`Couldn't save the repo order — ${res.error.message}`);
        setOrder(null);
      }
    });
  };

  return (
    // A bottom rule + generous gap: this block ends in a list of rows, and the
    // settings rows that follow look just like them without a hard break.
    <div className="flex flex-col gap-3 border-b border-kumo-hairline pb-5">
      <div>
        <div className="text-sm font-medium">Repos</div>
        <p className="text-sm text-kumo-subtle">
          Everything about the rail's repo list lives here: which repos are tracked, the order they
          sit in (drag a row), and each one's glyph and color so you can pick it out — especially in
          the collapsed icon strip — without reading names. Identity is decoration only: it never
          changes a status signal, and a repo waiting on you still shows amber.
        </p>
      </div>

      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search repos, or type an absolute path…"
        spellCheck={false}
        aria-label="Search repos"
      />

      {repos.length === 0 && (
        <p className="text-sm text-kumo-subtle/70">
          No repos tracked yet — track one from the list below.
        </p>
      )}

      <section aria-label="Tracked repos" className="flex flex-col gap-1">
        <h4 className="text-xs font-medium uppercase tracking-wide text-kumo-subtle">
          On the rail
        </h4>
        <div className="flex flex-col overflow-hidden rounded-md border border-kumo-hairline">
          {visibleRepos.map((repo) => (
            <RepoIdentityRow
              key={repo.key}
              repo={repo}
              dragging={dragDir === repo.dir}
              dropTarget={dropBefore === repo.dir}
              onDragStart={() => setDragDir(repo.dir)}
              onDragOverRow={() => setDropBefore(repo.dir)}
              onDropRow={() => drop(repo.dir)}
              onDragEnd={() => {
                setDragDir(null);
                setDropBefore(null);
              }}
              onUntrack={() => requestUntrack(repo)}
            />
          ))}
          {dragDir && (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDropBefore(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                drop("end");
              }}
              className="m-1 h-6 rounded-md border border-dashed border-kumo-hairline/70"
            />
          )}
        </div>
      </section>

      {showAddPath(query, candidates, trackedDirs) && (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          icon={<FolderPlusIcon className="size-3.5" />}
          onClick={() => void track(query.trim())}
        >
          Add path {query.trim()}
        </Button>
      )}

      {visibleCandidates.length > 0 && (
        <section aria-label="Repos not tracked" className="flex flex-col gap-1">
          <h4 className="text-xs font-medium uppercase tracking-wide text-kumo-subtle">
            Found under your scan roots ({visibleCandidates.length})
          </h4>
          <p className="text-xs text-kumo-subtle/70">
            Not on the rail. Track one to give it a glyph, a color, and a place in the order — or
            search above to narrow this list.
          </p>
          {/* Filled + bordered so this list reads as its own block: it sits
              between the tracked list and the notification settings below,
              and without containment its rows look like more settings. */}
          <div className="flex max-h-64 flex-col overflow-y-auto rounded-md border border-dashed border-kumo-hairline bg-muted/30">
            {visibleCandidates.map((c) => (
              <div
                key={c.dir}
                className="flex items-center gap-3 border-t border-kumo-hairline/60 px-2 py-2 first:border-t-0"
              >
                <GitBranchIcon aria-hidden className="size-4 shrink-0 text-kumo-subtle" />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{c.name}</span>
                  <span className="truncate font-mono text-xs text-kumo-subtle">{c.dir}</span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="px-2 text-xs"
                  onClick={() => void track(c.dir)}
                >
                  Track
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      <Dialog.Root open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <Dialog className="p-6">
          <Dialog.Title className="text-lg font-semibold">
            Untrack {confirm?.name} from the rail?
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-kumo-subtle">
            {confirm?.sessionIds.length}{" "}
            {confirm?.sessionIds.length === 1 ? "session is" : "sessions are"} still running.
            Untracking will stop {confirm?.sessionIds.length === 1 ? "it" : "them"}.
          </Dialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close
              render={(p) => (
                <Button {...p} variant="secondary">
                  Cancel
                </Button>
              )}
            />
            <Dialog.Close
              render={(p) => (
                <Button
                  {...p}
                  variant="primary"
                  onClick={(e) => {
                    p.onClick?.(e);
                    if (confirm) void untrack(confirm.dir, confirm.name, confirm.sessionIds);
                    setConfirm(null);
                  }}
                >
                  Stop &amp; untrack
                </Button>
              )}
            />
          </div>
        </Dialog>
      </Dialog.Root>
    </div>
  );
}

function RepoIdentityRow({
  repo,
  dragging,
  dropTarget,
  onDragStart,
  onDragOverRow,
  onDropRow,
  onDragEnd,
  onUntrack,
}: {
  repo: RepoData;
  dragging: boolean;
  dropTarget: boolean;
  onDragStart: () => void;
  onDragOverRow: () => void;
  onDropRow: () => void;
  onDragEnd: () => void;
  onUntrack: () => void;
}) {
  // Local state is the truth once you have edited: the agentboard snapshot that
  // seeded it arrives on a poll, and re-syncing from it mid-edit would fight
  // the user's own clicks.
  const [meta, setMeta] = useState<RepoMeta | undefined>(repo.meta);
  const [saved, setSaved] = useState(false);
  const dir = repo.dir;
  const Icon = repoIcon(meta);
  // Unpinned, the color is the one the backend dealt — so the row previews it.
  const pinned = paletteColor(meta?.color);
  const accent = repoAccentStyles({ color: pinned ?? repo.color, meta });
  // `meta` lags an in-flight commit by a full await and `ab_set_repo_meta`
  // replaces the identity *wholesale*, so a second click built off the render
  // closure would send a payload missing the first field and erase it.
  const latest = useRef<RepoMeta | undefined>(repo.meta);

  const commit = async (next: RepoMeta | null, action: string, detail?: string) => {
    latest.current = next ?? undefined;
    const res = await invoke("ab_set_repo_meta", {
      dir,
      icon: next?.icon ?? null,
      color: next?.color ?? null,
    });
    if (res.isErr()) {
      if (!NotInTauri.is(res.error)) {
        toast.error(`Couldn't save ${repo.name} — ${res.error.message}`);
      }
      // Roll the optimistic ref back so the next edit doesn't build on a value
      // the backend rejected.
      latest.current = meta;
      return;
    }
    setMeta(next ?? undefined);
    uiAction(action, "settings", detail);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  };

  const setIcon = (name: string) =>
    void commit({ ...latest.current, icon: name }, "repo.icon_set", name);
  const setColor = (swatch: string) =>
    void commit({ ...latest.current, color: swatch }, "repo.color_set", "palette");
  const unpin = () => {
    void commit({ ...latest.current, color: undefined }, "repo.color_unpinned");
  };
  const reset = () => {
    void commit(null, "repo.identity_reset");
  };

  return (
    <div
      // The rail header's own identity decoration, so a repo's color is
      // visible where you set it.
      style={{ ...accent.edgeStyle, ...accent.surfaceStyle }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onDragOverRow();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDropRow();
      }}
      className={cn(
        // `border-l-2 … border-l-transparent` reserves the edge so `edgeStyle`'s
        // inline `borderLeftColor` has a border to paint and unthemed rows don't
        // shift width — the same idiom the rail header uses.
        "flex items-center gap-2 border-t border-l-2 border-kumo-hairline border-l-transparent px-2 py-2 first:border-t-transparent",
        dragging && "opacity-50",
        dropTarget && "border-t-agent",
      )}
    >
      <span
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          // Firefox/WebKit refuse to start a drag with an empty payload.
          e.dataTransfer.setData("text/plain", dir);
          onDragStart();
        }}
        onDragEnd={onDragEnd}
        aria-label={`Reorder ${repo.name}`}
        title="Drag to reorder"
        className="shrink-0 cursor-grab text-kumo-subtle active:cursor-grabbing"
      >
        <DotsSixVerticalIcon className="size-4" />
      </span>
      <Icon aria-hidden className="size-4 shrink-0" style={accent.iconStyle} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{repo.name}</span>
        <span className="truncate font-mono text-xs text-kumo-subtle">{dir}</span>
      </div>
      {saved && <span className="shrink-0 text-xs text-kumo-subtle">Saved.</span>}

      <Popover>
        <Popover.Trigger
          render={
            <Button variant="outline" size="sm" className="px-2 text-xs">
              Icon
            </Button>
          }
        />
        <Popover.Content className="w-auto p-3" align="end">
          <ToggleGroup
            aria-label="Icon"
            value={meta?.icon ? [meta.icon] : []}
            onValueChange={(v) => {
              if (v[0]) setIcon(v[0]);
            }}
            className="grid grid-cols-6 gap-2"
          >
            {Object.entries(REPO_ICONS).map(([name, Choice]) => (
              <Toggle
                key={name}
                value={name}
                title={name}
                aria-label={name}
                className="flex size-8 items-center justify-center rounded-md text-kumo-subtle outline-none hover:bg-kumo-tint hover:text-kumo-default focus-visible:ring-2 focus-visible:ring-kumo-focus data-[pressed]:bg-kumo-tint data-[pressed]:text-kumo-default"
              >
                <Choice className="size-4" style={accent.iconStyle} />
              </Toggle>
            ))}
          </ToggleGroup>
        </Popover.Content>
      </Popover>

      <Popover>
        <Popover.Trigger
          render={
            <Button variant="outline" size="sm" className="px-2 text-xs">
              Color · {pinned ? "pinned" : "auto"}
            </Button>
          }
        />
        <Popover.Content className="w-auto p-3" align="end">
          <div className="mb-2 flex items-center justify-between gap-2 text-xs text-kumo-subtle">
            {pinned ? "Pinned — kept as is" : "Auto — dealt one no other repo holds"}
            {pinned && (
              <Button variant="ghost" size="xs" onClick={unpin}>
                Auto
              </Button>
            )}
          </div>
          <ToggleGroup
            aria-label="Color"
            value={pinned ? [pinned] : []}
            onValueChange={(v) => {
              if (v[0]) setColor(v[0]);
            }}
            className="grid grid-cols-6 gap-1.5"
          >
            {PALETTE.map((swatch) => (
              <Toggle
                key={swatch}
                value={swatch}
                title={swatch}
                aria-label={swatch}
                style={{ backgroundColor: swatch }}
                className="size-7 rounded-md border border-kumo-hairline outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus data-[pressed]:ring-2 data-[pressed]:ring-kumo-focus data-[pressed]:ring-offset-1 data-[pressed]:ring-offset-kumo-base"
              />
            ))}
          </ToggleGroup>
        </Popover.Content>
      </Popover>

      <Button variant="ghost" size="sm" className="px-2 text-xs" onClick={reset}>
        Reset
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="px-2 text-xs text-kumo-subtle hover:text-kumo-default"
        onClick={onUntrack}
      >
        Untrack
      </Button>
    </div>
  );
}

type NextPrompt = NonNullable<UserSettings["nextPrompt"]>;

/** Rust holds the defaults, so a blank field here means "use them". */
function NextPromptEditor({
  value,
  onChange,
  onCommit,
}: {
  value: NextPrompt;
  onChange: (next: NextPrompt) => void;
  onCommit: () => void;
}) {
  const [spent, setSpent] = useState<number | null>(null);
  useEffect(() => {
    void invoke<number>("next_prompt_spend_today").then((r) => setSpent(r.unwrapOr(null)));
  }, []);
  const budget = value.dailyBudgetUsd ?? 0.2;
  return (
    <div className="flex flex-col gap-2">
      <SettingRow
        label="Next-prompt suggestion"
        description="The tt Claude mod's /next (or n on its band) asks one model call, with no tools, MCP or CLAUDE.md, what you'll type next. Never automatic."
        extra={
          spent != null && (
            <span className="font-mono text-xs text-kumo-subtle">
              ${spent.toFixed(4)} of ${budget.toFixed(2)} today
            </span>
          )
        }
      >
        <Input
          aria-label="Daily budget in US dollars"
          type="number"
          step="0.05"
          min="0"
          className="w-24"
          value={value.dailyBudgetUsd ?? ""}
          placeholder="0.20"
          onChange={(e) => {
            const n = Number.parseFloat(e.target.value);
            onChange({ ...value, dailyBudgetUsd: Number.isFinite(n) ? n : undefined });
          }}
          onBlur={onCommit}
        />
      </SettingRow>
      <InputArea
        aria-label="Next-prompt question"
        rows={3}
        value={value.question ?? ""}
        placeholder="Default: what is the person most likely to type as their next prompt…"
        onChange={(e) => onChange({ ...value, question: e.target.value || undefined })}
        onBlur={onCommit}
      />
    </div>
  );
}

type ClipSuggest = NonNullable<UserSettings["clipSuggest"]>;

function ClipSuggestEditor({
  value,
  onChange,
  onCommit,
}: {
  value: ClipSuggest;
  onChange: (next: ClipSuggest) => void;
  onCommit: () => void;
}) {
  return (
    <ToggleRow
      id="clip-suggest"
      label="Copy suggestions"
      description="When Claude hands you a command to run with the ! prefix, the tt Claude mod's band offers the command to paste into the prompt. 1–3 copies one, a copies all in order."
      checked={value.enabled ?? true}
      onCheckedChange={(enabled) => {
        onChange({ ...value, enabled });
        onCommit();
      }}
    />
  );
}
