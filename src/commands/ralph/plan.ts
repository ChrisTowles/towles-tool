import { Flags } from "@oclif/core";
import pc from "picocolors";
import { BaseCommand } from "../base.js";
import { DEFAULT_STATE_FILE, loadState, resolveRalphPath } from "./lib/state.js";
import { formatPlanAsMarkdown, formatPlanAsJson, copyToClipboard } from "./lib/formatter.js";

/**
 * Show plan summary with status, tasks, and mermaid graph
 */
export default class Plan extends BaseCommand {
  static override description = "Show plan summary with status, tasks, and mermaid graph";

  static override examples = [
    "<%= config.bin %> ralph plan",
    "<%= config.bin %> ralph plan --format json",
    "<%= config.bin %> ralph plan --copy",
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
      description: "Copy output to clipboard",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Plan);
    const ralphSettings = this.settings.settingsFile.settings.ralphSettings;
    const stateFile = resolveRalphPath(flags.stateFile, "stateFile", ralphSettings);

    const state = loadState(stateFile);

    if (!state) {
      console.log(pc.yellow(`No state file found at: ${stateFile}`));
      return;
    }

    if (state.tasks.length === 0) {
      console.log(pc.yellow("No tasks in state file."));
      console.log(pc.dim('Use: tt ralph task add "description"'));
      return;
    }

    let output: string;

    if (flags.format === "json") {
      output = formatPlanAsJson(state.tasks, state);
    } else {
      output = formatPlanAsMarkdown(state.tasks, state);
    }

    console.log(output);

    if (flags.copy) {
      if (copyToClipboard(output)) {
        console.log(pc.green("✓ Copied to clipboard"));
      } else {
        console.log(pc.yellow("⚠ Could not copy to clipboard (xclip/xsel not installed?)"));
      }
    }
  }
}
