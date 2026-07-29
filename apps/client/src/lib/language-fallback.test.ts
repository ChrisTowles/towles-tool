import { describe, expect, it } from "vitest";
import { fallbackLanguageFor } from "@/lib/language-fallback";

describe("fallbackLanguageFor", () => {
  it("borrows the INI grammar for TOML — VS Code ships none", () => {
    expect(fallbackLanguageFor("comment-lint.toml")).toBe("ini");
    expect(fallbackLanguageFor("/home/me/repo/Cargo.toml")).toBe("ini");
    expect(fallbackLanguageFor("Cargo.lock")).toBe("ini");
  });

  it("matches an exact name before an extension", () => {
    // `.cfg` alone is ini too, but the name entry is what answers here.
    expect(fallbackLanguageFor("setup.cfg")).toBe("ini");
    expect(fallbackLanguageFor("Vagrantfile")).toBe("ruby");
  });

  it("matches name prefixes", () => {
    expect(fallbackLanguageFor(".env.local")).toBe("ini");
    expect(fallbackLanguageFor(".env")).toBe("ini");
    expect(fallbackLanguageFor("Dockerfile.dev")).toBe("dockerfile");
    expect(fallbackLanguageFor("Makefile.am")).toBe("makefile");
  });

  it("treats a leading-dot name as all extension", () => {
    expect(fallbackLanguageFor("/etc/skel/.zshrc")).toBe("shellscript");
    expect(fallbackLanguageFor(".editorconfig")).toBe("ini");
  });

  it("is case-insensitive on extensions", () => {
    expect(fallbackLanguageFor("Config.TOML")).toBe("ini");
  });

  it("leaves anything it has no better answer for as plaintext", () => {
    expect(fallbackLanguageFor("main.rs")).toBeNull();
    expect(fallbackLanguageFor("notes")).toBeNull();
    expect(fallbackLanguageFor("thing.wat")).toBeNull();
  });
});
