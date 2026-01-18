import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Flags } from "@oclif/core";
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
 * Add a new plan to ralph state from a file
 */
export default class PlanAdd extends BaseCommand {
  static override description = "Add a new plan from a file";

  static override examples = [
    {
      description: "Add a plan from a markdown file",
      command: "<%= config.bin %> <%= command.id %> --file docs/plans/2025-01-18-feature.md",
    },
  ];

  static override flags = {
    ...BaseCommand.baseFlags,
    file: Flags.string({
      char: "f",
      description: "Path to plan file (markdown)",
      required: true,
    }),
    stateFile: Flags.string({
      char: "s",
      description: `State file path (default: ${DEFAULT_STATE_FILE})`,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(PlanAdd);
    const ralphSettings = this.settings.settings.ralphSettings;
    const stateFile = resolveRalphPath(flags.stateFile, "stateFile", ralphSettings);

    const planFilePath = resolve(flags.file);

    if (!existsSync(planFilePath)) {
      this.error(`Plan file not found: ${planFilePath}`);
    }

    let state = loadState(stateFile);

    if (!state) {
      state = createInitialState();
    }

    const newPlan = addPlanToState(state, planFilePath);
    saveState(state, stateFile);

    consola.log(colors.green(`✓ Added plan #${newPlan.id}`));
    consola.log(colors.dim(`  File: ${planFilePath}`));
    consola.log(colors.dim(`State saved to: ${stateFile}`));
    consola.log(colors.dim(`Total plans: ${state.plans.length}`));
  }
}
