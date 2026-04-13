import { describe, it, expect } from "vitest";
import { familyOf, familyColor } from "./family-color";
import type { Theme } from "@tt-agentboard/runtime";

const palette = {
  pink: "#f5c2e7",
  peach: "#fab387",
  teal: "#94e2d5",
  sky: "#89dceb",
  lavender: "#b4befe",
  mauve: "#cba6f7",
  blue: "#89b4fa",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  red: "#f38ba8",
  subtext0: "#a6adc8",
} as unknown as Theme["palette"];

describe("familyOf", () => {
  it("groups blog-* sessions", () => {
    expect(familyOf("blog-primary")).toBe("blog");
    expect(familyOf("blog-slot-1")).toBe("blog");
    expect(familyOf("blog-slot-2")).toBe("blog");
  });

  it("groups towles-tool-* sessions", () => {
    expect(familyOf("towles-tool-primary")).toBe("towles-tool");
    expect(familyOf("towles-tool-slot-1")).toBe("towles-tool");
  });

  it("returns the full name for solo sessions", () => {
    expect(familyOf("dotfiles")).toBe("dotfiles");
    expect(familyOf("f")).toBe("f");
    expect(familyOf("toolbox")).toBe("toolbox");
  });

  it("handles single-segment names without dash", () => {
    expect(familyOf("foo")).toBe("foo");
  });

  it("treats -primary and -slot-N as slot suffixes only", () => {
    expect(familyOf("my-project-primary")).toBe("my-project");
    expect(familyOf("my-project-slot-9")).toBe("my-project");
    expect(familyOf("my-project-other")).toBe("my-project-other");
  });
});

describe("familyColor", () => {
  it("maps known families to specific palette colors", () => {
    expect(familyColor("blog-primary", palette)).toBe(palette.pink);
    expect(familyColor("dotfiles", palette)).toBe(palette.peach);
    expect(familyColor("f", palette)).toBe(palette.teal);
    expect(familyColor("toolbox", palette)).toBe(palette.sky);
    expect(familyColor("towles-tool-primary", palette)).toBe(palette.lavender);
  });

  it("gives the same color to sessions in the same family", () => {
    expect(familyColor("blog-primary", palette)).toBe(familyColor("blog-slot-2", palette));
    expect(familyColor("towles-tool-primary", palette)).toBe(
      familyColor("towles-tool-slot-1", palette),
    );
  });

  it("falls back to a deterministic palette hue for unknown families", () => {
    const a = familyColor("unknown-repo", palette);
    const b = familyColor("unknown-repo", palette);
    expect(a).toBe(b); // deterministic
    expect(a).not.toBe(palette.subtext0); // not the legacy grey
  });
});
