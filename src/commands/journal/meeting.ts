import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { defineCommand } from "citty";
import consola from "consola";
import { colors } from "consola/utils";
import { withSettings, debugArg } from "../shared.js";
import { JOURNAL_TYPES } from "../../types/journal.js";
import {
  createMeetingContent,
  ensureDirectoryExists,
  ensureTemplatesExist,
  generateJournalFileInfoByType,
  openInEditor,
} from "../../lib/journal/index.js";

export default defineCommand({
  meta: { name: "meeting", description: "Structured meeting notes with agenda and action items" },
  args: {
    debug: debugArg,
    title: {
      type: "positional",
      required: false,
      description: "Meeting title",
    },
  },
  async run({ args }) {
    const { settings } = await withSettings(args.debug);

    try {
      const journalSettings = settings.journalSettings;
      const templateDir = journalSettings.templateDir;

      ensureTemplatesExist(templateDir);

      let title = args.title || "";
      if (title.trim().length === 0) {
        title = await consola.prompt(`Enter meeting title:`, {
          type: "text",
        });
      }

      const currentDate = new Date();
      const fileInfo = generateJournalFileInfoByType({
        journalSettings,
        date: currentDate,
        type: JOURNAL_TYPES.MEETING,
        title,
      });

      ensureDirectoryExists(path.dirname(fileInfo.fullPath));

      if (existsSync(fileInfo.fullPath)) {
        consola.info(`Opening existing meeting file: ${colors.cyan(fileInfo.fullPath)}`);
      } else {
        const content = createMeetingContent({ title, date: currentDate, templateDir });
        consola.info(`Creating new meeting file: ${colors.cyan(fileInfo.fullPath)}`);
        writeFileSync(fileInfo.fullPath, content, "utf8");
      }

      await openInEditor({
        editor: settings.preferredEditor,
        filePath: fileInfo.fullPath,
        folderPath: journalSettings.baseFolder,
      });
    } catch (error) {
      consola.warn(`Error creating meeting file:`, error);
      process.exit(1);
    }
  },
});
