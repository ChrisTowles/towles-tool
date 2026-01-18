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
 * Mark a ralph plan as done
 */
export default class PlanDone extends BaseCommand {
  static override description = "Mark a plan as done by ID";

  static override examples = [
    { description: "Mark plan #1 as done", command: "<%= config.bin %> <%= command.id %> 1" },
    {
      description: "Mark done using custom state file",
      command: "<%= config.bin %> <%= command.id %> 5 --stateFile custom-state.json",
    },
  ];

  static override args = {
    id: Args.integer({
      description: "Plan ID to mark done",
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

    const planId = args.id;

    if (planId < 1) {
      this.error("Invalid plan ID");
    }

    const state = loadState(stateFile);

    if (!state) {
      this.error(`No state file found at: ${stateFile}`);
    }

    const plan = state.plans.find((t) => t.id === planId);

    if (!plan) {
      this.error(`Plan #${planId} not found. Use: tt ralph plan list`);
    }

    if (plan.status === "done") {
      consola.log(colors.yellow(`Plan #${planId} is already done.`));
      return;
    }

    plan.status = "done";
    plan.completedAt = new Date().toISOString();
    saveState(state, stateFile);

    consola.log(colors.green(`✓ Marked plan #${planId} as done: ${plan.description}`));

    const remaining = state.plans.filter((t) => t.status !== "done").length;
    if (remaining === 0) {
      consola.log(colors.bold(colors.green("All plans complete!")));
    } else {
      consola.log(colors.dim(`Remaining plans: ${remaining}`));
    }
  }
}
