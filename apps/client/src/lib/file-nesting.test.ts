import { describe, expect, it } from "vitest";
import { FILE_NESTING_PATTERNS, nestFiles } from "./file-nesting";

/** `nestFiles` as a plain object, for readable assertions. */
function nest(names: string[]): Record<string, string[]> {
  return Object.fromEntries(nestFiles(names));
}

describe("nestFiles", () => {
  it("nests a test beside the file it tests", () => {
    expect(nest(["diff.ts", "diff.test.ts"])).toEqual({ "diff.ts": ["diff.test.ts"] });
    expect(nest(["status-bar.tsx", "status-bar.test.tsx"])).toEqual({
      "status-bar.tsx": ["status-bar.test.tsx"],
    });
  });

  it("nests by ecosystem convention, not just tests", () => {
    expect(nest(["Cargo.toml", "Cargo.lock"])).toEqual({ "Cargo.toml": ["Cargo.lock"] });
    expect(nest(["package.json", "package-lock.json"])).toEqual({
      "package.json": ["package-lock.json"],
    });
    expect(nest(["tsconfig.json", "tsconfig.node.json"])).toEqual({
      "tsconfig.json": ["tsconfig.node.json"],
    });
    expect(nest(["server.go", "server_test.go"])).toEqual({ "server.go": ["server_test.go"] });
  });

  it("leaves a file alone when its parent isn't in the list", () => {
    expect(nest(["diff.test.ts", "other.ts"])).toEqual({});
    expect(nest(["Cargo.lock"])).toEqual({});
  });

  it("gathers every child of one parent, sorted", () => {
    expect(nest(["agent.ts", "agent.test.ts", "agent.helpers.ts"])).toEqual({
      "agent.ts": ["agent.helpers.ts", "agent.test.ts"],
    });
  });

  it("never nests a file under itself", () => {
    for (const [name, children] of nestFiles(["README.md", "readme.md"]))
      expect(children).not.toContain(name);
  });

  it("keeps nesting one level deep — a parent is never also a child", () => {
    // `*.md` → `$(capture).*` is broad enough to chain without this rule.
    const nested = nestFiles(["a.md", "a.md.md", "a.md.md.md"]);
    const parents = new Set(nested.keys());
    for (const children of nested.values())
      for (const child of children) expect(parents.has(child)).toBe(false);
  });

  it("gives each child exactly one parent", () => {
    const names = ["a.ts", "a.tsx", "a.test.ts", "a.css", "a.module.css"];
    const seen = new Set<string>();
    for (const children of nestFiles(names).values())
      for (const child of children) {
        expect(seen.has(child)).toBe(false);
        seen.add(child);
      }
  });

  it("returns nothing for a list with no relationships", () => {
    expect(nest([])).toEqual({});
    expect(nest(["diff.ts", "agentboard.ts", "lib.rs"])).toEqual({});
  });

  it("ships the VS Code pattern table the Explorer is configured with", () => {
    // A guard on the copy, not the content: an empty or comment-only table
    // silently disables nesting in both surfaces.
    expect(Object.keys(FILE_NESTING_PATTERNS).length).toBeGreaterThan(50);
    expect(FILE_NESTING_PATTERNS["//"]).toBeUndefined();
    expect(FILE_NESTING_PATTERNS["*.ts"]).toContain("$(capture).*.ts");
  });
});
