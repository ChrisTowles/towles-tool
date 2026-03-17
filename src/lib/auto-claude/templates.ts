import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const TEMPLATES_DIR = join(__dirname, "prompt-templates");

// ── Template resolution ──

export interface TokenValues {
  SCOPE_PATH: string;
  ISSUE_DIR: string;
  MAIN_BRANCH: string;
  REVIEW_FEEDBACK?: string;
}

export function resolveTemplate(
  templateName: string,
  tokens: TokenValues,
  issueDir: string,
): string {
  const templatePath = join(TEMPLATES_DIR, templateName);
  let template = readFileSync(templatePath, "utf-8");

  for (const [key, value] of Object.entries(tokens)) {
    template = template.replaceAll(`{{${key}}}`, value);
  }

  const resolvedPath = join(issueDir, templateName);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, template, "utf-8");

  return relative(process.cwd(), resolvedPath);
}
