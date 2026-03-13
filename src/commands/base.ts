import { Command, Flags } from "@oclif/core";
import type { SettingsFile } from "../config/settings.js";
import { loadSettings } from "../config/settings.js";

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

  protected settingsFile!: SettingsFile;

  /** Shortcut to avoid `this.settingsFile.settings.X` stutter */
  protected get userSettings() {
    return this.settingsFile.settings;
  }

  /**
   * Called before run(). Loads user settings.
   */
  async init(): Promise<void> {
    await super.init();
    this.settingsFile = await loadSettings();
  }
}
