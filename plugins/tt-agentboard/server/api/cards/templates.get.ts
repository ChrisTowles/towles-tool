import { readdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse } from "yaml";

interface CardTemplate {
  name: string;
  description: string;
  prompt: string;
  executionMode: "headless" | "interactive";
  branchMode: "create" | "current";
  column: "ready" | "backlog";
}

export default defineEventHandler(() => {
  const templatesDir = resolve(process.cwd(), "templates", "card-templates");
  let files: string[];
  try {
    files = readdirSync(templatesDir).filter((f) => f.endsWith(".yaml"));
  } catch {
    return [];
  }

  return files.map((file) => {
    const content = readFileSync(join(templatesDir, file), "utf-8");
    return parse(content) as CardTemplate;
  });
});
