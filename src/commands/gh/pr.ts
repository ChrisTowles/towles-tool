import { defineCommand } from "citty";
import { x } from "tinyexec";
import consola from "consola";
import { colors } from "consola/utils";

import { debugArg } from "../shared.js";
import { isGithubCliInstalled } from "@towles/shared";

function generatePrContent(branch: string, commits: string[]): { title: string; body: string } {
  // Extract issue number from branch name if present (e.g., feature/123-some-feature)
  const issueMatch = branch.match(/(\d+)/);
  const issueNumber = issueMatch ? issueMatch[1] : null;

  // Generate title from first commit or branch name
  let title: string;
  if (commits.length === 1) {
    title = commits[0];
  } else {
    // Use branch name, cleaned up
    title = branch
      .replace(/^(feature|fix|bugfix|hotfix|chore|refactor)\//, "")
      .replace(/^\d+-/, "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // Generate body
  const lines: string[] = ["## Summary", ""];

  if (commits.length === 1) {
    lines.push(`- ${commits[0]}`);
  } else {
    for (const commit of commits.slice(0, 10)) {
      lines.push(`- ${commit}`);
    }
    if (commits.length > 10) {
      lines.push(`- ... and ${commits.length - 10} more commits`);
    }
  }

  lines.push("");

  if (issueNumber) {
    lines.push(`Closes #${issueNumber}`);
    lines.push("");
  }

  lines.push("## Test plan");
  lines.push("");
  lines.push("- [ ] Tests pass");
  lines.push("- [ ] Manual testing");

  return { title, body: lines.join("\n") };
}

export default defineCommand({
  meta: { name: "pr", description: "Create a pull request from the current branch" },
  args: {
    debug: debugArg,
    draft: {
      type: "boolean",
      alias: "D",
      description: "Create as draft PR",
      default: false,
    },
    base: {
      type: "string",
      alias: "b",
      description: "Base branch for the PR",
      default: "main",
    },
    yes: {
      type: "boolean",
      alias: "y",
      description: "Skip confirmation prompt",
      default: false,
    },
  },
  async run({ args }) {
    // Check prerequisites
    const cliInstalled = await isGithubCliInstalled();
    if (!cliInstalled) {
      consola.error("GitHub CLI not installed");
      process.exit(1);
    }

    // Get current branch
    const branchResult = await x("git", ["branch", "--show-current"]);
    const currentBranch = branchResult.stdout.trim();

    if (!currentBranch) {
      consola.error("Not on a branch (detached HEAD?)");
      process.exit(1);
    }

    if (currentBranch === args.base) {
      consola.error(`Already on base branch ${args.base}`);
      process.exit(1);
    }

    consola.info(`Current branch: ${colors.cyan(currentBranch)}`);
    consola.info(`Base branch: ${colors.cyan(args.base)}`);

    // Get commits between base and current branch
    const logResult = await x("git", ["log", `${args.base}..HEAD`, "--pretty=format:%s"]);

    const commits = logResult.stdout.trim().split("\n").filter(Boolean);

    if (commits.length === 0) {
      consola.error(`No commits between ${args.base} and ${currentBranch}`);
      process.exit(1);
    }

    consola.info(`Found ${colors.green(commits.length.toString())} commits`);

    // Generate PR title and body
    const { title, body } = generatePrContent(currentBranch, commits);

    consola.box({
      title: "PR Preview",
      message: `Title: ${title}\n\n${body}`,
    });

    // Confirm unless --yes
    if (!args.yes) {
      const confirmed = await consola.prompt("Create this PR?", {
        type: "confirm",
        initial: true,
      });

      if (!confirmed) {
        consola.info(colors.dim("Canceled"));
        process.exit(0);
      }
    }

    // Push branch if needed
    const statusResult = await x("git", ["status", "-sb"]);
    const needsPush = !statusResult.stdout.includes("origin/");

    if (needsPush) {
      consola.info("Pushing branch to remote...");
      await x("git", ["push", "-u", "origin", currentBranch]);
    }

    // Create PR
    const prArgs = ["pr", "create", "--title", title, "--body", body, "--base", args.base];

    if (args.draft) {
      prArgs.push("--draft");
    }

    const prResult = await x("gh", prArgs);
    const prUrl = prResult.stdout.trim();

    consola.success(`PR created: ${colors.cyan(prUrl)}`);
  },
});
