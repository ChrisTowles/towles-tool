import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import consola from "consola";
import pc from "picocolors";
import { x } from "tinyexec";

import { createBranchNameFromIssue } from "../../utils/git/branch-name.js";
import { getConfig } from "./config.js";
import { ARTIFACTS } from "./prompt-templates/index.js";
import { spawnClaude } from "./spawn-claude.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const TEMPLATES_DIR = join(__dirname, "prompt-templates");

// ── Shell helpers ──

async function exec(cmd: string, args: string[]): Promise<string> {
  const result = await x(cmd, args, { nodeOptions: { cwd: process.cwd() }, throwOnError: true });
  return result.stdout.trim();
}

export async function execSafe(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; ok: boolean }> {
  const result = await x(cmd, args, { nodeOptions: { cwd: process.cwd() }, throwOnError: false });
  return { stdout: (result.stdout ?? "").trim(), ok: result.exitCode === 0 };
}

export async function gh<T = unknown>(args: string[]): Promise<T> {
  const out = await exec("gh", args);
  return JSON.parse(out) as T;
}

export async function ghRaw(args: string[]): Promise<string> {
  const result = await execSafe("gh", args);
  return result.stdout;
}

export async function git(args: string[]): Promise<string> {
  return exec("git", args);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Claude CLI ──

export interface ClaudeResult {
  result: string;
  is_error: boolean;
  total_cost_usd: number;
  num_turns: number;
}

export async function runClaude(opts: {
  promptFile: string;
  permissionMode: "plan" | "acceptEdits";
  maxTurns?: number;
  retry?: boolean;
}): Promise<ClaudeResult> {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    opts.permissionMode,
    ...(opts.maxTurns ? ["--max-turns", String(opts.maxTurns)] : []),
    `@${opts.promptFile}`,
  ];

  const cfg = getConfig();
  let retryDelay = cfg.retryDelayMs;
  let retries = 0;

  while (true) {
    try {
      const result = await runClaudeStreaming(args);
      consola.success(`Done — ${result.num_turns} turns`);
      if (result.result) {
        consola.log(result.result);
      }
      return result;
    } catch (e) {
      const shouldRetry = opts.retry ?? cfg.loopRetryEnabled ?? false;
      if (!shouldRetry) throw e;

      retries++;
      if (retries >= cfg.maxRetries) {
        throw new Error(`Claude failed after ${cfg.maxRetries} retries: ${e}`);
      }

      consola.warn(`Claude process error (attempt ${retries}/${cfg.maxRetries}): ${e}`);
      consola.info(`Retrying in ${retryDelay / 1000}s...`);
      await sleep(retryDelay);
      retryDelay = Math.min(retryDelay * 2, cfg.maxRetryDelayMs);
    }
  }
}

function runClaudeStreaming(args: string[]): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const proc = spawnClaude(args);
    let capturedResult: ClaudeResult | null = null;
    let turnCount = 0;

    if (!proc.stdout) {
      reject(new Error("Claude process has no stdout"));
      return;
    }

    const rl = createInterface({ input: proc.stdout });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        handleStreamEvent(event, (turns) => {
          turnCount = turns;
        });

        if ("result" in event && "is_error" in event && "num_turns" in event) {
          capturedResult = {
            result: String(event.result ?? ""),
            is_error: Boolean(event.is_error),
            total_cost_usd: Number(event.total_cost_usd ?? 0),
            num_turns: Number(event.num_turns),
          };
        }
      } catch {
        // Skip non-JSON lines
      }
    });

    proc.on("error", (err) => {
      rl.close();
      reject(err);
    });

    proc.on("close", (code) => {
      rl.close();
      if (capturedResult) {
        resolve(capturedResult);
      } else if (code !== 0) {
        reject(new Error(`Claude process exited with code ${code}`));
      } else {
        resolve({ result: "", is_error: false, total_cost_usd: 0, num_turns: turnCount });
      }
    });
  });
}

