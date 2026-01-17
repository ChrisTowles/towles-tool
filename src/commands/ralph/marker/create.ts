import consola from "consola";
import { BaseCommand } from "../../base.js";
import { generateMarker, MARKER_PREFIX } from "../../../lib/ralph/marker.js";

/**
 * Generate a random marker for session tracking.
 * Output this marker during research, then use --findMarker when adding tasks.
 */
export default class MarkerCreate extends BaseCommand {
  static override description = "Generate a random marker for session tracking";

  static override examples = [
    {
      description:
        "Generate a random session marker, to later use with --findMarker when adding tasks",
      command: "<%= config.bin %> <%= command.id %>",
    },
    {
      description: "Typical workflow: generate marker then add task with it",
      command:
        '<%= config.bin %> ralph marker create && tt ralph task add "implement feature" --findMarker RALPH_MARKER_xxx',
    },
  ];

  static override flags = {
    ...BaseCommand.baseFlags,
  };

  async run(): Promise<void> {
    await this.parse(MarkerCreate);

    const marker = generateMarker();
    consola.log(`${MARKER_PREFIX}${marker}`);
  }
}
