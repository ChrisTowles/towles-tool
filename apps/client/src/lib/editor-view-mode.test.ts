import { describe, expect, it } from "vitest";
import { initialViewMode, modeForPanels, panelsFor, type EditorViewMode } from "./editor-view-mode";

const MODES: EditorViewMode[] = ["code", "split", "preview"];

describe("initialViewMode", () => {
  it("opens the markup kinds rendered", () => {
    expect(initialViewMode("markdown", false)).toBe("preview");
    expect(initialViewMode("html", false)).toBe("preview");
  });

  it("opens everything else as source", () => {
    expect(initialViewMode(null, false)).toBe("code");
    expect(initialViewMode("image", false)).toBe("code");
  });

  it("yields to an anchored open, whose target is a line", () => {
    expect(initialViewMode("markdown", true)).toBe("code");
    expect(initialViewMode("html", true)).toBe("code");
  });
});

describe("panelsFor", () => {
  it("gives each mode the halves it names", () => {
    expect(panelsFor("code")).toEqual({ editor: true, preview: false });
    expect(panelsFor("split")).toEqual({ editor: true, preview: true });
    expect(panelsFor("preview")).toEqual({ editor: false, preview: true });
  });

  it("never closes both halves", () => {
    for (const mode of MODES) {
      const { editor, preview } = panelsFor(mode);
      expect(editor || preview).toBe(true);
    }
  });
});

describe("modeForPanels", () => {
  it("round-trips every mode", () => {
    for (const mode of MODES) {
      const { editor, preview } = panelsFor(mode);
      expect(modeForPanels(editor, preview)).toBe(mode);
    }
  });

  it("reads a both-collapsed layout as code rather than inventing a fourth mode", () => {
    expect(modeForPanels(false, false)).toBe("code");
  });
});
