import { rmSync } from "node:fs";
import { join } from "node:path";

import { defineCommand } from "citty";
import consola from "consola";
import { colors } from "consola/utils";
import prompts from "prompts";

import { debugArg } from "../shared.js";
import { initConfig } from "../../lib/auto-claude/index.js";
import { LABELS, removeLabel, setLabel } from "../../lib/auto-claude/labels.js";
import type { ExecSafeFn } from "../../lib/auto-claude/labels.js";
import { getIssues, isGithubCliInstalled } from "../../utils/git/gh-cli-wrapper.js";
import type { Issue } from "../../utils/git/gh-cli-wrapper.js";

/**
 * Core retry logic: swap labels on failed issues to re-trigger the pipeline.
 * Extracted for testability.
 */
export async function retryIssues(
  repo: string,
  triggerLabel: string,
  selected: Issue[],
  clean: boolean,
  exec?: ExecSafeFn,
): Promise<number> {
  for (const issue of selected) {
    consola.info(`Retrying issue #${issue.number}: ${issue.title}`);

    await removeLabel(repo, issue.number, LABELS.failed, exec);
    consola.success(`  Removed '${LABELS.failed}' label`);

    await setLabel(repo, issue.number, triggerLabel, exec);
    consola.success(`  Added '${triggerLabel}' label`);

    if (clean) {
      const artifactDir = join(process.cwd(), `.auto-claude/issue-${issue.number}`);
      try {
        rmSync(artifactDir, { recursive: true, force: true });
        consola.success(`  Cleaned artifacts: ${artifactDir}`);
      } catch {
        consola.warn(`  Could not clean artifacts: ${artifactDir}`);
      }
    }
  }

  return selected.length;
}

export default defineCommand({
  meta: { name: "retry", description: "Retry failed auto-claude issues by swapping labels" },
  args: {
    debug: debugArg,
    issue: {
      type: "string" as const,
      alias: "i",
      description: "Issue number to retry",
    },
    clean: {
      type: "boolean" as const,
      description: "Delete local .auto-claude/issue-{N}/ artifacts",
      default: false,
    },
  },
  async run({ args }) {
    const issueNumber = args.issue ? Number(args.issue) : undefined;

    const cfg = await initConfig();

    const cliInstalled = await isGithubCliInstalled();
    if (!cliInstalled) {
      consola.error("GitHub CLI (gh) is not installed");
      process.exit(1);
    }

    const failedIssues = await getIssues({ cwd: process.cwd(), label: LABELS.failed });

    let selected: Issue[];

    if (issueNumber) {
      const match = failedIssues.find((i) => i.number === issueNumber);
      if (!match) {
        consola.error(`Issue #${issueNumber} not found with '${LABELS.failed}' label`);
        process.exit(1);
      }
      selected = [match];
    } else {
      if (failedIssues.length === 0) {
        consola.info(`No open issues with '${LABELS.failed}' label`);
        return;
      }

      consola.info(colors.yellow(`${failedIssues.length} failed issue(s) found`));

      const choices = failedIssues.map((issue) => ({
        title: `#${issue.number} ${issue.title}`,
        value: issue.number,
      }));

      const result = await prompts(
        {
          name: "selected",
          message: "Select issues to retry:",
          type: "multiselect",
          choices,
          instructions: false,
          hint: "- Space to select, Enter to confirm",
        },
        {
          onCancel: () => {
            consola.info(colors.dim("Canceled"));
            process.exit(0);
          },
        },
      );

      if (!result.selected || result.selected.length === 0) {
        consola.info(colors.dim("No issues selected"));
        return;
      }

      selected = failedIssues.filter((i) => result.selected.includes(i.number));
    }

    const count = await retryIssues(cfg.repo, cfg.triggerLabel, selected, args.clean as boolean);
    consola.box(`Retried ${count} issue(s)`);
  },
});
