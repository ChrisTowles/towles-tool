import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { Pencil, RefreshCw, X } from "lucide-react";
import { DiffReview, type DiffReviewRequest } from "@/components/diff-review";
import { MonacoMultiDiff, type ChangedFile, type ChangedFiles } from "@/components/diff-monaco";
import { DiffTreeRail } from "@/components/diff-tree-rail";
import { EditableToggle } from "@/components/editable-toggle";
import { EditorFontButtons } from "@/components/editor-font-buttons";
import { ClaudeBadge, IconBtn, PanePlaceholder } from "@/components/agentboard-bits";
import { PaneChrome, PaneLens } from "@/components/pane-chrome";
import { folderBaseKey, folderStatsKey, type FolderData } from "@/lib/agentboard";
import {
  clampDiffRailWidth,
  DEFAULT_DIFF_RAIL_WIDTH,
  DIFF_RAIL_WIDTH_KEY,
  loadDiffRailWidth,
  MIN_DIFF_RAIL_WIDTH,
  sortToTreeOrder,
} from "@/lib/diff";
import { stageToggleAction } from "@/lib/diff-staging";
import { errorMessage } from "@/lib/errors";
import { ideReadFile, useIdeConnected } from "@/lib/ide";
import { invoke, isTauri } from "@/lib/tauri";
import { uiAction } from "@/lib/ui-action";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/** Which baseline the pane diffs against (mirrors `DiffMode` in tt-agentboard). */
type DiffMode = "main" | "uncommitted" | "staged";

/** Says the file list is a floor and names the directory responsible — a short
 * count must never read as a total. The cause is nearly always a `.gitignore` gap. */
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
  hint: "Everything not committed yet, diffed against the index — a staged hunk leaves this view for `staged`. Checkboxes and the gutter's + stage; VS Code's model.",
};

const STAGED_MODE = {
  key: "staged" as const,
  label: "staged",
  hint: "What `git commit` would take right now — the index vs HEAD, read-only. Uncheck or use the gutter's − to unstage.",
};

/** A folder's diff as a *pane* in the Agentboard tiling. Everything refetches off
 * the backend's git snapshot (the `statsKey`/`baseKey` effect), never a timer. */
