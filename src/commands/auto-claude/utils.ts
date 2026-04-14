import { join } from "node:path";

import consola from "consola";
import pc from "picocolors";

import {
  createBranchNameFromIssue,
  ensureDir,
  execSafe,
  fileExists,
  git,
  readFile,
  writeFile,
} from "@towles/shared";
import { runClaude } from "./claude-cli.js";
import { getConfig } from "./config.js";
import { logger } from "./logger.js";
import { ARTIFACTS } from "./prompt-templates/index.js";
import { resolveTemplate } from "./templates.js";

import type { SpawnClaudeFn } from "./spawn-claude.js";
import type { TokenValues } from "./templates.js";

export { ensureDir, fileExists, readFile, writeFile } from "@towles/shared";

// ── Issue context ──

export interface IssueContext {
  number: number;
  title: string;
  body: string;
  repo: string;
  scopePath: string;
  issueDir: string;
  issueDirRel: string;
  branch: string;
}

export function buildIssueContext(
  issue: { number: number; title: string; body: string },
  repo: string,
  scopePath: string,
): IssueContext {
  const issueDirRel = `.auto-claude/issue-${issue.number}`;
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    repo,
    scopePath,
    issueDir: join(process.cwd(), issueDirRel),
    issueDirRel,
    branch: createBranchNameFromIssue({ number: issue.number, title: issue.title }),
  };
}

export function buildTokens(ctx: IssueContext, overrides?: Partial<TokenValues>): TokenValues {
  return {
    SCOPE_PATH: ctx.scopePath,
    ISSUE_DIR: ctx.issueDirRel,
    MAIN_BRANCH: getConfig().mainBranch,
    REVIEW_FEEDBACK: "",
    ...overrides,
  };
}

export function buildContextFromArtifacts(issueNumber: number): IssueContext {
  const cfg = getConfig();
  const issueDirRel = `.auto-claude/issue-${issueNumber}`;
  const ramblingsPath = join(process.cwd(), issueDirRel, ARTIFACTS.initialRamblings);

  if (!fileExists(ramblingsPath)) {
    throw new Error(`No artifacts found at ${issueDirRel}. Run the pipeline first.`);
  }

  const content = readFile(ramblingsPath);
  const titleMatch = content.match(/^# (.+)$/m);
  const title = titleMatch?.[1] ?? `Issue #${issueNumber}`;

  // Body starts after the second blank line (past the title and metadata lines)
  const secondBlankIdx = findNthBlankLine(content.split("\n"), 2);
  const body = content
    .split("\n")
    .slice(secondBlankIdx + 1)
    .join("\n")
    .trim();

  return buildIssueContext({ number: issueNumber, title, body }, cfg.repo, cfg.scopePath);
}

function findNthBlankLine(lines: string[], n: number): number {
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") {
      count++;
      if (count === n) return i;
    }
  }
  return 0;
}

// ── Logging ──

export function logBanner(label: string, width = 60): void {
  const inner = `  ${label}  `;
  const totalDashes = Math.max(0, width - inner.length - 2);
  const left = Math.ceil(totalDashes / 2);
  const right = Math.floor(totalDashes / 2);
  const dashes = pc.cyan;
  consola.log(
    `${dashes("#" + "-".repeat(left))}${pc.bold(inner)}${dashes("-".repeat(right) + "#")}`,
  );
}

export function logStep(step: string, ctx: IssueContext, skipped = false): void {
  const tag = skipped ? pc.yellow("SKIP") : pc.green("RUN");
  logBanner(`[${tag}] ${step}`);
  consola.log(pc.dim(`${ctx.repo}#${ctx.number} — ${ctx.title}`));
}

// ── Git branch helpers ──

export async function ensureBranch(branch: string): Promise<void> {
  const { mainBranch, remote } = getConfig();

  // Stash uncommitted changes so branch switching works from a dirty tree
  const status = await execSafe("git", ["status", "--porcelain"]);
  const hadDirtyTree = status.ok && status.stdout.length > 0;
  if (hadDirtyTree) {
    await git(["stash", "push", "-m", `auto-claude: before switching to ${branch}`]);
    logger.info("Stashed uncommitted changes");
  }

  // Check if branch exists locally (rev-parse is reliable, no output parsing)
  const local = await execSafe("git", ["rev-parse", "--verify", `refs/heads/${branch}`]);
  if (local.ok) {
    await git(["checkout", branch]);
    return;
  }

  // Check if branch exists on remote
  try {
    await git(["fetch", remote, branch]);
    await git(["checkout", branch]);
    return;
  } catch {
    // intentionally ignored: branch doesn't exist remotely, fall through to create it
  }

  // Create new branch from main
  await git(["checkout", mainBranch]);
  await git(["pull", remote, mainBranch]);
  await git(["checkout", "-b", branch]);
}

// ── Common step runner ──

export interface StepRunnerOptions {
  stepName: string;
  ctx: IssueContext;
  artifactPath: string;
  templateName: string;
  artifactValidator?: (path: string) => boolean;
  spawnFn?: SpawnClaudeFn;
}

/**
 * Runs a standard pipeline step: check artifact (skip if exists), run Claude
 * with a template, validate the artifact was produced, and commit.
 *
 * Used by plan, plan-implementation, review, and similar steps that follow
 * the same pattern.
 */
export async function runStepWithArtifact(opts: StepRunnerOptions): Promise<boolean> {
  const { stepName, ctx, artifactPath, templateName, artifactValidator, spawnFn } = opts;

  const isValid = artifactValidator ?? fileExists;
  if (isValid(artifactPath)) {
    logStep(stepName, ctx, true);
    return true;
  }

  logStep(stepName, ctx);

  const tokens = buildTokens(ctx);
  const promptFile = resolveTemplate(templateName, tokens, ctx.issueDir);

  const result = await runClaude({
    promptFile,
    maxTurns: getConfig().maxTurns,
    spawnFn,
  });

  if (result.is_error) {
    logger.error(`${stepName} step failed: ${result.result}`);
    return false;
  }

  if (!isValid(artifactPath)) {
    logger.error(`${stepName} step did not produce expected artifact`);
    return false;
  }

  return true;
}
