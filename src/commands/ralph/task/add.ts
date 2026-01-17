import { Args, Flags } from "@oclif/core";
import consola from "consola";
import { colors } from "consola/utils";
import { BaseCommand } from "../../base.js";
import {
  DEFAULT_STATE_FILE,
  DEFAULT_MAX_ITERATIONS,
  loadState,
  saveState,
  createInitialState,
  addTaskToState,
  resolveRalphPath,
} from "../../../lib/ralph/state.js";
import { findSessionByMarker } from "../../../lib/ralph/marker.js";

/**
 * Add a new task to ralph state
 */
export default class TaskAdd extends BaseCommand {
  static override description = "Add a new task";

  static override examples = [
    {
      description: "Add a simple task",
      command: '<%= config.bin %> <%= command.id %> "Fix the login bug"',
    },
    {
      description: "Add task with session for resumption",
      command: '<%= config.bin %> <%= command.id %> "Implement feature X" --sessionId abc123',
    },
    {
      description: "Add task by finding session via marker",
      command:
        '<%= config.bin %> <%= command.id %> "Implement feature X" --findMarker RALPH_MARKER_abc123',
    },
    {
      description: "Add task with label for filtering",
      command: '<%= config.bin %> <%= command.id %> "Backend refactor" --label backend',
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
    sessionId: Flags.string({
      description: "Claude session ID for resuming from prior research",
    }),
    findMarker: Flags.string({
      char: "m",
      description: "Find session by full marker (e.g., RALPH_MARKER_abc123)",
    }),
    label: Flags.string({
      char: "l",
      description: "Label for grouping/filtering tasks",
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(TaskAdd);
    const ralphSettings = this.settings.settings.ralphSettings;
    const stateFile = resolveRalphPath(flags.stateFile, "stateFile", ralphSettings);

    const description = args.description.trim();

    if (!description || description.length < 3) {
      this.error("Task description too short (min 3 chars)");
    }

    // Resolve session ID from --sessionId or --findMarker
    let sessionId = flags.sessionId;
    let marker: string | undefined;
    if (flags.findMarker) {
      if (sessionId) {
        this.error("Cannot use both --sessionId and --findMarker");
      }
      marker = flags.findMarker;
      consola.log(colors.dim(`Searching for marker: ${marker}...`));
      sessionId = (await findSessionByMarker(marker)) ?? undefined;
      if (!sessionId) {
        this.error(
          `Marker not found: ${marker}\nMake sure Claude output this marker during research.`,
        );
      }
      consola.log(colors.cyan(`Found session: ${sessionId.slice(0, 8)}...`));
    }

    let state = loadState(stateFile);

    if (!state) {
      state = createInitialState(DEFAULT_MAX_ITERATIONS);
    }

    const newTask = addTaskToState(state, description, sessionId, marker, flags.label);
    saveState(state, stateFile);

    consola.log(colors.green(`✓ Added task #${newTask.id}: ${newTask.description}`));
    if (flags.label) {
      consola.log(colors.cyan(`  Label: ${flags.label}`));
    }
    if (sessionId) {
      consola.log(colors.cyan(`  Session: ${sessionId.slice(0, 8)}...`));
    }
    if (marker) {
      consola.log(colors.dim(`  Marker: ${marker}`));
    }
    consola.log(colors.dim(`State saved to: ${stateFile}`));
    consola.log(colors.dim(`Total tasks: ${state.tasks.length}`));
  }
}
