import { resolve } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { logger } from "../../utils/logger";

/** Check if artifact content satisfies a pass condition */
export function checkPassCondition(condition: string, content: string): boolean {
  if (condition.startsWith("first_line_equals:")) {
    const expected = condition.slice("first_line_equals:".length);
    const firstLine = content.split("\n")[0]?.trim() ?? "";
    return firstLine === expected;
  }

  if (condition.startsWith("contains:")) {
    const expected = condition.slice("contains:".length);
    return content.includes(expected);
  }

  logger.warn(`Unknown pass_condition format: ${condition}`);
  return true;
}

/** Replace {variable} placeholders in a template string */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

/** Build an agentboard branch name from card ID and title */
export function buildAgentBranchName(cardId: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50)
    .replace(/-$/, "");

  return slug ? `agentboard/${cardId}-${slug}` : `agentboard/card-${cardId}`;
}

/** Escape a string for safe use in shell commands */
export function shellEscape(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

/** Build a multi-line claude CLI command from args */
export function buildClaudeCommand(args: string[]): string {
  return `claude \\\n  ${args.join(" \\\n  ")}`;
}

/** Build a claude command with stream-json output piped to a log file via tee */
export function buildStreamingCommand(args: string[], logFilePath: string): string {
  args.push("--output-format", "stream-json", "--verbose");
  return `${buildClaudeCommand(args)} 2>&1 | tee ${shellEscape(logFilePath)}`;
}

const LOG_DIR = resolve(
  process.env.AGENTBOARD_DATA_DIR ??
    resolve(process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"), "towles-tool", "agentboard"),
  "logs",
);

export function getCardLogPath(cardId: number): string {
  mkdirSync(LOG_DIR, { recursive: true });
  return resolve(LOG_DIR, `card-${cardId}.ndjson`);
}
