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
      description: "Generate a random session marker",
      command: "<%= config.bin %> ralph marker create",
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
