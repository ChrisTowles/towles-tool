import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { ChevronRight, Pencil, RefreshCw, X } from "lucide-react";
import { DiffReview, type DiffReviewRequest } from "@/components/diff-review";
import { MonacoMultiDiff, type ChangedFile, type ChangedFiles } from "@/components/diff-monaco";
import { EditableToggle } from "@/components/editable-toggle";
import { EditorFontButtons } from "@/components/editor-font-buttons";
import { ClaudeBadge, IconBtn, PanePlaceholder } from "@/components/agentboard-bits";
import { PaneChrome, PaneLens } from "@/components/pane-chrome";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { folderBaseKey, folderStatsKey, type FolderData } from "@/lib/agentboard";
import { openInExternalEditor } from "@/lib/external-editor";
import {
  buildDiffTree,
  clampDiffRailWidth,
  DEFAULT_DIFF_RAIL_WIDTH,
  DIFF_RAIL_WIDTH_KEY,
  loadDiffRailWidth,
  MIN_DIFF_RAIL_WIDTH,
  sortToTreeOrder,
  type DiffTreeNode,
} from "@/lib/diff";
import { ideReadFile, useIdeConnected } from "@/lib/ide";
import { invoke, isTauri } from "@/lib/tauri";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/** Which baseline the pane diffs against (mirrors `DiffMode` in tt-agentboard). */
type DiffMode = "main" | "uncommitted";

/** Git name-status letter → folder-rail-ish color in the tree rail. */
const STATUS_COLORS: Record<string, string> = {
  A: "text-emerald-500",
  "?": "text-emerald-500",
  D: "text-red-500",
  R: "text-sky-500",
  C: "text-sky-500",
  M: "text-amber-500",
};

/** Navigation tree beside the multi-diff; clicking a file scrolls its diff into
 * view. The per-row checkbox is GitHub-review-style "viewed", not git staging —
 * it collapses that file's diff. A folder's covers every file beneath it; a
 * file's covers only itself, since whether nested tests count is the reviewer's
 * call. Memoized against DiffPane's unrelated re-renders. */