function handleStreamEvent(event: Record<string, unknown>, onTurn: (count: number) => void): void {
  // Tool use events: look for content blocks with tool_use type
  if (event.type === "assistant" && Array.isArray(event.message)) {
    for (const block of event.message) {
      if (
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        (block as Record<string, unknown>).type === "tool_use"
      ) {
        const name = (block as Record<string, unknown>).name;
        if (typeof name === "string") {
          consola.info(`  ${pc.dim("\u21B3")} ${name}`);
        }
      }
    }
  }

  // Content block with tool_use (alternative format)
  if (
    event.type === "content_block_start" &&
    typeof event.content_block === "object" &&
    event.content_block !== null
  ) {
    const block = event.content_block as Record<string, unknown>;
    if (block.type === "tool_use" && typeof block.name === "string") {
      consola.info(`  ${pc.dim("\u21B3")} ${block.name}`);
    }
  }

  // Turn count tracking
  if (typeof event.num_turns === "number" && !("result" in event)) {
    onTurn(event.num_turns as number);
  }
}

// ── Template resolution ──

export interface TokenValues {
  SCOPE_PATH: string;
  ISSUE_DIR: string;
  MAIN_BRANCH: string;
}

export function resolveTemplate(
  templateName: string,
  tokens: TokenValues,
  issueDir: string,
): string {
  const templatePath = join(TEMPLATES_DIR, templateName);
  let template = readFileSync(templatePath, "utf-8");

  for (const [key, value] of Object.entries(tokens)) {
    template = template.replaceAll(`{{${key}}}`, value);
  }

  const resolvedPath = join(issueDir, templateName);
  ensureDir(dirname(resolvedPath));
  writeFileSync(resolvedPath, template, "utf-8");

  return relative(process.cwd(), resolvedPath);
}

// ── File helpers ──

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

export function readFile(path: string): string {
  return readFileSync(path, "utf-8");
}

export function writeFile(path: string, content: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, content, "utf-8");
}

// ── Git helpers ──

export async function commitArtifacts(ctx: IssueContext, message: string): Promise<void> {
  await git(["add", ctx.issueDirRel]);
  const staged = await execSafe("git", ["diff", "--cached", "--name-only"]);
  if (staged.ok && staged.stdout.length > 0) {
    await git(["commit", "-m", message]);
  }
}

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

export function buildTokens(ctx: IssueContext): TokenValues {
  return {
    SCOPE_PATH: ctx.scopePath,
    ISSUE_DIR: ctx.issueDirRel,
    MAIN_BRANCH: getConfig().mainBranch,
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

export function log(msg: string): void {
  consola.info(`[auto-claude] ${msg}`);
}

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

  try {
    const branches = await git(["branch", "--list", branch]);
    if (branches.includes(branch)) {
      await git(["checkout", branch]);
      return;
    }
  } catch {
    /* ignore */
  }

  try {
    await git(["fetch", remote, branch]);
    await git(["checkout", branch]);
    return;
  } catch {
    /* doesn't exist remotely */
  }

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
}

/**
 * Runs a standard pipeline step: check artifact (skip if exists), run Claude
 * with a template, validate the artifact was produced, and commit.
 *
 * Used by plan, plan-implementation, review, and similar steps that follow
 * the same pattern.
 */
export async function runStepWithArtifact(opts: StepRunnerOptions): Promise<boolean> {
  const { stepName, ctx, artifactPath, templateName, artifactValidator } = opts;

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
    permissionMode: "acceptEdits",
    maxTurns: getConfig().maxTurns,
  });

  if (result.is_error) {
    consola.error(`${stepName} step failed: ${result.result}`);
    return false;
  }

  if (!isValid(artifactPath)) {
    consola.error(`${stepName} step did not produce expected artifact`);
    return false;
  }

  await commitArtifacts(
    ctx,
    `chore(auto-claude): ${stepName.toLowerCase()} for ${ctx.repo}#${ctx.number}`,
  );
  return true;
}
