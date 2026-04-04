import { describe, expect, it } from "vitest";

import {
  buildConfig,
  formatConfigSummary,
  serializeConfig,
  validateBranchName,
  validateScopePath,
  validateTriggerLabel,
} from "./config-init-helpers";

describe("validateTriggerLabel", () => {
  it("accepts a valid label", () => {
    expect(validateTriggerLabel("auto-claude")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(validateTriggerLabel("")).toBe("Trigger label cannot be empty");
  });

  it("rejects whitespace-only", () => {
    expect(validateTriggerLabel("   ")).toBe("Trigger label cannot be empty");
  });

  it("rejects label with spaces", () => {
    expect(validateTriggerLabel("auto claude")).toBe("Trigger label cannot contain spaces");
  });
});

describe("validateBranchName", () => {
  it("accepts a valid branch name", () => {
    expect(validateBranchName("main")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(validateBranchName("")).toBe("Branch name cannot be empty");
  });
});

describe("validateScopePath", () => {
  it("accepts a valid path", () => {
    expect(validateScopePath(".")).toBe(true);
  });

  it("accepts a subdirectory", () => {
    expect(validateScopePath("src/lib")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(validateScopePath("")).toBe("Scope path cannot be empty");
  });
});

describe("buildConfig", () => {
  it("builds config with provided values", () => {
    const config = buildConfig({
      triggerLabel: "my-label",
      mainBranch: "develop",
      scopePath: "src/",
      model: "sonnet",
      repo: "owner/repo",
    });

    expect(config.triggerLabel).toBe("my-label");
    expect(config.mainBranch).toBe("develop");
    expect(config.scopePath).toBe("src/");
    expect(config.model).toBe("sonnet");
    expect(config.repo).toBe("owner/repo");
  });

  it("applies schema defaults for fields not in input", () => {
    const config = buildConfig({
      triggerLabel: "auto-claude",
      mainBranch: "main",
      scopePath: ".",
      model: "opus",
      repo: "owner/repo",
    });

    expect(config.remote).toBe("origin");
    expect(config.maxImplementIterations).toBe(5);
    expect(config.maxReviewRetries).toBe(2);
    expect(config.loopIntervalMinutes).toBe(30);
  });
});

describe("formatConfigSummary", () => {
  it("includes all key fields", () => {
    const config = buildConfig({
      triggerLabel: "auto-claude",
      mainBranch: "main",
      scopePath: ".",
      model: "opus",
      repo: "owner/repo",
    });

    const summary = formatConfigSummary(config);
    expect(summary).toContain("owner/repo");
    expect(summary).toContain("auto-claude");
    expect(summary).toContain("main");
    expect(summary).toContain("opus");
    expect(summary).toContain("origin");
    expect(summary).toContain("30min");
  });
});

describe("serializeConfig", () => {
  it("returns valid JSON with trailing newline", () => {
    const config = buildConfig({
      triggerLabel: "auto-claude",
      mainBranch: "main",
      scopePath: ".",
      model: "opus",
      repo: "owner/repo",
    });

    const json = serializeConfig(config);
    expect(json.endsWith("\n")).toBe(true);

    const parsed = JSON.parse(json);
    expect(parsed.repo).toBe("owner/repo");
    expect(parsed.triggerLabel).toBe("auto-claude");
  });

  it("is pretty-printed with 2-space indent", () => {
    const config = buildConfig({
      triggerLabel: "test",
      mainBranch: "main",
      scopePath: ".",
      model: "opus",
      repo: "o/r",
    });

    const json = serializeConfig(config);
    expect(json).toContain('  "repo"');
  });
});
