import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { defineCommand } from "citty";
import consola from "consola";
import { colors } from "consola/utils";
import { withSettings, debugArg } from "../shared.js";
import { JOURNAL_TYPES } from "../../types/journal.js";
import {
  createJournalContent,
  ensureDirectoryExists,
  ensureTemplatesExist,
  generateJournalFileInfoByType,
  openInEditor,
} from "../../lib/journal/index.js";

export default defineCommand({
  meta: {
    name: "daily-notes",
    description: "Weekly files with daily sections for ongoing work and notes",
  },
  args: {
    debug: debugArg,
  },
  async run({ args }) {
    const { settings } = await withSettings(args.debug);

    try {
      const journalSettings = settings.journalSettings;
      const templateDir = journalSettings.templateDir;

      ensureTemplatesExist(templateDir);

      const currentDate = new Date();
      const fileInfo = generateJournalFileInfoByType({
        journalSettings,
        date: currentDate,
        type: JOURNAL_TYPES.DAILY_NOTES,
        title: "",
      });

      ensureDirectoryExists(path.dirname(fileInfo.fullPath));

      if (existsSync(fileInfo.fullPath)) {
        consola.info(`Opening existing daily-notes file: ${colors.cyan(fileInfo.fullPath)}`);
      } else {
        const content = createJournalContent({ mondayDate: fileInfo.mondayDate, templateDir });
        consola.info(`Creating new daily-notes file: ${colors.cyan(fileInfo.fullPath)}`);
        writeFileSync(fileInfo.fullPath, content, "utf8");
      }

      await openInEditor({
        editor: settings.preferredEditor,
        filePath: fileInfo.fullPath,
        folderPath: journalSettings.baseFolder,
      });
    } catch (error) {
      consola.warn(`Error creating daily-notes file:`, error);
      process.exit(1);
    }
  },
});
