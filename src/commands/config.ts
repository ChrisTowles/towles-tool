import { defineCommand } from "citty";
import consola from "consola";
import { withSettings, debugArg } from "./shared.js";

export default defineCommand({
  meta: { name: "config", description: "Display current configuration settings" },
  args: { debug: debugArg },
  async run({ args }) {
    const { settingsFile, settings } = await withSettings(args.debug);

    consola.info("Configuration");
    consola.log("");

    consola.info(`Settings File: ${settingsFile.path}`);
    consola.log("");

    consola.warn("User Config:");
    consola.log(`  Daily Path Template: ${settings.journalSettings.dailyPathTemplate}`);
    consola.log(`  Meeting Path Template: ${settings.journalSettings.meetingPathTemplate}`);
    consola.log(`  Note Path Template: ${settings.journalSettings.notePathTemplate}`);
    consola.log(`  Editor: ${settings.preferredEditor}`);
    consola.log("");

    consola.warn("Working Directory:");
    consola.log(`  ${process.cwd()}`);
    consola.log("");
  },
});
