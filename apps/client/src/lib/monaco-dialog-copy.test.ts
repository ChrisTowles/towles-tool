import { describe, expect, it } from "vitest";
import { isDangerous, stripMnemonic } from "@/lib/monaco-dialog-copy";

describe("stripMnemonic", () => {
  it("drops VS Code's && mnemonic markers", () => {
    expect(stripMnemonic("&&Delete")).toBe("Delete");
    expect(stripMnemonic("Move to &&Trash")).toBe("Move to Trash");
  });

  it("leaves a plain label alone", () => {
    expect(stripMnemonic("OK")).toBe("OK");
  });
});

describe("isDangerous", () => {
  it("flags destructive verbs so the confirm gets the destructive button", () => {
    expect(isDangerous("Delete", "Are you sure you want to delete 'a.txt'?")).toBe(true);
    expect(isDangerous("Move to Trash", "Delete a.txt?")).toBe(true);
    expect(isDangerous("OK", "Discard your changes?")).toBe(true);
  });

  it("leaves an ordinary confirmation alone", () => {
    expect(isDangerous("Save", "Save changes to app.ts?")).toBe(false);
  });
});
