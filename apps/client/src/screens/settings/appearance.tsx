import { Select } from "@cloudflare/kumo";
import { COLOR_THEMES, type ColorTheme, type Theme } from "@/components/theme-provider";
import { uiAction } from "@/lib/ui-action";
import { SettingRow, type FilterSection } from "./common";

export function appearanceSections(
  theme: Theme,
  setTheme: (t: Theme) => void,
  colorTheme: ColorTheme,
  setColorTheme: (c: ColorTheme) => void,
): FilterSection[] {
  return [
    {
      rows: [
        {
          label: "Theme",
          keywords: ["appearance", "color", "light", "dark", "system"],
          node: (
            <SettingRow label="Theme" description="Light, dark, or follow the system.">
              <Select
                aria-label="Theme"
                className="w-32"
                value={theme}
                onValueChange={(v) => {
                  if (!v) return;
                  uiAction("settings.theme", "settings", v);
                  setTheme(v as Theme);
                }}
                items={{ light: "Light", dark: "Dark", system: "System" }}
              />
            </SettingRow>
          ),
        },
        {
          label: "Color theme",
          keywords: [
            "appearance",
            "color",
            "palette",
            "dracula",
            "nord",
            "gruvbox",
            "tokyo night",
            "catppuccin",
            "one dark",
          ],
          node: (
            <SettingRow label="Color theme" description="Palette used in dark mode.">
              <Select
                aria-label="Color theme"
                className="w-40"
                value={colorTheme}
                onValueChange={(v) => {
                  if (!v) return;
                  uiAction("settings.color_theme", "settings", v);
                  setColorTheme(v as ColorTheme);
                }}
                items={COLOR_THEMES.map((t) => ({
                  value: t.id,
                  label: (
                    <span className="flex items-center gap-2">
                      <span
                        className="size-2.5 rounded-full"
                        style={{ backgroundColor: t.swatch }}
                      />
                      {t.label}
                    </span>
                  ),
                }))}
              />
            </SettingRow>
          ),
        },
      ],
    },
  ];
}
