import { Command, Flags } from '@oclif/core'
import { LoadedSettings, loadSettings } from '../config/settings.js'

/**
 * Base command that all towles-tool commands extend.
 * Provides shared functionality like settings loading and debug flag.
 */
export abstract class BaseCommand extends Command {
  static baseFlags = {
    debug: Flags.boolean({
      char: 'd',
      description: 'Enable debug output',
      default: false,
    }),
  }

  protected settings!: LoadedSettings

  /**
   * Called before run(). Loads user settings.
   */
  async init(): Promise<void> {
    await super.init()
    this.settings = await loadSettings()
  }

  /**
   * Helper to log debug messages when --debug flag is set.
   */
  protected logDebug(message: string, ...args: unknown[]): void {
    // Access flags via parse() - oclif guarantees flags exist after init()
    void (this.parse as () => Promise<{ flags: { debug?: boolean } }>)()
      .then(parsed => {
        if (parsed.flags?.debug) {
          this.log(`[DEBUG] ${message}`, ...args)
        }
      })
      .catch(() => { /* ignore parse errors in debug logging */ })
  }
}
