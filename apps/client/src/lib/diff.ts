/**
 * File-tree grouping for path lists (the diff pane's rail). The unified-diff
 * parser that used to live here died with the hand-rolled diff renderer — the
 * diff pane now uses the VS Code diff editor over full file contents.
 */

import { nestFiles } from "./file-nesting";

/** A row in a file rail's tree rendering: a directory (with its children) or
 * a file. `index` is the file's position in the flat path list the tree was
 * built from, so selection state stays keyed by that array. A file has
 * children too — the siblings nested under it (see `nestFileNodes`) — usually
 * an empty list. */
export type DiffTreeNode =
  | { kind: "folder"; name: string; path: string; children: DiffTreeNode[] }
  | { kind: "file"; name: string; path: string; index: number; children: DiffTreeNode[] };

type FileNode = Extract<DiffTreeNode, { kind: "file" }>;

type BuildingFolder = {
  name: string;
  path: string;
  folders: Map<string, BuildingFolder>;
  files: FileNode[];
};

/**
 * Fold each nestable file into its parent's row — `diff.test.ts` under
 * `diff.ts` — so a rail of changed files reads as one row per unit of work
 * instead of two interleaved alphabetical lists. The rules are VS Code's file
 * nesting, over the pattern table the Files pane's Explorer also runs on
 * (`lib/file-nesting.ts`); nesting is per-directory, so a file whose parent
 * isn't in the change set stays a top-level row rather than disappearing.
 */
function nestFileNodes(files: FileNode[]): FileNode[] {
  const nested = nestFiles(files.map((f) => f.name));
  if (nested.size === 0) return files;
  const byName = new Map(files.map((f) => [f.name, f]));
  const claimed = new Set<string>();
  for (const [parent, children] of nested) {
    const node = byName.get(parent);
    if (!node) continue;
    for (const child of children) {
      const childNode = byName.get(child);
      if (!childNode) continue;
      node.children.push(childNode);
      claimed.add(child);
    }
  }
  return files.filter((f) => !claimed.has(f.name));
}

/** Directory chains with only one child directory and no files of their own
 * collapse into a single row (`src/components` instead of `src` > `components`),
 * matching VS Code / GitHub's "compact folders" tree rendering. */
function collapseSingleChildChain(
  name: string,
  path: string,
  children: DiffTreeNode[],
): DiffTreeNode {
  let mergedName = name;
  let mergedPath = path;
  let mergedChildren = children;
  while (mergedChildren.length === 1 && mergedChildren[0].kind === "folder") {
    const only = mergedChildren[0];
    mergedName = `${mergedName}/${only.name}`;
    mergedPath = only.path;
    mergedChildren = only.children;
  }
  return { kind: "folder", name: mergedName, path: mergedPath, children: mergedChildren };
}

/** Group a flat path list into a directory tree for a file rail: folders
 * sort before files, both alphabetically within their level. */
export function buildDiffTree(paths: string[]): DiffTreeNode[] {
  const root: BuildingFolder = { name: "", path: "", folders: new Map(), files: [] };

  paths.forEach((filePath, index) => {
    const segments = filePath.split("/");
    let node = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      const path = node.path ? `${node.path}/${seg}` : seg;
      let child = node.folders.get(seg);
      if (!child) {
        child = { name: seg, path, folders: new Map(), files: [] };
        node.folders.set(seg, child);
      }
      node = child;
    }
    const name = segments[segments.length - 1];
    node.files.push({ kind: "file", name, path: filePath, index, children: [] });
  });

  function finalize(node: BuildingFolder): DiffTreeNode[] {
    const folderNodes = Array.from(node.folders.values())
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((f) => collapseSingleChildChain(f.name, f.path, finalize(f)));
    const fileNodes = nestFileNodes(
      [...node.files].toSorted((a, b) => a.name.localeCompare(b.name)),
    );
    return [...folderNodes, ...fileNodes];
  }

  return finalize(root);
}

/** Reorder a path-keyed list into the order `buildDiffTree` renders it —
 * folders before files, alphabetical at each level — so a stacked list of the
 * same files (the diff pane's Monaco column) reads top-to-bottom in lockstep
 * with the tree rail beside it. Git's own `name-status` order is a flat sort by
 * full path, which interleaves differently (a root-level `.env` sorts first
 * there but renders last in the tree). */
export function sortToTreeOrder<T extends { path: string }>(items: readonly T[]): T[] {
  const walk = (nodes: DiffTreeNode[]): T[] =>
    nodes.flatMap((node) =>
      node.kind === "file"
        ? // A nested test follows its subject, so the stacked diffs keep
          // pairing the two the way the rail does.
          [items[node.index], ...walk(node.children)]
        : walk(node.children),
    );
  return walk(buildDiffTree(items.map((it) => it.path)));
}

/** localStorage key for the diff pane's file-rail width. Same idiom as the
 * Cockpit repo filter and the Telemetry log filters — a view preference the
 * shared settings file has no business carrying. */
export const DIFF_RAIL_WIDTH_KEY = "tt-diff-rail-width";

/** Default file-rail width in px — what `w-56` was before it could be dragged. */
export const DEFAULT_DIFF_RAIL_WIDTH = 224;
/** Narrow enough to be a status-letter strip, without losing the checkboxes. */
export const MIN_DIFF_RAIL_WIDTH = 120;
/** Only an upper bound on the *stored* width; a drag additionally leaves room
 * for the diff itself (the pane can be narrower than this). */
export const MAX_DIFF_RAIL_WIDTH = 640;

/** Hold a width inside the rail's bounds. */
export function clampDiffRailWidth(px: number): number {
  return Math.round(Math.min(MAX_DIFF_RAIL_WIDTH, Math.max(MIN_DIFF_RAIL_WIDTH, px)));
}

/** Restore the persisted rail width from its raw localStorage string,
 * degrading to the default on anything unparseable. */
export function loadDiffRailWidth(raw: string | null): number {
  const px = Number(raw);
  return raw && Number.isFinite(px) ? clampDiffRailWidth(px) : DEFAULT_DIFF_RAIL_WIDTH;
}
