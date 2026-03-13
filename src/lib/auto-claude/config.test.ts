import { afterEach, describe, expect, it } from "vitest";

import { AutoClaudeConfigSchema, getConfig, initConfig, resetConfig } from "./config";

describe("AutoClaudeConfigSchema", () => {
  it("should apply all defaults when only repo is provided", () => {
    const cfg = AutoClaudeConfigSchema.parse({ repo: "owner/repo" });

    expect(cfg.triggerLabel).toBe("auto-claude");
    expect(cfg.scopePath).toBe(".");
    expect(cfg.mainBranch).toBe("main");
    expect(cfg.remote).toBe("origin");
    expect(cfg.maxImplementIterations).toBe(5);
    expect(cfg.maxTurns).toBeUndefined();
    expect(cfg.loopIntervalMinutes).toBe(30);
    expect(cfg.loopRetryEnabled).toBe(false);
    expect(cfg.maxRetries).toBe(5);
    expect(cfg.retryDelayMs).toBe(30_000);
    expect(cfg.maxRetryDelayMs).toBe(300_000);
  });

  it("should allow overriding defaults", () => {
    const cfg = AutoClaudeConfigSchema.parse({
      repo: "owner/repo",
      triggerLabel: "bot",
      maxImplementIterations: 10,
      maxRetries: 3,
      loopRetryEnabled: true,
    });

    expect(cfg.triggerLabel).toBe("bot");
    expect(cfg.maxImplementIterations).toBe(10);
    expect(cfg.maxRetries).toBe(3);
    expect(cfg.loopRetryEnabled).toBe(true);
  });

  it("should require repo field", () => {
    expect(() => AutoClaudeConfigSchema.parse({})).toThrow();
  });
});

describe("getConfig", () => {
  afterEach(() => {
    resetConfig();
  });

  it("should return config after initConfig with explicit repo and mainBranch", async () => {
    await initConfig({ repo: "test/repo", mainBranch: "main" });
    const cfg = getConfig();
    expect(cfg.repo).toBe("test/repo");
    expect(cfg.mainBranch).toBe("main");
  });
});
