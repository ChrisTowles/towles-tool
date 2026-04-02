import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { defineCommand } from "citty";
import consola from "consola";
import { colors } from "consola/utils";
import { withSettings, debugArg } from "../shared.js";
import { JOURNAL_TYPES } from "../../types/journal.js";
import { ensureDirectoryExists } from "./fs.js";
import { openInEditor } from "./editor.js";
import { createNoteContent, ensureTemplatesExist } from "./templates.js";
import { generateJournalFileInfoByType } from "./paths.js";

export default defineCommand({
  meta: { name: "note", description: "General-purpose notes with structured sections" },
  args: {
    debug: debugArg,
    title: {
      type: "positional",
      required: false,
      description: "Note title",
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
        title = await consola.prompt(`Enter note title:`, {
          type: "text",
        });
      }

      const currentDate = new Date();
      const fileInfo = generateJournalFileInfoByType({
        journalSettings,
        date: currentDate,
        type: JOURNAL_TYPES.NOTE,
        title,
      });

      ensureDirectoryExists(path.dirname(fileInfo.fullPath));

      if (existsSync(fileInfo.fullPath)) {
        consola.info(`Opening existing note file: ${colors.cyan(fileInfo.fullPath)}`);
      } else {
        const content = createNoteContent({ title, date: currentDate, templateDir });
        consola.info(`Creating new note file: ${colors.cyan(fileInfo.fullPath)}`);
        writeFileSync(fileInfo.fullPath, content, "utf8");
      }

      await openInEditor({
        editor: settings.preferredEditor,
        filePath: fileInfo.fullPath,
        folderPath: journalSettings.baseFolder,
      });
    } catch (error) {
      consola.warn(`Error creating note file:`, error);
      process.exit(1);
    }
  },
});
