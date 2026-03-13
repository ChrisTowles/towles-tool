import consola from "consola";
import { x } from "tinyexec";
import { z } from "zod/v4";

export const AutoClaudeConfigSchema = z.object({
  triggerLabel: z.string().default("auto-claude"),
  repo: z.string(),
  scopePath: z.string().default("."),
  mainBranch: z.string().default("main"),
  remote: z.string().default("origin"),
  maxImplementIterations: z.number().default(5),
  maxTurns: z.number().optional(),
  loopIntervalMinutes: z.number().default(30),
  loopRetryEnabled: z.boolean().default(false),
  maxRetries: z.number().default(5),
  retryDelayMs: z.number().default(30_000),
  maxRetryDelayMs: z.number().default(300_000),
});

export type AutoClaudeConfig = z.infer<typeof AutoClaudeConfigSchema>;

let _config: AutoClaudeConfig | undefined;

export async function initConfig(
  overrides: Partial<AutoClaudeConfig> = {},
): Promise<AutoClaudeConfig> {
  // Auto-detect repo
  let repo = overrides.repo;
  if (!repo) {
    const result = await x(
      "gh",
      ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
      {
        nodeOptions: { cwd: process.cwd() },
        throwOnError: true,
      },
    );
    repo = result.stdout.trim();
  }
  consola.info(`Detected repo: ${repo}`);

  // Auto-detect main branch
  let mainBranch = overrides.mainBranch;
  if (!mainBranch) {
    try {
      const result = await x("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
        nodeOptions: { cwd: process.cwd() },
        throwOnError: true,
      });
      mainBranch = result.stdout.trim().replace("refs/remotes/origin/", "");
    } catch {
      mainBranch = "main";
    }
  }

  _config = AutoClaudeConfigSchema.parse({
    ...overrides,
    repo,
    mainBranch,
  });

  return _config;
}

export function getConfig(): AutoClaudeConfig {
  if (!_config) throw new Error("Config not initialized. Call initConfig() first.");
  return _config;
}

export function resetConfig(): void {
  _config = undefined;
}
