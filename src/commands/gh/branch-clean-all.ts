import { Args, Flags } from "@oclif/core";
import { colors } from "consola/utils";
import consola from "consola";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { BaseCommand } from "../base.js";
import { isGithubCliInstalled, getMergedPrForBranch } from "../../utils/git/gh-cli-wrapper.js";
import type { MergedPrInfo } from "../../utils/git/gh-cli-wrapper.js";
import {
  getLocalBranches,
  getCurrentBranch,
  getMergedBranches,
  getGoneBranches,
  deleteBranch,
} from "../../utils/git/git-wrapper.js";

interface StaleBranch {
  name: string;
  method: "github-pr" | "git-merged" | "gone-upstream";
  pr?: MergedPrInfo;
}

interface RepoResult {
  path: string;
  name: string;
  staleBranches: StaleBranch[];
  error?: string;
}

const PROTECTED_BRANCHES = new Set(["main", "master", "develop", "dev"]);

export function isProtectedBranch(
  branch: string,
  baseBranch: string,
  currentBranch: string,
): boolean {
  return PROTECTED_BRANCHES.has(branch) || branch === baseBranch || branch === currentBranch;
}

export function discoverGitRepos(folder: string): string[] {
  const entries = readdirSync(folder);
  const repos: string[] = [];
  for (const entry of entries) {
    const fullPath = join(folder, entry);
    try {
      if (statSync(fullPath).isDirectory() && existsSync(join(fullPath, ".git"))) {
        repos.push(fullPath);
      }
    } catch {
      // skip entries we can't stat
    }
  }
  return repos.sort();
}

function methodLabel(method: StaleBranch["method"]): string {
  switch (method) {
    case "github-pr":
      return colors.green("PR merged");
    case "git-merged":
      return colors.cyan("git merged");
    case "gone-upstream":
      return colors.yellow("upstream gone");
  }
}

export default class BranchCleanAll extends BaseCommand {
  static override description =
    "Scan repos in a folder and find branches with merged PRs, merged commits, or deleted upstreams";

  static override examples = [
    {
      description: "Scan repos in ~/code/p",
      command: "<%= config.bin %> <%= command.id %> ~/code/p",
    },
    {
      description: "Dry run only",
      command: "<%= config.bin %> <%= command.id %> ~/code/p --dry-run",
    },
    {
      description: "Skip confirmation",
      command: "<%= config.bin %> <%= command.id %> ~/code/p --force",
    },
    {
      description: "Check against develop",
      command: "<%= config.bin %> <%= command.id %> ~/code/p --base develop",
    },
  ];

  static override args = {
    folder: Args.string({
      description: "Path to the folder containing git repos",
      required: true,
    }),
  };

