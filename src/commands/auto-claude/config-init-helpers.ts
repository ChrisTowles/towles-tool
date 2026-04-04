import { AutoClaudeConfigSchema } from "./config.js";
import type { AutoClaudeConfig } from "./config.js";

export const CONFIG_DIR = ".auto-claude";
export const CONFIG_FILENAME = "config.json";
export const CONFIG_PATH = `${CONFIG_DIR}/${CONFIG_FILENAME}`;

export interface ConfigInitInput {
  triggerLabel: string;
  mainBranch: string;
  scopePath: string;
  model: string;
  repo: string;
}

/**
 * Build a full AutoClaudeConfig from user inputs, applying schema defaults.
 */
export function buildConfig(input: ConfigInitInput): AutoClaudeConfig {
  return AutoClaudeConfigSchema.parse({
    triggerLabel: input.triggerLabel,
    mainBranch: input.mainBranch,
    scopePath: input.scopePath,
    model: input.model,
    repo: input.repo,
  });
}

/**
 * Validate that a trigger label is non-empty and contains no spaces.
 */
export function validateTriggerLabel(label: string): string | true {
  const trimmed = label.trim();
  if (trimmed.length === 0) return "Trigger label cannot be empty";
  if (/\s/.test(trimmed)) return "Trigger label cannot contain spaces";
  return true;
}

/**
 * Validate that a branch name is non-empty.
 */
export function validateBranchName(name: string): string | true {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Branch name cannot be empty";
  return true;
}

/**
 * Validate that a scope path is non-empty.
 */
export function validateScopePath(path: string): string | true {
  const trimmed = path.trim();
  if (trimmed.length === 0) return "Scope path cannot be empty";
  return true;
}

/**
 * Format the config as a human-readable summary for confirmation.
 */
export function formatConfigSummary(config: AutoClaudeConfig): string {
  return [
    `  repo:           ${config.repo}`,
    `  triggerLabel:   ${config.triggerLabel}`,
    `  mainBranch:     ${config.mainBranch}`,
    `  scopePath:      ${config.scopePath}`,
    `  model:          ${config.model}`,
    `  remote:         ${config.remote}`,
    `  maxIterations:  ${config.maxImplementIterations}`,
    `  maxReviewRetries: ${config.maxReviewRetries}`,
    `  loopInterval:   ${config.loopIntervalMinutes}min`,
  ].join("\n");
}

/**
 * Serialize config to JSON for writing to disk.
 */
export function serializeConfig(config: AutoClaudeConfig): string {
  return JSON.stringify(config, null, 2) + "\n";
}
