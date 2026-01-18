import { Flags } from "@oclif/core";
import pc from "picocolors";
import { BaseCommand } from "../../base.js";
import { DEFAULT_STATE_FILE, loadState, resolveRalphPath } from "../../../lib/ralph/state.js";
import { formatPlansAsMarkdown } from "../../../lib/ralph/formatter.js";

/**
 * List all ralph plans
 */
export default class PlanList extends BaseCommand {
  static override description = "List all plans";

  static override examples = [
    { description: "List all plans", command: "<%= config.bin %> <%= command.id %>" },
    {
      description: "Output as markdown",
      command: "<%= config.bin %> <%= command.id %> --format markdown",
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
      description: "Output format: default, markdown",
      default: "default",
      options: ["default", "markdown"],
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(PlanList);
    const ralphSettings = this.settings.settings.ralphSettings;
    const stateFile = resolveRalphPath(flags.stateFile, "stateFile", ralphSettings);

    const state = loadState(stateFile);

    if (!state) {
      this.log(pc.yellow(`No state file found at: ${stateFile}`));
      return;
    }

    const plans = state.plans;

    if (plans.length === 0) {
      this.log(pc.yellow("No plans in state file."));
      this.log(pc.dim('Use: tt ralph plan add "description"'));
      return;
    }

    if (flags.format === "markdown") {
      this.log(formatPlansAsMarkdown(plans));
      return;
    }

    // Default format output - compact with truncation
    const ready = plans.filter((p) => p.status === "ready");
    const done = plans.filter((p) => p.status === "done");

    const truncate = (s: string, len: number) => (s.length > len ? s.slice(0, len - 1) + "…" : s);
    const termWidth = process.stdout.columns || 120;

    // Summary header
    this.log(
      pc.bold("\nPlans: ") +
        pc.green(`${done.length} done`) +
        pc.dim(" / ") +
        pc.yellow(`${ready.length} ready`),
    );
    this.log();

    // Show ready plans first (these are actionable)
    // Reserve ~10 chars for "  ○ #XX " prefix
    const pathWidth = Math.max(40, termWidth - 12);

    if (ready.length > 0) {
      for (const plan of ready) {
        const icon = pc.dim("○");
        const id = pc.cyan(`#${plan.id}`);
        const filePath = truncate(plan.planFilePath, pathWidth);
        const errorSuffix = plan.error ? pc.red(` ⚠ ${truncate(plan.error, 30)}`) : "";
        this.log(`  ${icon} ${id} ${filePath}${errorSuffix}`);
      }
    }

    // Show done plans collapsed
    if (done.length > 0) {
      this.log(pc.dim(`  ─── ${done.length} completed ───`));
      for (const plan of done) {
        const filePath = truncate(plan.planFilePath, pathWidth - 5);
        this.log(pc.dim(`  ✓ #${plan.id} ${filePath}`));
      }
    }
    this.log();
  }
}
