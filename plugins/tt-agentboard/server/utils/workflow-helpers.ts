import { logger } from "./logger";

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

/** Escape a string for safe use in shell commands */
export function shellEscape(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}
