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
