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
  readPlanContent,
} from "../../lib/ralph/state.js";
import {
  buildIterationPrompt,
  formatDuration,
  extractOutputSummary,
  detectCompletionMarker,
} from "../../lib/ralph/formatter.js";
import { checkClaudeCli, runIteration } from "../../lib/ralph/execution.js";
import type { RalphPlan } from "../../lib/ralph/state.js";

/** Get the plan to work on: focused plan or first incomplete */
function getCurrentPlan(plans: RalphPlan[], focusedPlanId: number | null): RalphPlan | undefined {
  if (focusedPlanId !== null) {
    return plans.find((p) => p.id === focusedPlanId);
  }
  return plans.find((p) => p.status !== "done");
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
      description: "Focus on specific plan",
      command: "<%= config.bin %> <%= command.id %> --planId 5",
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
    planId: Flags.integer({
      char: "p",
      description: "Focus on specific plan ID",
    }),
    maxIterations: Flags.integer({
      char: "m",
      description: "Max iterations",
      default: DEFAULT_MAX_ITERATIONS,
    }),
    autoCommit: Flags.boolean({
      description: "Auto-commit after each completed plan",
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
    const focusedPlanId = flags.planId ?? null;

    // Load existing state
    let state = loadState(stateFile);

    if (!state) {
      this.error(`No state file found at: ${stateFile}\nUse: tt ralph plan add --file path.md`);
    }

    const remainingPlans = state.plans.filter((t) => t.status !== "done");
    if (remainingPlans.length === 0) {
      consola.log(colors.green("✅ All plans are done!"));
      return;
    }

    // Validate focused plan if specified
    if (focusedPlanId !== null) {
      const focusedPlan = state.plans.find((t) => t.id === focusedPlanId);
      if (!focusedPlan) {
        this.error(`Plan #${focusedPlanId} not found. Use: tt ralph plan list`);
      }
      if (focusedPlan.status === "done") {
        consola.log(colors.yellow(`Plan #${focusedPlanId} is already done.`));
        return;
      }
    }

    // Get current plan to work on
    const currentPlan = getCurrentPlan(state.plans, focusedPlanId);
    if (!currentPlan) {
      consola.log(colors.green("✅ All plans are done!"));
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
      consola.log(`  Remaining plans: ${remainingPlans.length}`);

      consola.log(colors.cyan("\nCurrent plan:"));
      consola.log(`  #${currentPlan.id}: ${currentPlan.planFilePath}`);

      // Read plan content
      const planContent = readPlanContent(currentPlan, state, stateFile);
      if (!planContent) {
        this.error(`Cannot read plan file: ${currentPlan.planFilePath}`);
      }

      // Show prompt preview
      const prompt = buildIterationPrompt({
        completionMarker: flags.completionMarker,
        plan: currentPlan,
        planContent,
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
    consola.log(colors.dim(`Focus: ${focusedPlanId ? `Plan #${focusedPlanId}` : "Ralph picks"}`));
    consola.log(colors.dim(`Max iterations: ${maxIterations}`));
    consola.log(colors.dim(`Log file: ${logFile}`));
    consola.log(colors.dim(`Auto-commit: ${flags.autoCommit}`));
    consola.log(colors.dim(`Tasks: ${state.plans.length} (${done} done, ${ready} ready)`));
    consola.log("");

    logStream.write(`Focus: ${focusedPlanId ? `Plan #${focusedPlanId}` : "Ralph picks"}\n`);
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
      // Get current plan for this iteration
      const plan = getCurrentPlan(state.plans, focusedPlanId);
      if (!plan) {
        completed = true;
        state.status = "completed";
        saveState(state, stateFile);
        consola.log(
          colors.bold(colors.green(`\n✅ All plans completed after ${iteration} iteration(s)`)),
        );
        logStream.write(`\n✅ All plans completed after ${iteration} iteration(s)\n`);
        break;
      }

      // Read plan content
      const planContent = readPlanContent(plan, state, stateFile);
      if (!planContent) {
        consola.log(colors.yellow(`⚠ Skipping plan #${plan.id}: cannot read file`));
        logStream.write(`⚠ Skipping plan #${plan.id}: cannot read file\n`);
        continue;
      }

      const prompt = buildIterationPrompt({
        completionMarker: flags.completionMarker,
        plan: plan,
        planContent,
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
          colors.bold(colors.green(`\n✅ Plan completed after ${iteration} iteration(s)`)),
        );
        logStream.write(`\n✅ Plan completed after ${iteration} iteration(s)\n`);
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
