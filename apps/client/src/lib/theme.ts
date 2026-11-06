// The light/dark mode and the dark palette: persisted atoms, applied to <html>
// by one app effect. Nothing else touches `documentElement`'s theme attributes.
import { Schema } from "effect";
import * as Atom from "effect/reactivity/Atom";
import { persistedAtom } from "@/lib/atoms/persisted";
import { appEffect, write } from "@/lib/atoms/registry";

export type Theme = "dark" | "light" | "system";

/** Dark-mode palettes, applied via `data-color-theme` under `.dark`. Only ones
 * ported from a vetted shadcn/ui community theme belong here (sources in
 * index.css) — no from-scratch color guessing. */
export type ColorTheme = "default" | "nord" | "catppuccin";

export const COLOR_THEMES: { id: ColorTheme; label: string; swatch: string }[] = [
  { id: "default", label: "Default", swatch: "#a3a3a3" },
  { id: "nord", label: "Nord", swatch: "#86c0d0" },
  { id: "catppuccin", label: "Catppuccin Mocha", swatch: "#cba6f7" },
];

export const themeAtom = persistedAtom<Theme, string>(
  "tt-ui-theme",
  Schema.Literals(["dark", "light", "system"]),
  "system",
);
export const colorThemeAtom = persistedAtom<ColorTheme, string>(
  "tt-ui-color-theme",
  Schema.Literals(["default", "nord", "catppuccin"]),
  "default",
);

export const setTheme = (t: Theme): void => write(themeAtom, t);
export const setColorTheme = (t: ColorTheme): void => write(colorThemeAtom, t);

appEffect(
  Atom.make((get) => {
    const theme = get(themeAtom);
    const root = document.documentElement;
    const mode =
      theme === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : theme;
    root.classList.remove("light", "dark");
    root.classList.add(mode);
    // Kumo resolves its palette from `data-mode`; `.dark` still drives `dark:`.
    root.dataset.mode = mode;
    root.dataset.colorTheme = get(colorThemeAtom);
  }).pipe(Atom.keepAlive, Atom.withLabel("theme")),
);
