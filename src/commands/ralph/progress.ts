import * as fs from "node:fs";
import * as path from "node:path";
import { Args, Flags } from "@oclif/core";
import { BaseCommand } from "../base.js";
import { DEFAULT_PROGRESS_FILE, resolveRalphPath } from "../../lib/ralph/state.js";

/**
 * Append progress message to ralph-progress.md (write-only, no read)
 */
export default class Progress extends BaseCommand {
  static override description = "Append progress message (write-only, never reads file)";

  static override examples = [
    {
      description: "Append a progress message",
      command: '<%= config.bin %> <%= command.id %> "Completed user service implementation"',
    },
    {
      description: "Append to custom progress file",
      command: '<%= config.bin %> <%= command.id %> "Starting tests" --file custom-progress.md',
    },
  ];

  static override args = {
    message: Args.string({
      description: "Progress message to append",
      required: true,
    }),
  };

  static override flags = {
    ...BaseCommand.baseFlags,
    file: Flags.string({
      char: "f",
      description: `Progress file path (default: ${DEFAULT_PROGRESS_FILE})`,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Progress);
    const ralphSettings = this.settings.settings.ralphSettings;
    const progressFile = resolveRalphPath(flags.file, "progressFile", ralphSettings);

    const timestamp = new Date().toISOString();
    const line = `- [${timestamp}] ${args.message}\n`;

    fs.mkdirSync(path.dirname(progressFile), { recursive: true });
    fs.appendFileSync(progressFile, line);
  }
}
