import { rmSync } from "node:fs";
import { join } from "node:path";

import consola from "consola";

import { getConfig } from "../config.js";
import { ARTIFACTS, STEP_LABELS, TEMPLATES } from "../prompt-templates/index.js";
import {
  buildTokens,
  execSafe,
  fileExists,
  git,
  log,
  logStep,
  resolveTemplate,
  runClaude,
} from "../utils.js";
import type { IssueContext } from "../utils.js";

export async function stepRefresh(ctx: IssueContext): Promise<boolean> {
  logStep(STEP_LABELS.refresh, ctx);
  const { mainBranch, remote } = getConfig();

  const branchList = await git(["branch", "--list", ctx.branch]);
  if (!branchList.includes(ctx.branch.split("/").pop()!)) {
    try {
      await git(["fetch", remote, ctx.branch]);
      await git(["checkout", ctx.branch]);
    } catch {
      log(`Branch ${ctx.branch} does not exist locally or remotely.`);
      return false;
    }
  }

  await git(["checkout", mainBranch]);
  await git(["pull", remote, mainBranch]);
  await git(["checkout", ctx.branch]);

  if (await isBranchUpToDate(mainBranch)) {
    log(`Branch is already up-to-date with ${mainBranch}.`);
  } else {
    await rebaseOrMerge(mainBranch);
  }

  const tokens = buildTokens(ctx);
  const promptFile = resolveTemplate(TEMPLATES.refresh, tokens, ctx.issueDir);
  const result = await runClaude({
    promptFile,
    permissionMode: "acceptEdits",
    maxTurns: getConfig().maxTurns,
  });

  if (result.is_error) {
    consola.error(`Refresh step failed: ${result.result}`);
    await git(["checkout", mainBranch]).catch(() => {});
    return false;
  }

  await invalidateStaleArtifacts(ctx);

  await git(["push", "--force-with-lease", "-u", remote, ctx.branch]);
  await git(["checkout", mainBranch]).catch(() => {});

  return true;
}

async function isBranchUpToDate(mainBranch: string): Promise<boolean> {
  try {
    await git(["merge-base", "--is-ancestor", mainBranch, "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

async function rebaseOrMerge(mainBranch: string): Promise<void> {
  try {
    await git(["rebase", mainBranch]);
  } catch {
    await git(["rebase", "--abort"]).catch(() => {});
    try {
      await git(["merge", mainBranch, "--no-edit"]);
    } catch {
      const conflicts = await execSafe("git", ["diff", "--name-only", "--diff-filter=U"]);
      if (conflicts.stdout.length > 0) {
        await git(["merge", "--abort"]);
        throw new Error(`Merge conflicts detected in: ${conflicts.stdout}`);
      }
      await git(["add", "."]);
      await git(["commit", "--no-edit"]);
    }
  }
}

async function invalidateStaleArtifacts(ctx: IssueContext): Promise<void> {
  const paths = [
    join(ctx.issueDir, ARTIFACTS.review),
    join(ctx.issueDir, ARTIFACTS.completedSummary),
  ];

  for (const p of paths) {
    if (fileExists(p)) {
      rmSync(p);
    }
  }
}
