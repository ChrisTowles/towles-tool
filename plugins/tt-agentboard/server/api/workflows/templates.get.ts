import { readFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { glob } from "glob";
import { parse as parseYaml } from "yaml";
import { logger } from "~~/server/utils/logger";

/**
 * GET /api/workflows/templates
 * Returns available workflow templates from the templates/ directory.
 */
export default defineEventHandler(async () => {
  const templatesDir = resolve(import.meta.dirname ?? __dirname, "../../../templates/workflows");

  const files = await glob(resolve(templatesDir, "*.yaml"));

  const templates = files.map((file) => {
    try {
      const content = readFileSync(file, "utf-8");
      const parsed = parseYaml(content) as { name?: string; description?: string };
      return {
        filename: basename(file),
        name: parsed.name ?? basename(file, ".yaml"),
        description: parsed.description ?? "",
        content,
      };
    } catch (err) {
      logger.error(`Failed to read template ${file}:`, err);
      return null;
    }
  }).filter(Boolean);

  return { templates };
});
