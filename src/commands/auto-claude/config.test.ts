import { afterEach, describe, expect, it } from "vitest";

import { AutoClaudeConfigSchema, getConfig, initConfig } from "./config";

describe("AutoClaudeConfigSchema", () => {
  it("should apply all defaults when only repo is provided", () => {
    const cfg = AutoClaudeConfigSchema.parse({ repo: "owner/repo" });

    expect(cfg.triggerLabel).toBe("auto-claude");
    expect(cfg.scopePath).toBe(".");
    expect(cfg.mainBranch).toBe("main");
    expect(cfg.remote).toBe("origin");
    expect(cfg.maxImplementIterations).toBe(5);
    expect(cfg.maxTurns).toBeUndefined();
    expect(cfg.model).toBe("opus");
    expect(cfg.maxReviewRetries).toBe(2);
    expect(cfg.loopIntervalMinutes).toBe(30);
  });

  it("should allow overriding defaults", () => {
    const cfg = AutoClaudeConfigSchema.parse({
      repo: "owner/repo",
      triggerLabel: "bot",
      maxImplementIterations: 10,
      model: "sonnet",
      maxReviewRetries: 5,
    });

    expect(cfg.triggerLabel).toBe("bot");
    expect(cfg.maxImplementIterations).toBe(10);
    expect(cfg.model).toBe("sonnet");
    expect(cfg.maxReviewRetries).toBe(5);
  });

  it("should require repo field", () => {
    expect(() => AutoClaudeConfigSchema.parse({})).toThrow();
  });
});

describe("getConfig", () => {
  afterEach(() => {
    // Reset internal config state by re-initializing
  });

  it("should return config after initConfig with explicit repo and mainBranch", async () => {
    await initConfig({ repo: "test/repo", mainBranch: "main" });
    const cfg = getConfig();
    expect(cfg.repo).toBe("test/repo");
    expect(cfg.mainBranch).toBe("main");
  });
});
