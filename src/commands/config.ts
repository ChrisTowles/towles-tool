import consola from "consola";
import { BaseCommand } from "./base.js";

/**
 * Display current configuration settings
 */
export default class Config extends BaseCommand {
  static override description = "Display current configuration settings";

  static override examples = [
    { description: "Display configuration", command: "<%= config.bin %> <%= command.id %>" },
    { description: "Use alias", command: "<%= config.bin %> cfg" },
  ];

  async run(): Promise<void> {
    await this.parse(Config);

    consola.info("Configuration");
    consola.log("");

    consola.info(`Settings File: ${this.settings.path}`);
    consola.log("");

    consola.warn("User Config:");
    consola.log(
      `  Daily Path Template: ${this.settings.settings.journalSettings.dailyPathTemplate}`,
    );
    consola.log(
      `  Meeting Path Template: ${this.settings.settings.journalSettings.meetingPathTemplate}`,
    );
    consola.log(`  Note Path Template: ${this.settings.settings.journalSettings.notePathTemplate}`);
    consola.log(`  Editor: ${this.settings.settings.preferredEditor}`);
    consola.log("");

    consola.warn("Working Directory:");
    consola.log(`  ${process.cwd()}`);
    consola.log("");

    consola.info("Shell Completions:");
    consola.log("  Run `tt completion` to generate shell completions");
    consola.log("  Bash/Zsh: tt completion >> ~/.bashrc (or ~/.zshrc)");
    consola.log("  Fish: tt completion > ~/.config/fish/completions/tt.fish");
  }
}