  static override flags = {
    ...BaseCommand.baseFlags,
    force: Flags.boolean({
      char: "f",
      description: "Skip confirmation prompt",
      default: false,
    }),
    "dry-run": Flags.boolean({
      char: "n",
      description: "List stale branches without deleting",
      default: false,
    }),
    base: Flags.string({
      char: "b",
      description: "Base branch to check against",
      default: "main",
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BranchCleanAll);
    const folder = resolve(args.folder);
    const baseBranch = flags.base;
    const dryRun = flags["dry-run"];

    // Validate folder
    if (!existsSync(folder) || !statSync(folder).isDirectory()) {
      consola.error(`Folder not found: ${folder}`);
      this.exit(1);
    }

    // Check gh CLI
    const ghInstalled = await isGithubCliInstalled();
    if (!ghInstalled) {
      consola.error("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/");
      this.exit(1);
    }

    // Discover repos
    const repoPaths = discoverGitRepos(folder);
    if (repoPaths.length === 0) {
      consola.info(colors.yellow("No git repos found in " + folder));
      return;
    }

    consola.log(colors.cyan(`Found ${repoPaths.length} git repo(s) in ${folder}`));
    consola.log("");

    // Gather branch info for each repo in parallel
    const results = await Promise.allSettled(
      repoPaths.map((repoPath) => this.analyzeRepo(repoPath, baseBranch)),
    );

    const repoResults: RepoResult[] = [];
    for (const [i, result] of results.entries()) {
      if (result.status === "fulfilled") {
        repoResults.push(result.value);
      } else {
        const name = repoPaths[i].split("/").pop()!;
        repoResults.push({
          path: repoPaths[i],
          name,
          staleBranches: [],
          error: String(result.reason),
        });
      }
    }

    // Display results
    let totalStale = 0;
    const reposWithStale: RepoResult[] = [];

    for (const repo of repoResults) {
      if (repo.error) {
        consola.warn(`${colors.yellow(repo.name)}: ${colors.dim(repo.error)}`);
        continue;
      }

      if (repo.staleBranches.length === 0) {
        continue;
      }

      totalStale += repo.staleBranches.length;
      reposWithStale.push(repo);

      const lines = repo.staleBranches.map((b) => {
        const prInfo = b.pr ? colors.dim(` (PR #${b.pr.number}: ${b.pr.title})`) : "";
        return `  ${colors.red(b.name)} ${methodLabel(b.method)}${prInfo}`;
      });

      consola.box({
        title: `${repo.name} — ${repo.staleBranches.length} stale branch(es)`,
        message: lines.join("\n"),
      });
    }

    if (totalStale === 0) {
      consola.info(colors.green("No stale branches found across all repos"));
      return;
    }

    consola.log(
      colors.cyan(`Total: ${totalStale} stale branch(es) across ${reposWithStale.length} repo(s)`),
    );

    if (dryRun) {
      consola.info(colors.yellow("Dry run — no branches deleted"));
      return;
    }

    // Confirmation
    if (!flags.force) {
      const answer = await consola.prompt(
        `Delete ${totalStale} stale branch(es) across ${reposWithStale.length} repo(s)?`,
        { type: "confirm", initial: false },
      );

      if (!answer) {
        consola.info(colors.dim("Canceled"));
        return;
      }
    }

    // Delete
    let deleted = 0;
    let failed = 0;

    for (const repo of reposWithStale) {
      consola.log(colors.cyan(`\n${repo.name}:`));
      for (const branch of repo.staleBranches) {
        try {
          await deleteBranch(repo.path, branch.name, true);
          consola.log(colors.green(`  ✓ Deleted ${branch.name}`));
          deleted++;
        } catch {
          consola.log(colors.red(`  ✗ Failed to delete ${branch.name}`));
          failed++;
        }
      }
    }

    // Summary
    consola.log("");
    if (deleted > 0) {
      consola.success(colors.green(`Deleted ${deleted} branch(es)`));
    }
    if (failed > 0) {
      consola.warn(colors.yellow(`Failed to delete ${failed} branch(es)`));
    }
    const skipped = repoResults.filter((r) => r.error).length;
    if (skipped > 0) {
      consola.warn(colors.yellow(`Skipped ${skipped} repo(s) due to errors`));
    }
  }

  private async analyzeRepo(repoPath: string, baseBranch: string): Promise<RepoResult> {
    const name = repoPath.split("/").pop()!;

    const [currentBranch, localBranches, mergedBranches, goneBranches] = await Promise.all([
      getCurrentBranch(repoPath),
      getLocalBranches(repoPath),
      getMergedBranches(repoPath, baseBranch).catch(() => [] as string[]),
      getGoneBranches(repoPath).catch(() => [] as string[]),
    ]);

    const candidates = localBranches.filter(
      (b) => !isProtectedBranch(b, baseBranch, currentBranch),
    );

    const mergedSet = new Set(mergedBranches);
    const goneSet = new Set(goneBranches);

    const staleBranches: StaleBranch[] = [];
    const seen = new Set<string>();

    // Check GitHub API for merged PRs (in parallel)
    const prResults = await Promise.allSettled(
      candidates.map((branch) => getMergedPrForBranch({ branch, cwd: repoPath })),
    );

    for (const [i, result] of prResults.entries()) {
      const branch = candidates[i];
      if (result.status === "fulfilled" && result.value) {
        staleBranches.push({ name: branch, method: "github-pr", pr: result.value });
        seen.add(branch);
      }
    }

    // Check git merged
    for (const branch of candidates) {
      if (!seen.has(branch) && mergedSet.has(branch)) {
        staleBranches.push({ name: branch, method: "git-merged" });
        seen.add(branch);
      }
    }

    // Check gone upstream
    for (const branch of candidates) {
      if (!seen.has(branch) && goneSet.has(branch)) {
        staleBranches.push({ name: branch, method: "gone-upstream" });
        seen.add(branch);
      }
    }

    return { path: repoPath, name, staleBranches };
  }
}
