import { Flags } from "@oclif/core";
import { colors } from "consola/utils";
import consola from "consola";
import { x } from "tinyexec";

import { BaseCommand } from "../base.js";

/**
 * Clean up merged branches
 */
export default class BranchClean extends BaseCommand {
  static override description = "Delete local branches that have been merged into main";

  static override examples = [
    { description: "Clean merged branches", command: "<%= config.bin %> gh branch-clean" },
    {
      description: "Preview without deleting",
      command: "<%= config.bin %> gh branch-clean --dry-run",
    },
    { description: "Skip confirmation", command: "<%= config.bin %> gh branch-clean --force" },
    {
      description: "Check against develop",
      command: "<%= config.bin %> gh branch-clean --base develop",
    },
  ];

  static override flags = {
    ...BaseCommand.baseFlags,
    force: Flags.boolean({
      char: "f",
      description: "Skip confirmation prompt",
      default: false,
    }),
    "dry-run": Flags.boolean({
      char: "d",
      description: "Preview branches without deleting",
      default: false,
    }),
    base: Flags.string({
      char: "b",
      description: "Base branch to check against",
      default: "main",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(BranchClean);
    const baseBranch = flags.base;
    const dryRun = flags["dry-run"];

    // Get current branch
    const currentResult = await x("git", ["branch", "--show-current"]);
    const currentBranch = currentResult.stdout.trim();

    // Get merged branches
    const mergedResult = await x("git", ["branch", "--merged", baseBranch]);
    const allMerged = mergedResult.stdout
      .split("\n")
      .map((b) => b.trim().replace(/^\* /, ""))
      .filter((b) => b.length > 0);

    // Exclude protected branches
    const protectedBranches = ["main", "master", "develop", "dev", baseBranch, currentBranch];
    const toDelete = allMerged.filter((b) => !protectedBranches.includes(b));

    if (toDelete.length === 0) {
      consola.info(colors.green("No merged branches to clean up"));
      return;
    }

    consola.log(colors.cyan(`Found ${toDelete.length} merged branch(es):`));
    for (const branch of toDelete) {
      consola.log(`  - ${branch}`);
    }

    if (dryRun) {
      consola.info(colors.yellow("Dry run - no branches deleted"));
      return;
    }

    if (!flags.force) {
      const answer = await consola.prompt(`Delete ${toDelete.length} branch(es)?`, {
        type: "confirm",
        initial: false,
      });

      if (!answer) {
        consola.info(colors.dim("Canceled"));
        return;
      }
    }

    // Delete branches
    let deleted = 0;
    let failed = 0;

    for (const branch of toDelete) {
      try {
        await x("git", ["branch", "-d", branch]);
        consola.log(colors.green(`✓ Deleted ${branch}`));
        deleted++;
      } catch {
        consola.log(colors.red(`✗ Failed to delete ${branch}`));
        failed++;
      }
    }

    consola.log("");
    if (deleted > 0) {
      consola.info(colors.green(`Deleted ${deleted} branch(es)`));
    }
    if (failed > 0) {
      consola.warn(colors.yellow(`Failed to delete ${failed} branch(es)`));
    }
  }
}
