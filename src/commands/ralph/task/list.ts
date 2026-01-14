import { Flags } from "@oclif/core";
import pc from "picocolors";
import { BaseCommand } from "../../base.js";
import { DEFAULT_STATE_FILE, loadState } from "../lib/state.js";
import { formatTasksAsMarkdown } from "../lib/formatter.js";

/**
 * List all ralph tasks
 */
export default class TaskList extends BaseCommand {
  static override description = "List all tasks";

  static override examples = [
    "<%= config.bin %> ralph task list",
    "<%= config.bin %> ralph task list --format markdown",
    "<%= config.bin %> ralph task list --label backend",
  ];

  static override flags = {
    ...BaseCommand.baseFlags,
    stateFile: Flags.string({
      char: "s",
      description: "State file path",
      default: DEFAULT_STATE_FILE,
    }),
    format: Flags.string({
      char: "f",
      description: "Output format: default, markdown",
      default: "default",
      options: ["default", "markdown"],
    }),
    label: Flags.string({
      char: "l",
      description: "Filter tasks by label",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(TaskList);

    const state = loadState(flags.stateFile);

    if (!state) {
      this.log(pc.yellow(`No state file found at: ${flags.stateFile}`));
      return;
    }

    // Filter by label if specified
    let tasks = state.tasks;
    if (flags.label) {
      tasks = tasks.filter((t) => t.label === flags.label);
      if (tasks.length === 0) {
        this.log(pc.yellow(`No tasks with label: ${flags.label}`));
        return;
      }
    }

    if (tasks.length === 0) {
      this.log(pc.yellow("No tasks in state file."));
      this.log(pc.dim('Use: tt ralph task add "description"'));
      return;
    }

    if (flags.format === "markdown") {
      this.log(formatTasksAsMarkdown(tasks));
      return;
    }

    // Default format output - compact with truncation
    const ready = tasks.filter((t) => t.status === "ready");
    const done = tasks.filter((t) => t.status === "done");

    const truncate = (s: string, len: number) => (s.length > len ? s.slice(0, len - 1) + "…" : s);
    const termWidth = process.stdout.columns || 120;

    // Summary header
    const labelInfo = flags.label ? ` [${flags.label}]` : "";
    this.log(
      pc.bold(`\nTasks${labelInfo}: `) +
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
