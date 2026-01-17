import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { Args } from "@oclif/core";
import consola from "consola";
import { colors } from "consola/utils";
import { BaseCommand } from "../base.js";
import { JOURNAL_TYPES } from "../../types/journal.js";
import {
  createMeetingContent,
  ensureDirectoryExists,
  ensureTemplatesExist,
  generateJournalFileInfoByType,
  openInEditor,
} from "../../lib/journal/utils.js";

/**
 * Create or open meeting notes file
 */
export default class Meeting extends BaseCommand {
  static override description = "Structured meeting notes with agenda and action items";

  static override args = {
    title: Args.string({
      description: "Meeting title",
      required: false,
    }),
  };

  static override examples = [
    {
      description: "Create meeting note (prompts for title)",
      command: "<%= config.bin %> <%= command.id %>",
    },
    {
      description: "Create with title",
      command: '<%= config.bin %> <%= command.id %> "Sprint Planning"',
    },
    { description: "Using alias", command: '<%= config.bin %> m "Standup"' },
  ];

  async run(): Promise<void> {
    const { args } = await this.parse(Meeting);

    try {
      const journalSettings = this.settings.settings.journalSettings;
      const templateDir = journalSettings.templateDir;

      // Ensure templates exist on first run
      ensureTemplatesExist(templateDir);

      // Prompt for title if not provided
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

      // Ensure journal directory exists
      ensureDirectoryExists(path.dirname(fileInfo.fullPath));

      if (existsSync(fileInfo.fullPath)) {
        consola.info(`Opening existing meeting file: ${colors.cyan(fileInfo.fullPath)}`);
      } else {
        const content = createMeetingContent({ title, date: currentDate, templateDir });
        consola.info(`Creating new meeting file: ${colors.cyan(fileInfo.fullPath)}`);
        writeFileSync(fileInfo.fullPath, content, "utf8");
      }

      await openInEditor({
        editor: this.settings.settings.preferredEditor,
        filePath: fileInfo.fullPath,
        folderPath: journalSettings.baseFolder,
      });
    } catch (error) {
      consola.warn(`Error creating meeting file:`, error);
      process.exit(1);
    }
  }
}
