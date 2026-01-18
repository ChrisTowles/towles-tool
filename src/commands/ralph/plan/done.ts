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
 * Mark a ralph task as done
 */
export default class PlanDone extends BaseCommand {
  static override description = "Mark a task as done by ID";

  static override examples = [
    { description: "Mark task #1 as done", command: "<%= config.bin %> <%= command.id %> 1" },
    {
      description: "Mark done using custom state file",
      command: "<%= config.bin %> <%= command.id %> 5 --stateFile custom-state.json",
    },
  ];

  static override args = {
    id: Args.integer({
      description: "Task ID to mark done",
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
    const { args, flags } = await this.parse(PlanDone);
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

    const task = state.tasks.find((t) => t.id === taskId);

    if (!task) {
      this.error(`Task #${taskId} not found. Use: tt ralph plan list`);
    }

    if (task.status === "done") {
      consola.log(colors.yellow(`Task #${taskId} is already done.`));
      return;
    }

    task.status = "done";
    task.completedAt = new Date().toISOString();
    saveState(state, stateFile);

    consola.log(colors.green(`✓ Marked task #${taskId} as done: ${task.description}`));

    const remaining = state.tasks.filter((t) => t.status !== "done").length;
    if (remaining === 0) {
      consola.log(colors.bold(colors.green("All tasks complete!")));
    } else {
      consola.log(colors.dim(`Remaining tasks: ${remaining}`));
    }
  }
}
