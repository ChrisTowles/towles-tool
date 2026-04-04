import { defineCommand } from "citty";
import consola from "consola";
import { colors } from "consola/utils";
import {
  UserSettingsSchema,
  USER_SETTINGS_PATH,
  saveSettings,
  loadSettings,
} from "../../config/settings.js";

export default defineCommand({
  meta: { name: "reset", description: "Reset settings to defaults" },
  args: {
    confirm: {
      type: "boolean",
      description: "Confirm the reset (required to actually reset)",
      default: false,
    },
  },
  async run({ args }) {
    const defaults = UserSettingsSchema.parse({});

    if (!args.confirm) {
      consola.log(`${colors.bold("Current settings vs defaults:")}\n`);

      let currentSettings: Record<string, unknown>;
      try {
        const { settings } = await loadSettings();
        currentSettings = settings as unknown as Record<string, unknown>;
      } catch {
        currentSettings = {};
      }

      const currentJson = JSON.stringify(currentSettings, null, 2);
      const defaultJson = JSON.stringify(defaults, null, 2);

      if (currentJson === defaultJson) {
        consola.log(`${colors.green("✓")} Settings already match defaults. Nothing to reset.`);
        return;
      }

      consola.log(`${colors.red("Current:")} ${currentJson}\n`);
      consola.log(`${colors.green("Default:")} ${defaultJson}\n`);

      consola.warn("Run with --confirm to reset settings to defaults.");
      process.exitCode = 1;
      return;
    }

    await saveSettings({ path: USER_SETTINGS_PATH, settings: defaults });
    consola.log(`${colors.green("✓")} Settings reset to defaults: ${USER_SETTINGS_PATH}`);
  },
});
