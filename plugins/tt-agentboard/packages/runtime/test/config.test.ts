import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config";

const TEST_HOME = join(import.meta.dir, ".test-home");
const CONFIG_DIR = join(TEST_HOME, ".config", "towles-tool", "agentboard");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

describe("config", () => {
  beforeEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(TEST_HOME, { recursive: true, force: true });
  });

  describe("loadConfig", () => {
    it("returns defaults when no config file exists", () => {
      const config = loadConfig(TEST_HOME);
      expect(config.plugins).toEqual([]);
      expect(config.port).toBeUndefined();
      expect(config.theme).toBeUndefined();
      expect(config.sidebarWidth).toBeUndefined();
    });

    it("reads config from disk", () => {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(
        CONFIG_FILE,
        JSON.stringify({
          port: 4201,
          theme: "tokyo-night",
          sidebarWidth: 30,
          plugins: ["my-plugin"],
        }),
      );

      const config = loadConfig(TEST_HOME);
      expect(config.port).toBe(4201);
      expect(config.theme).toBe("tokyo-night");
      expect(config.sidebarWidth).toBe(30);
      expect(config.plugins).toEqual(["my-plugin"]);
    });

    it("handles malformed JSON gracefully", () => {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(CONFIG_FILE, "not json {{{");

      const config = loadConfig(TEST_HOME);
      expect(config.plugins).toEqual([]);
    });
  });

  describe("saveConfig", () => {
    it("creates config directory and file", () => {
      saveConfig({ theme: "gruvbox-dark" }, TEST_HOME);

      expect(existsSync(CONFIG_FILE)).toBe(true);
      const saved = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
      expect(saved.theme).toBe("gruvbox-dark");
    });

    it("merges with existing config", () => {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(
        CONFIG_FILE,
        JSON.stringify({
          theme: "nord",
          sidebarWidth: 28,
          plugins: [],
        }),
      );

      saveConfig({ sidebarWidth: 32 }, TEST_HOME);

      const saved = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
      expect(saved.theme).toBe("nord");
      expect(saved.sidebarWidth).toBe(32);
    });
  });
});
