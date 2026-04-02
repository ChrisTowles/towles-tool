import { defineCommand } from "citty";
import { colors } from "consola/utils";
import consola from "consola";
import { run } from "@towles/shared";

import { debugArg } from "../shared.js";

export default defineCommand({
  meta: {
    name: "branch-clean",
    description: "Delete local branches that have been merged into main",
  },
  args: {
    debug: debugArg,
    force: {
      type: "boolean",
      alias: "f",
      description: "Skip confirmation prompt",
      default: false,
    },
    dryRun: {
      type: "boolean",
      description: "Preview branches without deleting",
      default: false,
    },
    base: {
      type: "string",
      alias: "b",
      description: "Base branch to check against",
      default: "main",
    },
  },
  async run({ args }) {
    const baseBranch = args.base;

    // Get current branch
    const currentResult = await run("git", ["branch", "--show-current"]);
    const currentBranch = currentResult.stdout.trim();

    // Get merged branches
    const mergedResult = await run("git", ["branch", "--merged", baseBranch]);
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

    if (args.dryRun) {
      consola.info(colors.yellow("Dry run - no branches deleted"));
      return;
    }

    if (!args.force) {
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
        await run("git", ["branch", "-d", branch]);
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
  },
});
