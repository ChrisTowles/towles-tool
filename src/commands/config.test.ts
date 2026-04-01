import { describe, it, expect } from "vitest";
import { runCommand } from "citty";

describe("config command", () => {
  it("runs config without throwing", async () => {
    const { default: configCmd } = await import("./config.js");
    await expect(runCommand(configCmd, { rawArgs: [] })).resolves.toBeDefined();
  });
});
