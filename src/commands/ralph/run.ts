import * as fs from "node:fs";
import { Flags } from "@oclif/core";
import consola from "consola";
import { colors } from "consola/utils";
import { BaseCommand } from "../base.js";
import {
  DEFAULT_STATE_FILE,
  DEFAULT_LOG_FILE,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_COMPLETION_MARKER,
  CLAUDE_DEFAULT_ARGS,
  loadState,
  saveState,
  appendHistory,
  resolveRalphPath,
  getRalphPaths,
} from "../../lib/ralph/state.js";
import {
  buildIterationPrompt,
  formatDuration,
  extractOutputSummary,
  detectCompletionMarker,
} from "../../lib/ralph/formatter.js";
import { checkClaudeCli, runIteration } from "../../lib/ralph/execution.js";
import type { RalphPlan } from "../../lib/ralph/state.js";

/** Get the task to work on: focused task or first incomplete */
function getCurrentTask(tasks: RalphPlan[], focusedTaskId: number | null): RalphPlan | undefined {
  if (focusedTaskId !== null) {
    return tasks.find((t) => t.id === focusedTaskId);
  }
  return tasks.find((t) => t.status !== "done");
}

/**
 * Run the autonomous ralph loop
 */
export default class Run extends BaseCommand {
  static override description = "Start the autonomous ralph loop";

  static override examples = [
    { description: "Start the autonomous loop", command: "<%= config.bin %> <%= command.id %>" },
    {
      description: "Limit to 20 iterations",
      command: "<%= config.bin %> <%= command.id %> --maxIterations 20",
    },
    {
      description: "Focus on specific task",
      command: "<%= config.bin %> <%= command.id %> --taskId 5",
    },
    {
      description: "Run without auto-committing",
      command: "<%= config.bin %> <%= command.id %> --no-autoCommit",
    },
    {
      description: "Preview config without executing",
      command: "<%= config.bin %> <%= command.id %> --dryRun",
    },
  ];

