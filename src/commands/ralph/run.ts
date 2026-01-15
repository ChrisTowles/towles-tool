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
  formatTasksForPrompt,
} from "../../lib/ralph/formatter.js";
import { checkClaudeCli, runIteration } from "../../lib/ralph/execution.js";

/**
 * Read last N iterations from progress file. Only returns iteration entries,
 * excluding headers/status sections that could confuse the model.
 */
function readLastIterations(filePath: string, count: number): string {
  if (!fs.existsSync(filePath)) return "";
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    // Split by iteration headers, keeping the delimiter
    const parts = content.split(/(?=### Iteration)/g);
    // Skip first part (header/status content) - only want iteration entries
    const iterations = parts.filter((p) => p.startsWith("### Iteration"));
    if (iterations.length === 0) return "";
    return iterations.slice(-count).join("\n").trim();
  } catch {
    return "";
  }
}

/**
 * Run the autonomous ralph loop
 */
export default class Run extends BaseCommand {
  static override aliases = ["run"];
  static override description = "Start the autonomous ralph loop";

  static override examples = [
    "<%= config.bin %> ralph run",
    "<%= config.bin %> ralph run --maxIterations 20",
    "<%= config.bin %> ralph run --taskId 5",
    "<%= config.bin %> ralph run --no-autoCommit",
    "<%= config.bin %> ralph run --noFork",
    "<%= config.bin %> ralph run --dryRun",
    "<%= config.bin %> ralph run --addIterations 5",
    "<%= config.bin %> ralph run --label backend",
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
    addIterations: Flags.integer({
      char: "a",
      description:
        "Add iterations to current count (e.g., at 5/10, --addIterations 10 makes it 5/20)",
    }),
    autoCommit: Flags.boolean({
      description: "Auto-commit after each completed task",
      default: true,
      allowNo: true,
    }),
    noFork: Flags.boolean({
      description: "Disable session forking (start fresh session)",
      default: false,
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
    label: Flags.string({
      char: "l",
      description: "Only run tasks with this label",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Run);
    const ralphSettings = this.settings.settings.ralphSettings;
    const stateFile = resolveRalphPath(flags.stateFile, "stateFile", ralphSettings);
    const logFile = resolveRalphPath(flags.logFile, "logFile", ralphSettings);
    const ralphPaths = getRalphPaths(ralphSettings);

    let maxIterations = flags.maxIterations;
    const addIterations = flags.addIterations;
    const extraClaudeArgs = flags.claudeArgs?.split(" ").filter(Boolean) || [];
    const focusedTaskId = flags.taskId ?? null;

    // Load existing state
    let state = loadState(stateFile);

    if (!state) {
      this.error(`No state file found at: ${stateFile}\nUse: tt ralph task add "description"`);
    }

    // Handle --addIterations: extend max from current iteration
    if (addIterations !== undefined) {
      maxIterations = state.iteration + addIterations;
      consola.log(
        colors.cyan(
          `Adding ${addIterations} iterations: ${state.iteration}/${state.maxIterations} → ${state.iteration}/${maxIterations}`,
        ),
      );
    }

    // Filter by label if specified
    const labelFilter = flags.label;
    let remainingTasks = state.tasks.filter((t) => t.status !== "done");
    if (labelFilter) {
      remainingTasks = remainingTasks.filter((t) => t.label === labelFilter);
    }
    if (remainingTasks.length === 0) {
      const msg = labelFilter
        ? `All tasks with label '${labelFilter}' are done!`
        : "All tasks are done!";
      consola.log(colors.green(`✅ ${msg}`));
      return;
    }

    // Validate focused task if specified
    if (focusedTaskId !== null) {
      const focusedTask = state.tasks.find((t) => t.id === focusedTaskId);
      if (!focusedTask) {
        this.error(`Task #${focusedTaskId} not found. Use: tt ralph task list`);
      }
      if (focusedTask.status === "done") {
        consola.log(colors.yellow(`Task #${focusedTaskId} is already done.`));
        return;
      }
    }

    // Dry run mode
    if (flags.dryRun) {
      consola.log(colors.bold("\n=== DRY RUN ===\n"));
      consola.log(colors.cyan("Config:"));
      consola.log(`  Focus: ${focusedTaskId ? `Task #${focusedTaskId}` : "Ralph picks"}`);
      consola.log(`  Label filter: ${labelFilter || "(none)"}`);
      consola.log(`  Max iterations: ${maxIterations}`);
      consola.log(`  State file: ${stateFile}`);
      consola.log(`  Log file: ${logFile}`);
      consola.log(`  Completion marker: ${flags.completionMarker}`);
      consola.log(`  Auto-commit: ${flags.autoCommit}`);
      consola.log(`  Fork session: ${!flags.noFork}`);
      consola.log(`  Session ID: ${state.sessionId || "(none)"}`);
      consola.log(`  Claude args: ${[...CLAUDE_DEFAULT_ARGS, ...extraClaudeArgs].join(" ")}`);
      consola.log(`  Remaining tasks: ${remainingTasks.length}`);

      consola.log(colors.cyan("\nTasks:"));
      for (const t of state.tasks) {
        const icon = t.status === "done" ? "✓" : "○";
        const focus = focusedTaskId === t.id ? colors.cyan(" ← FOCUS") : "";
        consola.log(`  ${icon} ${t.id}. ${t.description} (${t.status})${focus}`);
      }

      // Show prompt preview
      const progressContent = readLastIterations(ralphPaths.progressFile, 3);
      const taskList = formatTasksForPrompt(remainingTasks);
      const prompt = buildIterationPrompt({
        completionMarker: flags.completionMarker,
        progressFile: ralphPaths.progressFile,
        focusedTaskId,
        skipCommit: !flags.autoCommit,
        progressContent: progressContent || undefined,
        taskList,
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
    state.maxIterations = maxIterations;
    state.status = "running";

    // Create log stream (append mode)
    const logStream = fs.createWriteStream(logFile, { flags: "a" });

    const ready = state.tasks.filter((t) => t.status === "ready").length;
    const done = state.tasks.filter((t) => t.status === "done").length;

    logStream.write(`\n${"=".repeat(60)}\n`);
    logStream.write(`Ralph Loop Started: ${new Date().toISOString()}\n`);
    logStream.write(`${"=".repeat(60)}\n\n`);

    consola.log(colors.bold(colors.blue("\nRalph Loop Starting\n")));
    consola.log(colors.dim(`Focus: ${focusedTaskId ? `Task #${focusedTaskId}` : "Ralph picks"}`));
    if (labelFilter) {
      consola.log(colors.dim(`Label filter: ${labelFilter}`));
    }
    consola.log(colors.dim(`Max iterations: ${maxIterations}`));
    consola.log(colors.dim(`Log file: ${logFile}`));
    consola.log(colors.dim(`Auto-commit: ${flags.autoCommit}`));
    consola.log(
      colors.dim(
        `Fork session: ${!flags.noFork}${state.sessionId ? ` (session: ${state.sessionId.slice(0, 8)}...)` : ""}`,
      ),
    );
    consola.log(colors.dim(`Tasks: ${state.tasks.length} (${done} done, ${ready} ready)`));
    consola.log("");

    logStream.write(`Focus: ${focusedTaskId ? `Task #${focusedTaskId}` : "Ralph picks"}\n`);
    logStream.write(`Max iterations: ${maxIterations}\n`);
    logStream.write(`Tasks: ${state.tasks.length} (${done} done, ${ready} ready)\n\n`);

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

    while (state.iteration < maxIterations && !interrupted && !completed) {
      state.iteration++;
      const currentIteration = state.iteration;

      const iterHeader = `Iteration ${currentIteration}/${maxIterations}`;
      logStream.write(`\n━━━ ${iterHeader} ━━━\n`);

      const iterationStart = new Date().toISOString();
      const progressContent = readLastIterations(ralphPaths.progressFile, 3);
      // Reload remaining tasks for current state
      const currentRemainingTasks = state.tasks.filter((t) => t.status !== "done");
      const taskList = formatTasksForPrompt(
        labelFilter
          ? currentRemainingTasks.filter((t) => t.label === labelFilter)
          : currentRemainingTasks,
      );
      const prompt = buildIterationPrompt({
        completionMarker: flags.completionMarker,
        progressFile: ralphPaths.progressFile,
        focusedTaskId,
        skipCommit: !flags.autoCommit,
        progressContent: progressContent || undefined,
        taskList,
      });

      // Log the prompt
      logStream.write(`\n--- Prompt ---\n${prompt}\n--- End Prompt ---\n\n`);

      // Build claude args
      const iterClaudeArgs = [...extraClaudeArgs];
      const currentTask = focusedTaskId
        ? state.tasks.find((t) => t.id === focusedTaskId)
        : state.tasks.find((t) => t.status === "ready");

      // Fork from task's sessionId (or state-level fallback) unless disabled
      const taskSessionId = currentTask?.sessionId || state.sessionId;
      if (!flags.noFork && taskSessionId) {
        iterClaudeArgs.push("--fork-session", taskSessionId);
      }

      // Print iteration header
      const sessionInfo = taskSessionId
        ? colors.dim(` (fork: ${taskSessionId.slice(0, 8)}...)`)
        : "";
      consola.log("");
      consola.log(colors.bold(colors.blue(`━━━ ${iterHeader}${sessionInfo} ━━━`)));
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
        const currentIter = state.iteration;
        Object.assign(state, freshState, { iteration: currentIter });
      }

      // Store session ID on the current task for future resumption
      const taskToUpdate = currentTask
        ? state.tasks.find((t) => t.id === currentTask.id)
        : undefined;
      if (iterResult.sessionId && taskToUpdate && !taskToUpdate.sessionId) {
        taskToUpdate.sessionId = iterResult.sessionId;
        state.sessionId = iterResult.sessionId;
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
          iteration: state.iteration,
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
        `\n━━━ Iteration ${state.iteration} Summary ━━━\nDuration: ${durationHuman}${contextInfo}\nMarker found: ${markerFound ? "yes" : "no"}\n`,
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
          colors.bold(colors.green(`\n✅ Task completed after ${state.iteration} iteration(s)`)),
        );
        logStream.write(`\n✅ Task completed after ${state.iteration} iteration(s)\n`);
      }
    }

    logStream.end();

    // Final status
    if (completed) {
      return;
    }

    if (!interrupted && state.iteration >= maxIterations) {
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
