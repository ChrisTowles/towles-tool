import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defineCommand } from "citty";
import consola from "consola";
import prompts from "prompts";

import { git, run } from "@towles/shared";
import { debugArg } from "../shared.js";
import { AutoClaudeConfigSchema } from "./config.js";
import {
  CONFIG_DIR,
  CONFIG_PATH,
  buildConfig,
  formatConfigSummary,
  serializeConfig,
  validateBranchName,
  validateScopePath,
  validateTriggerLabel,
} from "./config-init-helpers.js";

async function detectRepo(): Promise<string> {
  const result = await run(
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
    { throwOnError: true },
  );
  return result.stdout.trim();
}

async function detectMainBranch(): Promise<string> {
  try {
    const branch = await git(["symbolic-ref", "refs/remotes/origin/HEAD"]);
    return branch.trim().replace("refs/remotes/origin/", "");
  } catch {
    return "main";
  }
}

async function detectGitRoot(): Promise<string> {
  return (await git(["rev-parse", "--show-toplevel"])).trim();
}

export default defineCommand({
  meta: { name: "config-init", description: "Initialize auto-claude config for the current repo" },
  args: {
    debug: debugArg,
    "non-interactive": {
      type: "boolean" as const,
      description: "Use all defaults without prompting",
      default: false,
    },
  },
  async run({ args }) {
    const gitRoot = await detectGitRoot();
    const configPath = join(gitRoot, CONFIG_PATH);

    if (existsSync(configPath)) {
      consola.warn(`Config already exists at ${CONFIG_PATH}`);
      if (!args["non-interactive"]) {
        const { overwrite } = await prompts({
          type: "confirm",
          name: "overwrite",
          message: "Overwrite existing config?",
          initial: false,
        });
        if (!overwrite) {
          consola.info("Aborted.");
          return;
        }
      }
    }

    const defaults = AutoClaudeConfigSchema.parse({
      repo: await detectRepo(),
      mainBranch: await detectMainBranch(),
    });

    if (args["non-interactive"]) {
      const config = buildConfig({
        triggerLabel: defaults.triggerLabel,
        mainBranch: defaults.mainBranch,
        scopePath: defaults.scopePath,
        model: defaults.model,
        repo: defaults.repo,
      });

      const dirPath = join(gitRoot, CONFIG_DIR);
      mkdirSync(dirPath, { recursive: true });
      writeFileSync(configPath, serializeConfig(config));
      consola.success(`Config written to ${CONFIG_PATH}`);
      return;
    }

    // Interactive prompts
    const answers = await prompts([
      {
        type: "text",
        name: "triggerLabel",
        message: "Trigger label",
        initial: defaults.triggerLabel,
        validate: (v: string) => validateTriggerLabel(v),
      },
      {
        type: "text",
        name: "mainBranch",
        message: "Main branch name",
        initial: defaults.mainBranch,
        validate: (v: string) => validateBranchName(v),
      },
      {
        type: "text",
        name: "scopePath",
        message: "Scope path",
        initial: defaults.scopePath,
        validate: (v: string) => validateScopePath(v),
      },
      {
        type: "text",
        name: "model",
        message: "Claude model",
        initial: defaults.model,
      },
    ]);

    // User cancelled (Ctrl-C during prompts)
    if (!answers.triggerLabel) {
      consola.info("Aborted.");
      return;
    }

    const config = buildConfig({
      triggerLabel: answers.triggerLabel,
      mainBranch: answers.mainBranch,
      scopePath: answers.scopePath,
      model: answers.model,
      repo: defaults.repo,
    });

    consola.box(`Config summary:\n\n${formatConfigSummary(config)}`);

    const { confirmed } = await prompts({
      type: "confirm",
      name: "confirmed",
      message: `Write config to ${CONFIG_PATH}?`,
      initial: true,
    });

    if (!confirmed) {
      consola.info("Aborted.");
      return;
    }

    const dirPath = join(gitRoot, CONFIG_DIR);
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(configPath, serializeConfig(config));
    consola.success(`Config written to ${CONFIG_PATH}`);
  },
});
