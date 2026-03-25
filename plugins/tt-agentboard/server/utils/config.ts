import { resolve } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";

export interface AgentBoardConfig {
  repoPaths: string[];
}

const defaultDataDir = resolve(
  process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"),
  "towles-tool",
  "agentboard",
);

const dataDir = process.env.AGENTBOARD_DATA_DIR ?? defaultDataDir;
const configPath = resolve(dataDir, "config.json");

export function readConfig(): AgentBoardConfig {
  try {
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as AgentBoardConfig;
  } catch {
    return { repoPaths: [] };
  }
}

export function writeConfig(config: AgentBoardConfig): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}
