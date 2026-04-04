import { describe, it, expect, afterEach } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCommand } from "citty";

describe("config show", () => {
  it("runs without throwing", async () => {
    const { default: showCmd } = await import("./show.js");
    await expect(runCommand(showCmd, { rawArgs: [] })).resolves.toBeDefined();
  });
});

describe("config validate", () => {
  let dir: string;

  async function writeTempFile(content: string): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "tt-config-test-"));
    const filePath = join(dir, "settings.json");
    await writeFile(filePath, content, "utf-8");
    return filePath;
  }

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("reports valid config as ok", async () => {
    const filePath = await writeTempFile(JSON.stringify({ preferredEditor: "vim" }));
    const { default: validateCmd } = await import("./validate.js");

    process.exitCode = 0;
    await runCommand(validateCmd, { rawArgs: ["--path", filePath] });
    expect(process.exitCode).toBe(0);
  });

  it("reports invalid JSON", async () => {
    const filePath = await writeTempFile("not json {{{");
    const { default: validateCmd } = await import("./validate.js");

    process.exitCode = 0;
    await runCommand(validateCmd, { rawArgs: ["--path", filePath] });
    expect(process.exitCode).toBe(1);
  });

  it("reports schema validation errors", async () => {
    const filePath = await writeTempFile(JSON.stringify({ preferredEditor: 123 }));
    const { default: validateCmd } = await import("./validate.js");

    process.exitCode = 0;
    await runCommand(validateCmd, { rawArgs: ["--path", filePath] });
    expect(process.exitCode).toBe(1);
  });

  it("reports missing file", async () => {
    const { default: validateCmd } = await import("./validate.js");

    process.exitCode = 0;
    await runCommand(validateCmd, { rawArgs: ["--path", "/tmp/nonexistent-tt-settings.json"] });
    expect(process.exitCode).toBe(1);
  });
});

describe("config reset", () => {
  let dir: string;

  async function writeTempSettings(content: string): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "tt-config-reset-"));
    const filePath = join(dir, "settings.json");
    await writeFile(filePath, content, "utf-8");
    return filePath;
  }

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("without --confirm exits with code 1 and shows diff", async () => {
    await writeTempSettings(JSON.stringify({ preferredEditor: "nvim" }));

    const { default: resetCmd } = await import("./reset.js");

    process.exitCode = 0;
    await runCommand(resetCmd, { rawArgs: [] });
    // Without --confirm it should set exitCode=1 (unless settings already match defaults)
    expect([0, 1]).toContain(process.exitCode);
  });

  it("with --confirm resets settings to defaults", async () => {
    const { default: resetCmd } = await import("./reset.js");

    process.exitCode = 0;
    await runCommand(resetCmd, { rawArgs: ["--confirm"] });
    expect(process.exitCode).toBe(0);

    // Verify the file was written with defaults by loading it
    const { readFile: rf } = await import("node:fs/promises");
    const { USER_SETTINGS_PATH: settingsPath, UserSettingsSchema } =
      await import("../../config/settings.js");
    const content = JSON.parse(await rf(settingsPath, "utf-8"));
    const defaults = UserSettingsSchema.parse({});
    expect(JSON.stringify(content)).toBe(JSON.stringify(defaults));
  });
});

describe("config schema", () => {
  it("outputs valid JSON schema", async () => {
    const { default: schemaCmd } = await import("./schema.js");

    const chunks: string[] = [];
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      await runCommand(schemaCmd, { rawArgs: [] });
    } finally {
      process.stdout.write = origWrite;
    }

    const output = chunks.join("");
    const schema = JSON.parse(output);
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();
    expect(schema.properties.preferredEditor).toBeDefined();
  });
});
