import { Args, Flags } from "@oclif/core";
import consola from "consola";
import { colors } from "consola/utils";
import { BaseCommand } from "../../base.js";
import {
  DEFAULT_STATE_FILE,
  loadState,
  saveState,
  resolveRalphPath,
} from "../../../lib/ralph/state.js";

/**
 * Remove a ralph task by ID
 */
export default class TaskRemove extends BaseCommand {
  static override description = "Remove a task by ID";

  static override examples = [
    { description: "Remove task #1", command: "<%= config.bin %> ralph task remove 1" },
    {
      description: "Remove from custom state file",
      command: "<%= config.bin %> ralph task remove 5 --stateFile custom-state.json",
    },
  ];

  static override args = {
    id: Args.integer({
      description: "Task ID to remove",
      required: true,
    }),
  };

  static override flags = {
    ...BaseCommand.baseFlags,
    stateFile: Flags.string({
      char: "s",
      description: `State file path (default: ${DEFAULT_STATE_FILE})`,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(TaskRemove);
    const ralphSettings = this.settings.settings.ralphSettings;
    const stateFile = resolveRalphPath(flags.stateFile, "stateFile", ralphSettings);

    const taskId = args.id;

    if (taskId < 1) {
      this.error("Invalid task ID");
    }

    const state = loadState(stateFile);

    if (!state) {
      this.error(`No state file found at: ${stateFile}`);
    }

    const taskIndex = state.tasks.findIndex((t) => t.id === taskId);

    if (taskIndex === -1) {
      this.error(`Task #${taskId} not found. Use: tt ralph task list`);
    }

    const removedTask = state.tasks[taskIndex];
    state.tasks.splice(taskIndex, 1);
    saveState(state, stateFile);

    consola.log(colors.green(`✓ Removed task #${taskId}: ${removedTask.description}`));
    consola.log(colors.dim(`Remaining tasks: ${state.tasks.length}`));
  }
}
