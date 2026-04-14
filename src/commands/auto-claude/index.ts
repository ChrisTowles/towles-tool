import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { defineCommand } from "citty";

import { debugArg } from "../shared.js";
import { printExplain, printStepTemplate } from "./explain.js";
import { STEP_NAMES, runPipeline } from "./pipeline.js";
import { fetchIssue, fetchIssues } from "./steps/fetch-issues.js";
import { getConfig, initConfig } from "./config.js";
import { git } from "@towles/shared";
import { runClaude } from "./claude-cli.js";
import { logger } from "./logger.js";
import { sleep } from "./shell.js";
import { logBanner } from "./utils.js";
import type { IssueContext } from "./utils.js";
import type { StepName } from "./prompt-templates/index.js";

export default defineCommand({
  meta: { name: "auto-claude", description: "Automated issue-to-PR pipeline using Claude Code" },
  args: {
    prompt: {
      type: "positional" as const,
      required: false,
      description: "Run a single prompt (skips issue pipeline)",
    },
    debug: debugArg,
    "max-turns": {
      type: "string" as const,
      description: "Maximum conversation turns for prompt mode (default: 10)",
      default: "10",
    },
    issue: {
      type: "string" as const,
      alias: "i",
      description: "Process a specific issue number",
    },
    until: {
      type: "string" as const,
      alias: "u",
      description: `Stop after this step (${STEP_NAMES.join(", ")})`,
    },
    reset: {
      type: "string" as const,
      description: "Delete local state for an issue (force restart)",
    },
    model: {
      type: "string" as const,
      description: "Claude model to use (default: opus)",
      default: "opus",
    },
    loop: {
      type: "boolean" as const,
      description: "Poll for labeled issues continuously",
      default: false,
    },
    interval: {
      type: "string" as const,
      description: "Poll interval in minutes (default: 30)",
    },
    limit: {
      type: "string" as const,
      description: "Max issues per iteration (default: 1)",
      default: "1",
    },
    label: {
      type: "string" as const,
      description: "Trigger label (default: auto-claude)",
    },
    "main-branch": {
      type: "string" as const,
      description: "Override main branch detection",
    },
    "scope-path": {
      type: "string" as const,
      description: "Path within repo to scope work (default: .)",
    },
    explain: {
      type: "boolean" as const,
      description: "Print a summary of all pipeline steps and exit",
      default: false,
    },
    "step-template": {
      type: "string" as const,
      description: `Print the raw prompt template for a step and exit (${STEP_NAMES.join(", ")})`,
    },
  },
  subCommands: {
    list: () => import("./list.js").then((m) => m.default),
    status: () => import("./status.js").then((m) => m.default),
    retry: () => import("./retry.js").then((m) => m.default),
    "config-init": () => import("./config-init.js").then((m) => m.default),
  },
  async run({ args }) {
    // Explain mode: print pipeline summary and exit
    if (args.explain) {
      printExplain();
      return;
    }

    // Step template mode: print raw template and exit
    if (args["step-template"]) {
      try {
        printStepTemplate(args["step-template"] as string);
      } catch (e) {
        logger.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
      return;
    }

    // Prompt mode: run a single prompt with structured output, skip issue pipeline
    if (args.prompt) {
      await initConfig({ model: args.model });

      const promptDir = join(tmpdir(), "tt-auto-claude");
      mkdirSync(promptDir, { recursive: true });
      const promptFile = join(promptDir, `prompt-${Date.now()}.md`);
      writeFileSync(promptFile, args.prompt);

      const result = await runClaude({
        promptFile,
        maxTurns: Number(args["max-turns"]),
      });

      if (result.is_error) {
        logger.error("Claude reported an error");
        process.exit(1);
      }
      return;
    }

    // Issue pipeline mode
    const cfg = await initConfig({
      triggerLabel: args.label,
      mainBranch: args["main-branch"],
      scopePath: args["scope-path"],
      model: args.model,
    });

    const resetIssue = args.reset ? Number(args.reset) : undefined;
    if (resetIssue) {
      const issueDir = join(process.cwd(), `.auto-claude/issue-${resetIssue}`);
      logger.info(`Resetting state for issue-${resetIssue}...`);
      rmSync(issueDir, { recursive: true, force: true });
      logger.info(`Cleaned ${issueDir}`);
      return;
    }

    const untilStep = args.until as StepName | undefined;
    const loopMode = args.loop as boolean;
    const intervalMs = (args.interval ? Number(args.interval) : cfg.loopIntervalMinutes) * 60_000;
    const limit = Number(args.limit);

    if (loopMode) {
      registerShutdownHandlers();
      logger.info(`Loop mode — interval: ${intervalMs / 60_000}min, limit: ${limit}`);
    }

    const issueNumber = args.issue ? Number(args.issue) : undefined;
    let iteration = 0;

    do {
      const iterationStart = Date.now();
      iteration++;

      if (loopMode) {
        logBanner(`Iteration #${iteration} — ${new Date().toISOString()}`);
      }

      try {
        await syncWithRemote();
      } catch (e) {
        logger.warn(`Sync failed: ${e instanceof Error ? e.message : String(e)}`);
        if (loopMode) {
          logger.info(`Will retry in ${Math.round(intervalMs / 1000)}s...`);
          await sleep(intervalMs);
          continue;
        }
        throw e;
      }

      logger.info("Fetching labeled issues…");
      let contexts: IssueContext[];
      if (issueNumber) {
        const ctx = await fetchIssue(issueNumber);
        contexts = ctx ? [ctx] : [];
      } else {
        contexts = await fetchIssues(limit);
      }

      if (contexts.length === 0) {
        logger.info("No issues to process.");
      } else {
        logger.info(`Processing ${contexts.length} issue(s)...\n`);

        for (const ctx of contexts) {
          const issueStart = Date.now();
          try {
            await runPipeline(ctx, untilStep);
          } catch (e) {
            logger.error(`Pipeline error for ${ctx.repo}#${ctx.number}:`, e);
          } finally {
            const elapsed = ((Date.now() - issueStart) / 1000).toFixed(1);
            logger.info(`Completed ${ctx.repo}#${ctx.number} in ${elapsed}s`);
          }
        }
      }

      if (loopMode) {
        const waitMs = Math.max(0, intervalMs - (Date.now() - iterationStart));
        if (waitMs > 0) {
          logger.info(`Waiting ${Math.round(waitMs / 1000)}s until next iteration...`);
          await sleep(waitMs);
        }
      }
    } while (loopMode);

    logger.info("Done.");
  },
});

async function syncWithRemote(): Promise<void> {
  const cfg = getConfig();
  logger.info("Syncing with remote...");
  await git(["fetch", "--all", "--prune"]);
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== cfg.mainBranch) {
    logger.warn(`On branch "${branch}", switching to ${cfg.mainBranch}...`);
    await git(["checkout", cfg.mainBranch]).catch(() => {
      // Best-effort checkout — may fail if working tree is dirty
    });
  }
  const status = await git(["status", "--porcelain"]);
  if (status.length > 0) {
    const files = status.trim().split("\n");
    logger.warn(`Working tree has ${files.length} uncommitted change(s):`);
    for (const file of files) {
      logger.warn(`  ${file.trim()}`);
    }
  }
  await git(["pull", cfg.remote, cfg.mainBranch]);
}

function registerShutdownHandlers(): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      logger.info(`Received ${signal}, shutting down...`);
      setTimeout(() => process.exit(1), 5_000).unref();
      git(["checkout", getConfig().mainBranch])
        .catch(() => {
          // Best-effort cleanup on shutdown — ignore failures
        })
        .then(() => process.exit(0));
    });
  }
}
