import { readFile } from "node:fs/promises";
import { defineCommand } from "citty";
import consola from "consola";
import { colors } from "consola/utils";
import { UserSettingsSchema, USER_SETTINGS_PATH } from "../../config/settings.js";
import { debugArg } from "../shared.js";

export default defineCommand({
  meta: { name: "validate", description: "Validate settings file against the config schema" },
  args: {
    debug: debugArg,
    path: {
      type: "string",
      description: "Path to settings file (defaults to standard location)",
    },
  },
  async run({ args }) {
    const filePath = args.path ?? USER_SETTINGS_PATH;

    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch {
      consola.error(`Settings file not found: ${filePath}`);
      process.exitCode = 1;
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      consola.error(`Invalid JSON in ${filePath}: ${(e as Error).message}`);
      process.exitCode = 1;
      return;
    }

    const result = UserSettingsSchema.safeParse(parsed);

    if (result.success) {
      consola.log(`${colors.green("✓")} ${filePath} is valid`);
    } else {
      consola.log(`${colors.red("✗")} ${filePath} has validation errors:\n`);
      for (const issue of result.error.issues) {
        const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        consola.log(`  ${colors.red("•")} ${colors.bold(path)}: ${issue.message}`);
      }
      process.exitCode = 1;
    }
  },
});
