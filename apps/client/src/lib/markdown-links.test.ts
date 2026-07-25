import { describe, expect, it } from "vitest";
import { classifyMarkdownLink, headingSlug } from "@/lib/markdown-links";

describe("classifyMarkdownLink", () => {
  it("sends http(s) and mailto to the OS", () => {
    expect(classifyMarkdownLink("README.md", "https://tauri.app")).toEqual({
      kind: "external",
      url: "https://tauri.app",
    });
    expect(classifyMarkdownLink("README.md", "mailto:me@example.com")).toEqual({
      kind: "external",
      url: "mailto:me@example.com",
    });
    expect(classifyMarkdownLink("README.md", "//example.com/x")).toEqual({
      kind: "external",
      url: "https://example.com/x",
    });
  });

  // `openUrl` on one of these is the OS's problem to have.
  it("refuses schemes it will not hand to the OS", () => {
    for (const href of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,<b>"]) {
      expect(classifyMarkdownLink("README.md", href)).toEqual({ kind: "invalid" });
    }
  });

  it("keeps an in-document anchor in the document", () => {
    expect(classifyMarkdownLink("README.md", "#why-this-exists")).toEqual({
      kind: "anchor",
      hash: "why-this-exists",
    });
    expect(classifyMarkdownLink("README.md", "#")).toEqual({ kind: "invalid" });
  });

  it("resolves a repo file relative to the referring document", () => {
    expect(classifyMarkdownLink("docs/guide.md", "../README.md")).toEqual({
      kind: "repo",
      path: "README.md",
      hash: null,
    });
    expect(classifyMarkdownLink("README.md", "docs/CUTOVER.md")).toEqual({
      kind: "repo",
      path: "docs/CUTOVER.md",
      hash: null,
    });
  });

  it("carries a fragment alongside the file it belongs to", () => {
    expect(classifyMarkdownLink("README.md", "docs/CUTOVER.md#why")).toEqual({
      kind: "repo",
      path: "docs/CUTOVER.md",
      hash: "why",
    });
  });

  it("is invalid when the path escapes the checkout", () => {
    expect(classifyMarkdownLink("README.md", "../../../etc/passwd")).toEqual({ kind: "invalid" });
  });
});

describe("headingSlug", () => {
  // GitHub's rule, not the HTML id spec — the links being resolved were
  // written against GitHub, so a merely-valid id leaves them all dead.
  it("matches GitHub's anchors for ordinary headings", () => {
    expect(headingSlug("Why this exists")).toBe("why-this-exists");
    expect(headingSlug("Features: in towles-tool, not yet in Claude Desktop")).toBe(
      "features-in-towles-tool-not-yet-in-claude-desktop",
    );
  });

  // Deleted punctuation leaves its spaces behind, so this is `a--b`, not
  // `a-b` — matching GitHub matters more than looking tidy.
  it("drops punctuation and keeps the spaces around it", () => {
    expect(headingSlug("`tt task` — the CLI")).toBe("tt-task--the-cli");
    expect(headingSlug("Worktree tasks — you are probably working in one")).toBe(
      "worktree-tasks--you-are-probably-working-in-one",
    );
  });

  it("trims the ends but not the middle", () => {
    expect(headingSlug("  spaced   out  ")).toBe("spaced---out");
  });
});
