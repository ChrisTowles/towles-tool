import { describe, expect, it } from "vitest";
import { pathFromModelUri } from "@/lib/editor-target";

describe("pathFromModelUri", () => {
  it("reads the file viewer's file: URIs", () => {
    expect(pathFromModelUri("file:///w/repo/src/app.ts")).toBe("/w/repo/src/app.ts");
  });

  it("reads both sides of a diff — they name the same working-tree file", () => {
    expect(pathFromModelUri("tt-diff-work:/w/repo/src/app.ts")).toBe("/w/repo/src/app.ts");
    expect(pathFromModelUri("tt-diff-base:/w/repo/src/app.ts")).toBe("/w/repo/src/app.ts");
  });

  it("decodes escapes a URI carries but a path can't", () => {
    expect(pathFromModelUri("file:///w/my%20repo/a%23b.ts")).toBe("/w/my repo/a#b.ts");
  });

  it("rejects models with no file behind them", () => {
    expect(pathFromModelUri("inmemory://model/5")).toBeNull();
    expect(pathFromModelUri("walkThrough:/editor/vs_code_welcome_page")).toBeNull();
    expect(pathFromModelUri("untitled:Untitled-1")).toBeNull();
    expect(pathFromModelUri("")).toBeNull();
    expect(pathFromModelUri(undefined)).toBeNull();
  });

  it("rejects a known scheme that somehow carries no absolute path", () => {
    expect(pathFromModelUri("file://")).toBeNull();
    expect(pathFromModelUri("tt-diff-work:relative/app.ts")).toBeNull();
  });
});