const DiffTreeRail = memo(function DiffTreeRail({
  dir,
  files,
  width,
  reviewed,
  dirty,
  conflict,
  onJump,
  onToggleReviewed,
  onToggleReviewedMany,
}: {
  /** The checkout the listed paths are relative to. */
  dir: string;
  files: ChangedFile[];
  /** Rail width in px — dragged on the divider, owned by DiffPane. */
  width: number;
  /** Paths the reviewer has checked off. */
  reviewed: ReadonlySet<string>;
  /** Paths with unsaved edits made in the diff pane — the Files tab's dirty dot. */
  dirty: ReadonlySet<string>;
  /** Paths changed on disk under unsaved edits; the Monaco pane owns resolution. */
  conflict: ReadonlySet<string>;
  onJump: (path: string) => void;
  /** Toggle one file's reviewed flag. */
  onToggleReviewed: (path: string) => void;
  /** Set (or clear) every path in the list at once — a folder's checkbox. */
  onToggleReviewedMany: (paths: string[], value: boolean) => void;
}) {
  // What the user has explicitly closed. Both folders and nested files default
  // *open*, unlike the Files pane's Explorer: every row here is a file under
  // review, and a disclosure would drop it out of the reviewer's list.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const tree = useMemo(() => buildDiffTree(files.map((f) => f.path)), [files]);
  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);
  // One bottom-up pass per file-set change. Walking each folder's subtree inside
  // renderNodes instead is O(n²) per render on a deeply nested tree.
  const leafPathsByFolder = useMemo(() => {
    const map = new Map<string, string[]>();
    const walk = (node: DiffTreeNode): string[] => {
      const leaves = node.children.flatMap(walk);
      // A file's nested tests count toward the folder above it, but a file is
      // not itself a folder checkbox.
      if (node.kind === "file") return [node.path, ...leaves];
      map.set(node.path, leaves);
      return leaves;
    };
    tree.forEach(walk);
    return map;
  }, [tree]);

  const renderNodes = (nodes: DiffTreeNode[], depth: number) =>
    nodes.map((node) => {
      const paddingLeft = 4 + depth * 12;
      if (node.kind === "folder") {
        const isCollapsed = collapsed.has(node.path);
        const paths = leafPathsByFolder.get(node.path) ?? [];
        const reviewedCount = paths.filter((p) => reviewed.has(p)).length;
        const checked: boolean | "indeterminate" =
          reviewedCount === 0 ? false : reviewedCount === paths.length ? true : "indeterminate";
        return (
          <li key={node.path}>
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div style={{ paddingLeft }} className="flex w-full items-center gap-1 py-0.5">
                  {/* `<label htmlFor>`, not nested in the button below: Radix's
                   * Checkbox renders a button and buttons can't nest. See
                   * apps/client/CLAUDE.md. */}
                  <label
                    htmlFor={`reviewed-${node.path}`}
                    onClick={(e) => e.stopPropagation()}
                    className="flex shrink-0 items-center"
                    title="mark every file in this folder reviewed"
                  >
                    <Checkbox
                      id={`reviewed-${node.path}`}
                      checked={checked}
                      onCheckedChange={(c) => onToggleReviewedMany(paths, c === true)}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      setCollapsed((prev) => {
                        const next = new Set(prev);
                        if (isCollapsed) next.delete(node.path);
                        else next.add(node.path);
                        return next;
                      })
                    }
                    className="flex min-w-0 flex-1 items-center gap-1 text-left font-mono text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    <ChevronRight
                      className={cn(
                        "size-3 shrink-0 transition-transform",
                        !isCollapsed && "rotate-90",
                      )}
                    />
                    <span className="truncate">{node.name}</span>
                  </button>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem
                  onSelect={() =>
                    void openInExternalEditor(node.path, { cwd: dir, where: "diff.tree.folder" })
                  }
                >
                  Open folder in external editor
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
            {!isCollapsed && <ul>{renderNodes(node.children, depth + 1)}</ul>}
          </li>
        );
      }
      const file = byPath.get(node.path);
      // A deleted file has nothing to open. The row still right-clicks so the
      // menu doesn't flicker along the tree; the item is just dead.
      const deleted = file?.status === "D";
      // The disclosure is a *sibling* button, not a chevron inside the jump
      // button — buttons can't nest (apps/client/CLAUDE.md).
      const nested = node.children.length > 0;
      const expanded = !collapsed.has(node.path);
      return (
        <li key={node.path}>
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                style={{ paddingLeft }}
                className="flex w-full items-center gap-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
              >
                <label
                  htmlFor={`reviewed-${node.path}`}
                  onClick={(e) => e.stopPropagation()}
                  className="flex shrink-0 items-center"
                  title="mark reviewed (collapses this file's diff)"
                >
                  <Checkbox
                    id={`reviewed-${node.path}`}
                    checked={reviewed.has(node.path)}
                    onCheckedChange={() => onToggleReviewed(node.path)}
                  />
                </label>
                {nested ? (
                  <button
                    type="button"
                    title={`${expanded ? "hide" : "show"} the ${node.children.length} file(s) nested under this one`}
                    onClick={() =>
                      setCollapsed((prev) => {
                        const next = new Set(prev);
                        if (expanded) next.add(node.path);
                        else next.delete(node.path);
                        return next;
                      })
                    }
                    className="shrink-0"
                  >
                    <ChevronRight
                      className={cn("size-3 transition-transform", expanded && "rotate-90")}
                    />
                  </button>
                ) : (
                  // Keeps a childless file's name on the same column as a
                  // folder's (whose chevron lives inside its own button).
                  <span className="size-3 shrink-0" />
                )}
                <button
                  type="button"
                  onClick={() => onJump(node.path)}
                  title={file?.oldPath ? `${file.oldPath} → ${node.path}` : node.path}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                >
                  <span className={cn("shrink-0", STATUS_COLORS[file?.status ?? ""] ?? "")}>
                    {file?.status ?? ""}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{node.name}</span>
                  {/* Only while collapsed, and only ever by the user's own
                   * hand — but a changed file must never be silently absent
                   * from a review's list. Bare count, no `+`: the ± columns
                   * sit right beside it. */}
                  {nested && !expanded && (
                    <span
                      title={`${node.children.length} more changed file(s) nested here`}
                      className="shrink-0 rounded-full border border-border/70 px-1 text-[9px] leading-[1.4] text-muted-foreground"
                    >
                      {node.children.length}
                    </span>
                  )}
                  {conflict.has(node.path) ? (
                    <span
                      title="Changed on disk while you have unsaved edits — resolve in the banner"
                      className="size-1.5 shrink-0 rounded-full bg-red-500"
                    />
                  ) : (
                    dirty.has(node.path) && (
                      <span
                        title="Unsaved changes — autosaves after a pause; ⌘S saves now"
                        className="size-1.5 shrink-0 rounded-full bg-amber-500"
                      />
                    )
                  )}
                  {file && file.untrackedFiles > 0 && (
                    <span
                      title="Untracked directory, too large to list file by file — probably missing from .gitignore"
                      className="shrink-0 rounded-full border border-amber-500/60 px-1 text-[9px] leading-[1.4] text-amber-500"
                    >
                      {file.untrackedFiles}+ files
                    </span>
                  )}
                  {file && (file.linesAdded > 0 || file.linesRemoved > 0) && (
                    <span className="shrink-0 pr-1 text-[10px]">
                      <span className="text-emerald-500">+{file.linesAdded}</span>{" "}
                      <span className="text-red-500">−{file.linesRemoved}</span>
                    </span>
                  )}
                </button>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                disabled={deleted}
                onSelect={() =>
                  void openInExternalEditor(node.path, { cwd: dir, where: "diff.tree" })
                }
              >
                Open in external editor
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
          {nested && expanded && <ul>{renderNodes(node.children, depth + 1)}</ul>}
        </li>
      );
    });

  return (
    <ul style={{ width }} className="shrink-0 overflow-y-auto border-r pr-1">
      {renderNodes(tree, 0)}
    </ul>
  );
});

