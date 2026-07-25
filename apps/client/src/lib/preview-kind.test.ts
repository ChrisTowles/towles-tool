import { describe, expect, it } from "vitest";
import { opensInEditor, previewKindFor } from "@/lib/preview-kind";

describe("previewKindFor", () => {
  it("routes markdown and html to the split view", () => {
    expect(previewKindFor("README.md")).toBe("markdown");
    expect(previewKindFor("docs/guide.markdown")).toBe("markdown");
    expect(previewKindFor("index.html")).toBe("html");
    expect(previewKindFor("index.htm")).toBe("html");
  });

  it("routes images and video to the media viewer", () => {
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico"]) {
      expect(previewKindFor(`docs/a.${ext}`)).toBe("image");
    }
    for (const ext of ["mp4", "webm", "mov"]) {
      expect(previewKindFor(`docs/a.${ext}`)).toBe("video");
    }
  });

  it("names formats it can't show rather than trying", () => {
    for (const ext of ["pdf", "zip", "woff2", "sqlite", "so", "wasm", "mp3", "icns"]) {
      expect(previewKindFor(`a.${ext}`)).toBe("binary");
    }
  });

  it("is case-insensitive", () => {
    expect(previewKindFor("README.MD")).toBe("markdown");
    expect(previewKindFor("Screenshot.PNG")).toBe("image");
  });

  // The list must never claim a source file — that would replace a real file
  // with the "can't display this" card.
  it("leaves ordinary text files to the editor", () => {
    for (const path of [
      "src/main.rs",
      "Cargo.toml",
      "package.json",
      "script.sh",
      "notes.txt",
      "style.css",
      "app.tsx",
      "query.sql",
    ]) {
      expect(previewKindFor(path)).toBeNull();
    }
  });

  it("treats a dotfile's name as a name, not an extension", () => {
    expect(previewKindFor(".gitignore")).toBeNull();
    expect(previewKindFor("a/.env")).toBeNull();
    expect(previewKindFor("Makefile")).toBeNull();
  });

  it("reads the extension from the last path segment", () => {
    // A directory named `images.png` holding a text file must not make the
    // file an image.
    expect(previewKindFor("images.png/notes.txt")).toBeNull();
  });
});

describe("opensInEditor", () => {
  it("is true for text and for the kinds with a source side", () => {
    expect(opensInEditor(null)).toBe(true);
    expect(opensInEditor("markdown")).toBe(true);
    expect(opensInEditor("html")).toBe(true);
  });

  it("is false for what Monaco cannot hold", () => {
    expect(opensInEditor("image")).toBe(false);
    expect(opensInEditor("video")).toBe(false);
    expect(opensInEditor("binary")).toBe(false);
  });
});
