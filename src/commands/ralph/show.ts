import { Flags } from "@oclif/core";
import consola from "consola";
import { colors } from "consola/utils";
import { BaseCommand } from "../base.js";
import { DEFAULT_STATE_FILE, loadState, resolveRalphPath } from "../../lib/ralph/state.js";
import {
  formatPlanAsMarkdown,
  formatPlanAsJson,
  copyToClipboard,
} from "../../lib/ralph/formatter.js";

/**
 * Show plan summary with status, tasks, and mermaid graph
 */
export default class Show extends BaseCommand {
  static override description = "Show plan summary with status, tasks, and mermaid graph";

  static override examples = [
    {
      description: "Show plan summary with mermaid graph",
      command: "<%= config.bin %> <%= command.id %>",
    },
    {
      description: "Output plan as JSON",
      command: "<%= config.bin %> <%= command.id %> --format json",
    },
    {
      description: "Copy plan output to clipboard",
      command: "<%= config.bin %> <%= command.id %> --copy",
    },
  ];

  static override flags = {
    ...BaseCommand.baseFlags,
    stateFile: Flags.string({
      char: "s",
      description: `State file path (default: ${DEFAULT_STATE_FILE})`,
    }),
    format: Flags.string({
      char: "f",
      description: "Output format",
      default: "default",
      options: ["default", "markdown", "json"],
    }),
    copy: Flags.boolean({
      char: "c",
      description: "Copy output to clipboard",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Show);
    const ralphSettings = this.settings.settings.ralphSettings;
    const stateFile = resolveRalphPath(flags.stateFile, "stateFile", ralphSettings);

    const state = loadState(stateFile);

    if (!state) {
      consola.log(colors.yellow(`No state file found at: ${stateFile}`));
      return;
    }

    if (state.tasks.length === 0) {
      consola.log(colors.yellow("No tasks in state file."));
      consola.log(colors.dim('Use: tt ralph plan add "description"'));
      return;
    }

    let output: string;

    if (flags.format === "json") {
      output = formatPlanAsJson(state.tasks, state);
    } else {
      output = formatPlanAsMarkdown(state.tasks, state);
    }

    consola.log(output);

    if (flags.copy) {
      if (copyToClipboard(output)) {
        consola.log(colors.green("✓ Copied to clipboard"));
      } else {
        consola.log(colors.yellow("⚠ Could not copy to clipboard (xclip/xsel not installed?)"));
      }
    }
  }
}
