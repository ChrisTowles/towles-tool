import {
  mkdirSync as defaultMkdirSync,
  readFileSync as defaultReadFileSync,
  writeFileSync as defaultWriteFileSync,
} from "node:fs";
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

export interface TemplateFsDeps {
  readFileSync: typeof defaultReadFileSync;
  writeFileSync: typeof defaultWriteFileSync;
  mkdirSync: typeof defaultMkdirSync;
}

const defaultFsDeps: TemplateFsDeps = {
  readFileSync: defaultReadFileSync,
  writeFileSync: defaultWriteFileSync,
  mkdirSync: defaultMkdirSync,
};

export function resolveTemplate(
  templateName: string,
  tokens: TokenValues,
  issueDir: string,
  fs: TemplateFsDeps = defaultFsDeps,
): string {
  const templatePath = join(TEMPLATES_DIR, templateName);
  let template = fs.readFileSync(templatePath, "utf-8") as string;

  for (const [key, value] of Object.entries(tokens)) {
    template = template.replaceAll(`{{${key}}}`, value);
  }

  const resolvedPath = join(issueDir, templateName);
  fs.mkdirSync(dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, template, "utf-8");

  return relative(process.cwd(), resolvedPath);
}
