import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { PartialTheme } from "./themes";

export interface AgentboardConfig {
  /** Explicit mux provider name (overrides auto-detect) */
  mux?: string;
  /** Custom server port */
  port?: number;
  /** Community plugin package names to load */
  plugins: string[];
  /** Theme: builtin name (e.g. "catppuccin-latte") or partial inline theme object */
  theme?: string | PartialTheme;
  /** Sidebar column width (default 26) */
  sidebarWidth?: number;
  /** Sidebar position relative to the terminal window (default "left") */
  sidebarPosition?: "left" | "right";
  /** Tmux prefix key for sidebar toggle (default "s") */
  keybinding?: string;
  /** Persisted detail panel heights keyed by mux session name */
  detailPanelHeights?: Record<string, number>;
}

const DEFAULTS: AgentboardConfig = {
  plugins: [],
};

/**
 * Load config from ~/.config/towles-tool/agentboard/config.json
 * @param homeDir — override home directory (for testing)
 */
export function loadConfig(homeDir?: string): AgentboardConfig {
  const home = homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
  const configPath = join(home, ".config", "towles-tool", "agentboard", "config.json");

  if (!existsSync(configPath)) {
    return { ...DEFAULTS };
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<AgentboardConfig>;
    return {
      ...DEFAULTS,
      ...parsed,
      plugins: parsed.plugins ?? DEFAULTS.plugins,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Save partial config updates to ~/.config/towles-tool/agentboard/config.json
 * Merges with existing config on disk to preserve fields.
 * @param updates — partial config fields to write
 * @param homeDir — override home directory (for testing)
 */
export function saveConfig(updates: Partial<AgentboardConfig>, homeDir?: string): void {
  const home = homeDir ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
  const configDir = join(home, ".config", "towles-tool", "agentboard");
  const configPath = join(configDir, "config.json");

  const existing = loadConfig(homeDir);
  const merged = { ...existing, ...updates };

  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n");
}