  static override flags = {
    ...BaseCommand.baseFlags,
    stateFile: Flags.string({
      char: "s",
      description: `State file path (default: ${DEFAULT_STATE_FILE})`,
    }),
    taskId: Flags.integer({
      char: "t",
      description: "Focus on specific task ID",
    }),
    maxIterations: Flags.integer({
      char: "m",
      description: "Max iterations",
      default: DEFAULT_MAX_ITERATIONS,
    }),
    autoCommit: Flags.boolean({
      description: "Auto-commit after each completed task",
      default: true,
      allowNo: true,
    }),
    dryRun: Flags.boolean({
      char: "n",
      description: "Show config without executing",
      default: false,
    }),
    claudeArgs: Flags.string({
      description: "Extra args to pass to claude CLI (space-separated)",
    }),
    logFile: Flags.string({
      description: `Log file path (default: ${DEFAULT_LOG_FILE})`,
    }),
    completionMarker: Flags.string({
      description: "Completion marker",
      default: DEFAULT_COMPLETION_MARKER,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Run);
    const ralphSettings = this.settings.settings.ralphSettings;
    const stateFile = resolveRalphPath(flags.stateFile, "stateFile", ralphSettings);
    const logFile = resolveRalphPath(flags.logFile, "logFile", ralphSettings);
    const ralphPaths = getRalphPaths(ralphSettings);

    const maxIterations = flags.maxIterations;
    const extraClaudeArgs = flags.claudeArgs?.split(" ").filter(Boolean) || [];
    const focusedTaskId = flags.taskId ?? null;

    // Load existing state
    let state = loadState(stateFile);

    if (!state) {
      this.error(`No state file found at: ${stateFile}\nUse: tt ralph plan add "description"`);
    }

    const remainingTasks = state.plans.filter((t) => t.status !== "done");
    if (remainingTasks.length === 0) {
      consola.log(colors.green("✅ All tasks are done!"));
      return;
    }

    // Validate focused task if specified
    if (focusedTaskId !== null) {
      const focusedTask = state.plans.find((t) => t.id === focusedTaskId);
      if (!focusedTask) {
        this.error(`Task #${focusedTaskId} not found. Use: tt ralph plan list`);
      }
      if (focusedTask.status === "done") {
        consola.log(colors.yellow(`Task #${focusedTaskId} is already done.`));
        return;
      }
    }

    // Get current task to work on
    const currentTask = getCurrentTask(state.plans, focusedTaskId);
    if (!currentTask) {
      consola.log(colors.green("✅ All tasks are done!"));
      return;
    }

    // Dry run mode
    if (flags.dryRun) {
      consola.log(colors.bold("\n=== DRY RUN ===\n"));
      consola.log(colors.cyan("Config:"));
      consola.log(`  Max iterations: ${maxIterations}`);
      consola.log(`  State file: ${stateFile}`);
      consola.log(`  Log file: ${logFile}`);
      consola.log(`  Completion marker: ${flags.completionMarker}`);
      consola.log(`  Auto-commit: ${flags.autoCommit}`);
      consola.log(`  Claude args: ${[...CLAUDE_DEFAULT_ARGS, ...extraClaudeArgs].join(" ")}`);
      consola.log(`  Remaining tasks: ${remainingTasks.length}`);

      consola.log(colors.cyan("\nCurrent task:"));
      consola.log(`  #${currentTask.id}: ${currentTask.description}`);

      // Show prompt preview
      const prompt = buildIterationPrompt({
        completionMarker: flags.completionMarker,
        plan: currentTask,
        skipCommit: !flags.autoCommit,
      });
      consola.log(colors.dim("─".repeat(60)));
      consola.log(colors.bold("Prompt Preview"));
      consola.log(colors.dim("─".repeat(60)));
      consola.log(prompt);
      consola.log(colors.dim("─".repeat(60)));

      consola.log(colors.bold("\n=== END DRY RUN ===\n"));
      return;
    }

    // Check claude CLI is available
    if (!(await checkClaudeCli())) {
      this.error(
        "claude CLI not found in PATH\nInstall Claude Code: https://docs.anthropic.com/en/docs/claude-code",
      );
    }

    // Update state for this run
    state.status = "running";

    // Create log stream (append mode)
    const logStream = fs.createWriteStream(logFile, { flags: "a" });

    const ready = state.plans.filter((t) => t.status === "ready").length;
    const done = state.plans.filter((t) => t.status === "done").length;

    logStream.write(`\n${"=".repeat(60)}\n`);
    logStream.write(`Ralph Loop Started: ${new Date().toISOString()}\n`);
    logStream.write(`${"=".repeat(60)}\n\n`);

    consola.log(colors.bold(colors.blue("\nRalph Loop Starting\n")));
    consola.log(colors.dim(`Focus: ${focusedTaskId ? `Task #${focusedTaskId}` : "Ralph picks"}`));
    consola.log(colors.dim(`Max iterations: ${maxIterations}`));
    consola.log(colors.dim(`Log file: ${logFile}`));
    consola.log(colors.dim(`Auto-commit: ${flags.autoCommit}`));
    consola.log(colors.dim(`Tasks: ${state.plans.length} (${done} done, ${ready} ready)`));
    consola.log("");

    logStream.write(`Focus: ${focusedTaskId ? `Task #${focusedTaskId}` : "Ralph picks"}\n`);
    logStream.write(`Max iterations: ${maxIterations}\n`);
    logStream.write(`Tasks: ${state.plans.length} (${done} done, ${ready} ready)\n\n`);

    // Handle SIGINT gracefully
    let interrupted = false;
    process.on("SIGINT", () => {
      if (interrupted) {
        logStream.end();
        process.exit(130);
      }
      interrupted = true;
      const msg = "\n\nInterrupted. Press Ctrl+C again to force exit.\n";
      consola.log(colors.yellow(msg));
      logStream.write(msg);
      state.status = "error";
      saveState(state, stateFile);
    });

    // Main loop
    let completed = false;
    let iteration = 0;

    while (iteration < maxIterations && !interrupted && !completed) {
      iteration++;

      const iterHeader = `Iteration ${iteration}/${maxIterations}`;
      logStream.write(`\n━━━ ${iterHeader} ━━━\n`);

      const iterationStart = new Date().toISOString();
      // Get current task for this iteration
      const task = getCurrentTask(state.plans, focusedTaskId);
      if (!task) {
        completed = true;
        state.status = "completed";
        saveState(state, stateFile);
        consola.log(
          colors.bold(colors.green(`\n✅ All tasks completed after ${iteration} iteration(s)`)),
        );
        logStream.write(`\n✅ All tasks completed after ${iteration} iteration(s)\n`);
        break;
      }
      const prompt = buildIterationPrompt({
        completionMarker: flags.completionMarker,
        plan: task,
        skipCommit: !flags.autoCommit,
      });

      // Log the prompt
      logStream.write(`\n--- Prompt ---\n${prompt}\n--- End Prompt ---\n\n`);

      // Build claude args
      const iterClaudeArgs = [...extraClaudeArgs];

      // Print iteration header
      consola.log("");
      consola.log(colors.bold(colors.blue(`━━━ ${iterHeader} ━━━`)));
      consola.log(colors.dim("─".repeat(60)));
      consola.log(colors.bold("Prompt"));
      consola.log(colors.dim("─".repeat(60)));
      consola.log(prompt);
      consola.log(colors.dim("─".repeat(60)));

      // Run iteration - output goes directly to stdout
      const iterResult = await runIteration(prompt, iterClaudeArgs, logStream);

      // Reload state from disk to pick up changes made by child claude process
      const freshState = loadState(stateFile);
      if (freshState) {
        Object.assign(state, freshState);
      }

      const iterationEnd = new Date().toISOString();
      const markerFound = detectCompletionMarker(iterResult.output, flags.completionMarker);

      // Calculate duration
      const startTime = new Date(iterationStart).getTime();
      const endTime = new Date(iterationEnd).getTime();
      const durationMs = endTime - startTime;
      const durationHuman = formatDuration(durationMs);

      // Record history
      appendHistory(
        {
          iteration,
          startedAt: iterationStart,
          completedAt: iterationEnd,
          durationMs,
          durationHuman,
          outputSummary: extractOutputSummary(iterResult.output),
          markerFound,
          contextUsedPercent: iterResult.contextUsedPercent,
        },
        ralphPaths.historyFile,
      );

      // Save state
      saveState(state, stateFile);

      // Log summary
      const contextInfo =
        iterResult.contextUsedPercent !== undefined
          ? ` | Context: ${iterResult.contextUsedPercent}%`
          : "";
      logStream.write(
        `\n━━━ Iteration ${iteration} Summary ━━━\nDuration: ${durationHuman}${contextInfo}\nMarker found: ${markerFound ? "yes" : "no"}\n`,
      );
      consola.log(
        colors.dim(
          `Duration: ${durationHuman}${contextInfo} | Marker: ${markerFound ? colors.green("yes") : colors.yellow("no")}`,
        ),
      );

      // Check completion
      if (markerFound) {
        completed = true;
        state.status = "completed";
        saveState(state, stateFile);
        consola.log(
          colors.bold(colors.green(`\n✅ Task completed after ${iteration} iteration(s)`)),
        );
        logStream.write(`\n✅ Task completed after ${iteration} iteration(s)\n`);
      }
    }

    logStream.end();

    // Final status
    if (completed) {
      return;
    }

    if (!interrupted && iteration >= maxIterations) {
      state.status = "max_iterations_reached";
      saveState(state, stateFile);
      consola.log(
        colors.bold(
          colors.yellow(`\n⚠️  Max iterations (${maxIterations}) reached without completion`),
        ),
      );
      consola.log(colors.dim(`State saved to: ${stateFile}`));
      logStream.write(`\n⚠️  Max iterations (${maxIterations}) reached without completion\n`);
      this.exit(1);
    }
  }
}
