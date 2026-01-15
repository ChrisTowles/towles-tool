import { Command, Flags } from "@oclif/core";
import { LoadedSettings, loadSettings } from "../config/settings.js";

/**
 * Base command that all towles-tool commands extend.
 * Provides shared functionality like settings loading and debug flag.
 */
export abstract class BaseCommand extends Command {
  static baseFlags = {
    debug: Flags.boolean({
      char: "d",
      description: "Enable debug output",
      default: false,
    }),
  };

  protected settings!: LoadedSettings;

  /**
   * Called before run(). Loads user settings.
   */
  async init(): Promise<void> {
    await super.init();
    this.settings = await loadSettings();
  }
}