/** Says the file list is a floor, and names the directory responsible.
 *
 * A count short by a hundred thousand files must never read as a total, and
 * the cause is nearly always one missing `.gitignore` line — so this names the
 * directory instead of reporting a generic limit. */
function UntrackedCapBanner({ cap }: { cap: NonNullable<ChangedFiles["untrackedCap"]> }) {
  return (
    <div className="mx-2 mt-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-600 dark:text-amber-400">
      <span className="font-mono">{cap.dir}</span> is untracked and too large to list — stopped at{" "}
      {cap.files} files
      {cap.total ? ", and other untracked directories were left out entirely" : ""}. It probably
      belongs in <span className="font-mono">.gitignore</span>; until then these counts are a floor.
    </div>
  );
}

/** A `Set<string>` setter → a `(path, on)` toggle that allocates only on a real
 * transition. Shared by the dirty and conflict mirrors so they can't drift. */
function flipPathIn(setter: Dispatch<SetStateAction<Set<string>>>) {
  return (path: string, on: boolean) => {
    setter((prev) => {
      if (prev.has(path) === on) return prev;
      const next = new Set(prev);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  };
}

const UNCOMMITTED_MODE = {
  key: "uncommitted" as const,
  label: "uncommitted",
  hint: "Only what isn't committed yet — staged + unstaged changes vs HEAD",
};

/** A folder's diff as a *pane* in the Agentboard tiling, so it sits beside the
 * live terminals instead of covering them. Everything refetches off the
 * backend's git snapshot rather than a timer — see the `statsKey`/`baseKey`
 * effect below, which keeps the file list and the diffs on one repo state. */
export function DiffPane({
  folder,
  focused,
  onClose,
}: {
  /** The checkout this pane diffs; undefined when it left the rail. */
  folder: FolderData | undefined;
  /** This pane is the one the user last clicked into — see the focus-ring
   * rule in `screens/agentboard.tsx`'s `focusedPaneId`. */
  focused: boolean;
  /** Removes the pane from its window. */
  onClose: () => void;
}) {
  const dir = folder?.dir;
  const baseBranch = folder?.baseBranch?.trim() || null;
  // The worktree's creation base (`.tt-task`'s `base=`) — what the backend
  // auto-compares a task against instead of defaulting to main.
  const taskBaseBranch = folder?.taskBaseBranch?.trim() || null;
  const effectiveBase = baseBranch ?? taskBaseBranch;
  const [mode, setMode] = useState<DiffMode>("main");
  // Locked to start: a stray keystroke in a focused editor used to edit — and
  // auto-save — the file under review while an agent worked in the same tree.
  const [editable, setEditable] = useState(false);
  const [files, setFiles] = useState<ChangedFile[] | null>(null);
  // Which untracked directory the backend stopped expanding, if any — the
  // file list is then a floor and has to say so.
  const [untrackedCap, setUntrackedCap] = useState<ChangedFiles["untrackedCap"]>(null);
  const [refreshing, setRefreshing] = useState(false);
  const revealRef = useRef<((path: string) => void) | null>(null);
  const registerReveal = useCallback((fn: ((path: string) => void) | null) => {
    revealRef.current = fn;
  }, []);
  // Stable identity (unlike an inline arrow at the call site) so DiffTreeRail's
  // memo() isn't defeated by a fresh callback prop on every DiffPane render.
  const jumpTo = useCallback((path: string) => revealRef.current?.(path), []);
  const [editingBase, setEditingBase] = useState(false);
  // Claude's pending openDiff reviews, oldest first, each with its "before".
  const [reviews, setReviews] = useState<Array<DiffReviewRequest & { originalContent: string }>>(
    [],
  );

  // Claude called openDiff → queue an accept/reject review; close_tab /
  // closeAllDiffTabs dismiss (Rust already rejected the blocked calls).
  useEffect(() => {
    if (!dir || !isTauri()) return;
    let disposed = false;
    const unlistens: Array<() => void> = [];
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const opened = await listen<DiffReviewRequest>("ide://open-diff", (e) => {
        if (e.payload.dir !== dir) return;
        const raw = e.payload.oldFilePath;
        const rel = raw.startsWith(`${dir}/`) ? raw.slice(dir.length + 1) : raw;
        void ideReadFile(dir, rel).then((read) => {
          // An unreadable old file (new file, binary) reviews against empty.
          const originalContent = read.map((f) => f.content).unwrapOr("");
          setReviews((prev) => [...prev, { ...e.payload, originalContent }]);
        });
      });
      const closed = await listen<{ dir: string; tabName: string | null }>(
        "ide://close-diff",
        (e) => {
          if (e.payload.dir !== dir) return;
          const tab = e.payload.tabName;
          setReviews((prev) => (tab == null ? [] : prev.filter((r) => r.tabName !== tab)));
        },
      );
      if (disposed) {
        opened();
        closed();
      } else {
        unlistens.push(opened, closed);
      }
    })();
    return () => {
      disposed = true;
      for (const un of unlistens) un();
    };
  }, [dir]);

  // IDE bridge badge; MonacoFileDiff streams selections to the folder's `claude`.
  const ideConnected = useIdeConnected(dir);

  const mainMode = {
    key: "main" as const,
    label: effectiveBase ? `vs ${effectiveBase}` : "vs main",
    hint: baseBranch
      ? `Everything on this branch vs where it forked from "${baseBranch}" (your override) — committed and uncommitted work alike`
      : taskBaseBranch
        ? `Everything on this branch vs where it forked from "${taskBaseBranch}" (this task's creation base) — committed and uncommitted work alike`
        : "Everything on this branch vs where it forked from origin/main — committed and uncommitted work alike",
  };
  const modes = [mainMode, UNCOMMITTED_MODE];

  // GitHub-review-style "viewed" marks: client-side only, no git index
  // involved. Checking a file collapses its diff in the Monaco pane.
  const [reviewed, setReviewed] = useState<Set<string>>(() => new Set());

  // Mirrors what MonacoMultiDiff reports to the IDE bridge, kept here too so
  // the tree rail can show the same dirty dot the Files tab does.
  const [dirty, setDirty] = useState<Set<string>>(() => new Set());
  // Reported by MonacoMultiDiff, which owns the resolution banner; mirrored
  // here so the tree rail can mark the affected rows.
  const [conflict, setConflict] = useState<Set<string>>(() => new Set());
  const handleDirtyChange = useMemo(() => flipPathIn(setDirty), []);
  const handleConflictChange = useMemo(() => flipPathIn(setConflict), []);

  // One remembered width for every diff pane, not one per folder: what's being
  // sized is how much path a reviewer wants to read.
  const [railWidth, setRailWidth] = useState(() =>
    loadDiffRailWidth(localStorage.getItem(DIFF_RAIL_WIDTH_KEY)),
  );
  const splitRef = useRef<HTMLDivElement>(null);
  const commitRailWidth = (px: number) => {
    setRailWidth(px);
    localStorage.setItem(DIFF_RAIL_WIDTH_KEY, String(px));
    uiAction("diff.rail_resize", "agentboard", String(px));
  };

  function startRailDrag(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = railWidth;
    // A pane narrower than the stored maximum still has to show a diff, so the
    // ceiling is measured now rather than taken from the constant.
    const available = splitRef.current?.clientWidth ?? 0;
    const max = available > 0 ? Math.max(MIN_DIFF_RAIL_WIDTH, available - 240) : Infinity;
    let width = startWidth;
    const move = (ev: PointerEvent) => {
      width = Math.min(max, clampDiffRailWidth(startWidth + ev.clientX - startX));
      setRailWidth(width);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      commitRailWidth(width);
    };
    // On the window, like `use-column-drag`: the pointer leaves this 4px
    // handle immediately and only the window still hears it.
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const fetchDiff = useCallback(async () => {
    if (!dir) return;
    setRefreshing(true);
    const list = await invoke<ChangedFiles>("ab_get_diff_files", { dir, mode, baseBranch });
    const payload = list.unwrapOr({ files: [], untrackedCap: null });
    setUntrackedCap(payload.untrackedCap);
    // Tree order, not git's flat path sort: both columns render from this one
    // array, which is what keeps them scrolling in lockstep.
    const nextFiles = sortToTreeOrder(payload.files);
    setFiles(nextFiles);
    // Prune marks for paths that left the change set; everything else keeps
    // its mark, so a poll mid-review can't re-expand what was checked off.
    const paths = new Set(nextFiles.map((f) => f.path));
    setReviewed((prev) => {
      const next = new Set([...prev].filter((p) => paths.has(p)));
      return next.size === prev.size ? prev : next;
    });
    setRefreshing(false);
  }, [dir, mode, baseBranch]);

  // Switching folders starts a fresh review — marks from the last folder
  // don't belong to this one's file set.
  useEffect(() => {
    setReviewed(new Set());
    setDirty(new Set());
    setConflict(new Set());
    // …and a different checkout is locked again, same as a fresh pane.
    setEditable(false);
  }, [dir]);

  // A collapsed untracked directory is a directory: Monaco would try to read
  // it as a file, so only the rail lists it.
  const diffable = useMemo(() => (files ?? []).filter((f) => f.untrackedFiles === 0), [files]);

  const statsKey = folder ? folderStatsKey(folder) : "";
  const baseKey = folder ? folderBaseKey(folder) : "";
  // Both keys: a rebase or fetch moves the baseline with every working-tree
  // stat untouched, and MonacoMultiDiff already refetches its base sides on
  // `baseKey` — so keying the list off `statsKey` alone left the rail listing
  // files from the old merge-base beside diffs measured from the new one.
  useEffect(() => {
    void fetchDiff();
  }, [fetchDiff, statsKey, baseKey]);

  async function commitBaseBranch(value: string) {
    setEditingBase(false);
    if (!dir) return;
    const trimmed = value.trim();
    if (trimmed === (baseBranch ?? "")) return;
    const stored = await invoke<void>("ab_set_folder_base_branch", {
      dir,
      branch: trimmed || null,
    });
    // Silence here reads as success while the pane keeps diffing the old base —
    // the wrong diff is worse than no diff, so surface it.
    if (stored.isErr()) toast.error(`Couldn't set base branch — ${stored.error.message}`);
  }

  const toggleReviewed = useCallback((path: string) => {
    setReviewed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const toggleReviewedMany = useCallback((paths: string[], value: boolean) => {
    setReviewed((prev) => {
      const next = new Set(prev);
      for (const p of paths) {
        if (value) next.add(p);
        else next.delete(p);
      }
      return next;
    });
  }, []);

  if (!folder) return <PanePlaceholder label="folder gone" focused={focused} onRemove={onClose} />;

  return (
    <div
      className={cn(
        "flex h-full flex-col overflow-hidden rounded-lg border bg-card",
        focused && "border-violet-500/60",
      )}
    >
      <PaneChrome
        lens={<PaneLens kind="diff" />}
        controls={
          <>
            {ideConnected && <ClaudeBadge />}
            {editingBase ? (
              <input
                autoFocus
                defaultValue={baseBranch ?? ""}
                placeholder={
                  taskBaseBranch
                    ? `branch to compare against (blank = this task's base, "${taskBaseBranch}")`
                    : "branch to compare against (blank = auto-detect main)"
                }
                onBlur={(e) => void commitBaseBranch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter")
                    void commitBaseBranch((e.target as HTMLInputElement).value);
                  if (e.key === "Escape") setEditingBase(false);
                }}
                className="w-48 rounded-sm border border-input bg-background px-1.5 py-0.5 font-mono text-[10.5px] outline-none"
              />
            ) : (
              <span className="flex shrink-0 items-center rounded-md border border-border/70 p-0.5">
                {modes.map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    title={m.hint}
                    aria-pressed={mode === m.key}
                    onClick={() => setMode(m.key)}
                    className={cn(
                      "rounded-[5px] px-1.5 py-px font-mono text-[10.5px] transition-colors",
                      mode === m.key
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {m.label}
                  </button>
                ))}
              </span>
            )}
            {!editingBase && mode === "main" && (
              <IconBtn
                title={
                  taskBaseBranch
                    ? `set the parent branch this folder compares against (default: this task's base, "${taskBaseBranch}")`
                    : "set the parent branch this folder compares against (default: origin/main)"
                }
                onClick={() => setEditingBase(true)}
                className="hover:text-sky-500"
              >
                <Pencil className="size-3" />
              </IconBtn>
            )}
          </>
        }
        center={
          <EditableToggle
            editable={editable}
            subject="the files in this diff"
            onChange={(next) => {
              setEditable(next);
              uiAction("diff.editable", "agentboard", next ? "on" : "off");
            }}
          />
        }
        actions={
          <>
            <EditorFontButtons />
            <IconBtn
              title="refresh diff"
              onClick={() => void fetchDiff()}
              className="hover:text-sky-500"
            >
              <RefreshCw className={refreshing ? "size-3 animate-spin" : "size-3"} />
            </IconBtn>
            <IconBtn
              title="close pane (diff stays a click away on the folder)"
              onClick={onClose}
              className="hover:text-sky-500"
            >
              <X className="size-3" />
            </IconBtn>
          </>
        }
      />
      {untrackedCap && <UntrackedCapBanner cap={untrackedCap} />}
      <div ref={splitRef} className="relative flex min-h-0 flex-1 p-2">
        {files == null ? (
          <p className="p-2 text-sm text-muted-foreground">Loading…</p>
        ) : files.length === 0 ? (
          <p className="p-2 text-sm text-muted-foreground">No changes.</p>
        ) : (
          <>
            <DiffTreeRail
              dir={dir!}
              files={files}
              width={railWidth}
              reviewed={reviewed}
              dirty={dirty}
              conflict={conflict}
              onJump={jumpTo}
              onToggleReviewed={toggleReviewed}
              onToggleReviewedMany={toggleReviewedMany}
            />
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="resize the file list"
              title="Drag to resize the file list — double-click to reset"
              onPointerDown={startRailDrag}
              onDoubleClick={() => commitRailWidth(DEFAULT_DIFF_RAIL_WIDTH)}
              className="-mx-px w-1 shrink-0 cursor-col-resize rounded-full transition-colors hover:bg-violet-500/40 active:bg-violet-500/60"
            />
            <div className="min-w-0 flex-1">
              <MonacoMultiDiff
                dir={dir!}
                files={diffable}
                mode={mode}
                baseBranch={baseBranch}
                refreshKey={statsKey}
                baseKey={baseKey}
                editable={editable}
                connected={ideConnected}
                registerReveal={registerReveal}
                reviewed={reviewed}
                onToggleReviewed={toggleReviewed}
                onDirtyChange={handleDirtyChange}
                onConflictChange={handleConflictChange}
              />
            </div>
          </>
        )}
        {reviews[0] && (
          <DiffReview
            key={reviews[0].requestId}
            review={reviews[0]}
            originalContent={reviews[0].originalContent}
            onDone={() => setReviews((prev) => prev.slice(1))}
          />
        )}
      </div>
    </div>
  );
}
