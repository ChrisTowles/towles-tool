import { Flags } from "@oclif/core";
import pc from "picocolors";
import { BaseCommand } from "../../base.js";
import { DEFAULT_STATE_FILE, loadState, resolveRalphPath } from "../../../lib/ralph/state.js";
import { formatPlansAsMarkdown } from "../../../lib/ralph/formatter.js";

/**
 * List all ralph tasks
 */
export default class PlanList extends BaseCommand {
  static override description = "List all tasks";

  static override examples = [
    { description: "List all tasks", command: "<%= config.bin %> <%= command.id %>" },
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

    const tasks = state.plans;

    if (tasks.length === 0) {
      this.log(pc.yellow("No tasks in state file."));
      this.log(pc.dim('Use: tt ralph plan add "description"'));
      return;
    }

    if (flags.format === "markdown") {
      this.log(formatPlansAsMarkdown(tasks));
      return;
    }

    // Default format output - compact with truncation
    const ready = tasks.filter((t) => t.status === "ready");
    const done = tasks.filter((t) => t.status === "done");

    const truncate = (s: string, len: number) => (s.length > len ? s.slice(0, len - 1) + "…" : s);
    const termWidth = process.stdout.columns || 120;

    // Summary header
    this.log(
      pc.bold("\nTasks: ") +
        pc.green(`${done.length} done`) +
        pc.dim(" / ") +
        pc.yellow(`${ready.length} ready`),
    );
    this.log();

    // Show ready tasks first (these are actionable)
    // Reserve ~10 chars for "  ○ #XX " prefix
    const descWidth = Math.max(40, termWidth - 12);

    if (ready.length > 0) {
      for (const task of ready) {
        const icon = pc.dim("○");
        const id = pc.cyan(`#${task.id}`);
        const desc = truncate(task.description, descWidth);
        this.log(`  ${icon} ${id} ${desc}`);
      }
    }

    // Show done tasks collapsed
    if (done.length > 0) {
      this.log(pc.dim(`  ─── ${done.length} completed ───`));
      for (const task of done) {
        const desc = truncate(task.description, descWidth - 5);
        this.log(pc.dim(`  ✓ #${task.id} ${desc}`));
      }
    }
    this.log();
  }
}
