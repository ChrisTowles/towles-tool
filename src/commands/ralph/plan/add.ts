import { Args, Flags } from "@oclif/core";
import consola from "consola";
import { colors } from "consola/utils";
import { BaseCommand } from "../../base.js";
import {
  DEFAULT_STATE_FILE,
  loadState,
  saveState,
  createInitialState,
  addPlanToState,
  resolveRalphPath,
} from "../../../lib/ralph/state.js";

/**
 * Add a new plan to ralph state
 */
export default class PlanAdd extends BaseCommand {
  static override description = "Add a new plan";

  static override examples = [
    {
      description: "Add a simple plan",
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
      this.error("Plan description too short (min 3 chars)");
    }

    let state = loadState(stateFile);

    if (!state) {
      state = createInitialState();
    }

    const newPlan = addPlanToState(state, description);
    saveState(state, stateFile);

    consola.log(colors.green(`✓ Added plan #${newPlan.id}: ${newPlan.description}`));
    consola.log(colors.dim(`State saved to: ${stateFile}`));
    consola.log(colors.dim(`Total plans: ${state.plans.length}`));
  }
}
