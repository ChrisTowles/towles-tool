import { describe, expect, it } from "vitest";
import {
  buildDiffTree,
  DEFAULT_DIFF_RAIL_WIDTH,
  loadDiffRailWidth,
  MAX_DIFF_RAIL_WIDTH,
  MIN_DIFF_RAIL_WIDTH,
  sortToTreeOrder,
  type DiffTreeNode,
} from "./diff";

/** The children of the one folder a test built, as name strings. */
function childNames(node: DiffTreeNode): string[] {
  return node.children.map((c) => c.name);
}

describe("buildDiffTree", () => {
  it("groups files under their shared directories", () => {
    const tree = buildDiffTree(["src/a.ts", "src/b.ts", "README.md"]);
    expect(tree.map((n) => n.name)).toEqual(["src", "README.md"]);
    const src = tree[0];
    if (src.kind !== "folder") throw new Error("expected folder");
    expect(src.children.map((n) => n.name)).toEqual(["a.ts", "b.ts"]);
  });

  it("collapses single-child directory chains into one row", () => {
    const tree = buildDiffTree(["apps/client/src/lib/diff.ts"]);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ kind: "folder", name: "apps/client/src/lib" });
  });

  it("does not collapse a directory that holds a file alongside a subfolder", () => {
    const tree = buildDiffTree(["src/index.ts", "src/lib/diff.ts"]);
    expect(tree).toHaveLength(1);
    const src = tree[0];
    if (src.kind !== "folder") throw new Error("expected folder");
    expect(src.name).toBe("src");
    expect(src.children.map((n) => n.name)).toEqual(["lib", "index.ts"]);
  });

  it("keeps each file's index into the original flat array", () => {
    const tree = buildDiffTree(["src/a.ts", "src/b.ts"]);
    const src = tree[0];
    if (src.kind !== "folder") throw new Error("expected folder");
    const [a, b] = src.children;
    if (a.kind !== "file" || b.kind !== "file") throw new Error("expected files");
    expect([a.index, b.index]).toEqual([0, 1]);
  });

  it("nests a test file under the file it tests", () => {
    const tree = buildDiffTree(["src/diff.ts", "src/diff.test.ts"]);
    const src = tree[0];
    if (src.kind !== "folder") throw new Error("expected folder");
    expect(childNames(src)).toEqual(["diff.ts"]);
    expect(childNames(src.children[0])).toEqual(["diff.test.ts"]);
  });

  it("nests .spec and _test suffixes too, and keeps unrelated files alone", () => {
    const tree = buildDiffTree(["parser.tsx", "parser.spec.tsx", "server.go", "server_test.go"]);
    expect(tree.map((n) => n.name)).toEqual(["parser.tsx", "server.go"]);
    expect(childNames(tree[0])).toEqual(["parser.spec.tsx"]);
    expect(childNames(tree[1])).toEqual(["server_test.go"]);
  });

  it("prefers the subject sharing the test's extension", () => {
    const tree = buildDiffTree(["a.css", "a.ts", "a.test.ts"]);
    expect(tree.map((n) => n.name)).toEqual(["a.css", "a.ts"]);
    expect(childNames(tree[0])).toEqual([]);
    expect(childNames(tree[1])).toEqual(["a.test.ts"]);
  });

  it("leaves an orphan test at top level when its subject didn't change", () => {
    const tree = buildDiffTree(["src/diff.test.ts", "src/other.ts"]);
    const src = tree[0];
    if (src.kind !== "folder") throw new Error("expected folder");
    expect(childNames(src)).toEqual(["diff.test.ts", "other.ts"]);
  });

  it("uses the whole VS Code pattern table, not just tests", () => {
    const tree = buildDiffTree(["Cargo.toml", "Cargo.lock"]);
    expect(tree.map((n) => n.name)).toEqual(["Cargo.toml"]);
    expect(childNames(tree[0])).toEqual(["Cargo.lock"]);
  });

  it("does not nest across directories", () => {
    const tree = buildDiffTree(["src/diff.ts", "tests/diff.test.ts"]);
    expect(tree.map((n) => n.name)).toEqual(["src", "tests"]);
    expect(childNames(tree[0])).toEqual(["diff.ts"]);
    expect(childNames(tree[1])).toEqual(["diff.test.ts"]);
  });
});

describe("loadDiffRailWidth", () => {
  it("falls back to the default on missing or junk values", () => {
    expect(loadDiffRailWidth(null)).toBe(DEFAULT_DIFF_RAIL_WIDTH);
    expect(loadDiffRailWidth("")).toBe(DEFAULT_DIFF_RAIL_WIDTH);
    expect(loadDiffRailWidth("wide")).toBe(DEFAULT_DIFF_RAIL_WIDTH);
  });

  it("clamps a stored width into the rail's bounds", () => {
    expect(loadDiffRailWidth("10")).toBe(MIN_DIFF_RAIL_WIDTH);
    expect(loadDiffRailWidth("99999")).toBe(MAX_DIFF_RAIL_WIDTH);
    expect(loadDiffRailWidth("300.6")).toBe(301);
  });
});

describe("sortToTreeOrder", () => {
  it("puts files in the order the tree rail renders them", () => {
    // git name-status order: a flat sort by full path.
    const files = [
      { path: ".env.dev" },
      { path: "docs/entra.md" },
      { path: "packages/web-portal/CLAUDE.md" },
      { path: "packages/web-portal/app/page.tsx" },
    ];
    expect(sortToTreeOrder(files).map((f) => f.path)).toEqual([
      "docs/entra.md",
      "packages/web-portal/app/page.tsx",
      "packages/web-portal/CLAUDE.md",
      ".env.dev",
    ]);
  });

  it("keeps the full item, not just the path", () => {
    const files = [
      { path: "b.ts", status: "M" },
      { path: "src/a.ts", status: "A" },
    ];
    expect(sortToTreeOrder(files)).toEqual([
      { path: "src/a.ts", status: "A" },
      { path: "b.ts", status: "M" },
    ]);
  });

  it("puts a nested test right after the file it tests", () => {
    const files = [{ path: "src/diff.test.ts" }, { path: "src/a.ts" }, { path: "src/diff.ts" }];
    expect(sortToTreeOrder(files).map((f) => f.path)).toEqual([
      "src/a.ts",
      "src/diff.ts",
      "src/diff.test.ts",
    ]);
  });

  it("returns an empty list unchanged", () => {
    expect(sortToTreeOrder([])).toEqual([]);
  });
});
