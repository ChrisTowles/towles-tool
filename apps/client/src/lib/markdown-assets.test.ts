import { describe, expect, it } from "vitest";
import { dirOf, resolveMarkdownSrc, resolveRepoPath } from "@/lib/markdown-assets";

describe("dirOf", () => {
  it("is empty for a file at the repo root", () => {
    expect(dirOf("README.md")).toBe("");
  });

  it("drops the filename", () => {
    expect(dirOf("docs/guide/index.md")).toBe("docs/guide");
  });
});

describe("resolveRepoPath", () => {
  it("resolves against the referring file's directory, not the repo root", () => {
    expect(resolveRepoPath("docs/guide.md", "images/a.png")).toBe("docs/images/a.png");
    expect(resolveRepoPath("README.md", "docs/images/a.png")).toBe("docs/images/a.png");
  });

  it("collapses . and .. that stay inside the checkout", () => {
    expect(resolveRepoPath("docs/guide.md", "../images/a.png")).toBe("images/a.png");
    expect(resolveRepoPath("docs/guide.md", "./a.png")).toBe("docs/a.png");
    expect(resolveRepoPath("a/b/c.md", "../../d/e.png")).toBe("d/e.png");
  });

  it("refuses a path that climbs out of the checkout", () => {
    expect(resolveRepoPath("README.md", "../secrets.png")).toBeNull();
    expect(resolveRepoPath("docs/guide.md", "../../../etc/passwd")).toBeNull();
  });

  // GitHub resolves a leading slash against the site; for a repo file it is
  // nearly always meant as the repo root, and that reading is the one that
  // makes the link work.
  it("treats a leading slash as repo-root relative", () => {
    expect(resolveRepoPath("docs/deep/guide.md", "/docs/images/a.png")).toBe("docs/images/a.png");
  });

  it("strips the query and fragment a copied GitHub URL carries", () => {
    expect(resolveRepoPath("README.md", "docs/a.png?raw=true")).toBe("docs/a.png");
    expect(resolveRepoPath("README.md", "docs/a.png#fig1")).toBe("docs/a.png");
  });

  it("percent-decodes, because a Markdown URL is a URL", () => {
    expect(resolveRepoPath("README.md", "docs/my%20image.png")).toBe("docs/my image.png");
  });

  it("keeps a malformed escape rather than throwing on it", () => {
    expect(resolveRepoPath("README.md", "docs/100%.png")).toBe("docs/100%.png");
  });

  it("is null for an empty or fragment-only target", () => {
    expect(resolveRepoPath("README.md", "")).toBeNull();
    expect(resolveRepoPath("README.md", "#section")).toBeNull();
  });
});

describe("resolveMarkdownSrc", () => {
  it("passes remote images through untouched", () => {
    expect(resolveMarkdownSrc("README.md", "https://img.shields.io/badge.svg")).toEqual({
      kind: "external",
      url: "https://img.shields.io/badge.svg",
    });
  });

  it("promotes a protocol-relative URL to https", () => {
    expect(resolveMarkdownSrc("README.md", "//example.com/a.png")).toEqual({
      kind: "external",
      url: "https://example.com/a.png",
    });
  });

  it("allows inline data URLs", () => {
    const src = "data:image/svg+xml;utf8,<svg/>";
    expect(resolveMarkdownSrc("README.md", src)).toEqual({ kind: "external", url: src });
  });

  // Nothing in the preview can execute script (raw HTML is sanitized), but a
  // scheme the DOM might act on has no business reaching an attribute.
  it("refuses schemes that aren't http(s)/data", () => {
    for (const src of ["javascript:alert(1)", "file:///etc/passwd", "vbscript:x"]) {
      expect(resolveMarkdownSrc("README.md", src)).toEqual({ kind: "invalid" });
    }
  });

  it("classifies a relative path as a repo file", () => {
    expect(resolveMarkdownSrc("docs/guide.md", "images/demo.gif")).toEqual({
      kind: "repo",
      path: "docs/images/demo.gif",
    });
  });

  it("is invalid when the path escapes the checkout", () => {
    expect(resolveMarkdownSrc("README.md", "../../id_rsa")).toEqual({ kind: "invalid" });
  });

  it("ignores surrounding whitespace", () => {
    expect(resolveMarkdownSrc("README.md", "  docs/a.png  ")).toEqual({
      kind: "repo",
      path: "docs/a.png",
    });
  });
});
