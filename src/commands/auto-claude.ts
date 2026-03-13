import { rmSync } from "node:fs";
import { join } from "node:path";

import { Flags } from "@oclif/core";
import consola from "consola";

import { BaseCommand } from "./base.js";
import {
  STEP_NAMES,
  buildIssueContext,
  fetchIssue,
  fetchIssues,
  getConfig,
  git,
  initConfig,
  log,
  logBanner,
  runPipeline,
  sleep,
  stepRefresh,
} from "../lib/auto-claude/index.js";
import type { IssueContext, StepName } from "../lib/auto-claude/index.js";

export default class AutoClaude extends BaseCommand {
  static override aliases = ["ac"];

  static override description = "Automated issue-to-PR pipeline using Claude Code";

  static override examples = [
    {
      description: "Process a specific issue",
      command: "<%= config.bin %> auto-claude --issue 42",
    },
    {
      description: "Run until plan step",
      command: "<%= config.bin %> auto-claude --issue 42 --until plan",
    },
    {
      description: "Reset local state for an issue",
      command: "<%= config.bin %> auto-claude --reset 42",
    },
    {
      description: "Refresh a stale PR branch",
      command: "<%= config.bin %> auto-claude --refresh --issue 42",
    },
    {
      description: "Loop mode: poll for labeled issues",
      command: "<%= config.bin %> auto-claude --loop",
    },
    {
      description: "Loop with custom interval",
      command: "<%= config.bin %> auto-claude --loop --interval 45",
    },
  ];

  static override flags = {
    ...BaseCommand.baseFlags,
    issue: Flags.integer({
      char: "i",
      description: "Process a specific issue number",
    }),
    until: Flags.string({
      char: "u",
      description: `Stop after this step (${STEP_NAMES.join(", ")})`,
      options: [...STEP_NAMES],
    }),
    reset: Flags.integer({
      description: "Delete local state for an issue (force restart)",
    }),
    refresh: Flags.boolean({
      description: "Rebase a stale PR branch onto current main",
      default: false,
    }),
    loop: Flags.boolean({
      description: "Poll for labeled issues continuously",
      default: false,
    }),
    interval: Flags.integer({
      description: "Poll interval in minutes (default: 30)",
    }),
    limit: Flags.integer({
      description: "Max issues per iteration (default: 1)",
      default: 1,
    }),
    label: Flags.string({
      description: "Trigger label (default: auto-claude)",
    }),
    "main-branch": Flags.string({
      description: "Override main branch detection",
    }),
    "scope-path": Flags.string({
      description: "Path within repo to scope work (default: .)",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(AutoClaude);

    const cfg = await initConfig({
      triggerLabel: flags.label,
      mainBranch: flags["main-branch"],
      scopePath: flags["scope-path"],
      loopRetryEnabled: flags.loop || undefined,
    });

    if (flags.reset) {
      const issueDir = join(process.cwd(), `.auto-claude/issue-${flags.reset}`);
      log(`Resetting state for issue-${flags.reset}...`);
      rmSync(issueDir, { recursive: true, force: true });
      log(`Cleaned ${issueDir}`);
      return;
    }

    if (flags.refresh) {
      if (!flags.issue) {
        this.error("--refresh requires --issue <number>");
      }
      const ctx = buildIssueContext(
        { number: flags.issue, title: `Issue #${flags.issue}`, body: "" },
        cfg.repo,
        cfg.scopePath,
      );
      await stepRefresh(ctx);
      return;
    }

    const untilStep = flags.until as StepName | undefined;
    const loopMode = flags.loop;
    const intervalMs = (flags.interval ?? cfg.loopIntervalMinutes) * 60_000;
    const limit = flags.limit ?? 1;

    if (loopMode) {
      registerShutdownHandlers();
      log(`Loop mode — interval: ${intervalMs / 60_000}min, limit: ${limit}`);
    }

    let iteration = 0;

    do {
      const iterationStart = Date.now();
      iteration++;

      if (loopMode) {
        logBanner(`Iteration #${iteration} — ${new Date().toLocaleDateString("en-CA")}`);
      }

      try {
        await syncWithRemote();
      } catch (e) {
        log(`Sync failed: ${e instanceof Error ? e.message : String(e)}`);
        if (loopMode) {
          log(`Will retry in ${Math.round(intervalMs / 1000)}s...`);
          await sleep(intervalMs);
          continue;
        }
        throw e;
      }

      let contexts: IssueContext[];
      if (flags.issue) {
        const ctx = await fetchIssue(flags.issue);
        contexts = ctx ? [ctx] : [];
      } else {
        contexts = await fetchIssues(limit);
      }

      if (contexts.length === 0) {
        log("No issues to process.");
      } else {
        log(`Processing ${contexts.length} issue(s)...\n`);

        for (const ctx of contexts) {
          try {
            await runPipeline(ctx, untilStep);
          } catch (e) {
            consola.error(`Pipeline error for ${ctx.repo}#${ctx.number}:`, e);
          }
        }
      }

      if (loopMode) {
        const waitMs = Math.max(0, intervalMs - (Date.now() - iterationStart));
        if (waitMs > 0) {
          log(`Waiting ${Math.round(waitMs / 1000)}s until next iteration...`);
          await sleep(waitMs);
        }
      }
    } while (loopMode);

    log("Done.");
  }
}

async function syncWithRemote(): Promise<void> {
  const cfg = getConfig();
  log("Syncing with remote...");
  await git(["fetch", "--all", "--prune"]);
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== cfg.mainBranch) {
    log(`Warning: on branch "${branch}", switching to ${cfg.mainBranch}...`);
    await git(["checkout", cfg.mainBranch]).catch(() => {});
  }
  const status = await git(["status", "--porcelain"]);
  if (status.length > 0) {
    throw new Error("Working tree has uncommitted changes. Commit or stash them first.");
  }
  await git(["pull", cfg.remote, cfg.mainBranch]);
}

function registerShutdownHandlers(): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      log(`Received ${signal}, shutting down...`);
      setTimeout(() => process.exit(1), 5_000).unref();
      git(["checkout", getConfig().mainBranch])
        .catch(() => {})
        .then(() => process.exit(0));
    });
  }
}