export function DiffPane({
  folder,
  focused,
  onClose,
}: {
  /** The checkout this pane diffs; undefined when it left the rail. */
  folder: FolderData | undefined;
  /** The pane the user last clicked into (`focusedPaneId`'s focus ring). */
  focused: boolean;
  onClose: () => void;
}) {
  const dir = folder?.dir;
  const baseBranch = folder?.baseBranch?.trim() || null;
  // The worktree's creation base (`.tt-task` `base=`) — the auto-compare target.
  const taskBaseBranch = folder?.taskBaseBranch?.trim() || null;
  const effectiveBase = baseBranch ?? taskBaseBranch;
  const [mode, setMode] = useState<DiffMode>("main");
  // Locked to start: a stray keystroke once auto-saved the file under review.
  const [editable, setEditable] = useState(false);
  const [files, setFiles] = useState<ChangedFile[] | null>(null);
  // The untracked directory the backend stopped expanding — the list is then a floor.
  const [untrackedCap, setUntrackedCap] = useState<ChangedFiles["untrackedCap"]>(null);
  const [refreshing, setRefreshing] = useState(false);
  const revealRef = useRef<((path: string) => void) | null>(null);
  const registerReveal = useCallback((fn: ((path: string) => void) | null) => {
    revealRef.current = fn;
  }, []);
  // Stable identity so DiffTreeRail's memo() isn't defeated every render.
  const jumpTo = useCallback((path: string) => revealRef.current?.(path), []);
  const [editingBase, setEditingBase] = useState(false);
  // Claude's pending openDiff reviews, oldest first, each with its "before".
  const [reviews, setReviews] = useState<Array<DiffReviewRequest & { originalContent: string }>>(
    [],
  );

  // openDiff queues an accept/reject review; close_tab/closeAllDiffTabs dismiss.
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
  const modes = [mainMode, UNCOMMITTED_MODE, STAGED_MODE];
  // Checkboxes mean the git index in both staging modes, "viewed" in main.
  const staging = mode !== "main";

  // GitHub-review-style "viewed" marks: client-side only, no git index.
  const [reviewed, setReviewed] = useState<Set<string>>(() => new Set());

  // Mirror of MonacoMultiDiff's IDE-bridge dirty report, for the rail's dot.
  const [dirty, setDirty] = useState<Set<string>>(() => new Set());
  // From MonacoMultiDiff (owns the resolution banner); mirrored for rail rows.
  const [conflict, setConflict] = useState<Set<string>>(() => new Set());
  const handleDirtyChange = useMemo(() => flipPathIn(setDirty), []);
  const handleConflictChange = useMemo(() => flipPathIn(setConflict), []);

  // One width for every diff pane: what's sized is how much path gets read.
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
    // A narrow pane still has to show a diff — measure the ceiling now.
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
    // On the window (like `use-column-drag`): only it still hears the pointer.
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const fetchDiff = useCallback(async () => {
    if (!dir) return;
    setRefreshing(true);
    const list = await invoke<ChangedFiles>("ab_get_diff_files", { dir, mode, baseBranch });
    const payload = list.unwrapOr({ files: [], untrackedCap: null });
    setUntrackedCap(payload.untrackedCap);
    // Tree order: both columns render from this array and scroll in lockstep.
    const nextFiles = sortToTreeOrder(payload.files);
    setFiles(nextFiles);
    // Prune marks only for departed paths — a poll mid-review must not re-expand.
    const paths = new Set(nextFiles.map((f) => f.path));
    setReviewed((prev) => {
      const next = new Set([...prev].filter((p) => paths.has(p)));
      return next.size === prev.size ? prev : next;
    });
    setRefreshing(false);
  }, [dir, mode, baseBranch]);

  // 10s stats ceiling while up, not the fleet-wide 60s: an unstaged edit moves no
  // `.git` file the backend watches, so only a poll ever notices it.
  useEffect(() => {
    if (!dir) return;
    void invoke("ab_set_diff_focus", { dir, focused: true });
    return () => void invoke("ab_set_diff_focus", { dir, focused: false });
  }, [dir]);

  // Switching folders starts a fresh review — old marks don't carry over.
  useEffect(() => {
    setReviewed(new Set());
    setDirty(new Set());
    setConflict(new Set());
    // …and a different checkout is locked again, same as a fresh pane.
    setEditable(false);
  }, [dir]);

  // Monaco would read a collapsed untracked directory as a file — rail only.
  const diffable = useMemo(() => (files ?? []).filter((f) => f.untrackedFiles === 0), [files]);

  const statsKey = folder ? folderStatsKey(folder) : "";
  const baseKey = folder ? folderBaseKey(folder) : "";
  // In the staging modes a non-worktree side renders *index* content, which a
  // stage/unstage (here or in a terminal) moves while `baseKey` stays put — so
  // the in-place side refresh keys on the staged totals too.
  const monacoBaseKey = staging
    ? `${baseKey}|${folder?.stagedFiles ?? 0}:${folder?.stagedAdded ?? 0}:${folder?.stagedRemoved ?? 0}`
    : baseKey;
  // Both keys: a rebase/fetch moves the baseline without touching working-tree
  // stats — `statsKey` alone left old-merge-base files beside new-base diffs.
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
    // Silence reads as success while the pane keeps diffing the old base.
    if (stored.isErr()) toast.error(`Couldn't set base branch — ${stored.error.message}`);
  }

  /** One file's checkbox: fully staged unstages, anything else stages; the
   * staged view only ever unstages. False on a refused write (toasted). */
  const stageOne = useCallback(
    async (path: string): Promise<boolean> => {
      if (!dir) return false;
      const file = files?.find((c) => c.path === path);
      const action =
        mode === "staged" ? "unstage" : file ? stageToggleAction(file) : ("stage" as const);
      uiAction(action === "stage" ? "diff.stage_file" : "diff.unstage_file", "agentboard", path);
      const result = await invoke<void>(action === "stage" ? "ab_stage_file" : "ab_unstage_file", {
        dir,
        path,
      });
      if (result.isErr()) {
        toast.error(`Couldn't ${action} ${path} — ${errorMessage(result.error)}`);
        return false;
      }
      return true;
    },
    [dir, files, mode],
  );

  const toggleStage = useCallback(
    (path: string) => {
      void stageOne(path).then((ok) => {
        if (ok) void fetchDiff();
      });
    },
    [stageOne, fetchDiff],
  );

  const toggleStageMany = useCallback(
    (paths: string[], action: "stage" | "unstage") => {
      if (!dir) return;
      void (async () => {
        uiAction(action === "stage" ? "diff.stage_folder" : "diff.unstage_folder", "agentboard");
        for (const path of paths) {
          const result = await invoke<void>(
            action === "stage" ? "ab_stage_file" : "ab_unstage_file",
            { dir, path },
          );
          if (result.isErr()) {
            toast.error(`Couldn't ${action} ${path} — ${errorMessage(result.error)}`);
            break;
          }
        }
        void fetchDiff();
      })();
    },
    [dir, fetchDiff],
  );

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
          // The staged view renders index/HEAD snapshots — nothing to unlock.
          mode === "staged" ? undefined : (
            <EditableToggle
              editable={editable}
              subject="the files in this diff"
              onChange={(next) => {
                setEditable(next);
                uiAction("diff.editable", "agentboard", next ? "on" : "off");
              }}
            />
          )
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
              shortcut={focused ? "ab-close-pane" : undefined}
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
              staging={staging}
              reviewed={reviewed}
              dirty={dirty}
              conflict={conflict}
              onJump={jumpTo}
              onToggleReviewed={toggleReviewed}
              onToggleReviewedMany={toggleReviewedMany}
              onToggleStage={toggleStage}
              onToggleStageMany={toggleStageMany}
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
                baseKey={monacoBaseKey}
                editable={editable}
                connected={ideConnected}
                registerReveal={registerReveal}
                reviewed={reviewed}
                onToggleReviewed={toggleReviewed}
                onToggleStage={toggleStage}
                onStagingChanged={() => void fetchDiff()}
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
