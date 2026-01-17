import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import consola from "consola";
import { colors } from "consola/utils";
import { BaseCommand } from "../base.js";
import { JOURNAL_TYPES } from "../../types/journal.js";
import {
  createJournalContent,
  ensureDirectoryExists,
  ensureTemplatesExist,
  generateJournalFileInfoByType,
  openInEditor,
} from "../../lib/journal/utils.js";

/**
 * Create or open daily notes journal file
 */
export default class DailyNotes extends BaseCommand {
  static override aliases = ["today"];
  static override description = "Weekly files with daily sections for ongoing work and notes";

  static override examples = [
    {
      description: "Open weekly notes for today",
      command: "<%= config.bin %> <%= command.id %>",
    },
    { description: "Using alias", command: "<%= config.bin %> today" },
  ];

  async run(): Promise<void> {
    await this.parse(DailyNotes);

    try {
      const journalSettings = this.settings.settings.journalSettings;
      const templateDir = journalSettings.templateDir;

      // Ensure templates exist on first run
      ensureTemplatesExist(templateDir);

      const currentDate = new Date();
      const fileInfo = generateJournalFileInfoByType({
        journalSettings,
        date: currentDate,
        type: JOURNAL_TYPES.DAILY_NOTES,
        title: "",
      });

      // Ensure journal directory exists
      ensureDirectoryExists(path.dirname(fileInfo.fullPath));

      if (existsSync(fileInfo.fullPath)) {
        consola.info(`Opening existing daily-notes file: ${colors.cyan(fileInfo.fullPath)}`);
      } else {
        const content = createJournalContent({ mondayDate: fileInfo.mondayDate, templateDir });
        consola.info(`Creating new daily-notes file: ${colors.cyan(fileInfo.fullPath)}`);
        writeFileSync(fileInfo.fullPath, content, "utf8");
      }

      await openInEditor({
        editor: this.settings.settings.preferredEditor,
        filePath: fileInfo.fullPath,
        folderPath: journalSettings.baseFolder,
      });
    } catch (error) {
      consola.warn(`Error creating daily-notes file:`, error);
      process.exit(1);
    }
  }
}
