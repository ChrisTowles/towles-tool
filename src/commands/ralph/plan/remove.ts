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
 * Remove a ralph plan by ID
 */
export default class PlanRemove extends BaseCommand {
  static override description = "Remove a plan by ID";

  static override examples = [
    { description: "Remove plan #1", command: "<%= config.bin %> <%= command.id %> 1" },
    {
      description: "Remove from custom state file",
      command: "<%= config.bin %> <%= command.id %> 5 --stateFile custom-state.json",
    },
  ];

  static override args = {
    id: Args.integer({
      description: "Plan ID to remove",
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
    const { args, flags } = await this.parse(PlanRemove);
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

    const planIndex = state.plans.findIndex((p) => p.id === planId);

    if (planIndex === -1) {
      this.error(`Plan #${planId} not found. Use: tt ralph plan list`);
    }

    const removedPlan = state.plans[planIndex];
    state.plans.splice(planIndex, 1);
    saveState(state, stateFile);

    consola.log(colors.green(`✓ Removed plan #${planId}: ${removedPlan.planFilePath}`));
    consola.log(colors.dim(`Remaining plans: ${state.plans.length}`));
  }
}
