import { Args, Flags } from "@oclif/core";
import consola from "consola";
import { colors } from "consola/utils";
import { BaseCommand } from "../../base.js";
import {
  DEFAULT_STATE_FILE,
  DEFAULT_MAX_ITERATIONS,
  loadState,
  saveState,
  createInitialState,
  addTaskToState,
  resolveRalphPath,
} from "../../../lib/ralph/state.js";

/**
 * Add a new task to ralph state
 */
export default class PlanAdd extends BaseCommand {
  static override description = "Add a new task";

  static override examples = [
    {
      description: "Add a simple task",
      command: '<%= config.bin %> <%= command.id %> "Fix the login bug"',
    },
  ];

  static override args = {
    description: Args.string({
      description: "Task description",
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
    const { args, flags } = await this.parse(PlanAdd);
    const ralphSettings = this.settings.settings.ralphSettings;
    const stateFile = resolveRalphPath(flags.stateFile, "stateFile", ralphSettings);

    const description = args.description.trim();

    if (!description || description.length < 3) {
      this.error("Task description too short (min 3 chars)");
    }

    let state = loadState(stateFile);

    if (!state) {
      state = createInitialState(DEFAULT_MAX_ITERATIONS);
    }

    const newTask = addTaskToState(state, description);
    saveState(state, stateFile);

    consola.log(colors.green(`✓ Added task #${newTask.id}: ${newTask.description}`));
    consola.log(colors.dim(`State saved to: ${stateFile}`));
    consola.log(colors.dim(`Total tasks: ${state.tasks.length}`));
  }
}
