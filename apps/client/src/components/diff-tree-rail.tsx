/** Navigation tree beside the multi-diff. The checkbox column follows the
 * pane's mode: "vs main" keeps the GitHub-review "viewed" mark (client-side,
 * collapses the diff); the staging modes make it the git index, with
 * indeterminate as a partially staged file. */

import { memo, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ChangedFile } from "@/components/diff-monaco";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { folderStageState, stageCheckState } from "@/lib/diff-staging";
import { buildDiffTree, type DiffTreeNode } from "@/lib/diff";
import { openInExternalEditor } from "@/lib/external-editor";
import { cn } from "@/lib/utils";

const STATUS_COLORS: Record<string, string> = {
  A: "text-emerald-500",
  "?": "text-emerald-500",
  D: "text-red-500",
  R: "text-sky-500",
  C: "text-sky-500",
  M: "text-amber-500",
};

export const DiffTreeRail = memo(function DiffTreeRail({
  dir,
  files,
  width,
  staging,
  reviewed,
  dirty,
  conflict,
  onJump,
  onToggleReviewed,
  onToggleReviewedMany,
  onToggleStage,
  onToggleStageMany,
}: {
  /** The checkout the listed paths are relative to. */
  dir: string;
  files: ChangedFile[];
  /** Rail width in px — dragged on the divider, owned by DiffPane. */
  width: number;
  /** Checkboxes are the git index, not "viewed" marks. */
  staging: boolean;
  /** Paths the reviewer has checked off. */
  reviewed: ReadonlySet<string>;
  /** Paths with unsaved edits made in the diff pane — the Files tab's dirty dot. */
  dirty: ReadonlySet<string>;
  /** Paths changed on disk under unsaved edits; the Monaco pane owns resolution. */
  conflict: ReadonlySet<string>;
  onJump: (path: string) => void;
  onToggleReviewed: (path: string) => void;
  /** Set (or clear) every path in the list at once — a folder's checkbox. */
  onToggleReviewedMany: (paths: string[], value: boolean) => void;
  /** Stage or unstage one file (the row decides which from its state). */
  onToggleStage: (path: string) => void;
  onToggleStageMany: (paths: string[], action: "stage" | "unstage") => void;
}) {
  // What the user explicitly closed. Rows default *open*, unlike the Files
  // Explorer: a disclosure would drop a file from the reviewer's list.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const tree = useMemo(() => buildDiffTree(files.map((f) => f.path)), [files]);
  const byPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);
  // One bottom-up pass per file-set change — per-render subtree walks are O(n²).
  const leafPathsByFolder = useMemo(() => {
    const map = new Map<string, string[]>();
    const walk = (node: DiffTreeNode): string[] => {
      const leaves = node.children.flatMap(walk);
      // Nested tests count toward the folder above; a file is not a folder checkbox.
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
        let sumAdded = 0;
        let sumRemoved = 0;
        for (const p of paths) {
          const f = byPath.get(p);
          sumAdded += f?.linesAdded ?? 0;
          sumRemoved += f?.linesRemoved ?? 0;
        }
        let checked: boolean | "indeterminate";
        if (staging) {
          checked = folderStageState(paths.map((p) => byPath.get(p)!).filter(Boolean));
        } else {
          const reviewedCount = paths.filter((p) => reviewed.has(p)).length;
          checked =
            reviewedCount === 0 ? false : reviewedCount === paths.length ? true : "indeterminate";
        }
        return (
          <li key={node.path}>
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div style={{ paddingLeft }} className="flex w-full items-center gap-1 py-0.5">
                  {/* `<label htmlFor>`, not nested in the button below: Radix's
                   * Checkbox renders a button and buttons can't nest. */}
                  <label
                    htmlFor={`reviewed-${node.path}`}
                    onClick={(e) => e.stopPropagation()}
                    className="flex shrink-0 items-center"
                    title={
                      staging
                        ? "stage every file in this folder (uncheck to unstage them)"
                        : "mark every file in this folder reviewed"
                    }
                  >
                    <Checkbox
                      id={`reviewed-${node.path}`}
                      checked={checked}
                      onCheckedChange={(c) =>
                        staging
                          ? onToggleStageMany(paths, checked === true ? "unstage" : "stage")
                          : onToggleReviewedMany(paths, c === true)
                      }
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
                    <span className="min-w-0 flex-1 truncate">{node.name}</span>
                    {(sumAdded > 0 || sumRemoved > 0) && (
                      <span className="shrink-0 pr-1 text-[10px]">
                        <span className="text-emerald-500">+{sumAdded}</span>{" "}
                        <span className="text-red-500">−{sumRemoved}</span>
                      </span>
                    )}
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
      // A deleted file has nothing to open, but still right-clicks.
      const deleted = file?.status === "D";
      // A collapsed untracked directory can't be staged file-by-file from here.
      const unstageable = staging && (file?.untrackedFiles ?? 0) > 0;
      // A *sibling* button, not a chevron inside the jump button — can't nest.
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
                  title={
                    unstageable
                      ? "an untracked directory stages when its files are listed — expand .gitignore instead"
                      : staging
                        ? "staged — check to stage this file (git add), uncheck to unstage it"
                        : "mark reviewed (collapses this file's diff)"
                  }
                >
                  <Checkbox
                    id={`reviewed-${node.path}`}
                    disabled={unstageable}
                    checked={
                      staging ? (file ? stageCheckState(file) : false) : reviewed.has(node.path)
                    }
                    onCheckedChange={() =>
                      staging ? onToggleStage(node.path) : onToggleReviewed(node.path)
                    }
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
                  // Keeps a childless file's name on a folder's name column.
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
                  {/* Only while user-collapsed — a changed file must never be
                   * silently absent. Bare count: the ± columns sit beside it. */}
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
