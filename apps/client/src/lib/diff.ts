/** File-tree grouping for path lists (the diff pane's rail). */

import { nestFiles } from "./file-nesting";

/** `index` is the file's position in the flat path list, so selection state
 * stays keyed by that array. A file's children are its nested siblings. */
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

/** Nesting is per-directory, so a file whose parent isn't in the change set
 * stays a top-level row rather than disappearing. */
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

/** VS Code / GitHub "compact folders": `src/components`, not `src` > `components`. */
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

/** Reorder a path-keyed list into the order `buildDiffTree` renders it, so the
 * stacked diffs stay in lockstep with the rail. */
export function sortToTreeOrder<T extends { path: string }>(items: readonly T[]): T[] {
  const walk = (nodes: DiffTreeNode[]): T[] =>
    nodes.flatMap((node) =>
      node.kind === "file" ? [items[node.index], ...walk(node.children)] : walk(node.children),
    );
  return walk(buildDiffTree(items.map((it) => it.path)));
}

/** A view preference the shared settings file has no business carrying. */
export const DIFF_RAIL_WIDTH_KEY = "tt-diff-rail-width";

export const DEFAULT_DIFF_RAIL_WIDTH = 224;
export const MIN_DIFF_RAIL_WIDTH = 120;
/** Bounds the *stored* width only; a drag additionally leaves room for the diff. */
export const MAX_DIFF_RAIL_WIDTH = 640;

export function clampDiffRailWidth(px: number): number {
  return Math.round(Math.min(MAX_DIFF_RAIL_WIDTH, Math.max(MIN_DIFF_RAIL_WIDTH, px)));
}

/** Degrades to the default on anything unparseable. */
export function loadDiffRailWidth(raw: string | null): number {
  const px = Number(raw);
  return raw && Number.isFinite(px) ? clampDiffRailWidth(px) : DEFAULT_DIFF_RAIL_WIDTH;
}
