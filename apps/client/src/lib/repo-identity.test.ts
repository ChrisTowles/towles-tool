import { describe, expect, it } from "vitest";
import {
  DEFAULT_REPO_ICON,
  isHexColor,
  normalizeHex,
  repoAccentStyles,
  repoIcon,
  REPO_ICONS,
  paletteColor,
  REPO_PALETTE,
} from "./repo-identity";

describe("normalizeHex", () => {
  it("canonicalizes to lowercase #rrggbb", () => {
    expect(normalizeHex("#3B82F6")).toBe("#3b82f6");
    expect(normalizeHex("3b82f6")).toBe("#3b82f6");
    expect(normalizeHex("  #ABC  ")).toBe("#aabbcc");
    expect(normalizeHex("abc")).toBe("#aabbcc");
  });

  it("rejects anything that isn't a hex color", () => {
    for (const bad of ["", "#", "#12", "#12345", "#1234567", "red", "rgb(0,0,0)", "#zzzzzz"]) {
      expect([bad, normalizeHex(bad)]).toEqual([bad, null]);
      expect([bad, isHexColor(bad)]).toEqual([bad, false]);
    }
  });
});

describe("repoIcon", () => {
  it("falls back to the default for absent or unknown names", () => {
    expect(repoIcon(undefined)).toBe(DEFAULT_REPO_ICON);
    expect(repoIcon({})).toBe(DEFAULT_REPO_ICON);
    // The store is untrusted: a stale or hand-edited name must not crash.
    expect(repoIcon({ icon: "NotAnIcon" })).toBe(DEFAULT_REPO_ICON);
  });

  it("resolves an allowlisted name", () => {
    expect(repoIcon({ icon: "Rocket" })).toBe(REPO_ICONS.Rocket);
  });
});

describe("repoAccentStyles", () => {
  it("contributes nothing without a repo or a valid color", () => {
    expect(repoAccentStyles(undefined)).toEqual({
      iconStyle: undefined,
      edgeStyle: undefined,
      surfaceStyle: undefined,
      headerStyle: undefined,
    });
    expect(repoAccentStyles({ color: "nope", meta: { icon: "Rocket" } }).iconStyle).toBeUndefined();
  });

  it("lifts the ink, draws the edge solid, and washes the surface", () => {
    const accent = repoAccentStyles({ color: "#3B82F6" });
    expect(accent.iconStyle).toEqual({
      color: "color-mix(in oklab, #3b82f6 88%, var(--foreground))",
    });
    expect(accent.edgeStyle).toEqual({ borderLeftColor: "#3b82f6" });
    expect(accent.surfaceStyle?.backgroundColor).toBe(
      "color-mix(in srgb, #3b82f6 6%, transparent)",
    );
  });

  it("gives a rail header its edge and an opaque wash variable", () => {
    expect(repoAccentStyles({ color: "#3b82f6" }).headerStyle).toEqual({
      borderLeftColor: "#3b82f6",
      "--repo-wash": "color-mix(in srgb, #3b82f6 6%, var(--card))",
    });
  });

  it("mixes the wash into a caller-supplied opaque base (sticky surfaces)", () => {
    const tint = repoAccentStyles({ color: "#3b82f6" }, "var(--card)");
    expect(tint.surfaceStyle?.backgroundColor).toBe("color-mix(in srgb, #3b82f6 6%, var(--card))");
  });
});

describe("REPO_PALETTE", () => {
  it("is all canonical hex", () => {
    for (const swatch of REPO_PALETTE) expect(normalizeHex(swatch)).toBe(swatch);
  });
});

describe("paletteColor", () => {
  it("keeps a swatch, however it is written", () => {
    expect(paletteColor(REPO_PALETTE[0].toUpperCase())).toBe(REPO_PALETTE[0]);
  });
  it("drops a pin from outside the palette, and nothing", () => {
    expect(paletteColor("#e11d48")).toBeUndefined();
    expect(paletteColor(undefined)).toBeUndefined();
  });
});
