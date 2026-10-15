import { describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";

// Every source file, as text: the guard below is a lint over the whole client.
const SOURCES = import.meta.glob<string>(["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
});

const RAW_HUE =
  /(?<![\w-])(?:bg|text|border(?:-[lrtbxy])?|ring(?:-offset)?|outline|fill|stroke|decoration|from|via|to|shadow|divide|accent|caret|placeholder)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}(?![\w])/;
const PX_TEXT = /(?<![\w-])text-\[\d+(?:\.\d+)?px\]/;
const HEX = /#[0-9a-fA-F]{6}\b/;

/** Hex that is not a design choice of this app: someone else's colors. */
const HEX_ALLOWED: Record<string, string> = {
  "/src/lib/colors.ts": "the repo palette itself",
  "/src/components/theme-provider.tsx": "swatches of the themes `index.css` defines",
  "/src/components/code-server-pane.tsx": "VS Code's own dark background, behind its iframe",
  "/src/components/terminal-view.tsx": "fallbacks before the terminal's computed style exists",
  "/src/lib/preview.ts": "annotation pens, drawn into the user's image",
  "/src/lib/slack.ts": "the browser-dev mock's placeholder image",
};

function offenders(pattern: RegExp, allowed: Record<string, string> = {}): string[] {
  return Object.entries(SOURCES).flatMap(([path, text]) =>
    path in allowed
      ? []
      : text
          .split("\n")
          .flatMap((line, i) => (pattern.test(line) ? [`${path}:${i + 1}: ${line.trim()}`] : [])),
  );
}

describe("design tokens", () => {
  it("names a meaning, never a raw Tailwind hue", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
    expect(offenders(RAW_HUE)).toEqual([]);
  });

  it("sizes text from the type scale, never a one-off pixel size", () => {
    expect(offenders(PX_TEXT)).toEqual([]);
  });

  it("keeps hex colors in lib/colors.ts", () => {
    expect(offenders(HEX, HEX_ALLOWED)).toEqual([]);
  });

  it("merges the type scale as a size, so a color beside it survives", () => {
    expect(cn("text-mini", "text-muted-foreground")).toBe("text-mini text-muted-foreground");
    expect(cn("text-xs", "text-micro")).toBe("text-micro");
  });
});
