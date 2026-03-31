import { rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { defineCommand } from "citty";
import consola from "consola";

import { debugArg } from "../shared.js";
import {
  STEP_NAMES,
  fetchIssue,
  fetchIssues,
  getConfig,
  git,
  initConfig,
  log,
  logBanner,
  runClaude,
  runPipeline,
  sleep,
} from "../../lib/auto-claude/index.js";
import type { IssueContext, StepName } from "../../lib/auto-claude/index.js";

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
  },
  subCommands: {
    list: () => import("./list.js").then((m) => m.default),
    status: () => import("./status.js").then((m) => m.default),
    retry: () => import("./retry.js").then((m) => m.default),
  },
  async run({ args }) {
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
        consola.error("Claude reported an error");
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
      log(`Resetting state for issue-${resetIssue}...`);
      rmSync(issueDir, { recursive: true, force: true });
      log(`Cleaned ${issueDir}`);
      return;
    }

    const untilStep = args.until as StepName | undefined;
    const loopMode = args.loop as boolean;
    const intervalMs = (args.interval ? Number(args.interval) : cfg.loopIntervalMinutes) * 60_000;
    const limit = Number(args.limit);

    if (loopMode) {
      registerShutdownHandlers();
      log(`Loop mode — interval: ${intervalMs / 60_000}min, limit: ${limit}`);
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
        log(`Sync failed: ${e instanceof Error ? e.message : String(e)}`);
        if (loopMode) {
          log(`Will retry in ${Math.round(intervalMs / 1000)}s...`);
          await sleep(intervalMs);
          continue;
        }
        throw e;
      }

      log("Fetching labeled issues…");
      let contexts: IssueContext[];
      if (issueNumber) {
        const ctx = await fetchIssue(issueNumber);
        contexts = ctx ? [ctx] : [];
      } else {
        contexts = await fetchIssues(limit);
      }

      if (contexts.length === 0) {
        log("No issues to process.");
      } else {
        log(`Processing ${contexts.length} issue(s)...\n`);

        for (const ctx of contexts) {
          const issueStart = Date.now();
          try {
            await runPipeline(ctx, untilStep);
          } catch (e) {
            consola.error(`Pipeline error for ${ctx.repo}#${ctx.number}:`, e);
          } finally {
            const elapsed = ((Date.now() - issueStart) / 1000).toFixed(1);
            log(`Completed ${ctx.repo}#${ctx.number} in ${elapsed}s`);
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
  },
});

async function syncWithRemote(): Promise<void> {
  const cfg = getConfig();
  log("Syncing with remote...");
  await git(["fetch", "--all", "--prune"]);
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== cfg.mainBranch) {
    log(`Warning: on branch "${branch}", switching to ${cfg.mainBranch}...`);
    await git(["checkout", cfg.mainBranch]).catch(() => {
      // Best-effort checkout — may fail if working tree is dirty
    });
  }
  const status = await git(["status", "--porcelain"]);
  if (status.length > 0) {
    const files = status.trim().split("\n");
    consola.warn(`Working tree has ${files.length} uncommitted change(s):`);
    for (const file of files) {
      consola.warn(`  ${file.trim()}`);
    }
  }
  await git(["pull", cfg.remote, cfg.mainBranch]);
}

function registerShutdownHandlers(): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      log(`Received ${signal}, shutting down...`);
      setTimeout(() => process.exit(1), 5_000).unref();
      git(["checkout", getConfig().mainBranch])
        .catch(() => {
          // Best-effort cleanup on shutdown — ignore failures
        })
        .then(() => process.exit(0));
    });
  }
}
